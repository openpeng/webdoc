#!/usr/bin/env node
/**
 * WebPilot MCP Server
 * 暴露浏览器操作工具，供 Claude Code / Cursor / Codex 等 MCP 兼容 Agent 调用
 * 通过内置 WebSocket 服务直接与 Chrome 扩展通信
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import WebSocket, { WebSocketServer } from "ws";
import { TaskRuntime } from "./task-runtime.js";
import { AdapterRegistry } from "./adapters.js";

// The MCP process owns the local WebSocket bridge. This removes the need to
// start a separate daemon process before the browser extension can connect.
const PORT = Number(process.env.WEBPILOT_PORT) || 8765;
let extensionClient: WebSocket | null = null;
let requestIdCounter = 0;
type PendingRequest = { resolve: Function; reject: Function; timeout: NodeJS.Timeout };
type ActionLog = {
  id: number;
  action: string;
  parameters: Record<string, unknown>;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  success?: boolean;
  error?: string;
};
class BrowserActionError extends Error {
  constructor(message: string, readonly diagnostics?: unknown) {
    super(message);
    this.name = "BrowserActionError";
  }
}
const pendingRequests = new Map<number, PendingRequest>();
const actionLog: ActionLog[] = [];
const MAX_ACTION_LOG_ENTRIES = 100;

function safeParameters(params: Record<string, any>): Record<string, unknown> {
  // Keep diagnostics useful without retaining typed values or arbitrary scripts.
  const { text, script, ...safe } = params;
  return safe;
}

function logAction(entry: ActionLog) {
  actionLog.push(entry);
  if (actionLog.length > MAX_ACTION_LOG_ENTRIES) actionLog.shift();
}

function normalizeTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 10000;
  return Math.max(100, Math.min(Math.floor(value), 30000));
}

function rejectPendingRequests(error: Error) {
  for (const [requestId, pending] of pendingRequests) {
    clearTimeout(pending.timeout);
    pendingRequests.delete(requestId);
    pending.reject(error);
  }
}

function startBrowserBridge(): Promise<void> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: PORT });

    wss.once("listening", () => {
      console.error(`[WebPilot MCP] Browser bridge listening on ws://localhost:${PORT}`);
      resolve();
    });
    wss.once("error", reject);

    wss.on("connection", (socket) => {
      if (extensionClient && extensionClient.readyState === WebSocket.OPEN) {
        extensionClient.close(1000, "Replaced by a newer browser extension connection");
      }

      extensionClient = socket;
      console.error("[WebPilot MCP] Browser extension connected");

      socket.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (typeof msg.requestId === "number" && pendingRequests.has(msg.requestId)) {
          const { resolve, reject, timeout } = pendingRequests.get(msg.requestId)!;
          clearTimeout(timeout);
          pendingRequests.delete(msg.requestId);
          if (msg.success === false) {
            reject(new BrowserActionError(msg.error || "Unknown error", msg.diagnostics));
          } else {
            resolve(msg);
          }
        }
      } catch (error) {
        console.error("[WebPilot MCP] Failed to parse extension response:", error);
      }
      });

      socket.on("close", () => {
        if (extensionClient === socket) {
          extensionClient = null;
          console.error("[WebPilot MCP] Browser extension disconnected");
          rejectPendingRequests(new Error("Browser extension disconnected"));
        }
      });

      socket.on("error", (error) => {
        console.error("[WebPilot MCP] Browser extension socket error:", error.message);
      });
    });
  });
}

function sendToExtension(type: string, params: Record<string, any>): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!extensionClient || extensionClient.readyState !== WebSocket.OPEN) {
      reject(new Error("Browser extension is not connected. Open the WebPilot extension and click Connect."));
      return;
    }
    const requestId = ++requestIdCounter;
    const startedAt = Date.now();
    const entry: ActionLog = { id: requestId, action: type, parameters: safeParameters(params), startedAt: new Date(startedAt).toISOString() };
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      const error = new Error("Request timeout (30s)");
      logAction({ ...entry, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, success: false, error: error.message });
      reject(error);
    }, 30000);
    pendingRequests.set(requestId, {
      timeout,
      resolve: (result: any) => {
        logAction({ ...entry, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, success: true });
        resolve(result);
      },
      reject: (error: Error) => {
        logAction({ ...entry, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, success: false, error: error.message });
        reject(error);
      }
    });
    extensionClient.send(JSON.stringify({ type, requestId, ...params }));
  });
}

const taskRuntime = new TaskRuntime(sendToExtension);
const adapterRegistry = new AdapterRegistry(sendToExtension);

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
        description: "获取当前页面的可访问性风格快照，包括可交互元素和可复用的 @eN 引用",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
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
        description: "等待目标可操作后点击。支持 CSS、get_page_info 返回的 @eN、text=文本、role=button[name=\"文本\"]。",
        inputSchema: {
          type: "object" as const,
          properties: {
            selector: { type: "string", description: "CSS、@eN、text=文本或 role=button[name=\"文本\"]" },
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            timeoutMs: { type: "number", description: "等待目标可操作的毫秒数，默认 10000" },
          },
          required: ["selector"],
        },
      },
      {
        name: "type",
        description: "等待目标可操作后清空并输入文本；支持 input、textarea 与 contenteditable。",
        inputSchema: {
          type: "object" as const,
          properties: {
            selector: { type: "string", description: "CSS、@eN、text=文本或 role=textbox[name=\"文本\"]" },
            text: { type: "string", description: "要输入的文本" },
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
            timeoutMs: { type: "number", description: "等待目标可操作的毫秒数，默认 10000" },
          },
          required: ["selector", "text"],
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
        name: "get_action_log",
        description: "读取最近浏览器操作的时间线、耗时和错误信息；不会包含输入文本或执行脚本。",
        inputSchema: { type: "object" as const, properties: { limit: { type: "number", description: "最多返回条数，默认 20，最大 100" } }, required: [] }
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

      case "get_page_info":
        result = await sendToExtension("getPageInfo", { tabId: args.tabId });
        const elements = result.interactiveElements
          ?.map((e: any) => `${e.ref || ""} [${e.role || e.tag}] ${e.name || e.text || e.placeholder || e.id || "(no name)"}`)
          .join("\n") || "无";
        return {
          content: [{ type: "text", text: `页面: ${result.title}\nURL: ${result.url}\n状态: ${result.readyState}\n可交互元素数: ${result.elementCount}\n\n前60个元素（@eN 仅在页面未变化时有效）：\n${elements}` }],
        };

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

      case "click":
        result = await sendToExtension("click", { selector: args.selector, tabId: args.tabId, timeoutMs: normalizeTimeout(args.timeoutMs) });
        return {
          content: [{ type: "text", text: result.success
            ? `点击成功: <${result.tagName}> ${result.text || ""}\n耗时: ${result.diagnostics?.durationMs ?? "?"}ms`
            : `点击失败: ${result.error}` }],
        };

      case "type":
        result = await sendToExtension("type", { selector: args.selector, text: args.text, tabId: args.tabId, timeoutMs: normalizeTimeout(args.timeoutMs) });
        return {
          content: [{ type: "text", text: result.success
            ? `输入成功: <${result.tagName}>\n耗时: ${result.diagnostics?.durationMs ?? "?"}ms`
            : `输入失败: ${result.error}` }],
        };

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
        return { content: [{ type: "text", text: JSON.stringify(adapterRegistry.list(page.url), null, 2) }] };
      }

      case "extract_with_adapter":
        result = await adapterRegistry.extract(String(args.adapterId), typeof args.tabId === "number" ? args.tabId : undefined);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "extract_with_best_adapter":
        result = await adapterRegistry.extractBest(typeof args.tabId === "number" ? args.tabId : undefined);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

      case "get_adapter_health":
        return { content: [{ type: "text", text: JSON.stringify(adapterRegistry.healthReport(), null, 2) }] };

      case "get_action_log": {
        const limit = typeof args.limit === "number" ? Math.max(1, Math.min(Math.floor(args.limit), MAX_ACTION_LOG_ENTRIES)) : 20;
        return { content: [{ type: "text", text: JSON.stringify(actionLog.slice(-limit), null, 2) }] };
      }

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
  await startBrowserBridge();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[WebPilot MCP] Server running on stdio");
}

main().catch((err) => {
  console.error("[WebPilot MCP] Fatal error:", err);
  process.exit(1);
});
