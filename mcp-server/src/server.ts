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
import { htmlToMarkdown, type HtmlToMarkdownOptions } from "./html-to-markdown.js";
import { ApiCommandCache } from "./api-command-cache.js";
import { ApiCommandService, ServiceError } from "./api-command-service.js";
import type { AnalyzeAction } from "./api-command-service.js";
import type { CommandSummary, SiteScanSource } from "./api-command-types.js";

const MAX_ACTION_LOG_ENTRIES = 100;

function normalizeTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 10000;
  return Math.max(100, Math.min(Math.floor(value), 30000));
}

// 极简 HTML→纯文本：去 script/style、br/块级标签换行、合并空白、去缩进。
// 用于跨域 iframe 降级时把 replay 回的 HTML 正文转成可读文本（不依赖外部依赖）。
function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ");
  s = s
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/(p|div|h[1-6]|li|tr|table|section|article|header|footer)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
  s = s
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s;
}

// 从工具入参抽取 markdown 转换选项（与现有参数守卫风格一致：typeof 收窄 + 枚举 clamp）。
function buildMdOpts(args: any, defaultBaseUrl?: string): HtmlToMarkdownOptions {
  return {
    gfm: args.gfm !== false,
    headingStyle: args.headingStyle === "setext" ? "setext" : "atx",
    bulletListMarker: args.bulletListMarker === "+" || args.bulletListMarker === "*" ? args.bulletListMarker : "-",
    codeBlockStyle: args.codeBlockStyle === "indented" ? "indented" : "fenced",
    emDelimiter: args.emDelimiter === "_" ? "_" : "*",
    strongDelimiter: args.strongDelimiter === "__" ? "__" : "**",
    linkStyle: args.linkStyle === "referenced" ? "referenced" : "inlined",
    baseUrl: typeof args.baseUrl === "string" ? args.baseUrl : defaultBaseUrl,
    remove:
      typeof args.remove === "string" && args.remove.trim()
        ? (args.remove as string).split(",").map((s: string) => s.trim()).filter(Boolean)
        : undefined,
    keep:
      typeof args.keep === "string" && args.keep.trim()
        ? (args.keep as string).split(",").map((s: string) => s.trim()).filter(Boolean)
        : undefined,
  };
}

// 把 HTML 转成 Markdown 并按 returnFormat 决定最终返回文本（md 直接返回，json 返回元信息）。
function renderMarkdown(html: string, args: any, defaultBaseUrl: string | undefined, maxChars: number): string {
  let md = htmlToMarkdown(html ?? "", buildMdOpts(args, defaultBaseUrl));
  if (maxChars > 0 && md.length > maxChars) md = md.slice(0, maxChars);
  if (args.returnFormat === "json") {
    return JSON.stringify({ markdown: md, length: md.length, gfm: buildMdOpts(args, defaultBaseUrl).gfm !== false }, null, 2);
  }
  return md;
}

// 提取页面中 iframe 的正文文本。同源走 DOM 读取；跨域自动降级到网络层
// （capture → reload 触发 iframe Document 请求 → getNetworkResources 匹配 → replay_api_request 取回 HTML）。
// 返回 { source, url, text, truncated, error }；error 非空表示失败。
async function extractIframeText(opts: {
  tabId?: number;
  iframeSelector?: string;
  iframeIndex?: number;
  urlContains?: string;
  maxChars?: number;
  maxBodyChars?: number;
}): Promise<{ source: "same-origin" | "cross-origin" | "none"; url?: string; text: string; truncated: boolean; error?: string }> {
  const maxChars = typeof opts.maxChars === "number" ? Math.max(1, Math.min(opts.maxChars, 200000)) : 50000;
  const maxBodyChars = typeof opts.maxBodyChars === "number" ? Math.max(1, Math.min(opts.maxBodyChars, 500000)) : 50000;
  const iframeSelector = opts.iframeSelector && opts.iframeSelector.trim() ? opts.iframeSelector.trim() : "iframe";
  const urlContains = opts.urlContains && opts.urlContains.trim() ? opts.urlContains.trim() : "iframe";

  // 1) 同源 DOM 读取
  const direct = await sendToExtension("iframeAction", {
    tabId: opts.tabId,
    options: { action: "getText", iframeSelector, iframeIndex: opts.iframeIndex },
  });
  if (direct.success && typeof direct.text === "string" && direct.text.trim().length > 0) {
    const text = direct.text.length > maxChars ? direct.text.slice(0, maxChars) : direct.text;
    return { source: "same-origin", url: direct.iframeSrc, text, truncated: direct.text.length > maxChars };
  }

  // 2) 跨域降级：网络层
  if (!direct.success && /same-origin|cross-origin|No same-origin/i.test(direct.error || "")) {
    const capture = await sendToExtension("startNetworkCapture", { tabId: opts.tabId, filter: { type: "all" } });
    if (!capture.success) return { source: "none", text: "", truncated: false, error: `无法启动网络捕获 (${capture.error})` };
    await sendToExtension("reload", { tabId: opts.tabId });
    let docReq: any = undefined;
    for (let i = 0; i < 10 && !docReq; i++) {
      const net = await sendToExtension("getNetworkResources", {
        tabId: opts.tabId,
        options: { type: "Document", urlContains, limit: 20 },
      });
      docReq = (net.resources || []).find((r: any) => (r.url || "").includes(urlContains) && /html/i.test(r.mimeType || ""));
      if (!docReq) await new Promise((res) => setTimeout(res, 500));
    }
    await sendToExtension("stopNetworkCapture", { tabId: opts.tabId });
    if (!docReq) return { source: "none", text: "", truncated: false, error: `未捕获到 iframe 的 Document 请求（urlContains='${urlContains}'）` };
    const replay = await sendToExtension("replayApiRequest", { tabId: opts.tabId, options: { urlContains, url: docReq.url, maxBodyChars } });
    if (!replay.success) return { source: "none", text: "", truncated: false, error: `重放 iframe 文档失败 (${replay.error})` };
    const html = typeof replay.body === "string" ? replay.body : JSON.stringify(replay.body);
    const text = htmlToText(html);
    const truncated = text.length > maxChars;
    return { source: "cross-origin", url: docReq.url, text: truncated ? text.slice(0, maxChars) : text, truncated };
  }

  return { source: "none", url: direct.iframeSrc, text: "", truncated: false, error: direct.error || "无文本内容" };
}

// 本进程抢到 8765 则直连扩展（Leader），否则经 8766 转发给 Leader（Follower）。
const bridge = new BrowserBridge();
const sendToExtension = (type: string, params: Record<string, any>): Promise<any> => bridge.send(type, params);

const taskRuntime = new TaskRuntime(sendToExtension);
const adapterRegistry = new AdapterRegistry(sendToExtension);
const selectorCache = new SelectorCache();
// API 命令集单例：缓存 Repository 懒加载（构造不读盘），7 个 case 共用同一实例，
// 避免每次工具调用重复 new 导致缓存状态分裂（T03 / AC-11）。
const apiCommandCache = new ApiCommandCache();
const apiCommandService = new ApiCommandService(apiCommandCache, sendToExtension);

/**
 * 7 个 API 命令集工具的统一回包：结构化 JSON 文本 + isError。
 * 业务可预期错误（ServiceError）优先返回结构化 `{error:{code,message}}`，
 * 不抛未处理异常；其余异常交给 CallToolRequestSchema 既有 catch 统一处理。
 */
function apiToolResult<T>(value: T): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

async function apiToolCall<T>(fn: () => Promise<T>): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    return apiToolResult(await fn());
  } catch (err) {
    if (err instanceof ServiceError) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: { code: err.code, message: err.message } }, null, 2) }],
        isError: true,
      };
    }
    throw err;
  }
}

/** Q11：纯本地缓存读取的极简摘要（零网络请求、零自动执行），失败一律静默降级为空。 */
async function autoLoadApiCommands(url: unknown): Promise<CommandSummary[]> {
  if (typeof url !== "string" || !url) return [];
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host ? await apiCommandService.autoLoadSummary(host) : [];
  } catch {
    return [];
  }
}

/** Q11 navigate 追加的一行文本：只列命令名 / method / risk / 可用状态，绝不含真实 URL 或参数值。 */
function formatApiCommandLine(summaries: CommandSummary[]): string {
  if (summaries.length === 0) return "可用 API 命令: 无（可调用 analyze_page_apis 分析该域名接口；此处只推荐、不执行）";
  const preview = summaries.slice(0, 6)
    .map((item) => `${item.name}[${item.method}/${item.risk}]${item.available ? "" : "(不可用)"}`)
    .join(", ");
  const more = summaries.length > 6 ? ` 等共 ${summaries.length} 条` : "";
  return `可用 API 命令（只推荐、不执行）: ${preview}${more}；调用 list_api_commands 查看全部`;
}

/** 7 个工具的 domain 缺省解析：当前标签 hostname（getURL 是本地扩展查询，非站点网络请求）。 */
async function resolveDomainArg(args: Record<string, any>): Promise<string> {
  if (typeof args.domain === "string" && args.domain.trim()) return args.domain.trim();
  return apiCommandService.resolveDomain(typeof args.tabId === "number" ? args.tabId : undefined);
}

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
    version: "0.3.0",
  },
  {
    capabilities: { tools: {} },
  }
);

// 工具名去重：严格客户端（如 @deepseek-ai/dsh-mcp-client）会把"同一工具名出现两次"的列表
// 判定为无效并**整组拒绝**，导致该服务器所有工具都不可用。这里在返回前按名去重，
// 既修掉当前 browser_task / task_workflow 的重复注册，也防止以后再次出现。
function dedupeTools<T extends { name: string }>(tools: T[]): T[] {
  const seen = new Set<string>();
  return tools.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
}

// 工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: dedupeTools([
      {
        name: "navigate",
        description: "在浏览器中打开指定 URL。",
        inputSchema: {
          type: "object" as const,
          properties: {
          url: { type: "string" },
          tabId: { type: "number" },
        },
        required: ["url"],
      },
    },
      {
        name: "get_page_info",
        description: "获取页面可交互元素快照，返回 @eN 引用。structure=tree 按语义容器分组（适合消歧义），默认平铺。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number" },
            structure: { type: "string", enum: ["flat", "tree"], description: "默认 flat" },
          },
          required: [],
        },
      },
      {
        name: "get_page_text",
        description: "读取页面正文。format=markdown 走 turndown 转 MD 省 token；iframe 穿透自动降级。html 参数可跳过浏览器直接转换。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number" },
            maxChars: { type: "number", description: "默认 50000，最大 200000" },
            format: { type: "string", enum: ["text", "markdown"], description: "默认 text" },
            html: { type: "string", description: "直接传 HTML 时不走浏览器" },
            iframeUrlContains: { type: "string", description: "跨域 iframe 降级匹配子串，默认 'iframe'" },
            gfm: { type: "boolean" },
            headingStyle: { type: "string", enum: ["atx", "setext"] },
            bulletListMarker: { type: "string", enum: ["-", "+", "*"] },
            codeBlockStyle: { type: "string", enum: ["fenced", "indented"] },
            emDelimiter: { type: "string", enum: ["*", "_"] },
            strongDelimiter: { type: "string", enum: ["**", "__"] },
            linkStyle: { type: "string", enum: ["inlined", "referenced"] },
            baseUrl: { type: "string" },
            remove: { type: "string" },
            keep: { type: "string" },
            returnFormat: { type: "string", enum: ["md", "json"] },
          },
          required: [],
        },
      },
      {
        name: "click",
        description: "等待目标可操作后点击。支持 CSS、@eN、text=、role=。intent 可启用选择器缓存。",
        inputSchema: {
          type: "object" as const,
          properties: {
            selector: { type: "string", description: "CSS/@eN/text=/role=；intent 命中缓存时可省略" },
            intent: { type: "string", description: "站点唯一操作意图标识（小写字母数字._-）" },
            tabId: { type: "number" },
            timeoutMs: { type: "number", description: "默认 10000" },
          },
          required: [],
        },
      },
      {
        name: "type",
        description: "等待目标可操作后清空并输入文本。支持 intent 选择器缓存。",
        inputSchema: {
          type: "object" as const,
          properties: {
            selector: { type: "string", description: "CSS/@eN/text=/role=textbox；intent 命中缓存时可省略" },
            intent: { type: "string", description: "站点唯一操作意图标识" },
            text: { type: "string" },
            tabId: { type: "number" },
            timeoutMs: { type: "number", description: "默认 10000" },
          },
          required: ["text"],
        },
      },
      {
        name: "wait_for",
        description: "等待元素达到指定状态（visible/attached/hidden）。",
        inputSchema: {
          type: "object" as const,
          properties: {
            selector: { type: "string" },
            state: { type: "string", enum: ["visible", "attached", "hidden"], description: "默认 visible" },
            timeoutMs: { type: "number", description: "默认 10000，最大 30000" },
            stableMs: { type: "number" },
            tabId: { type: "number" }
          },
          required: ["selector"]
        }
      },
      {
        name: "screenshot",
        description: "截取当前可见页面截图。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number" },
          },
          required: [],
        },
      },
      {
        name: "get_resources",
        description: "获取页面加载的资源列表（真实图片 URL 等），通过 Performance API。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number" },
            type: { type: "string", enum: ["image", "all"], description: "默认 image" },
            minSize: { type: "number" },
            urlContains: { type: "string" },
            since: { type: "number" },
          },
          required: [],
        },
      },
      {
        name: "evaluate",
        description: "在页面上下文中执行 JavaScript（本地全权限模式：不做表达式护栏，支持多语句代码，可用 fetch、document.cookie、window.open 等页面真实全局）。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number" },
            expression: { type: "string" },
            globals: { type: "array", items: { type: "string" } },
            timeoutMs: { type: "number", description: "默认 3000，最大 10000" },
          },
          required: ["expression"],
        },
      },
      {
        name: "extract_table",
        description: "提取页面 HTML 表格数据，返回 headers 和 rows（声明式，不执行 JS）。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number" },
            selector: { type: "string", description: "默认 'table'" },
            header: { type: "string" },
            rows: { type: "string" },
            cells: { type: "string" },
            limit: { type: "number" },
          },
          required: [],
        },
      },
      {
        name: "start_network_capture",
        description: "开始监听标签页网络请求（通过 CDP Network 域）。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number" },
            type: { type: "string", enum: ["image", "all"], description: "默认 all" },
            urlContains: { type: "string" },
            mimeType: { type: "string" },
          },
          required: [],
        },
      },
      {
        name: "stop_network_capture",
        description: "停止网络请求监听。需先 start_network_capture。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number" },
          },
          required: [],
        },
      },
      {
        name: "get_network_resources",
        description: "读取网络捕获到的资源列表。需先 start_network_capture。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number" },
            urlContains: { type: "string" },
            mimeType: { type: "string" },
            type: { type: "string" },
            minStatus: { type: "number" },
            limit: { type: "number" },
          },
          required: [],
        },
      },
      {
        name: "replay_api_request",
        description: "重放已捕获的页面 API 请求（带登录 Cookie），可覆写 URL/参数/请求体。需先 start_network_capture。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number" },
            captureRequestId: { type: "string", description: "CDP requestId（与 urlContains 二选一，优先）" },
            urlContains: { type: "string", description: "按子串匹配已捕获请求" },
            url: { type: "string" },
            method: { type: "string" },
            queryParams: { type: "object" },
            body: { description: "请求体，非 GET 生效" },
            headers: { type: "object" },
            maxBodyChars: { type: "number" },
          },
          required: [],
        },
      },
      {
        name: "hover",
        description: "在指定元素上触发鼠标悬停事件。",
        inputSchema: {
          type: "object" as const,
          properties: {
            selector: { type: "string" },
            tabId: { type: "number" },
          },
          required: ["selector"],
        },
      },
      {
        name: "press_key",
        description: "模拟按键（Enter/Escape/Tab/Arrow 等）。",
        inputSchema: {
          type: "object" as const,
          properties: {
            key: { type: "string" },
            selector: { type: "string" },
            tabId: { type: "number" },
          },
          required: ["key"],
        },
      },
      {
        name: "scroll",
        description: "滚动页面（到元素/方向/坐标）。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number" },
            selector: { type: "string" },
            direction: { type: "string", enum: ["up", "down", "left", "right"] },
            amount: { type: "number" },
            x: { type: "number" },
            y: { type: "number" },
            smooth: { type: "boolean" },
            block: { type: "string", enum: ["start", "center", "end", "nearest"] },
          },
          required: [],
        },
      },
      {
        name: "select_option",
        description: "设置 <select> 下拉框的选中值（value/文本/标签）。",
        inputSchema: {
          type: "object" as const,
          properties: {
            selector: { type: "string" },
            value: { type: "string" },
            tabId: { type: "number" },
            byLabel: { type: "boolean" },
            byText: { type: "boolean" },
            fuzzy: { type: "boolean" },
          },
          required: ["selector", "value"],
        },
      },
      {
        name: "drag_drop",
        description: "从源元素拖拽到目标元素。",
        inputSchema: {
          type: "object" as const,
          properties: {
            fromSelector: { type: "string" },
            toSelector: { type: "string" },
            tabId: { type: "number" },
          },
          required: ["fromSelector", "toSelector"],
        },
      },
      {
        name: "wait_for_dynamic",
        description: "使用 MutationObserver 等待 SPA 动态内容（元素/文本/网络空闲）。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number" },
            selector: { type: "string" },
            textContains: { type: "string" },
            minElementCount: { type: "number" },
            networkIdle: { type: "boolean" },
            timeoutMs: { type: "number", description: "默认 10000，最大 30000" },
          },
          required: [],
        },
      },
      {
        name: "iframe_action",
        description: "操作同源 iframe 内容（getText/query/click）。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number" },
            action: { type: "string", enum: ["getText", "query", "click"] },
            iframeSelector: { type: "string" },
            iframeIndex: { type: "number" },
            selector: { type: "string" },
          },
          required: ["action"],
        },
      },
      {
        name: "extract_iframe_text",
        description: "提取 iframe 正文。同源走 DOM，跨域自动降级到网络层 replay。对调用方透明。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number" },
            iframeSelector: { type: "string" },
            iframeUrlContains: { type: "string", description: "跨域匹配子串，默认 'iframe'" },
            maxChars: { type: "number" },
            maxBodyChars: { type: "number" },
          },
          required: [],
        },
      },
      {
        name: "get_console_logs",
        description: "捕获页面控制台日志，持续指定时长后返回。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number" },
            duration: { type: "number", description: "毫秒，默认 3000，最大 10000" },
          },
          required: [],
        },
      },
      {
        name: "shadow_dom_action",
        description: "操作 Shadow DOM 内的元素（query/click/getText/type）。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number" },
            action: { type: "string", enum: ["query", "click", "getText", "type"] },
            hostSelector: { type: "string" },
            innerSelector: { type: "string" },
            selector: { type: "string" },
            text: { type: "string" },
          },
          required: ["action"],
        },
      },
      {
        name: "execute_js",
        description: "在页面中执行任意 JavaScript 代码（本地全权限模式；与 evaluate 等价，支持多语句代码体）。",
        inputSchema: {
          type: "object" as const,
          properties: {
            script: { type: "string", description: "要执行的 JavaScript：单个表达式或多语句代码体。" },
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
          },
          required: ["script"],
        },
      },
      {
        name: "list_tabs",
        description: "列出当前浏览器中所有标签页。",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
      {
        name: "inspect",
        description: "检查页面可操作控件，返回稳定引用和语义提示。",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number" },
            scope: { type: "string", enum: ["page", "focused", "composer"] },
            includeUnnamed: { type: "boolean" },
            clickableOnly: { type: "boolean" },
            maxCandidates: { type: "number" },
          },
          required: [],
        },
      },
      {
        name: "probe_selector",
        description: "一次性检查选择器是否匹配（不等待），返回匹配结果或诊断。",
        inputSchema: {
          type: "object" as const,
          properties: { selector: { type: "string" }, tabId: { type: "number" } },
          required: ["selector"],
        },
      },
      {
        name: "click_at",
        description: "点击指定视口坐标的控件。",
        inputSchema: {
          type: "object" as const,
          properties: { x: { type: "number" }, y: { type: "number" }, tabId: { type: "number" } },
          required: ["x", "y"],
        },
      },
      {
        name: "get_selector_cache",
        description: "查看选择器缓存条目与健康度。",
        inputSchema: { type: "object" as const, properties: { host: { type: "string" } }, required: [] }
      },
      {
        name: "get_action_log",
        description: "读取最近浏览器操作的时间线和耗时。",
        inputSchema: { type: "object" as const, properties: { limit: { type: "number", description: "默认 20，最大 100" } }, required: [] }
      },
      {
        name: "cleanup_sessions",
        description: "清理浏览器 WebPilot 会话标签组。",
        inputSchema: { type: "object" as const, properties: {
          onlyIdle: { type: "boolean", description: "仅清理闲置组，默认 true" },
          sessionId: { type: "string" }
        }, required: [] }
      },
      {
        name: "claim_session",
        description: "认领一个闲置的 WebPilot 标签组到当前会话（自动认领不可用时的兜底）。",
        inputSchema: { type: "object" as const, properties: {
          groupId: { type: "number", description: "目标标签组 ID（浏览器标签组号）" },
          agentKey: { type: "string", description: "目标归属键（与 groupId 二选一）" }
        }, required: [] }
      },
      {
        name: "browser_status",
        description: "查看当前会话身份（归属键/实例键）、角色与浏览器侧会话标签组状态。",
        inputSchema: { type: "object" as const, properties: {}, required: [] }
      },
      // ===== 合并工具：浏览器全局配置（合并 set_viewport/set_user_agent/set_timezone/set_geolocation/set_network_throttle） =====
      {
        name: "browser_config",
        description: "浏览器全局配置（视口/UA/时区/地理位置/网络限速）。",
        inputSchema: {
          type: "object" as const,
          properties: {
            action: { type: "string", enum: ["set_viewport", "set_user_agent", "set_timezone", "set_geolocation", "set_network_throttle"], description: "配置动作" },
            tabId: { type: "number" },
            // set_viewport
            width: { type: "number" },
            height: { type: "number" },
            deviceScaleFactor: { type: "number" },
            mobile: { type: "boolean" },
            touch: { type: "boolean" },
            // set_user_agent
            userAgent: { type: "string" },
            // set_timezone
            timezone: { type: "string" },
            // set_geolocation
            latitude: { type: "number" },
            longitude: { type: "number" },
            accuracy: { type: "number" },
            // set_network_throttle
            offline: { type: "boolean" },
            reset: { type: "boolean" },
            latency: { type: "number" },
            downloadKbps: { type: "number" },
            uploadKbps: { type: "number" },
          },
          required: ["action"],
        },
      },
      // ===== 合并工具：浏览器 Cookie 操作（合并 get_cookies/get_all_cookies/set_cookie/delete_cookie） =====
      {
        name: "browser_cookie",
        description: "浏览器 Cookie 操作（get/getAll/set/delete）。",
        inputSchema: {
          type: "object" as const,
          properties: {
            action: { type: "string", enum: ["get", "get_all", "set", "delete"], description: "Cookie 操作" },
            tabId: { type: "number" },
            name: { type: "string" },
            value: { type: "string" },
            url: { type: "string" },
            domain: { type: "string" },
            path: { type: "string" },
            secure: { type: "boolean" },
            httpOnly: { type: "boolean" },
            sameSite: { type: "string", enum: ["no_restriction", "lax", "strict", "unspecified"] },
            expirationDate: { type: "number" },
          },
          required: ["action"],
        },
      },
      // ===== 合并工具：浏览器任务（合并 start_task/observe_task/run_task_step/verify_task_step/cancel_task/resume_task/get_task/get_task_log） =====
      {
        name: "browser_task",
        description: "浏览器任务操作（start/observe/step/verify/cancel/resume/get/log）。【需 enable_task_mode】",
        inputSchema: {
          type: "object" as const,
          properties: {
            action: { type: "string", enum: ["start", "observe", "step", "verify", "cancel", "resume", "get", "log"], description: "任务操作" },
            taskId: { type: "string" },
            // start
            goal: { type: "string" },
            maxSteps: { type: "number" },
            // step
            stepAction: { type: "string", enum: ["navigate", "click", "type", "wait"] },
            url: { type: "string" },
            selector: { type: "string" },
            text: { type: "string" },
            state: { type: "string", enum: ["visible", "attached", "hidden"] },
            timeoutMs: { type: "number" },
            // verify
            kind: { type: "string" },
            value: { type: ["string", "number"] as any },
            completeOnPass: { type: "boolean" },
            // cancel
            reason: { type: "string" },
            // log
            limit: { type: "number" },
          },
          required: ["action"],
        },
      },
      // ===== 合并工具：任务计划（合并 set_task_plan/run_planned_step/advance_task_plan/create_task_checkpoint/restore_task_checkpoint/save_task_as_workflow/list_workflows/recommend_workflows/start_workflow） =====
      {
        name: "task_workflow",
        description: "任务计划与工作流操作（plan/run/advance/checkpoint/workflow）。【需 enable_task_mode】",
        inputSchema: {
          type: "object" as const,
          properties: {
            action: { type: "string", enum: ["set_plan", "run_plan", "advance_plan", "create_checkpoint", "restore_checkpoint", "save_workflow", "list_workflows", "recommend", "start_workflow"], description: "计划/工作流操作" },
            taskId: { type: "string" },
            checkpointId: { type: "string" },
            // set_plan
            name: { type: "string" },
            steps: { type: "array", items: { type: "object" } },
            // save_workflow
            // list_workflows (no extra params)
            // recommend
            tabId: { type: "number" },
            // start_workflow
            workflowId: { type: "string" },
            parameters: { type: "object" },
            maxSteps: { type: "number" },
          },
          required: ["action"],
        },
      },
      // ===== 合并工具：浏览器页面信息（合并 get_url/reload/go_back_forward/full_page_screenshot/element_screenshot/upload_file/download_file/save_pdf/handle_dialog） =====
      {
        name: "browser_page",
        description: "浏览器页面操作（URL/刷新/导航/截图/上传/下载/保存/弹窗）。",
        inputSchema: {
          type: "object" as const,
          properties: {
            action: { type: "string", enum: ["get_url", "reload", "go_back", "go_forward", "full_screenshot", "element_screenshot", "upload_file", "download_file", "save_pdf", "handle_dialog"], description: "页面操作" },
            tabId: { type: "number" },
            // reload
            bypassCache: { type: "boolean" },
            // element_screenshot
            selector: { type: "string" },
            // upload_file
            filePath: { type: "string" },
            // download_file
            url: { type: "string" },
            filename: { type: "string" },
            // save_pdf
            landscape: { type: "boolean" },
            printBackground: { type: "boolean" },
            scale: { type: "number" },
            paperWidth: { type: "number" },
            paperHeight: { type: "number" },
            marginTop: { type: "number" },
            marginBottom: { type: "number" },
            marginLeft: { type: "number" },
            marginRight: { type: "number" },
            displayHeaderFooter: { type: "boolean" },
            // handle_dialog
            dialogAction: { type: "string" },
          },
          required: ["action"],
        },
      },
      // ===== 合并工具：适配器管理（合并 list_adapters/extract_with_adapter/extract_with_best_adapter/get_adapter_health） =====
      {
        name: "adapter",
        description: "适配器管理（list/extract/best/health）。",
        inputSchema: {
          type: "object" as const,
          properties: {
            action: { type: "string", enum: ["list", "extract", "best", "health"], description: "适配器操作" },
            tabId: { type: "number" },
            adapterId: { type: "string" },
          },
          required: ["action"],
        },
      },
      // ===== 合并工具：WebMCP 双通道（合并 get_webmcp_health/list_webmcp_tools/execute_webmcp_tool/probe_page_capabilities） =====
      {
        name: "webmcp",
        description: "WebMCP 操作（health/list/execute/probe）。",
        inputSchema: {
          type: "object" as const,
          properties: {
            action: { type: "string", enum: ["health", "list", "execute", "probe"], description: "WebMCP 操作" },
            tabId: { type: "number" },
            // execute
            toolName: { type: "string" },
            input: { type: "object" },
          },
          required: ["action"],
        },
      },
      // ===== 任务工具（调用端需 enable_task_mode） =====
      {
      name: "browser_task",
      description: "浏览器任务操作（start/observe/step/verify/cancel/resume/get/log）。【需 enable_task_mode】",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: { type: "string", enum: ["start", "observe", "step", "verify", "cancel", "resume", "get", "log"], description: "任务操作" },
          taskId: { type: "string" },
          goal: { type: "string" },
          maxSteps: { type: "number" },
          stepAction: { type: "string", enum: ["navigate", "click", "type", "wait"] },
          url: { type: "string" },
          selector: { type: "string" },
          text: { type: "string" },
          state: { type: "string", enum: ["visible", "attached", "hidden"] },
          timeoutMs: { type: "number" },
          kind: { type: "string" },
          value: { type: ["string", "number"] as any },
          completeOnPass: { type: "boolean" },
          reason: { type: "string" },
          limit: { type: "number" },
        },
        required: ["action"],
      },
    },
    {
      name: "task_workflow",
      description: "任务计划与工作流操作（plan/run/advance/checkpoint/workflow）。【需 enable_task_mode】",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: { type: "string", enum: ["set_plan", "run_plan", "advance_plan", "create_checkpoint", "restore_checkpoint", "save_workflow", "list_workflows", "recommend", "start_workflow"], description: "计划/工作流操作" },
          taskId: { type: "string" },
          checkpointId: { type: "string" },
          name: { type: "string" },
          steps: { type: "array", items: { type: "object" } },
          tabId: { type: "number" },
          workflowId: { type: "string" },
          parameters: { type: "object" },
          maxSteps: { type: "number" },
        },
        required: ["action"],
      },
    },

    // ===== 按域名的 API 命令集（7 个独立具名工具，snake_case，Q1）=====
    {
      name: "analyze_page_apis",
      description: "页面 API 分析并沉淀为可复用命令：action=start 启动抓包 → 用户/Agent 操作页面 → action=stop_and_analyze 产出报告并写入域名级缓存；analyze_current 为兼容入口（解析现有抓包缓冲区）；scan_site 为静态推导入口：直接读取 JS bundle / HAR / OpenAPI / 声明式命令包，无需打开页面、无需抓包、无需登录会话，一次拿到整站接口骨架（产物强制需人工复核、默认按 write 保守处理）。bundle 受登录态保护时加 collectViaExtension=true（或 discoverBundles=true 自动发现）由扩展侧借页面会话取文本，扫描仍走同一套解析。",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: { type: "string", enum: ["start", "stop_and_analyze", "analyze_current", "scan_site"], description: "分析动作" },
          domain: { type: "string", description: "精确 hostname（缺省按当前标签域名）" },
          analysisId: { type: "string", description: "start 返回的关联键，stop_and_analyze 时回传" },
          tabId: { type: "number" },
          filter: { type: "object", description: "可选 {urlContains, mimeType} 过滤" },
          includeStaticAssets: { type: "boolean", description: "默认 false，排除静态资源" },
          maxEndpoints: { type: "number", description: "默认 20，端点数上限" },
          captureResponseBody: { type: "boolean", description: "Q8 响应体采样，默认 false；仅分析期间限量采样" },
          mode: { type: "string", enum: ["full", "merge"], description: "默认 merge；full 会移除未观测到的非人工条目" },
          overwriteManual: { type: "boolean", description: "默认 false，人工修正条目始终保留" },
          sources: {
            type: "array",
            description: "scan_site 专用数据源：[{kind:\"js\"|\"har\"|\"openapi\"|\"commands\", url?:string, text?:string}]。url 仅 http(s)、默认同源且拒绝私网；text 优先，便于离线复现",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["js", "har", "openapi", "commands"] },
                url: { type: "string" },
                text: { type: "string" },
              },
              required: ["kind"],
            },
          },
          allowPrivateHosts: { type: "boolean", description: "scan_site 黄区开关：允许内网/回环地址数据源，默认 false（SSRF 风险）" },
          allowCrossHost: { type: "boolean", description: "scan_site 黄区开关：允许跨 hostname 脚本源（CDN），默认 false，需同时给 extraHosts" },
          extraHosts: { type: "array", items: { type: "string" }, description: "allowCrossHost=true 时显式放行的精确 hostname 白名单" },
          trustSpec: { type: "boolean", description: "默认 false：静态推导命令一律按 write 保守处理；置 true 时 openapi/commands 来源按声明方法判定 risk" },
          loosePaths: { type: "boolean", description: "放宽 JS 路径判定（接受非标准 API 前缀），默认 false，会增加误报" },
          scanTimeoutMs: { type: "number", description: "单个远端数据源读取超时，默认 8000，clamp 100..30000" },
          collectViaExtension: { type: "boolean", description: "scan_site 绿区开关：URL 类数据源改由扩展侧借页面登录态取文本（Node 直读 401 时用），默认 false" },
          discoverBundles: { type: "boolean", description: "scan_site 绿区开关：从 tabId 对应页面自动发现已加载的 JS bundle 并补采，默认 false（隐含 collectViaExtension）" },
          bundleMaxSources: { type: "number", description: "bundle 补采条数上限，默认 6，clamp 1..10" },
          bundleUseBrowserCache: { type: "boolean", description: "是否允许 CDP 读浏览器缓存里已加载过的原始字节兜底，默认 true" },
        },
        required: ["action"],
      },
    },
    {
      name: "list_api_commands",
      description: "列出某精确 hostname 的可用 API 命令（自动加载入口，纯本地缓存读取）。返回精简 CommandCard、stale[] 与 warnings[]。",
      inputSchema: {
        type: "object" as const,
        properties: {
          domain: { type: "string", description: "精确 hostname（缺省按当前标签域名）" },
          includeDisabled: { type: "boolean", description: "默认 false，禁用/弃用条目视同未命中" },
          keyword: { type: "string" },
          risk: { type: "string", enum: ["read", "write"] },
        },
      },
    },
    {
      name: "get_api_command",
      description: "查看单条 API 命令完整定义（params[] / responseFields[] / responseSchema / health / source / schemaVersion / manuallyEdited）。",
      inputSchema: {
        type: "object" as const,
        properties: {
          domain: { type: "string" },
          commandId: { type: "string", description: "与 name 二选一" },
          name: { type: "string", description: "如 list.courses" },
          tabId: { type: "number" },
        },
      },
    },
    {
      name: "call_api_command",
      description: "按持久化命令模板执行 API 调用（免开网页、无需抓包缓冲区，自动携带当前浏览器会话 Cookie）。写命令 risk=write 必须 confirm:true，否则返回 confirmationRequired 预览且零网络请求。",
      inputSchema: {
        type: "object" as const,
        properties: {
          domain: { type: "string" },
          commandId: { type: "string", description: "与 name 二选一" },
          name: { type: "string" },
          params: { type: "object", description: "命令参数，键对应 {{param}} 占位符名" },
          fields: { type: "array", items: { type: "string" }, description: "响应字段白名单覆盖（点路径）" },
          maxBodyChars: { type: "number", description: "默认 50000，clamp 1000..500000" },
          confirm: { type: "boolean", description: "写命令必须显式为 true（仅防误触发，非安全边界）" },
          tabId: { type: "number", description: "可省略；显式传时沿用跨组拒绝" },
          timeoutMs: { type: "number", description: "默认 10000，clamp 100..25000" },
        },
      },
    },
    {
      name: "update_api_command",
      description: "人工修正命令（改名 / 改参数模板 / 改响应裁剪 / 加备注 / 标记弃用），置 manuallyEdited=true，后续 full/merge 均保留。",
      inputSchema: {
        type: "object" as const,
        properties: {
          domain: { type: "string" },
          commandId: { type: "string" },
          name: { type: "string" },
          params: { type: "array", items: { type: "object" } },
          responseFields: { type: "array", items: { type: "string" } },
          note: { type: "string" },
          deprecated: { type: "boolean" },
          tabId: { type: "number" },
        },
        required: ["commandId"],
      },
    },
    {
      name: "invalidate_api_commands",
      description: "使缓存失效：action=disable / delete（单命令）/ clear_domain（整域名）。",
      inputSchema: {
        type: "object" as const,
        properties: {
          domain: { type: "string" },
          commandId: { type: "string", description: "disable/delete 时需要" },
          action: { type: "string", enum: ["disable", "delete", "clear_domain"] },
          tabId: { type: "number" },
        },
        required: ["action"],
      },
    },
    {
      name: "get_api_command_cache",
      description: "缓存健康度报告：domains[] / perCommand{hits,misses,consecutiveFailures,disabled,averageDurationMs,lastSuccessAt,lastError} / skippedInvalid[] / errors[] / schemaVersion。",
      inputSchema: {
        type: "object" as const,
        properties: {
          domain: { type: "string", description: "省略则返回全部域名" },
        },
      },
    },
    {
      name: "ai_search",
      description: "AI 搜索摘要：一次调用拿到全网 AI 答案（百度 baikan）+ 引用来源，免开网页、免抓包。"
        + "底层接口等价于 `GET https://m.baidu.com/s?word={query}`（urlTemplate 里回显），"
        + "但会直接从页面的 baikan 数据块提取结构化答案与引用，不返回 2MB 原始 HTML。"
        + "注意：并非每个查询都有 AI 摘要，found=false 属正常结果（换更具体的问法）。",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "搜索词 / 问题，1..200 字符" },
          maxChars: { type: "number", description: "答案截断上限，默认 8000，clamp 200..30000" },
          maxCitations: { type: "number", description: "引用条数上限，默认 10，clamp 0..20" },
          timeoutMs: { type: "number", description: "单次取页超时，默认 15000" },
        },
        required: ["query"],
      },
    },
  ]),
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
          // Q11：原有文本前缀一字不动，仅追加一行纯本地缓存摘要（零网络请求、零自动执行）。
          content: [{ type: "text", text: `导航成功: ${result.title}\nURL: ${result.url}\n标签页ID: ${result.tabId}\n${formatApiCommandLine(await autoLoadApiCommands(result?.url))}` }],
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

      case "get_page_text": {
        const wantMarkdown = args.format === "markdown";
        const maxChars = typeof args.maxChars === "number" ? Math.max(1_000, Math.min(Math.floor(args.maxChars), 200_000)) : 50_000;

        // 直接传 html：纯服务端转换，不依赖浏览器
        if (typeof args.html === "string" && args.html.length > 0) {
          return { content: [{ type: "text", text: renderMarkdown(args.html, args, undefined, maxChars) }] };
        }

        // 走浏览器取当前页
        result = await sendToExtension("getPageText", {
          tabId: args.tabId,
          maxChars,
          returnHtml: wantMarkdown,
        });

        // 纯文本模式：保持原行为
        if (!wantMarkdown) {
          let text = `页面: ${result.title}\nURL: ${result.url}\n字符数: ${result.characterCount}${result.truncated ? "（已截断）" : ""}\n\n${result.text}`;

          // 若主页面包含 iframe（正文可能全在 iframe 内，如 workbuddy 文档），自动穿透 iframe 取回其正文
          const probe = await sendToExtension("probeSelector", { tabId: args.tabId, selector: "iframe" });
          if (probe?.matched && !/iframe/i.test(result.text || "")) {
            const iframeText = await extractIframeText({
              tabId: typeof args.tabId === "number" ? args.tabId : undefined,
              maxChars,
              urlContains: typeof args.iframeUrlContains === "string" ? args.iframeUrlContains : undefined,
            });
            if (!iframeText.error && iframeText.text.trim()) {
              text += `\n\n--- iframe 正文（${iframeText.source === "same-origin" ? "同源" : "跨域降级"}, ${iframeText.url}）---\n${iframeText.text}`;
            }
          }
          return { content: [{ type: "text", text }] };
        }

        // markdown 模式：把页面 HTML 转成 Markdown（开源库 turndown，省 token）
        let md = htmlToMarkdown(result.html ?? "", buildMdOpts(args, result.url));

        // 正文几乎为空时（如内容在 iframe 内），穿透取回 iframe 正文追加
        const probe = await sendToExtension("probeSelector", { tabId: args.tabId, selector: "iframe" });
        if (probe?.matched && md.trim().length < 200) {
          const iframeText = await extractIframeText({
            tabId: typeof args.tabId === "number" ? args.tabId : undefined,
            maxChars,
            urlContains: typeof args.iframeUrlContains === "string" ? args.iframeUrlContains : undefined,
          });
          if (!iframeText.error && iframeText.text.trim()) {
            md += `\n\n--- iframe 正文（${iframeText.source === "same-origin" ? "同源" : "跨域降级"}, ${iframeText.url}）---\n\n${iframeText.text}`;
          }
        }
        return { content: [{ type: "text", text: renderMarkdown(md, args, result.url, maxChars) }] };
      }
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
      case "execute_js":
        result = await sendToExtension("evaluate", {
          tabId: args.tabId,
          expression: typeof args.expression === "string" ? args.expression : args.script,
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
          `[${r.status}] ${r.method || "?"} ${r.mimeType} ${r.type} id=${r.requestId}\n  ${r.url}${r.postData ? `\n  body: ${String(r.postData).slice(0, 500)}` : ""}`
        ).join("\n") || "无";
        return {
          content: [{ type: "text", text: `网络资源\n已捕获: ${result.totalCaptured}, 返回: ${result.count}, 活跃: ${result.active}\n开始时间: ${result.startedAt}\n\n${netResources}` }],
          isError: !result.success,
        };

      case "replay_api_request":
        result = await sendToExtension("replayApiRequest", {
          tabId: args.tabId,
          options: {
            captureRequestId: args.captureRequestId != null ? String(args.captureRequestId) : undefined,
            urlContains: typeof args.urlContains === "string" ? args.urlContains : undefined,
            url: typeof args.url === "string" ? args.url : undefined,
            method: typeof args.method === "string" ? args.method : undefined,
            queryParams: args.queryParams && typeof args.queryParams === "object" ? args.queryParams : undefined,
            body: args.body,
            headers: args.headers && typeof args.headers === "object" ? args.headers : undefined,
            maxBodyChars: typeof args.maxBodyChars === "number" ? args.maxBodyChars : undefined,
          },
        });
        if (!result.success) {
          return { content: [{ type: "text", text: `重放失败: ${result.error}` }], isError: true };
        }
        const replayBody = typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2);
        return {
          content: [{ type: "text", text: `重放成功 [${result.status}] ${result.method} ${result.url}\n耗时: ${result.durationMs}ms, 响应长度: ${result.bodyLength}${result.truncated ? " (已截断)" : ""}\n\n${replayBody}` }],
          isError: result.status >= 400,
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

      case "extract_iframe_text": {
        const out = await extractIframeText({
          tabId: typeof args.tabId === "number" ? args.tabId : undefined,
          iframeSelector: typeof args.iframeSelector === "string" ? args.iframeSelector : undefined,
          iframeIndex: typeof args.iframeIndex === "number" ? args.iframeIndex : undefined,
          urlContains: typeof args.iframeUrlContains === "string" ? args.iframeUrlContains : undefined,
          maxChars: typeof args.maxChars === "number" ? args.maxChars : undefined,
          maxBodyChars: typeof args.maxBodyChars === "number" ? args.maxBodyChars : undefined,
        });
        if (out.error) {
          return { content: [{ type: "text", text: `iframe 正文提取失败：${out.error}${out.url ? `\niframeSrc: ${out.url}` : ""}` }], isError: true };
        }
        const tag = out.source === "same-origin" ? "同源" : "跨域降级";
        return {
          content: [{ type: "text", text: `iframe (${tag}, ${out.url})\n截断: ${out.truncated}\n\n${out.text}` }],
        };
      }

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

      // ===== 合并工具：browser_config =====
      case "browser_config": {
        const action = args.action as string;
        const tabId = args.tabId;
        switch (action) {
          case "set_viewport":
            result = await sendToExtension("setViewport", { tabId, options: {
              width: typeof args.width === "number" ? args.width : undefined,
              height: typeof args.height === "number" ? args.height : undefined,
              deviceScaleFactor: typeof args.deviceScaleFactor === "number" ? args.deviceScaleFactor : undefined,
              mobile: args.mobile === true,
              touch: args.touch === true,
              userAgent: typeof args.userAgent === "string" ? args.userAgent : undefined,
            }});
            return { content: [{ type: "text", text: result.success ? result.message : `设置失败: ${result.error}` }], isError: !result.success };
          case "set_user_agent":
            result = await sendToExtension("setUserAgent", { userAgent: args.userAgent, tabId });
            return { content: [{ type: "text", text: result.success ? result.message : `设置失败: ${result.error}` }], isError: !result.success };
          case "set_timezone":
            result = await sendToExtension("setTimezone", { timezone: args.timezone, tabId });
            return { content: [{ type: "text", text: result.success ? result.message : `设置失败: ${result.error}` }], isError: !result.success };
          case "set_geolocation":
            result = await sendToExtension("setGeolocation", { tabId, options: {
              latitude: args.latitude,
              longitude: args.longitude,
              accuracy: typeof args.accuracy === "number" ? args.accuracy : undefined,
            }});
            return { content: [{ type: "text", text: result.success ? result.message : `设置失败: ${result.error}` }], isError: !result.success };
          case "set_network_throttle":
            result = await sendToExtension("setNetworkThrottle", { tabId, options: {
              offline: args.offline === true,
              reset: args.reset === true,
              latency: typeof args.latency === "number" ? args.latency : undefined,
              downloadKbps: typeof args.downloadKbps === "number" ? args.downloadKbps : undefined,
              uploadKbps: typeof args.uploadKbps === "number" ? args.uploadKbps : undefined,
            }});
            return { content: [{ type: "text", text: result.success ? result.message : `设置失败: ${result.error}` }], isError: !result.success };
          default:
            throw new Error(`Unknown browser_config action: ${action}`);
        }
      }

      // ===== 合并工具：browser_cookie =====
      case "browser_cookie": {
        const action = args.action as string;
        const tabId = args.tabId;
        switch (action) {
          case "get":
            result = await sendToExtension("getCookies", { tabId, options: {
              name: typeof args.name === "string" ? args.name : undefined,
              domain: typeof args.domain === "string" ? args.domain : undefined,
              path: typeof args.path === "string" ? args.path : undefined,
              secure: args.secure === true,
              session: args.session === true,
            }});
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "get_all":
            result = await sendToExtension("getAllCookies", { tabId });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "set":
            result = await sendToExtension("setCookie", { tabId, options: {
              name: args.name,
              value: args.value,
              url: typeof args.url === "string" ? args.url : undefined,
              domain: typeof args.domain === "string" ? args.domain : undefined,
              path: typeof args.path === "string" ? args.path : undefined,
              secure: args.secure === true,
              httpOnly: args.httpOnly === true,
              sameSite: typeof args.sameSite === "string" ? args.sameSite : undefined,
              expirationDate: typeof args.expirationDate === "number" ? args.expirationDate : undefined,
            }});
            return { content: [{ type: "text", text: result.success ? result.message : `设置失败: ${result.error}` }], isError: !result.success };
          case "delete":
            result = await sendToExtension("deleteCookie", { tabId, options: {
              name: args.name,
              url: typeof args.url === "string" ? args.url : undefined,
              domain: typeof args.domain === "string" ? args.domain : undefined,
            }});
            return { content: [{ type: "text", text: result.success ? result.message : `删除失败: ${result.error}` }], isError: !result.success };
          default:
            throw new Error(`Unknown browser_cookie action: ${action}`);
        }
      }

      // ===== 合并工具：browser_task =====
      case "browser_task": {
        const action = args.action as string;
        switch (action) {
          case "start":
            result = await taskRuntime.start(String(args.goal), { tabId: typeof args.tabId === "number" ? args.tabId : undefined, maxSteps: typeof args.maxSteps === "number" ? args.maxSteps : undefined });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "observe":
            result = await taskRuntime.observe(String(args.taskId));
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "step":
            result = await taskRuntime.act(String(args.taskId), {
              action: args.stepAction as any,
              url: typeof args.url === "string" ? args.url : undefined,
              selector: typeof args.selector === "string" ? args.selector : undefined,
              text: typeof args.text === "string" ? args.text : undefined,
              state: typeof args.state === "string" ? args.state as any : undefined,
              timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
            });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "verify":
            result = await taskRuntime.verify(String(args.taskId), {
              kind: String(args.kind),
              value: args.value,
              selector: typeof args.selector === "string" ? args.selector : undefined,
            }, args.completeOnPass === true);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "cancel":
            result = await taskRuntime.cancel(String(args.taskId), typeof args.reason === "string" ? args.reason : undefined);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "resume":
            result = await taskRuntime.resume(String(args.taskId));
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "get":
            result = taskRuntime.get(String(args.taskId));
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "log":
            result = taskRuntime.log(String(args.taskId), typeof args.limit === "number" ? args.limit : undefined);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          default:
            throw new Error(`Unknown browser_task action: ${action}`);
        }
      }

      // ===== 合并工具：task_workflow =====
      case "task_workflow": {
        const action = args.action as string;
        switch (action) {
          case "set_plan":
            result = await taskRuntime.setPlan(String(args.taskId), { name: typeof args.name === "string" ? args.name : undefined, steps: args.steps });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "run_plan":
            result = await taskRuntime.runPlannedStep(String(args.taskId));
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "advance_plan":
            result = await taskRuntime.advancePlan(String(args.taskId));
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "create_checkpoint":
            result = await taskRuntime.checkpoint(String(args.taskId), typeof args.name === "string" ? args.name : undefined);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "restore_checkpoint":
            result = await taskRuntime.restore(String(args.taskId), String(args.checkpointId));
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "save_workflow":
            result = await taskRuntime.saveWorkflow(String(args.taskId), typeof args.name === "string" ? args.name : undefined);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "list_workflows":
            result = await taskRuntime.listWorkflows();
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "recommend": {
            const page = await sendToExtension("getPageInfo", { tabId: args.tabId });
            result = await taskRuntime.recommendWorkflows(page.url);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          }
          case "start_workflow":
            result = await taskRuntime.startWorkflow(String(args.workflowId), args.parameters && typeof args.parameters === "object" ? args.parameters as Record<string, unknown> : {}, { tabId: typeof args.tabId === "number" ? args.tabId : undefined, maxSteps: typeof args.maxSteps === "number" ? args.maxSteps : undefined });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          default:
            throw new Error(`Unknown task_workflow action: ${action}`);
        }
      }

      // ===== 合并工具：browser_page =====
      case "browser_page": {
        const action = args.action as string;
        const tabId = args.tabId;
        switch (action) {
          case "get_url":
            result = await sendToExtension("getURL", { tabId });
            return { content: [{ type: "text", text: result.success ? `URL: ${result.url}\n标题: ${result.title}` : `获取失败: ${result.error}` }], isError: !result.success };
          case "reload":
            result = await sendToExtension("reload", { bypassCache: args.bypassCache === true, tabId });
            return { content: [{ type: "text", text: result.success ? result.message : `刷新失败: ${result.error}` }], isError: !result.success };
          case "go_back":
            result = await sendToExtension("goBackForward", { direction: "back", tabId });
            return { content: [{ type: "text", text: result.success ? `后退成功 → ${result.url}` : `导航失败: ${result.error}` }], isError: !result.success };
          case "go_forward":
            result = await sendToExtension("goBackForward", { direction: "forward", tabId });
            return { content: [{ type: "text", text: result.success ? `前进成功 → ${result.url}` : `导航失败: ${result.error}` }], isError: !result.success };
          case "full_screenshot":
            result = await sendToExtension("fullPageScreenshot", { tabId });
            if (result.success) {
              return { content: [{ type: "image", data: result.data, mimeType: "image/png" }], isError: false };
            }
            return { content: [{ type: "text", text: `整页截图失败: ${result.error}` }], isError: true };
          case "element_screenshot":
            result = await sendToExtension("elementScreenshot", { selector: args.selector, tabId });
            if (result.success) {
              return { content: [{ type: "image", data: result.data, mimeType: "image/png" }], isError: false };
            }
            return { content: [{ type: "text", text: `元素截图失败: ${result.error}` }], isError: true };
          case "upload_file":
            result = await sendToExtension("uploadFile", { selector: args.selector, filePath: args.filePath, tabId });
            return { content: [{ type: "text", text: result.success ? `上传成功: ${result.filePath}` : `上传失败: ${result.error}` }], isError: !result.success };
          case "download_file":
            result = await sendToExtension("downloadFile", { url: args.url, filename: args.filename, tabId });
            return { content: [{ type: "text", text: result.success ? `下载已启动 (ID: ${result.downloadId})\nURL: ${result.url}\n文件名: ${result.filename || "(默认)"}` : `下载失败: ${result.error}` }], isError: !result.success };
          case "save_pdf":
            result = await sendToExtension("savePDF", {
              tabId,
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
          case "handle_dialog":
            result = await sendToExtension("handleDialog", { action: args.dialogAction, tabId });
            return { content: [{ type: "text", text: result.success ? result.message : `弹窗处理失败: ${result.error}` }], isError: !result.success };
          default:
            throw new Error(`Unknown browser_page action: ${action}`);
        }
      }

      // ===== 合并工具：adapter =====
      case "adapter": {
        const action = args.action as string;
        switch (action) {
          case "list": {
            const page = await sendToExtension("getPageInfo", { tabId: args.tabId });
            result = await adapterRegistry.list(page.url);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          }
          case "extract":
            result = await adapterRegistry.extract(String(args.adapterId), typeof args.tabId === "number" ? args.tabId : undefined);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "best":
            result = await adapterRegistry.extractBest(typeof args.tabId === "number" ? args.tabId : undefined);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "health":
            result = await adapterRegistry.healthReport();
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          default:
            throw new Error(`Unknown adapter action: ${action}`);
        }
      }

      case "list_tabs": {
        const r = await sendToExtension("listTabs", {});
        const tabs: any[] = r.tabs ?? [];
        if (!tabs.length) return { content: [{ type: "text", text: "没有可见标签页" }] };
        const lines = tabs.map((t: any) => `${t.active ? "*" : " "} [${t.id}] ${t.title || "(无标题)"} — ${t.url}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ===== 会话运维 =====
      case "get_action_log": {
        const entries = bridge.actionLogEntries(typeof args.limit === "number" ? args.limit : 20);
        const status = bridge.status();
        const lines = entries.map((e: any) =>
          `[${e.startedAt}] ${e.success ? "OK " : "ERR"} ${e.action} (${e.durationMs ?? "?"}ms) session=${e.session}` +
          `${e.error ? ` — ${e.error}` : ""}`);
        const header = [
          `角色: ${status.role}`,
          `归属键 agentKey: ${status.agentKey}`,
          `实例键 instanceKey: ${status.instanceKey}`,
          `归属粒度 scope: ${status.scope}`,
          `活跃实例: ${status.activeSessions.length}`,
          "---",
        ].join("\n");
        return { content: [{ type: "text", text: `${header}\n${lines.join("\n") || "(无操作记录)"}` }] };
      }

      case "cleanup_sessions": {
        const r = await sendToExtension("cleanupSessions", {
          options: {
            onlyIdle: args.onlyIdle !== false,
            sessionId: typeof args.sessionId === "string" ? args.sessionId : undefined,
          },
        });
        return { content: [{ type: "text", text: `已清理 ${r.closed?.length ?? 0} 个组，剩余 ${r.remaining ?? "?"} 个` }] };
      }

      case "claim_session": {
        const r = await sendToExtension("claimSession", {
          options: {
            groupId: typeof args.groupId === "number" ? args.groupId : undefined,
            agentKey: typeof args.agentKey === "string" ? args.agentKey : undefined,
          },
        });
        if (!r.success) return { content: [{ type: "text", text: `认领失败: ${r.error}` }], isError: true };
        return { content: [{ type: "text", text: `认领成功: 标签组 ${r.groupId}（${r.tabCount} 个标签页）` }] };
      }

      case "browser_status": {
        const status = bridge.status();
        let browser: any = null;
        try {
          browser = await sendToExtension("getSessionStatus", {});
        } catch (error: any) {
          browser = { error: error.message };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              role: status.role,
              agentKey: status.agentKey,
              instanceKey: status.instanceKey,
              scope: status.scope,
              activeSessions: status.activeSessions,
              sessions: status.sessions,
              browser,
            }, null, 2),
          }],
        };
      }

      // ===== 合并工具：webmcp =====
      case "webmcp": {
        const action = args.action as string;
        switch (action) {
          case "health":
            result = await sendToExtension("webmcpHealth", { tabId: args.tabId });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "list":
            result = await sendToExtension("webmcpGetTools", { tabId: args.tabId });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "execute":
            result = await sendToExtension("webmcpExecuteTool", { toolName: String(args.toolName), input: args.input && typeof args.input === "object" ? args.input : {}, tabId: args.tabId });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          case "probe":
            result = await sendToExtension("probeCapabilities", { tabId: args.tabId });
            // Q11：在 JSON.stringify 之前追加 result.apiCommands，原有字段语义与前缀不变。
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  ...result,
                  apiCommands: await autoLoadApiCommands(result?.url),
                }, null, 2),
              }],
            };
          default:
            throw new Error(`Unknown webmcp action: ${action}`);
        }
      }

      // ===== 7 个独立具名 API 命令集工具（与上面 inputSchema 一一对应）=====
      case "analyze_page_apis":
        return apiToolCall(() => apiCommandService.analyze({
          action: args.action as AnalyzeAction,
          domain: typeof args.domain === "string" ? args.domain : undefined,
          analysisId: typeof args.analysisId === "string" ? args.analysisId : undefined,
          tabId: typeof args.tabId === "number" ? args.tabId : undefined,
          filter: args.filter && typeof args.filter === "object" && !Array.isArray(args.filter)
            ? args.filter as { urlContains?: string; mimeType?: string }
            : undefined,
          includeStaticAssets: args.includeStaticAssets === true,
          maxEndpoints: typeof args.maxEndpoints === "number" ? args.maxEndpoints : undefined,
          captureResponseBody: args.captureResponseBody === true,
          mode: args.mode === "full" ? "full" : args.mode === "merge" ? "merge" : undefined,
          overwriteManual: args.overwriteManual === true,
          sources: Array.isArray(args.sources) ? args.sources as SiteScanSource[] : undefined,
          allowPrivateHosts: args.allowPrivateHosts === true,
          allowCrossHost: args.allowCrossHost === true,
          extraHosts: Array.isArray(args.extraHosts)
            ? args.extraHosts.filter((item): item is string => typeof item === "string") : undefined,
          trustSpec: args.trustSpec === true,
          loosePaths: args.loosePaths === true,
          scanTimeoutMs: typeof args.scanTimeoutMs === "number" ? args.scanTimeoutMs : undefined,
          collectViaExtension: args.collectViaExtension === true,
          discoverBundles: args.discoverBundles === true,
          bundleMaxSources: typeof args.bundleMaxSources === "number" ? args.bundleMaxSources : undefined,
          bundleUseBrowserCache: args.bundleUseBrowserCache !== false,
        }));

      case "list_api_commands":
        return apiToolCall(async () => apiCommandService.list({
          domain: await resolveDomainArg(args),
          includeDisabled: args.includeDisabled === true,
          keyword: typeof args.keyword === "string" ? args.keyword : undefined,
          risk: args.risk === "read" || args.risk === "write" ? args.risk : undefined,
        }));

      case "get_api_command":
        return apiToolCall(async () => apiCommandService.get({
          domain: await resolveDomainArg(args),
          commandId: typeof args.commandId === "string" ? args.commandId : undefined,
          name: typeof args.name === "string" ? args.name : undefined,
        }));

      case "call_api_command":
        return apiToolCall(async () => apiCommandService.call({
          domain: await resolveDomainArg(args),
          commandId: typeof args.commandId === "string" ? args.commandId : undefined,
          name: typeof args.name === "string" ? args.name : undefined,
          params: args.params && typeof args.params === "object" && !Array.isArray(args.params)
            ? args.params as Record<string, unknown>
            : {},
          fields: Array.isArray(args.fields) ? args.fields as string[] : undefined,
          maxBodyChars: typeof args.maxBodyChars === "number" ? args.maxBodyChars : undefined,
          confirm: args.confirm === true,
          tabId: typeof args.tabId === "number" ? args.tabId : undefined,
          timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
        }));

      case "update_api_command":
        return apiToolCall(async () => apiCommandService.update({
          domain: await resolveDomainArg(args),
          commandId: typeof args.commandId === "string" ? args.commandId : "",
          name: typeof args.name === "string" ? args.name : undefined,
          params: Array.isArray(args.params) ? args.params : undefined,
          responseFields: Array.isArray(args.responseFields) ? args.responseFields : undefined,
          note: typeof args.note === "string" ? args.note : undefined,
          deprecated: typeof args.deprecated === "boolean" ? args.deprecated : undefined,
        }));

      case "invalidate_api_commands":
        return apiToolCall(async () => apiCommandService.invalidate({
          domain: await resolveDomainArg(args),
          commandId: typeof args.commandId === "string" ? args.commandId : undefined,
          action: args.action === "disable" || args.action === "delete" ? args.action : "clear_domain",
        }));

      case "get_api_command_cache":
        return apiToolCall(() => apiCommandService.cacheReport(
          typeof args.domain === "string" && args.domain.trim() ? args.domain.trim() : undefined,
        ));

      case "ai_search":
        return apiToolCall(() => apiCommandService.aiSearch({
          query: typeof args.query === "string" ? args.query : "",
          maxChars: typeof args.maxChars === "number" ? args.maxChars : undefined,
          maxCitations: typeof args.maxCitations === "number" ? args.maxCitations : undefined,
          timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
        }));

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
  // initialize 完成后用 clientInfo.name 重新派生归属键与实例键（同一窗口/项目重启归属键不变）
  server.oninitialized = () => {
    const clientInfo = server.getClientVersion();
    if (clientInfo?.name) bridge.setClientName(clientInfo.name);
    console.error(
      `[WebPilot MCP] Session: agent=${bridge.agentKey} instance=${bridge.instanceKey} scope=${bridge.scope} (role: ${bridge.role})`,
    );
  };
  await server.connect(transport);
  console.error(`[WebPilot MCP] Server running on stdio (role: ${bridge.role})`);
}

main().catch((err) => {
  console.error("[WebPilot MCP] Fatal error:", err);
  process.exit(1);
});
