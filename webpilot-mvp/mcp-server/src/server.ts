#!/usr/bin/env node
/**
 * WebPilot MCP Server
 * 暴露浏览器操作工具，供 Claude Code / Cursor / Codex 等 MCP 兼容 Agent 调用
 * 通过 BrowserBridge（Leader-Follower）与 Chrome 扩展通信，支持多进程共享
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TaskRuntime } from "./task-runtime.js";
import { AdapterRegistry } from "./adapters.js";
import { BrowserBridge } from "./bridge.js";
import { SelectorCache, isCacheableSelector, isValidIntent } from "./selector-cache.js";
import { formatElementLine, formatPageTree } from "./page-format.js";

const MAX_ACTION_LOG_ENTRIES = 100;

function normalizeTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 10000;
  return Math.max(100, Math.min(Math.floor(value), 30000));
}

// 本进程抢到 8765 则直连扩展（Leader），否则经 8766 转发给 Leader（Follower）。
const bridge = new BrowserBridge();
const sendToExtension = (type: string, params: Record<string, any>): Promise<any> => bridge.send(type, params);

const taskRuntime = new TaskRuntime(sendToExtension);
const adapterRegistry = new AdapterRegistry(sendToExtension);
const selectorCache = new SelectorCache();

// click/type 的 (站点, intent) 缓存流程：命中时用缓存定位符直接执行（零观察），
// 失败或未命中时回退显式 selector，成功后用耐久定位符回写缓存。
// 返回扩展端结果与缓存备注；cacheError 非空表示无法发起任何执行。
async function performWithSelectorCache(
  action: "click" | "type",
  args: Record<string, any>
): Promise<{ result?: any; notes: string[]; cacheError?: string }> {
  const explicit = typeof args.selector === "string" && args.selector.trim() ? args.selector.trim() : undefined;
  const extra = action === "type" ? { text: args.text } : {};
  const send = (selector: string) =>
    sendToExtension(action, { selector, ...extra, tabId: args.tabId, timeoutMs: normalizeTimeout(args.timeoutMs) });
  if (args.intent === undefined) {
    if (!explicit) return { notes: [], cacheError: "selector is required when intent is not provided" };
    return { result: await send(explicit), notes: [] };
  }
  if (!isValidIntent(args.intent)) {
    return { notes: [], cacheError: "intent must be lowercase letters, digits, dot, dash or underscore (max 64 chars), e.g. search-input" };
  }
  const intent = args.intent;
  const page = await sendToExtension("getURL", { tabId: args.tabId });
  let host: string;
  try {
    host = new URL(page.url).hostname.toLowerCase();
  } catch {
    return { notes: [], cacheError: `could not determine hostname from current page URL: ${page.url}` };
  }
  const notes: string[] = [];
  const cached = await selectorCache.lookup(host, intent);
  if (cached) {
    const result = await send(cached.selector);
    if (result.success) {
      await selectorCache.recordSuccess(host, intent, cached.selector, result.diagnostics?.durationMs ?? 0);
      notes.push(`[cache] hit: (${host}, ${intent}) → ${cached.selector}`);
      return { result, notes };
    }
    await selectorCache.recordFailure(host, intent, result.error);
    notes.push(`[cache] cached selector failed (${cached.selector}): ${result.error}`);
    if (!explicit) {
      return { notes, cacheError: `cached selector for (${host}, ${intent}) failed; observe the page and retry with an explicit selector` };
    }
  } else if (!explicit) {
    const status = await selectorCache.status(host, intent);
    return { notes, cacheError: `no usable cache entry for (${host}, ${intent}) — ${status === "disabled" ? "entry disabled after repeated failures" : "no entry yet"}; observe the page and retry with an explicit selector` };
  }
  const result = await send(explicit!);
  if (result.success) {
    const durable = result.diagnostics?.durableSelector || (isCacheableSelector(explicit) ? explicit : undefined);
    if (durable) {
      await selectorCache.recordSuccess(host, intent, durable, result.diagnostics?.durationMs ?? 0);
      notes.push(`[cache] stored: (${host}, ${intent}) → ${durable}`);
    } else {
      notes.push(`[cache] not stored: no durable locator could be derived for ${explicit}`);
    }
  }
  return { result, notes };
}

// ===== MCP Server =====
const server = new Server(
  {
    name: "webpilot-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: { tools: {} },
  }
);

// 工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "navigate",
        description: "在浏览器中打开指定 URL，返回页面标题和 URL",
        inputSchema: {
          type: "object" as const,
          properties: {
            url: { type: "string", description: "要打开的 URL" },
            tabId: { type: "number", description: "目标标签页 ID（可选，默认当前活动标签）" },
          },
          required: ["url"],
        },
      },
      {
        name: "get_page_info",
        description: "获取当前页面的可访问性风格快照，包括可交互元素和可复用的 @eN 引用。structure=tree 时按语义容器（main/dialog/list 行等）分组缩进输出，适合同名元素消歧义或弹窗定位；默认平铺，token 更低。两种形态的 @eN 索引可互换。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            structure: { type: "string", enum: ["flat", "tree"], description: "页面表示形态，默认 flat" },
          },
          required: [],
        },
      },
      {
        name: "get_page_text",
        description: "读取页面正文纯文本，不执行任意页面 JavaScript",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            maxChars: { type: "number", description: "返回的最大字符数，默认 50000，最大 200000" },
          },
          required: [],
        },
      },
      {
        name: "click",
        description: "等待目标可操作后点击。支持 CSS、get_page_info 返回的 @eN、text=文本、role=button[name=\"文本\"]。可选 intent 启用选择器缓存：同站点同 intent 命中缓存时无需先观察页面。",
        inputSchema: {
          type: "object" as const,
          properties: {
            selector: { type: "string", description: "CSS、@eN、text=文本或 role=button[name=\"文本\"]；提供 intent 且缓存命中时可省略" },
            intent: { type: "string", description: "站点内稳定的操作意图标识（小写字母/数字/./_/-，如 search-button），用于 (站点, intent) 选择器缓存。缓存按站点共享、不区分页面路径，intent 应表达全站唯一语义；页面专属操作请把页面编进名称（如 settings.save-button）" },
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            timeoutMs: { type: "number", description: "等待目标可操作的毫秒数，默认 10000" },
          },
          required: [],
        },
      },
      {
        name: "type",
        description: "等待目标可操作后清空并输入文本；支持 input、textarea 与 contenteditable。可选 intent 启用选择器缓存：同站点同 intent 命中缓存时无需先观察页面。",
        inputSchema: {
          type: "object" as const,
          properties: {
            selector: { type: "string", description: "CSS、@eN、text=文本或 role=textbox[name=\"文本\"]；提供 intent 且缓存命中时可省略" },
            intent: { type: "string", description: "站点内稳定的操作意图标识（小写字母/数字/./_/-，如 search-input），用于 (站点, intent) 选择器缓存。缓存按站点共享、不区分页面路径，intent 应表达全站唯一语义；页面专属操作请把页面编进名称（如 profile.nickname-input）" },
            text: { type: "string", description: "要输入的文本" },
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            timeoutMs: { type: "number", description: "等待目标可操作的毫秒数，默认 10000" },
          },
          required: ["text"],
        },
      },
      {
        name: "wait_for",
        description: "等待页面元素达到指定状态，并在超时时返回可诊断的页面快照。",
        inputSchema: {
          type: "object" as const,
          properties: {
            selector: { type: "string", description: "CSS、@eN、text=文本或 role=… 定位器" },
            state: { type: "string", enum: ["visible", "attached", "hidden"], description: "默认 visible" },
            timeoutMs: { type: "number", description: "超时毫秒数，默认 10000，最大 30000" },
            stableMs: { type: "number", description: "元素位置尺寸稳定多久才返回，默认 150" },
            tabId: { type: "number", description: "目标标签页 ID（可选）" }
          },
          required: ["selector"]
        }
      },
      {
        name: "screenshot",
        description: "截取当前可见页面截图，返回 base64 PNG",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
          },
          required: [],
        },
      },
      {
        name: "get_resources",
        description: "通过 Performance Resource Timing API 获取页面加载的资源列表（如真实图片 URL），无需执行任意 JavaScript。适用于豆包等 img.src 为 SVG 占位符的场景。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            type: { type: "string", enum: ["image", "all"], description: "筛选资源类型，image 仅返回图片资源，all 返回全部。默认 image" },
            minSize: { type: "number", description: "最小传输字节数阈值，过滤小体积占位资源" },
            urlContains: { type: "string", description: "URL 子串过滤，仅返回包含该子串的资源" },
            since: { type: "number", description: "只返回 startTime 大于该值的资源（毫秒），用于获取最近加载的资源" },
          },
          required: [],
        },
      },
      {
        name: "evaluate",
        description: "在页面上下文中安全地执行 JS 表达式并返回可序列化结果。有安全护栏：禁用 eval/fetch/XMLHttpRequest/cookie 等，表达式最大 2000 字符。适用于读取页面变量、计算动态属性等场景。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            expression: { type: "string", description: "要执行的 JS 表达式（非语句），如 'document.querySelectorAll(\"img\").length' 或 'performance.now()'" },
            globals: { type: "array", items: { type: "string" }, description: "额外的全局变量白名单，如 ['crypto', 'URL']" },
            timeoutMs: { type: "number", description: "超时毫秒数，默认 3000，最大 10000" },
          },
          required: ["expression"],
        },
      },
      {
        name: "extract_table",
        description: "从页面中提取 HTML 表格数据，返回结构化的 headers 和 rows。声明式操作，不执行任意 JS。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            selector: { type: "string", description: "表格的 CSS 选择器，默认 'table'" },
            header: { type: "string", description: "表头单元格选择器，默认 'thead th, tr:first-child th'" },
            rows: { type: "string", description: "数据行选择器，默认 'tbody tr'" },
            cells: { type: "string", description: "单元格选择器，默认 'td'" },
            limit: { type: "number", description: "最大行数，默认 100，最大 500" },
          },
          required: [],
        },
      },
      {
        name: "start_network_capture",
        description: "通过 Chrome DevTools Protocol Network 域开始监听标签页的所有网络请求。捕获所有资源加载（图片、API 响应、fetch 等），比 Performance API 更全面。需要 debugger 权限。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            type: { type: "string", enum: ["image", "all"], description: "筛选类型，image 仅捕获图片，all 捕获全部。默认 all" },
            urlContains: { type: "string", description: "URL 子串过滤" },
            mimeType: { type: "string", description: "MIME 类型子串过滤，如 'image/'" },
          },
          required: [],
        },
      },
      {
        name: "stop_network_capture",
        description: "停止标签页的网络请求监听，分离 CDP debugger。应在 start_network_capture 后、完成数据采集时调用。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
          },
          required: [],
        },
      },
      {
        name: "get_network_resources",
        description: "读取 CDP 网络捕获到的资源列表。需先调用 start_network_capture。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            urlContains: { type: "string", description: "URL 子串过滤" },
            mimeType: { type: "string", description: "MIME 类型子串过滤" },
            type: { type: "string", description: "CDP 资源类型过滤，如 Image、Fetch、XHR、Script 等" },
            minStatus: { type: "number", description: "最小 HTTP 状态码，如 200" },
            limit: { type: "number", description: "返回最大条数，默认 100，最大 500" },
          },
          required: [],
        },
      },
      {
        name: "hover",
        description: "在指定元素上触发鼠标悬停事件（mouseover/mouseenter/mousemove）。适用于下拉菜单、工具提示等 hover 交互场景。",
        inputSchema: {
          type: "object" as const,
          properties: {
            selector: { type: "string", description: "CSS、@eN、text=文本或 role=… 定位器" },
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
          },
          required: ["selector"],
        },
      },
      {
        name: "press_key",
        description: "在指定元素上模拟按键。支持 Enter、Escape、Tab、Space、ArrowUp/Down/Left/Right、Backspace、Delete 等特殊键。Enter 在表单元素上会触发提交。",
        inputSchema: {
          type: "object" as const,
          properties: {
            key: { type: "string", description: "按键名称，如 Enter、Escape、Tab、Space、ArrowDown 等" },
            selector: { type: "string", description: "目标元素定位器（可选，默认当前焦点元素）" },
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
          },
          required: ["key"],
        },
      },
      {
        name: "scroll",
        description: "滚动页面。支持三种模式：滚动到指定元素（selector）、按方向滚动（direction）、滚动到绝对坐标（x/y）。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            selector: { type: "string", description: "滚动到该元素（与 direction/x,y 互斥）" },
            direction: { type: "string", enum: ["up", "down", "left", "right"], description: "按方向滚动（与 selector 互斥）" },
            amount: { type: "number", description: "方向滚动的像素量，默认 300" },
            x: { type: "number", description: "绝对横坐标" },
            y: { type: "number", description: "绝对纵坐标" },
            smooth: { type: "boolean", description: "是否使用平滑滚动，默认 false" },
            block: { type: "string", enum: ["start", "center", "end", "nearest"], description: "scrollIntoView 的 block 对齐，默认 center" },
          },
          required: [],
        },
      },
      {
        name: "select_option",
        description: "设置 <select> 下拉框的选中值。支持按 value、按文本、按标签匹配，以及模糊匹配。",
        inputSchema: {
          type: "object" as const,
          properties: {
            selector: { type: "string", description: "select 元素的定位器" },
            value: { type: "string", description: "要选中的值或文本" },
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            byLabel: { type: "boolean", description: "按 option 标签文本匹配（包含匹配）" },
            byText: { type: "boolean", description: "按 option 文本精确匹配" },
            fuzzy: { type: "boolean", description: "模糊匹配，当精确匹配失败时启用" },
          },
          required: ["selector", "value"],
        },
      },
      {
        name: "drag_drop",
        description: "从源元素拖拽到目标元素。同时触发 HTML5 拖拽事件和鼠标事件，兼容大多数拖拽库。",
        inputSchema: {
          type: "object" as const,
          properties: {
            fromSelector: { type: "string", description: "源元素定位器" },
            toSelector: { type: "string", description: "目标元素定位器" },
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
          },
          required: ["fromSelector", "toSelector"],
        },
      },
      {
        name: "wait_for_dynamic",
        description: "使用 MutationObserver 等待 SPA 动态内容出现。比 wait_for 更适合异步渲染场景，支持等待元素出现、文本出现、元素数量达标、网络空闲。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            selector: { type: "string", description: "等待该 CSS 选择器匹配的元素出现" },
            textContains: { type: "string", description: "等待页面包含该文本" },
            minElementCount: { type: "number", description: "等待可交互元素数量达到该值" },
            networkIdle: { type: "boolean", description: "等待 DOM 变更停止 800ms（网络空闲）" },
            timeoutMs: { type: "number", description: "超时毫秒数，默认 10000，最大 30000" },
          },
          required: [],
        },
      },
      {
        name: "iframe_action",
        description: "操作同源 iframe 内的内容。支持 getText（读取文本）、query（查询元素）、click（点击元素）。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            action: { type: "string", enum: ["getText", "query", "click"], description: "要执行的操作" },
            iframeSelector: { type: "string", description: "iframe 的 CSS 选择器（可选，默认第一个同源 iframe）" },
            iframeIndex: { type: "number", description: "iframe 索引（可选，从 0 开始）" },
            selector: { type: "string", description: "iframe 内的目标元素选择器（query/click 时使用）" },
          },
          required: ["action"],
        },
      },
      {
        name: "upload_file",
        description: "通过 CDP 向 <input type=\"file\"> 元素上传文件。需提供文件的本地绝对路径。",
        inputSchema: {
          type: "object" as const,
          properties: {
            selector: { type: "string", description: "file input 的 CSS 选择器（可选，默认 input[type=\"file\"]）" },
            filePath: { type: "string", description: "要上传的文件的本地绝对路径" },
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
          },
          required: ["filePath"],
        },
      },
      {
        name: "handle_dialog",
        description: "处理浏览器弹窗（alert/confirm/prompt）。通过 CDP Page.handleJavaScriptDialog 实现。action 设为 'dismiss' 拒绝，其他值接受并可选填 promptText。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            action: { type: "string", description: "dismiss 拒绝弹窗；accept 接受弹窗；其他字符串作为 prompt 的输入文本接受" },
          },
          required: ["action"],
        },
      },
      {
        name: "download_file",
        description: "通过浏览器下载 API 下载文件到本地下载目录。使用浏览器的登录态，可下载需要认证的资源。",
        inputSchema: {
          type: "object" as const,
          properties: {
            url: { type: "string", description: "要下载的文件 URL" },
            filename: { type: "string", description: "保存的文件名（可选，默认使用 URL 中的文件名）" },
            tabId: { type: "number", description: "目标标签页 ID（可选，仅用于审计）" },
          },
          required: ["url"],
        },
      },
      {
        name: "reload",
        description: "刷新当前页面。可选择绕过缓存强制刷新。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            bypassCache: { type: "boolean", description: "是否绕过缓存（Ctrl+Shift+R 效果），默认 false" },
          },
          required: [],
        },
      },
      {
        name: "go_back_forward",
        description: "浏览器历史导航：前进或后退。当已到达历史边界时返回错误。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            direction: { type: "string", enum: ["back", "forward"], description: "back 后退，forward 前进" },
          },
          required: ["direction"],
        },
      },
      {
        name: "get_url",
        description: "获取当前页面的 URL、标题和 favicon。轻量级工具，不注入页面脚本。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
          },
          required: [],
        },
      },
      {
        name: "full_page_screenshot",
        description: "截取整个可滚动页面的完整截图（非仅可见区域）。通过 CDP captureBeyondViewport 实现。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
          },
          required: [],
        },
      },
      {
        name: "element_screenshot",
        description: "截取指定元素的截图。先定位元素获取边界，再通过 CDP clip 参数截取该区域。",
        inputSchema: {
          type: "object" as const,
          properties: {
            selector: { type: "string", description: "目标元素定位器（CSS、@eN、text= 等）" },
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
          },
          required: ["selector"],
        },
      },
      {
        name: "get_console_logs",
        description: "捕获页面的 JavaScript 控制台日志。通过 CDP Runtime.consoleAPICalled 和 Log.entryAdded 事件监听。持续指定时长后返回所有捕获的日志。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            duration: { type: "number", description: "捕获时长（毫秒），默认 3000，最大 10000" },
          },
          required: [],
        },
      },
      {
        name: "shadow_dom_action",
        description: "操作 Shadow DOM 内的元素。支持 query（查询）、click（点击）、getText（读取文本）、type（输入文本）。可自动穿透所有 shadow root 查找元素。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            action: { type: "string", enum: ["query", "click", "getText", "type"], description: "要执行的操作" },
            hostSelector: { type: "string", description: "Shadow host 的 CSS 选择器（可选，不填则自动搜索所有 shadow root）" },
            innerSelector: { type: "string", description: "Shadow DOM 内的目标元素选择器" },
            selector: { type: "string", description: "innerSelector 的别名" },
            text: { type: "string", description: "type 操作要输入的文本" },
          },
          required: ["action"],
        },
      },
      {
        name: "set_viewport",
        description: "设置视口大小和设备模拟参数。可模拟移动设备、设置 DPR、启用触摸事件。也可同时覆盖 User-Agent。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            width: { type: "number", description: "视口宽度（像素），默认 1280" },
            height: { type: "number", description: "视口高度（像素），默认 800" },
            deviceScaleFactor: { type: "number", description: "设备像素比，默认 1" },
            mobile: { type: "boolean", description: "是否模拟移动设备，默认 false" },
            touch: { type: "boolean", description: "是否启用触摸事件模拟，默认 false" },
            userAgent: { type: "string", description: "同时设置 User-Agent（可选）" },
          },
          required: [],
        },
      },
      {
        name: "set_user_agent",
        description: "覆盖浏览器的 User-Agent 字符串。会影响后续所有网络请求和 JS navigator.userAgent。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            userAgent: { type: "string", description: "要设置的 User-Agent 字符串" },
          },
          required: ["userAgent"],
        },
      },
      {
        name: "save_pdf",
        description: "将当前页面保存为 PDF。通过 CDP Page.printToPDF 实现。可指定文件名保存到下载目录，或返回 base64 数据。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            filename: { type: "string", description: "保存文件名（带或不带 .pdf 后缀）。不填则返回 base64 数据。" },
            landscape: { type: "boolean", description: "横向打印，默认 false" },
            printBackground: { type: "boolean", description: "打印背景色，默认 true" },
            scale: { type: "number", description: "缩放比例，默认 1" },
            paperWidth: { type: "number", description: "纸张宽度（英寸），默认 8.5" },
            paperHeight: { type: "number", description: "纸张高度（英寸），默认 11" },
            marginTop: { type: "number", description: "上边距（英寸），默认 0.4" },
            marginBottom: { type: "number", description: "下边距（英寸），默认 0.4" },
            marginLeft: { type: "number", description: "左边距（英寸），默认 0.4" },
            marginRight: { type: "number", description: "右边距（英寸），默认 0.4" },
            displayHeaderFooter: { type: "boolean", description: "显示页眉页脚，默认 false" },
          },
          required: [],
        },
      },
      {
        name: "set_geolocation",
        description: "覆盖浏览器的地理位置。通过 CDP Emulation.setGeolocationOverride 实现。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            latitude: { type: "number", description: "纬度" },
            longitude: { type: "number", description: "经度" },
            accuracy: { type: "number", description: "精度（米），默认 100" },
          },
          required: ["latitude", "longitude"],
        },
      },
      {
        name: "set_network_throttle",
        description: "模拟网络条件：限速、离线或恢复正常。通过 CDP Network.emulateNetworkConditions 实现。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            offline: { type: "boolean", description: "设为离线模式" },
            reset: { type: "boolean", description: "恢复正常网络条件" },
            latency: { type: "number", description: "额外延迟（毫秒），默认 100" },
            downloadKbps: { type: "number", description: "下载速率（kbps），默认 1000" },
            uploadKbps: { type: "number", description: "上传速率（kbps），默认 500" },
          },
          required: [],
        },
      },
      {
        name: "set_timezone",
        description: "覆盖浏览器的时区。通过 CDP Emulation.setTimezoneOverride 实现。如 'Asia/Shanghai'、'America/New_York'。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            timezone: { type: "string", description: "IANA 时区标识符，如 'Asia/Shanghai'" },
          },
          required: ["timezone"],
        },
      },
      {
        name: "get_cookies",
        description: "获取当前页面关联的 Cookie 列表。可按名称、域名、路径筛选。通过 chrome.cookies API 实现。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            name: { type: "string", description: "按 Cookie 名称筛选" },
            domain: { type: "string", description: "按域名筛选" },
            path: { type: "string", description: "按路径筛选" },
            secure: { type: "boolean", description: "仅返回安全 Cookie" },
            session: { type: "boolean", description: "仅返回会话 Cookie" },
          },
          required: [],
        },
      },
      {
        name: "get_all_cookies",
        description: "获取浏览器中所有 Cookie（跨域）。会自动过滤到当前页面相关的域名。用于审计或排查登录态问题。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选，用于确定当前域名）" },
          },
          required: [],
        },
      },
      {
        name: "set_cookie",
        description: "设置或修改 Cookie。可指定名称、值、域名、路径、过期时间、安全/HttpOnly/SameSite 属性。不指定域名时自动使用当前页面域名。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            name: { type: "string", description: "Cookie 名称" },
            value: { type: "string", description: "Cookie 值" },
            url: { type: "string", description: "关联 URL（可选，默认当前页面）" },
            domain: { type: "string", description: "域名（可选，默认当前页面域名）" },
            path: { type: "string", description: "路径，默认 /" },
            secure: { type: "boolean", description: "是否仅 HTTPS 传输" },
            httpOnly: { type: "boolean", description: "是否 HttpOnly" },
            sameSite: { type: "string", enum: ["no_restriction", "lax", "strict", "unspecified"], description: "SameSite 策略" },
            expirationDate: { type: "number", description: "过期时间（Unix 时间戳，秒）。不填为会话 Cookie。" },
          },
          required: ["name", "value"],
        },
      },
      {
        name: "delete_cookie",
        description: "删除指定 Cookie。需提供 Cookie 名称，域名默认为当前页面。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            name: { type: "string", description: "要删除的 Cookie 名称" },
            url: { type: "string", description: "关联 URL（可选，默认当前页面）" },
            domain: { type: "string", description: "域名（可选）" },
          },
          required: ["name"],
        },
      },
      {
        name: "execute_js",
        description: "Deprecated: arbitrary page JavaScript is disabled. Use inspect or probe_selector instead.",
        inputSchema: {
          type: "object" as const,
          properties: {
            script: { type: "string", description: "Deprecated and ignored." },
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
          },
          required: ["script"],
        },
      },
      {
        name: "list_tabs",
        description: "列出当前浏览器中所有标签页",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
      {
        name: "inspect",
        description: "Inspect page controls without arbitrary page JavaScript. Returns stable @wpN references, bounds, and compact hints for semantic and unnamed clickable controls.",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number" },
            scope: { type: "string", enum: ["page", "focused", "composer"], description: "Use focused or composer to inspect controls near the active editor." },
            includeUnnamed: { type: "boolean", description: "Include visible controls without accessible names. Defaults to true." },
            clickableOnly: { type: "boolean", description: "Restrict results to likely actionable controls. Defaults to true." },
            maxCandidates: { type: "number", description: "Maximum candidates, 1-100; defaults to 30." },
          },
          required: [],
        },
      },
      {
        name: "probe_selector",
        description: "Check a CSS, text, role, @eN, or @wpN locator once without waiting. Returns a match result, compact element metadata, or diagnostics.",
        inputSchema: {
          type: "object" as const,
          properties: { selector: { type: "string" }, tabId: { type: "number" } },
          required: ["selector"],
        },
      },
      {
        name: "click_at",
        description: "Click the visible actionable control at viewport coordinates returned by inspect or a fresh screenshot. Subject to the extension's read-only policy.",
        inputSchema: {
          type: "object" as const,
          properties: { x: { type: "number" }, y: { type: "number" }, tabId: { type: "number" } },
          required: ["x", "y"],
        },
      },
      {
        name: "list_adapters",
        description: "列出当前页面可用的只读站点适配器。",
        inputSchema: { type: "object" as const, properties: { tabId: { type: "number" } }, required: [] }
      },
      {
        name: "extract_with_adapter",
        description: "使用预置只读适配器直接返回结构化 JSON，避免向 Agent 发送整页 DOM。",
        inputSchema: { type: "object" as const, properties: { adapterId: { type: "string" }, tabId: { type: "number" } }, required: ["adapterId"] }
      },
      {
        name: "extract_with_best_adapter",
        description: "按域名和路径自动选择最具体的只读适配器；提取失败时降级到通用页面摘要，并返回降级证据。",
        inputSchema: { type: "object" as const, properties: { tabId: { type: "number" } }, required: [] }
      },
      {
        name: "get_adapter_health",
        description: "查看各只读适配器的调用量、成功率、耗时和最近错误，用于发现 DOM 变化。",
        inputSchema: { type: "object" as const, properties: {}, required: [] }
      },
      {
        name: "get_selector_cache",
        description: "查看 (站点, intent) 选择器缓存条目与健康度（命中/失败/禁用状态/平均耗时），用于排查失效缓存。",
        inputSchema: { type: "object" as const, properties: { host: { type: "string", description: "只看指定站点（可选）" } }, required: [] }
      },
      {
        name: "get_action_log",
        description: "读取最近浏览器操作的时间线、耗时和错误信息，并附带本进程角色（leader/follower）与会话状态；不会包含输入文本或执行脚本。",
        inputSchema: { type: "object" as const, properties: { limit: { type: "number", description: "最多返回条数，默认 20，最大 100" } }, required: [] }
      },
      {
        name: "cleanup_sessions",
        description: "清理浏览器中的 WebPilot 会话标签组。默认只关闭闲置（idle）组；可指定 sessionId 定向清理。",
        inputSchema: { type: "object" as const, properties: {
          onlyIdle: { type: "boolean", description: "仅清理闲置组，默认 true；为 false 时连同非活跃的 active 组一起清理" },
          sessionId: { type: "string", description: "只清理指定 sessionId 的标签组（可选）" }
        }, required: [] }
      },
      {
        name: "start_task",
        description: "创建确定性浏览器任务会话，并记录初始页面观察和证据日志。",
        inputSchema: { type: "object" as const, properties: {
          goal: { type: "string", description: "任务目标" },
          tabId: { type: "number", description: "目标标签页 ID（可选）" },
          maxSteps: { type: "number", description: "最大单步动作数，默认 30，最大 100" }
        }, required: ["goal"] }
      },
      {
        name: "observe_task",
        description: "刷新任务页面观察。任何页面跳转或验证失败后，应先调用此工具再决定下一步。",
        inputSchema: { type: "object" as const, properties: { taskId: { type: "string" } }, required: ["taskId"] }
      },
      {
        name: "run_task_step",
        description: "在任务会话中执行恰好一个动作，随后强制重新观察页面并运行循环检测。",
        inputSchema: { type: "object" as const, properties: {
          taskId: { type: "string" },
          action: { type: "string", enum: ["navigate", "click", "type", "wait"] },
          url: { type: "string", description: "navigate 所需" },
          selector: { type: "string", description: "click/type/wait 所需" },
          text: { type: "string", description: "type 所需" },
          state: { type: "string", enum: ["visible", "attached", "hidden"], description: "wait 状态，默认 visible" },
          timeoutMs: { type: "number" }
        }, required: ["taskId", "action"] }
      },
      {
        name: "verify_task_step",
        description: "执行确定性任务验证。kind 支持 url_includes、url_equals、title_includes、text_present、text_absent、locator_visible、locator_hidden、interactive_count_at_least。",
        inputSchema: { type: "object" as const, properties: {
          taskId: { type: "string" },
          kind: { type: "string" },
          value: { type: ["string", "number"] as any },
          selector: { type: "string" },
          completeOnPass: { type: "boolean", description: "通过后将任务标记完成，默认 false" }
        }, required: ["taskId", "kind"] }
      },
      {
        name: "cancel_task",
        description: "取消任务会话；不会关闭浏览器标签页。",
        inputSchema: { type: "object" as const, properties: { taskId: { type: "string" }, reason: { type: "string" } }, required: ["taskId"] }
      },
      {
        name: "resume_task",
        description: "恢复 paused 状态的任务并重新观察页面。典型场景：任务因跳转到登录页暂停，人工在浏览器完成登录后调用此工具继续；返回 stillOnLoginPage 指示是否仍在登录页。",
        inputSchema: { type: "object" as const, properties: { taskId: { type: "string" } }, required: ["taskId"] }
      },
      {
        name: "get_task",
        description: "获取任务状态、最新页面指纹和暂停原因。",
        inputSchema: { type: "object" as const, properties: { taskId: { type: "string" } }, required: ["taskId"] }
      },
      {
        name: "get_task_log",
        description: "读取任务的结构化证据日志。输入文本不会写入日志。",
        inputSchema: { type: "object" as const, properties: { taskId: { type: "string" }, limit: { type: "number" } }, required: ["taskId"] }
      },
      {
        name: "create_task_checkpoint",
        description: "保存任务的软检查点（URL 和页面指纹）。不会保存或回滚表单内容。",
        inputSchema: { type: "object" as const, properties: { taskId: { type: "string" }, label: { type: "string" } }, required: ["taskId"] }
      },
      {
        name: "restore_task_checkpoint",
        description: "导航回软检查点 URL 并重新观察页面；返回 URL/指纹是否匹配。",
        inputSchema: { type: "object" as const, properties: { taskId: { type: "string" }, checkpointId: { type: "string" } }, required: ["taskId", "checkpointId"] }
      },
      {
        name: "set_task_plan",
        description: "保存 Agent 制定的结构化计划。每项 steps 必须有 action（navigate/click/type/wait），可带 verification 断言。",
        inputSchema: { type: "object" as const, properties: { taskId: { type: "string" }, name: { type: "string" }, steps: { type: "array", items: { type: "object" } } }, required: ["taskId", "steps"] }
      },
      {
        name: "run_planned_step",
        description: "执行当前计划中的一个动作；有 verification 时自动验证，验证通过才推进到下一计划项。",
        inputSchema: { type: "object" as const, properties: { taskId: { type: "string" } }, required: ["taskId"] }
      },
      {
        name: "advance_task_plan",
        description: "在外部验证已通过后，手动推进当前计划项。",
        inputSchema: { type: "object" as const, properties: { taskId: { type: "string" } }, required: ["taskId"] }
      },
      {
        name: "save_task_as_workflow",
        description: "将已完成且有计划的任务保存为可复用工作流。输入动作必须使用 {{parameter}}，不会保存字面输入文本。",
        inputSchema: { type: "object" as const, properties: { taskId: { type: "string" }, name: { type: "string" } }, required: ["taskId"] }
      },
      {
        name: "list_workflows",
        description: "列出本地已沉淀的可复用工作流。",
        inputSchema: { type: "object" as const, properties: {}, required: [] }
      },
      {
        name: "recommend_workflows",
        description: "按当前页面域名推荐已验证的本地工作流经验；只推荐，不执行。",
        inputSchema: { type: "object" as const, properties: { tabId: { type: "number" } }, required: [] }
      },
      {
        name: "start_workflow",
        description: "以参数实例化已保存工作流，创建新任务并加载其计划。",
        inputSchema: { type: "object" as const, properties: { workflowId: { type: "string" }, parameters: { type: "object" }, tabId: { type: "number" }, maxSteps: { type: "number" } }, required: ["workflowId"] }
      },
    ],
  };
});

// 工具调用处理
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = request.params.arguments ?? {};

  try {
    let result: any;

    switch (name) {
      case "navigate":
        result = await sendToExtension("navigate", { url: args.url, tabId: args.tabId });
        return {
          content: [{ type: "text", text: `导航成功: ${result.title}\nURL: ${result.url}\n标签页ID: ${result.tabId}` }],
        };

      case "get_page_info": {
        const structure = args.structure === "tree" ? "tree" : "flat";
        result = await sendToExtension("getPageInfo", { tabId: args.tabId, structure });
        const header = `页面: ${result.title}\nURL: ${result.url}\n状态: ${result.readyState}\n可交互元素数: ${result.elementCount}`;
        if (structure === "tree") {
          const treeLines = formatPageTree(result.tree).join("\n") || "无";
          return {
            content: [{ type: "text", text: `${header}\n\n元素按语义容器分组（@eN 仅在页面未变化时有效）：\n${treeLines}` }],
          };
        }
        const elements = result.interactiveElements
          ?.map((e: any) => formatElementLine(e))
          .join("\n") || "无";
        return {
          content: [{ type: "text", text: `${header}\n\n前60个元素（@eN 仅在页面未变化时有效）：\n${elements}` }],
        };
      }

      case "inspect":
        result = await sendToExtension("inspect", {
          tabId: args.tabId,
          options: {
            scope: args.scope,
            includeUnnamed: args.includeUnnamed,
            clickableOnly: args.clickableOnly,
            maxCandidates: typeof args.maxCandidates === "number" ? Math.max(1, Math.min(Math.floor(args.maxCandidates), 100)) : undefined,
          },
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "probe_selector":
        result = await sendToExtension("probeSelector", { selector: args.selector, tabId: args.tabId });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: result.matched !== true };

      case "click_at":
        result = await sendToExtension("clickAt", { x: args.x, y: args.y, tabId: args.tabId });
        return {
          content: [{ type: "text", text: result.success
            ? `Clicked at (${args.x}, ${args.y}): <${result.tagName}> ${result.text || ""}`
            : `Click at (${args.x}, ${args.y}) failed: ${result.error}` }],
          isError: !result.success,
        };

      case "get_page_text":
        result = await sendToExtension("getPageText", {
          tabId: args.tabId,
          maxChars: typeof args.maxChars === "number" ? Math.max(1_000, Math.min(Math.floor(args.maxChars), 200_000)) : 50_000,
        });
        return {
          content: [{ type: "text", text: `页面: ${result.title}\nURL: ${result.url}\n字符数: ${result.characterCount}${result.truncated ? "（已截断）" : ""}\n\n${result.text}` }],
        };

      case "click": {
        const { result: clickResult, notes: clickNotes, cacheError: clickCacheError } = await performWithSelectorCache("click", args);
        if (clickCacheError) return { content: [{ type: "text", text: [`点击失败: ${clickCacheError}`, ...clickNotes].join("\n") }], isError: true };
        result = clickResult;
        const clickText = result.success
          ? `点击成功: <${result.tagName}> ${result.text || ""}\n耗时: ${result.diagnostics?.durationMs ?? "?"}ms`
          : `点击失败: ${result.error}`;
        return { content: [{ type: "text", text: [clickText, ...clickNotes].join("\n") }] };
      }

      case "type": {
        const { result: typeResult, notes: typeNotes, cacheError: typeCacheError } = await performWithSelectorCache("type", args);
        if (typeCacheError) return { content: [{ type: "text", text: [`输入失败: ${typeCacheError}`, ...typeNotes].join("\n") }], isError: true };
        result = typeResult;
        const typeText = result.success
          ? `输入成功: <${result.tagName}>\n耗时: ${result.diagnostics?.durationMs ?? "?"}ms`
          : `输入失败: ${result.error}`;
        return { content: [{ type: "text", text: [typeText, ...typeNotes].join("\n") }] };
      }

      case "wait_for":
        result = await sendToExtension("waitFor", {
          selector: args.selector,
          state: args.state || "visible",
          tabId: args.tabId,
          timeoutMs: normalizeTimeout(args.timeoutMs),
          stableMs: typeof args.stableMs === "number" ? Math.max(0, Math.min(args.stableMs, 5000)) : 150
        });
        return { content: [{ type: "text", text: result.success
          ? `等待完成: ${result.state}，${result.attempts} 次检查，耗时 ${result.durationMs}ms`
          : `等待失败: ${result.error}\n诊断: ${JSON.stringify(result.diagnostics)}` }], isError: !result.success };

      case "screenshot":
        result = await sendToExtension("screenshot", { tabId: args.tabId });
        if (result.success && result.data) {
          return {
            content: [
              { type: "text", text: "截图已捕获" },
              { type: "image", data: result.data, mimeType: "image/png" },
            ],
          };
        }
        return { content: [{ type: "text", text: `截图失败: ${result.error}` }] };

      case "get_resources":
        result = await sendToExtension("getResources", {
          tabId: args.tabId,
          options: {
            type: args.type === "all" ? "all" : "image",
            minSize: typeof args.minSize === "number" ? args.minSize : undefined,
            urlContains: typeof args.urlContains === "string" ? args.urlContains : undefined,
            since: typeof args.since === "number" ? args.since : undefined,
          },
        });
        const resourceList = result.resources?.map((r: any) =>
          `${r.url}\n  size: ${r.transferSize}B, type: ${r.initiatorType}, startTime: ${r.startTime}ms`
        ).join("\n") || "无";
        return {
          content: [{ type: "text", text: `页面: ${result.title}\nURL: ${result.url}\n资源数: ${result.count}\n\n${resourceList}` }],
        };

      case "evaluate":
        result = await sendToExtension("evaluate", {
          tabId: args.tabId,
          expression: args.expression,
          options: {
            globals: Array.isArray(args.globals) ? args.globals : [],
            timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
          },
        });
        return {
          content: [{ type: "text", text: result.error
            ? `执行失败: ${result.error}`
            : `结果 (${result.type}): ${JSON.stringify(result.result, null, 2)}` }],
          isError: Boolean(result.error),
        };

      case "extract_table":
        result = await sendToExtension("extractTable", {
          tabId: args.tabId,
          spec: {
            selector: typeof args.selector === "string" ? args.selector : undefined,
            header: typeof args.header === "string" ? args.header : undefined,
            rows: typeof args.rows === "string" ? args.rows : undefined,
            cells: typeof args.cells === "string" ? args.cells : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
          },
        });
        const table = result.data?.table;
        if (!table) return { content: [{ type: "text", text: `提取失败: ${result.error || "未知错误"}` }], isError: true };
        const headerStr = table.headers?.join(" | ") || "(无表头)";
        const rowStr = table.rows?.map((r: any[]) => r.join(" | ")).join("\n") || "(无数据)";
        return {
          content: [{ type: "text", text: `表格提取成功\n行数: ${table.rowCount}, 列数: ${table.columnCount}\n\n表头: ${headerStr}\n\n${rowStr}` }],
          isError: Boolean(table.error),
        };

      case "start_network_capture":
        result = await sendToExtension("startNetworkCapture", {
          tabId: args.tabId,
          filter: {
            type: args.type === "image" ? "image" : "all",
            urlContains: typeof args.urlContains === "string" ? args.urlContains : undefined,
            mimeType: typeof args.mimeType === "string" ? args.mimeType : undefined,
          },
        });
        return { content: [{ type: "text", text: result.success ? `网络捕获已启动 (tabId: ${result.tabId})` : `启动失败: ${result.error}` }], isError: !result.success };

      case "stop_network_capture":
        result = await sendToExtension("stopNetworkCapture", { tabId: args.tabId });
        return { content: [{ type: "text", text: result.success ? `网络捕获已停止 (tabId: ${result.tabId})` : `停止失败: ${result.error}` }], isError: !result.success };

      case "get_network_resources":
        result = await sendToExtension("getNetworkResources", {
          tabId: args.tabId,
          options: {
            urlContains: typeof args.urlContains === "string" ? args.urlContains : undefined,
            mimeType: typeof args.mimeType === "string" ? args.mimeType : undefined,
            type: typeof args.type === "string" ? args.type : undefined,
            minStatus: typeof args.minStatus === "number" ? args.minStatus : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
          },
        });
        const netResources = result.resources?.map((r: any) =>
          `[${r.status}] ${r.mimeType} ${r.type}\n  ${r.url}`
        ).join("\n") || "无";
        return {
          content: [{ type: "text", text: `网络资源\n已捕获: ${result.totalCaptured}, 返回: ${result.count}, 活跃: ${result.active}\n开始时间: ${result.startedAt}\n\n${netResources}` }],
          isError: !result.success,
        };

      case "hover":
        result = await sendToExtension("hover", { selector: args.selector, tabId: args.tabId });
        return { content: [{ type: "text", text: result.success ? `悬停成功: <${result.tagName}> ${result.text || ""}` : `悬停失败: ${result.error}` }], isError: !result.success };

      case "press_key":
        result = await sendToExtension("pressKey", { selector: args.selector, key: args.key, tabId: args.tabId });
        return { content: [{ type: "text", text: result.success ? `按键成功: ${result.key} on <${result.tagName}>` : `按键失败: ${result.error}` }], isError: !result.success };

      case "scroll":
        result = await sendToExtension("scroll", { tabId: args.tabId, options: {
          selector: typeof args.selector === "string" ? args.selector : undefined,
          direction: typeof args.direction === "string" ? args.direction : undefined,
          amount: typeof args.amount === "number" ? args.amount : undefined,
          x: typeof args.x === "number" ? args.x : undefined,
          y: typeof args.y === "number" ? args.y : undefined,
          smooth: args.smooth === true,
          block: typeof args.block === "string" ? args.block : undefined,
        }});
        return { content: [{ type: "text", text: result.success ? `滚动成功 (${result.mode})` : `滚动失败: ${result.error}` }], isError: !result.success };

      case "select_option":
        result = await sendToExtension("selectOption", {
          selector: args.selector, value: args.value, tabId: args.tabId,
          options: { byLabel: args.byLabel === true, byText: args.byText === true, fuzzy: args.fuzzy === true },
        });
        return { content: [{ type: "text", text: result.success
          ? `选择成功: value="${result.value}", text="${result.selectedText}", index=${result.selectedIndex}/${result.optionCount}`
          : `选择失败: ${result.error}` }], isError: !result.success };

      case "drag_drop":
        result = await sendToExtension("dragDrop", { fromSelector: args.fromSelector, toSelector: args.toSelector, tabId: args.tabId });
        return { content: [{ type: "text", text: result.success
          ? `拖拽成功: <${result.from?.tag}> → <${result.to?.tag}>`
          : `拖拽失败: ${result.error}` }], isError: !result.success };

      case "wait_for_dynamic":
        result = await sendToExtension("waitForDynamic", { tabId: args.tabId, options: {
          selector: typeof args.selector === "string" ? args.selector : undefined,
          textContains: typeof args.textContains === "string" ? args.textContains : undefined,
          minElementCount: typeof args.minElementCount === "number" ? args.minElementCount : undefined,
          networkIdle: args.networkIdle === true,
          timeoutMs: normalizeTimeout(args.timeoutMs),
        }});
        return { content: [{ type: "text", text: result.success
          ? `动态等待成功: ${result.reason}, 耗时 ${result.durationMs}ms`
          : `动态等待失败: ${result.error}` }], isError: !result.success };

      case "iframe_action":
        result = await sendToExtension("iframeAction", { tabId: args.tabId, options: {
          action: args.action,
          iframeSelector: typeof args.iframeSelector === "string" ? args.iframeSelector : undefined,
          iframeIndex: typeof args.iframeIndex === "number" ? args.iframeIndex : undefined,
          selector: typeof args.selector === "string" ? args.selector : undefined,
        }});
        if (result.action === 'getText') {
          return { content: [{ type: "text", text: `iframe (${result.iframeSrc})\n字符数: ${result.characterCount}\n\n${result.text}` }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "upload_file":
        result = await sendToExtension("uploadFile", { selector: args.selector, filePath: args.filePath, tabId: args.tabId });
        return { content: [{ type: "text", text: result.success ? `上传成功: ${result.filePath}` : `上传失败: ${result.error}` }], isError: !result.success };

      case "handle_dialog":
        result = await sendToExtension("handleDialog", { action: args.action, tabId: args.tabId });
        return { content: [{ type: "text", text: result.success ? result.message : `弹窗处理失败: ${result.error}` }], isError: !result.success };

      case "download_file":
        result = await sendToExtension("downloadFile", { url: args.url, filename: args.filename, tabId: args.tabId });
        return { content: [{ type: "text", text: result.success ? `下载已启动 (ID: ${result.downloadId})\nURL: ${result.url}\n文件名: ${result.filename || "(默认)"}` : `下载失败: ${result.error}` }], isError: !result.success };

      case "reload":
        result = await sendToExtension("reload", { bypassCache: args.bypassCache === true, tabId: args.tabId });
        return { content: [{ type: "text", text: result.success ? result.message : `刷新失败: ${result.error}` }], isError: !result.success };

      case "go_back_forward":
        result = await sendToExtension("goBackForward", { direction: args.direction, tabId: args.tabId });
        return { content: [{ type: "text", text: result.success ? `${args.direction === "back" ? "后退" : "前进"}成功 → ${result.url}` : `导航失败: ${result.error}` }], isError: !result.success };

      case "get_url":
        result = await sendToExtension("getURL", { tabId: args.tabId });
        return { content: [{ type: "text", text: result.success ? `URL: ${result.url}\n标题: ${result.title}` : `获取失败: ${result.error}` }], isError: !result.success };

      case "full_page_screenshot":
        result = await sendToExtension("fullPageScreenshot", { tabId: args.tabId });
        if (result.success) {
          return { content: [{ type: "image", data: result.data, mimeType: "image/png" }], isError: false };
        }
        return { content: [{ type: "text", text: `整页截图失败: ${result.error}` }], isError: true };

      case "element_screenshot":
        result = await sendToExtension("elementScreenshot", { selector: args.selector, tabId: args.tabId });
        if (result.success) {
          return { content: [{ type: "image", data: result.data, mimeType: "image/png" }], isError: false };
        }
        return { content: [{ type: "text", text: `元素截图失败: ${result.error}` }], isError: true };

      case "get_console_logs":
        result = await sendToExtension("getConsoleLogs", {
          tabId: args.tabId,
          options: { duration: typeof args.duration === "number" ? Math.min(args.duration, 10000) : 3000 },
        });
        if (result.success) {
          const logStr = result.logs?.map((l: any) =>
            `[${l.type}] ${Array.isArray(l.args) ? l.args.join(" ") : l.text || ""}${l.stackTrace ? "\n  " + l.stackTrace.join("\n  ") : ""}`
          ).join("\n") || "(无日志)";
          return { content: [{ type: "text", text: `控制台日志 (${result.count} 条, ${result.duration}ms)\n\n${logStr}` }] };
        }
        return { content: [{ type: "text", text: `日志捕获失败: ${result.error}` }], isError: true };

      case "shadow_dom_action":
        result = await sendToExtension("shadowDomAction", {
          tabId: args.tabId,
          options: {
            action: args.action,
            hostSelector: typeof args.hostSelector === "string" ? args.hostSelector : undefined,
            innerSelector: typeof args.innerSelector === "string" ? args.innerSelector : (typeof args.selector === "string" ? args.selector : undefined),
            text: typeof args.text === "string" ? args.text : undefined,
          },
        });
        if (result.action === "getText") {
          const textStr = result.hosts?.map((h: any) => `<${h.hostTag}${h.hostId ? " #" + h.hostId : ""}>: ${h.text}`).join("\n") || "(无文本)";
          return { content: [{ type: "text", text: `Shadow DOM 文本 (${result.shadowHostCount} 个 host)\n\n${textStr}` }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "set_viewport":
        result = await sendToExtension("setViewport", {
          tabId: args.tabId,
          options: {
            width: typeof args.width === "number" ? args.width : undefined,
            height: typeof args.height === "number" ? args.height : undefined,
            deviceScaleFactor: typeof args.deviceScaleFactor === "number" ? args.deviceScaleFactor : undefined,
            mobile: args.mobile === true,
            touch: args.touch === true,
            userAgent: typeof args.userAgent === "string" ? args.userAgent : undefined,
          },
        });
        return { content: [{ type: "text", text: result.success ? result.message : `设置失败: ${result.error}` }], isError: !result.success };

      case "set_user_agent":
        result = await sendToExtension("setUserAgent", { userAgent: args.userAgent, tabId: args.tabId });
        return { content: [{ type: "text", text: result.success ? result.message : `设置失败: ${result.error}` }], isError: !result.success };

      case "save_pdf":
        result = await sendToExtension("savePDF", {
          tabId: args.tabId,
          options: {
            landscape: args.landscape === true,
            printBackground: args.printBackground !== false,
            scale: typeof args.scale === "number" ? args.scale : undefined,
            paperWidth: typeof args.paperWidth === "number" ? args.paperWidth : undefined,
            paperHeight: typeof args.paperHeight === "number" ? args.paperHeight : undefined,
            marginTop: typeof args.marginTop === "number" ? args.marginTop : undefined,
            marginBottom: typeof args.marginBottom === "number" ? args.marginBottom : undefined,
            marginLeft: typeof args.marginLeft === "number" ? args.marginLeft : undefined,
            marginRight: typeof args.marginRight === "number" ? args.marginRight : undefined,
            displayHeaderFooter: args.displayHeaderFooter === true,
          },
          filename: typeof args.filename === "string" ? args.filename : undefined,
        });
        return { content: [{ type: "text", text: result.success ? result.message || "PDF 生成成功" : `PDF 生成失败: ${result.error}` }], isError: !result.success };

      case "set_geolocation":
        result = await sendToExtension("setGeolocation", {
          tabId: args.tabId,
          options: {
            latitude: args.latitude,
            longitude: args.longitude,
            accuracy: typeof args.accuracy === "number" ? args.accuracy : undefined,
          },
        });
        return { content: [{ type: "text", text: result.success ? result.message : `设置失败: ${result.error}` }], isError: !result.success };

      case "set_network_throttle":
        result = await sendToExtension("setNetworkThrottle", {
          tabId: args.tabId,
          options: {
            offline: args.offline === true,
            reset: args.reset === true,
            latency: typeof args.latency === "number" ? args.latency : undefined,
            downloadKbps: typeof args.downloadKbps === "number" ? args.downloadKbps : undefined,
            uploadKbps: typeof args.uploadKbps === "number" ? args.uploadKbps : undefined,
          },
        });
        return { content: [{ type: "text", text: result.success ? result.message : `设置失败: ${result.error}` }], isError: !result.success };

      case "set_timezone":
        result = await sendToExtension("setTimezone", { timezone: args.timezone, tabId: args.tabId });
        return { content: [{ type: "text", text: result.success ? result.message : `设置失败: ${result.error}` }], isError: !result.success };

      case "get_cookies":
        result = await sendToExtension("getCookies", {
          tabId: args.tabId,
          options: {
            name: typeof args.name === "string" ? args.name : undefined,
            domain: typeof args.domain === "string" ? args.domain : undefined,
            path: typeof args.path === "string" ? args.path : undefined,
            secure: typeof args.secure === "boolean" ? args.secure : undefined,
            session: typeof args.session === "boolean" ? args.session : undefined,
          },
        });
        if (result.success) {
          const cookieStr = result.cookies?.map((c: any) =>
            `${c.name}=${c.value}${c.domain ? ` (domain: ${c.domain})` : ""}${c.secure ? " [Secure]" : ""}${c.httpOnly ? " [HttpOnly]" : ""}${c.session ? " [Session]" : ` [expires: ${new Date(c.expirationDate * 1000).toISOString()}]`}`
          ).join("\n") || "(无 Cookie)";
          return { content: [{ type: "text", text: `Cookie (${result.count} 条, url: ${result.url})\n\n${cookieStr}` }] };
        }
        return { content: [{ type: "text", text: `获取失败: ${result.error}` }], isError: true };

      case "get_all_cookies":
        result = await sendToExtension("getAllCookies", { tabId: args.tabId });
        if (result.success) {
          const cookieStr = result.cookies?.map((c: any) =>
            `${c.name}=${c.value} (domain: ${c.domain})`
          ).join("\n") || "(无 Cookie)";
          return { content: [{ type: "text", text: `所有 Cookie (当前域: ${result.count}/${result.totalInBrowser})\n\n${cookieStr}` }] };
        }
        return { content: [{ type: "text", text: `获取失败: ${result.error}` }], isError: true };

      case "set_cookie":
        result = await sendToExtension("setCookie", {
          tabId: args.tabId,
          details: {
            name: args.name,
            value: args.value,
            url: typeof args.url === "string" ? args.url : undefined,
            domain: typeof args.domain === "string" ? args.domain : undefined,
            path: typeof args.path === "string" ? args.path : undefined,
            secure: typeof args.secure === "boolean" ? args.secure : undefined,
            httpOnly: typeof args.httpOnly === "boolean" ? args.httpOnly : undefined,
            sameSite: typeof args.sameSite === "string" ? args.sameSite : undefined,
            expirationDate: typeof args.expirationDate === "number" ? args.expirationDate : undefined,
          },
        });
        return { content: [{ type: "text", text: result.success ? result.message : `设置失败: ${result.error}` }], isError: !result.success };

      case "delete_cookie":
        result = await sendToExtension("deleteCookie", {
          tabId: args.tabId,
          details: {
            name: args.name,
            url: typeof args.url === "string" ? args.url : undefined,
            domain: typeof args.domain === "string" ? args.domain : undefined,
          },
        });
        return { content: [{ type: "text", text: result.success ? result.message : `删除失败: ${result.error}` }], isError: !result.success };

      case "execute_js":
        return {
          content: [{ type: "text", text: "execute_js is disabled because it relies on CSP-sensitive arbitrary JavaScript. Use inspect, probe_selector, get_page_text, or a site adapter instead." }],
          isError: true,
        };

      case "list_tabs":
        result = await sendToExtension("listTabs", {});
        const tabs = result.tabs?.map((t: any) => `[${t.active ? "*" : " "}] ${t.id}: ${t.title?.slice(0, 50)} (${t.url})`).join("\n");
        return {
          content: [{ type: "text", text: `当前标签页:\n${tabs}` }],
        };

      case "list_adapters": {
        const page = await sendToExtension("getPageInfo", { tabId: args.tabId });
        return { content: [{ type: "text", text: JSON.stringify(await adapterRegistry.list(page.url), null, 2) }] };
      }

      case "extract_with_adapter":
        result = await adapterRegistry.extract(String(args.adapterId), typeof args.tabId === "number" ? args.tabId : undefined);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "extract_with_best_adapter":
        result = await adapterRegistry.extractBest(typeof args.tabId === "number" ? args.tabId : undefined);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "get_adapter_health":
        return { content: [{ type: "text", text: JSON.stringify(await adapterRegistry.healthReport(), null, 2) }] };

      case "get_selector_cache":
        return { content: [{ type: "text", text: JSON.stringify(await selectorCache.report(typeof args.host === "string" ? args.host : undefined), null, 2) }] };

      case "get_action_log": {
        const limit = typeof args.limit === "number" ? Math.max(1, Math.min(Math.floor(args.limit), MAX_ACTION_LOG_ENTRIES)) : 20;
        return { content: [{ type: "text", text: JSON.stringify({ ...bridge.status(), entries: bridge.actionLogEntries(limit) }, null, 2) }] };
      }

      case "cleanup_sessions":
        result = await sendToExtension("cleanupSessions", {
          options: {
            onlyIdle: args.onlyIdle !== false,
            sessionId: typeof args.sessionId === "string" ? args.sessionId : undefined,
          },
        });
        return { content: [{ type: "text", text: `已清理会话组: ${result.closed?.length ? result.closed.join(", ") : "(无)"}\n剩余组数: ${result.remaining}` }] };

      case "start_task":
        result = await taskRuntime.start(String(args.goal), { tabId: typeof args.tabId === "number" ? args.tabId : undefined, maxSteps: typeof args.maxSteps === "number" ? args.maxSteps : undefined });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "observe_task":
        result = await taskRuntime.observe(String(args.taskId));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "run_task_step":
        result = await taskRuntime.act(String(args.taskId), {
          action: args.action, url: args.url, selector: args.selector, text: args.text,
          state: args.state, timeoutMs: normalizeTimeout(args.timeoutMs)
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "verify_task_step":
        result = await taskRuntime.verify(String(args.taskId), { kind: args.kind, value: args.value, selector: args.selector }, args.completeOnPass === true);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "cancel_task":
        result = await taskRuntime.cancel(String(args.taskId), typeof args.reason === "string" ? args.reason : undefined);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "resume_task":
        result = await taskRuntime.resume(String(args.taskId));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "get_task":
        return { content: [{ type: "text", text: JSON.stringify(taskRuntime.get(String(args.taskId)), null, 2) }] };

      case "get_task_log":
        return { content: [{ type: "text", text: JSON.stringify(taskRuntime.log(String(args.taskId), typeof args.limit === "number" ? args.limit : undefined), null, 2) }] };

      case "create_task_checkpoint":
        result = await taskRuntime.checkpoint(String(args.taskId), typeof args.label === "string" ? args.label : undefined);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "restore_task_checkpoint":
        result = await taskRuntime.restore(String(args.taskId), String(args.checkpointId));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "set_task_plan":
        result = await taskRuntime.setPlan(String(args.taskId), { name: typeof args.name === "string" ? args.name : undefined, steps: args.steps });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "run_planned_step":
        result = await taskRuntime.runPlannedStep(String(args.taskId));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "advance_task_plan":
        result = await taskRuntime.advancePlan(String(args.taskId));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "save_task_as_workflow":
        result = await taskRuntime.saveWorkflow(String(args.taskId), typeof args.name === "string" ? args.name : undefined);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "list_workflows":
        return { content: [{ type: "text", text: JSON.stringify(await taskRuntime.listWorkflows(), null, 2) }] };

      case "recommend_workflows": {
        const page = await sendToExtension("getPageInfo", { tabId: args.tabId });
        return { content: [{ type: "text", text: JSON.stringify(await taskRuntime.recommendWorkflows(page.url), null, 2) }] };
      }

      case "start_workflow":
        result = await taskRuntime.startWorkflow(String(args.workflowId), args.parameters && typeof args.parameters === "object" ? args.parameters as Record<string, unknown> : {}, { tabId: typeof args.tabId === "number" ? args.tabId : undefined, maxSteps: typeof args.maxSteps === "number" ? args.maxSteps : undefined });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    const diagnostics = err.diagnostics ? `\nDiagnostics: ${JSON.stringify(err.diagnostics)}` : "";
    return {
      content: [{ type: "text", text: `Error: ${err.message}${diagnostics}` }],
      isError: true,
    };
  }
});

// ===== 启动 =====
async function main() {
  await bridge.start();
  const transport = new StdioServerTransport();
  // initialize 完成后用 clientInfo.name 重新派生稳定 sessionId（同一窗口/项目重启不变）
  server.oninitialized = () => {
    const clientInfo = server.getClientVersion();
    if (clientInfo?.name) bridge.setClientName(clientInfo.name);
    console.error(`[WebPilot MCP] Session: ${bridge.sessionId} (role: ${bridge.role})`);
  };
  await server.connect(transport);
  console.error(`[WebPilot MCP] Server running on stdio (role: ${bridge.role})`);
}

main().catch((err) => {
  console.error("[WebPilot MCP] Fatal error:", err);
  process.exit(1);
});
