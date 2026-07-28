#!/usr/bin/env node
/**
 * WebPilot MCP Server
 * 暴露浏览器操作工具，供 Claude Code / Cursor / Codex 等 MCP 兼容 Agent 调用
 * 通过 WebSocket 与本地 Daemon 通信，由 Daemon 转发指令到 Chrome 扩展
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import WebSocket from "ws";

// ===== WebSocket 连接到 Daemon =====
const DAEMON_WS = process.env.WEBPILOT_DAEMON_URL || "ws://localhost:8765";
let ws: WebSocket | null = null;
let requestIdCounter = 0;
const pendingRequests = new Map<number, { resolve: Function; reject: Function; timeout: NodeJS.Timeout }>();

function connectDaemon(): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(DAEMON_WS);
    ws.on("open", () => {
      console.error("[WebPilot MCP] Connected to daemon:", DAEMON_WS);
      resolve();
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.requestId && pendingRequests.has(msg.requestId)) {
          const { resolve, reject, timeout } = pendingRequests.get(msg.requestId)!;
          clearTimeout(timeout);
          pendingRequests.delete(msg.requestId);
          if (msg.success === false) {
            reject(new Error(msg.error || "Unknown error"));
          } else {
            resolve(msg);
          }
        }
      } catch (e) {
        console.error("[WebPilot MCP] Parse daemon response error:", e);
      }
    });
    ws.on("close", () => {
      console.error("[WebPilot MCP] Daemon connection closed");
      ws = null;
      // 自动重连
      setTimeout(() => connectDaemon().catch(() => {}), 3000);
    });
    ws.on("error", (err) => {
      console.error("[WebPilot MCP] Daemon connection error:", err.message);
      reject(err);
    });
    setTimeout(() => reject(new Error("Connection timeout")), 5000);
  });
}

function sendToDaemon(type: string, params: Record<string, any>): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error("Not connected to daemon. Please start the daemon first."));
      return;
    }
    const requestId = ++requestIdCounter;
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("Request timeout (30s)"));
    }, 30000);
    pendingRequests.set(requestId, { resolve, reject, timeout });
    ws.send(JSON.stringify({ type, requestId, ...params }));
  });
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
        description: "获取当前页面信息，包括 URL、标题、可交互元素列表",
        inputSchema: {
          type: "object" as const,
          properties: {
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
          },
          required: [],
        },
      },
      {
        name: "click",
        description: "点击页面中匹配 CSS 选择器的元素",
        inputSchema: {
          type: "object" as const,
          properties: {
            selector: { type: "string", description: "CSS 选择器，如 #submit-btn" },
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
          },
          required: ["selector"],
        },
      },
      {
        name: "type",
        description: "在输入框中输入文本",
        inputSchema: {
          type: "object" as const,
          properties: {
            selector: { type: "string", description: "目标输入框的 CSS 选择器" },
            text: { type: "string", description: "要输入的文本" },
            tabId: { type: "number", description: "目标标签页 ID（可选）" },
          },
          required: ["selector", "text"],
        },
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
        name: "execute_js",
        description: "在当前页面执行 JavaScript 代码",
        inputSchema: {
          type: "object" as const,
          properties: {
            script: { type: "string", description: "要执行的 JavaScript 代码" },
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
    ],
  };
});

// 工具调用处理
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: any;

    switch (name) {
      case "navigate":
        result = await sendToDaemon("navigate", { url: args.url, tabId: args.tabId });
        return {
          content: [{ type: "text", text: `导航成功: ${result.title}\nURL: ${result.url}\n标签页ID: ${result.tabId}` }],
        };

      case "get_page_info":
        result = await sendToDaemon("getPageInfo", { tabId: args.tabId });
        const elements = result.interactiveElements
          ?.map((e: any, i: number) => `${i}. [${e.tag}] ${e.text || e.placeholder || e.id || "(no text)"}`)
          .join("\n") || "无";
        return {
          content: [{ type: "text", text: `页面: ${result.title}\nURL: ${result.url}\n可交互元素数: ${result.elementCount}\n\n前30个元素:\n${elements}` }],
        };

      case "click":
        result = await sendToDaemon("click", { selector: args.selector, tabId: args.tabId });
        return {
          content: [{ type: "text", text: result.success
            ? `点击成功: <${result.tagName}> ${result.text || ""}`
            : `点击失败: ${result.error}` }],
        };

      case "type":
        result = await sendToDaemon("type", { selector: args.selector, text: args.text, tabId: args.tabId });
        return {
          content: [{ type: "text", text: result.success
            ? `输入成功: <${result.tagName}>`
            : `输入失败: ${result.error}` }],
        };

      case "screenshot":
        result = await sendToDaemon("screenshot", { tabId: args.tabId });
        if (result.success && result.data) {
          return {
            content: [
              { type: "text", text: "截图已捕获" },
              { type: "image", data: result.data, mimeType: "image/png" },
            ],
          };
        }
        return { content: [{ type: "text", text: `截图失败: ${result.error}` }] };

      case "execute_js":
        result = await sendToDaemon("executeJs", { script: args.script, tabId: args.tabId });
        return {
          content: [{ type: "text", text: result.success
            ? `执行结果: ${result.result}`
            : `执行失败: ${result.error}` }],
        };

      case "list_tabs":
        result = await sendToDaemon("listTabs", {});
        const tabs = result.tabs?.map((t: any) => `[${t.active ? "*" : " "}] ${t.id}: ${t.title?.slice(0, 50)} (${t.url})`).join("\n");
        return {
          content: [{ type: "text", text: `当前标签页:\n${tabs}` }],
        };

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ===== 启动 =====
async function main() {
  await connectDaemon();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[WebPilot MCP] Server running on stdio");
}

main().catch((err) => {
  console.error("[WebPilot MCP] Fatal error:", err);
  process.exit(1);
});
