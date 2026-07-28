#!/usr/bin/env node
/**
 * WebPilot Daemon
 * 本地桥接服务：WebSocket Server
 * - MCP Server 作为客户端连接进来（发送操作指令）
 * - 浏览器扩展作为客户端连接进来（执行浏览器操作）
 * - Daemon 作为中转，将 MCP Server 的指令转发给扩展，将扩展的响应返回给 MCP Server
 */

import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.WEBPILOT_PORT) || 8765;
const wss = new WebSocketServer({ port: PORT });

let mcpClient: WebSocket | null = null;
let extClient: WebSocket | null = null;

console.log(`[WebPilot Daemon] WebSocket server listening on ws://localhost:${PORT}`);

wss.on("connection", (ws, req) => {
  const clientType = req.headers["x-client-type"] as string | undefined;
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const typeFromQuery = url.searchParams.get("type");
  const resolvedType = clientType || typeFromQuery || "unknown";

  console.log(`[WebPilot Daemon] Client connected: ${resolvedType}`);

  if (resolvedType === "mcp") {
    if (mcpClient) {
      console.log("[WebPilot Daemon] MCP client already connected, closing old one");
      mcpClient.close();
    }
    mcpClient = ws;
    ws.send(JSON.stringify({ type: "hello", message: "Connected to WebPilot Daemon (MCP)" }));
  } else if (resolvedType === "extension") {
    if (extClient) {
      console.log("[WebPilot Daemon] Extension client already connected, closing old one");
      extClient.close();
    }
    extClient = ws;
    ws.send(JSON.stringify({ type: "hello", message: "Connected to WebPilot Daemon (Extension)" }));
  } else {
    // 自动识别：第一个不带类型标记的连接默认为 extension
    if (!extClient) {
      extClient = ws;
      console.log("[WebPilot Daemon] Auto-registered as extension (first connection)");
      ws.send(JSON.stringify({ type: "hello", message: "Connected to WebPilot Daemon (Extension, auto-detected)" }));
    } else if (!mcpClient) {
      mcpClient = ws;
      console.log("[WebPilot Daemon] Auto-registered as MCP (second connection)");
      ws.send(JSON.stringify({ type: "hello", message: "Connected to WebPilot Daemon (MCP, auto-detected)" }));
    } else {
      console.log("[WebPilot Daemon] Unknown client, rejecting");
      ws.close(1000, "Both MCP and Extension already connected");
      return;
    }
  }

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      routeMessage(ws, msg);
    } catch (e) {
      console.error("[WebPilot Daemon] Parse error:", e);
    }
  });

  ws.on("close", () => {
    if (ws === mcpClient) {
      console.log("[WebPilot Daemon] MCP client disconnected");
      mcpClient = null;
    } else if (ws === extClient) {
      console.log("[WebPilot Daemon] Extension client disconnected");
      extClient = null;
    }
  });

  ws.on("error", (err) => {
    console.error("[WebPilot Daemon] WebSocket error:", err.message);
  });
});

// 消息路由逻辑
function routeMessage(sender: WebSocket, msg: any) {
  // MCP Server -> Daemon -> Extension
  if (sender === mcpClient && extClient && extClient.readyState === WebSocket.OPEN) {
    extClient.send(JSON.stringify(msg));
    return;
  }

  // Extension -> Daemon -> MCP Server
  if (sender === extClient && mcpClient && mcpClient.readyState === WebSocket.OPEN) {
    mcpClient.send(JSON.stringify(msg));
    return;
  }

  // MCP Server 发送了指令，但扩展未连接
  if (sender === mcpClient && (!extClient || extClient.readyState !== WebSocket.OPEN)) {
    sender.send(JSON.stringify({
      requestId: msg.requestId,
      success: false,
      error: "Browser extension not connected. Please open Chrome extension and click Connect."
    }));
    return;
  }

  console.log("[WebPilot Daemon] Message dropped (no route):", msg.type);
}

// 优雅关闭
process.on("SIGINT", () => {
  console.log("\n[WebPilot Daemon] Shutting down...");
  wss.clients.forEach((ws) => ws.close());
  wss.close(() => process.exit(0));
});
