/**
 * BrowserBridge — Leader-Follower 进程共享桥
 *
 * 第一个抢到 8765 端口的进程成为 Leader：持有 Chrome 扩展连接，并在 8766
 * （仅 127.0.0.1）接受其他 WebPilot 进程（Follower）的命令转发。
 * 绑定 8765 失败的进程成为 Follower：以 WS 客户端连 8766 转发命令；
 * 与 Leader 断开后随机退避重试「绑 8765 → 成则晋升 / 败则重连 8766」。
 *
 * 每条命令都携带 sessionId（由 MCP clientInfo.name + 进程工作目录哈希派生），
 * 扩展据此把不同 agent 的 tab 隔离到各自的标签组。
 */

import WebSocket, { WebSocketServer } from "ws";
import { createHash } from "crypto";

const EXTENSION_PORT = Number(process.env.WEBPILOT_PORT) || 8765;
const PROXY_PORT = Number(process.env.WEBPILOT_PROXY_PORT) || EXTENSION_PORT + 1;
const BIND_HOST = "127.0.0.1";
const EXTENSION_TIMEOUT_MS = 30_000;
// Forward timeout must exceed the leader's extension timeout so the follower
// receives the leader's precise error instead of a generic timeout.
const FORWARD_TIMEOUT_MS = 35_000;
const RETRY_BACKOFF_MIN_MS = 200;
const RETRY_BACKOFF_MAX_MS = 1_000;
const MAX_ACTION_LOG_ENTRIES = 100;
const GROUP_TTL_MINUTES = Number(process.env.WEBPILOT_GROUP_TTL_MIN ?? 30);
const MAX_GROUPS = Number(process.env.WEBPILOT_MAX_GROUPS ?? 5);

export class BrowserActionError extends Error {
  constructor(message: string, readonly diagnostics?: unknown) {
    super(message);
    this.name = "BrowserActionError";
  }
}

export type BridgeRole = "leader" | "follower" | "starting";

type ActionLog = {
  id: number;
  action: string;
  session: string;
  parameters: Record<string, unknown>;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  success?: boolean;
  error?: string;
};

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout };

function safeParameters(params: Record<string, any>): Record<string, unknown> {
  // Keep diagnostics useful without retaining typed values or arbitrary scripts.
  const { text, script, ...safe } = params;
  return safe;
}

function backoffDelay(): number {
  return RETRY_BACKOFF_MIN_MS + Math.floor(Math.random() * (RETRY_BACKOFF_MAX_MS - RETRY_BACKOFF_MIN_MS));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class BrowserBridge {
  private roleValue: BridgeRole = "starting";
  private clientName = "agent";
  private sessionIdValue: string;

  // Leader state
  private extensionServer: WebSocketServer | null = null;
  private proxyServer: WebSocketServer | null = null;
  private extensionClient: WebSocket | null = null;
  private requestIdCounter = 0;
  private readonly pendingExtension = new Map<number, Pending>();
  private readonly followerSessions = new Map<WebSocket, string>();

  // Follower state
  private proxySocket: WebSocket | null = null;
  private cmdIdCounter = 0;
  private readonly pendingForward = new Map<number, Pending>();

  private readonly actionLog: ActionLog[] = [];
  private electing = false;

  constructor() {
    this.sessionIdValue = this.computeSessionId();
  }

  get role(): BridgeRole {
    return this.roleValue;
  }

  get sessionId(): string {
    return this.sessionIdValue;
  }

  /** MCP initialize 之后用 clientInfo.name 重新派生稳定 sessionId */
  setClientName(name: string): void {
    if (!name || name === this.clientName) return;
    this.clientName = name;
    this.sessionIdValue = this.computeSessionId();
    if (this.roleValue === "leader") {
      this.pushSessionUpdate();
    } else if (this.proxySocket?.readyState === WebSocket.OPEN) {
      this.proxySocket.send(JSON.stringify({ kind: "hello", sessionId: this.sessionIdValue }));
    }
  }

  status(): { role: BridgeRole; sessionId: string; activeSessions: string[] } {
    return { role: this.roleValue, sessionId: this.sessionIdValue, activeSessions: this.activeSessionList() };
  }

  actionLogEntries(limit: number): ActionLog[] {
    const capped = Math.max(1, Math.min(Math.floor(limit), MAX_ACTION_LOG_ENTRIES));
    return this.actionLog.slice(-capped);
  }

  async start(): Promise<void> {
    await this.elect();
  }

  /** 对外与旧 sendToExtension 同签名；自动附加本进程 sessionId */
  send(type: string, params: Record<string, any>): Promise<any> {
    if (this.roleValue === "leader") {
      return this.sendViaExtension(type, params, this.sessionIdValue);
    }
    if (this.roleValue === "follower") {
      return this.forwardToLeader(type, params);
    }
    return Promise.reject(new Error("Browser bridge is still starting. Retry in a moment."));
  }

  // ===== 竞选 =====

  private computeSessionId(): string {
    const slug = this.clientName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
    const cwdHash = createHash("sha256").update(process.cwd().toLowerCase()).digest("hex").slice(0, 6);
    return `${slug}-${cwdHash}`;
  }

  private async elect(): Promise<void> {
    if (this.electing) return;
    this.electing = true;
    try {
      // 竞选循环：先尝试成为 Leader，失败（端口被占）则以 Follower 连接代理口。
      for (;;) {
        try {
          await this.becomeLeader();
          return;
        } catch (error: any) {
          if (error?.code !== "EADDRINUSE") {
            console.error("[WebPilot MCP] Failed to bind extension port:", error?.message || error);
          }
        }
        try {
          await this.becomeFollower();
          return;
        } catch {
          // Leader 可能刚退出而端口仍在释放；退避后重试竞选。
        }
        await delay(backoffDelay());
      }
    } finally {
      this.electing = false;
    }
  }

  private becomeLeader(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: BIND_HOST, port: EXTENSION_PORT });
      wss.once("error", reject);
      wss.once("listening", () => {
        this.extensionServer = wss;
        this.roleValue = "leader";
        console.error(`[WebPilot MCP] Role: leader — browser bridge on ws://${BIND_HOST}:${EXTENSION_PORT}`);
        wss.on("connection", socket => this.handleExtensionConnection(socket));
        this.startProxyServer();
        resolve();
      });
    });
  }

  private startProxyServer(): void {
    const proxy = new WebSocketServer({ host: BIND_HOST, port: PROXY_PORT });
    proxy.once("error", error => {
      // 没有代理口时本进程仍可独立工作，只是其他进程无法共享。
      console.error(`[WebPilot MCP] Failed to bind follower proxy port ${PROXY_PORT}:`, (error as Error).message);
    });
    proxy.once("listening", () => {
      this.proxyServer = proxy;
      console.error(`[WebPilot MCP] Follower proxy listening on ws://${BIND_HOST}:${PROXY_PORT}`);
    });
    proxy.on("connection", socket => this.handleFollowerConnection(socket));
  }

  private handleExtensionConnection(socket: WebSocket): void {
    if (this.extensionClient && this.extensionClient.readyState === WebSocket.OPEN) {
      this.extensionClient.close(1000, "Replaced by a newer browser extension connection");
    }
    this.extensionClient = socket;
    console.error("[WebPilot MCP] Browser extension connected");
    this.pushSessionUpdate();

    socket.on("message", data => {
      try {
        const msg = JSON.parse(data.toString());
        if (typeof msg.requestId === "number" && this.pendingExtension.has(msg.requestId)) {
          const pending = this.pendingExtension.get(msg.requestId)!;
          clearTimeout(pending.timeout);
          this.pendingExtension.delete(msg.requestId);
          if (msg.success === false) {
            pending.reject(new BrowserActionError(msg.error || "Unknown error", msg.diagnostics));
          } else {
            pending.resolve(msg);
          }
        }
      } catch (error) {
        console.error("[WebPilot MCP] Failed to parse extension response:", error);
      }
    });

    socket.on("close", () => {
      if (this.extensionClient !== socket) return;
      this.extensionClient = null;
      console.error("[WebPilot MCP] Browser extension disconnected");
      this.rejectPending(this.pendingExtension, new Error("Browser extension disconnected"));
    });

    socket.on("error", error => {
      console.error("[WebPilot MCP] Browser extension socket error:", error.message);
    });
  }

  private handleFollowerConnection(socket: WebSocket): void {
    socket.on("message", data => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.kind === "hello" && typeof msg.sessionId === "string") {
        this.followerSessions.set(socket, msg.sessionId);
        console.error(`[WebPilot MCP] Follower joined: ${msg.sessionId.slice(0, 8)}`);
        this.pushSessionUpdate();
        return;
      }
      if (msg.kind === "cmd" && typeof msg.cmdId === "number") {
        const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : this.followerSessions.get(socket) || "unknown";
        this.sendViaExtension(String(msg.type), msg.params || {}, sessionId)
          .then(payload => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ kind: "result", cmdId: msg.cmdId, ok: true, payload }));
            }
          })
          .catch((error: any) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ kind: "result", cmdId: msg.cmdId, ok: false, error: error.message, diagnostics: error.diagnostics }));
            }
          });
      }
    });

    socket.on("close", () => {
      const sessionId = this.followerSessions.get(socket);
      this.followerSessions.delete(socket);
      if (sessionId) {
        console.error(`[WebPilot MCP] Follower left: ${sessionId.slice(0, 8)}`);
        this.pushSessionUpdate();
      }
    });

    socket.on("error", () => { /* close 事件负责清理 */ });
  }

  private activeSessionList(): string[] {
    const sessions = new Set<string>([this.sessionIdValue]);
    for (const sessionId of this.followerSessions.values()) sessions.add(sessionId);
    return [...sessions];
  }

  /** 把「活跃 session 列表 + 组回收配置」下发扩展，驱动 idle 标记与 TTL 回收 */
  private pushSessionUpdate(): void {
    if (this.roleValue !== "leader" || !this.extensionClient || this.extensionClient.readyState !== WebSocket.OPEN) return;
    this.extensionClient.send(JSON.stringify({
      type: "sessionUpdate",
      activeSessions: this.activeSessionList(),
      config: { ttlMinutes: GROUP_TTL_MINUTES, maxGroups: MAX_GROUPS },
    }));
  }

  // ===== Leader：直连扩展 =====

  private sendViaExtension(type: string, params: Record<string, any>, sessionId: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.extensionClient || this.extensionClient.readyState !== WebSocket.OPEN) {
        reject(new Error("Browser extension is not connected. Open the WebPilot extension and click Connect."));
        return;
      }
      const requestId = ++this.requestIdCounter;
      const startedAt = Date.now();
      const entry: ActionLog = {
        id: requestId,
        action: type,
        session: sessionId.slice(0, 8),
        parameters: safeParameters(params),
        startedAt: new Date(startedAt).toISOString(),
      };
      const timeout = setTimeout(() => {
        this.pendingExtension.delete(requestId);
        const error = new Error("Request timeout (30s)");
        this.logAction({ ...entry, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, success: false, error: error.message });
        reject(error);
      }, EXTENSION_TIMEOUT_MS);
      this.pendingExtension.set(requestId, {
        timeout,
        resolve: result => {
          this.logAction({ ...entry, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, success: true });
          resolve(result);
        },
        reject: error => {
          this.logAction({ ...entry, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, success: false, error: error.message });
          reject(error);
        },
      });
      this.extensionClient.send(JSON.stringify({ type, requestId, sessionId, ...params }));
    });
  }

  // ===== Follower：经 Leader 转发 =====

  private becomeFollower(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://${BIND_HOST}:${PROXY_PORT}`);
      let opened = false;

      socket.on("open", () => {
        opened = true;
        this.proxySocket = socket;
        this.roleValue = "follower";
        socket.send(JSON.stringify({ kind: "hello", sessionId: this.sessionIdValue }));
        console.error(`[WebPilot MCP] Role: follower — forwarding via ws://${BIND_HOST}:${PROXY_PORT}`);
        resolve();
      });

      socket.on("message", data => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.kind !== "result" || typeof msg.cmdId !== "number") return;
          const pending = this.pendingForward.get(msg.cmdId);
          if (!pending) return;
          clearTimeout(pending.timeout);
          this.pendingForward.delete(msg.cmdId);
          if (msg.ok) pending.resolve(msg.payload);
          else pending.reject(new BrowserActionError(msg.error || "Unknown error", msg.diagnostics));
        } catch (error) {
          console.error("[WebPilot MCP] Failed to parse leader response:", error);
        }
      });

      socket.on("close", () => {
        if (!opened) return;
        if (this.proxySocket === socket) this.proxySocket = null;
        this.roleValue = "starting";
        this.rejectPending(this.pendingForward, new Error("Lost connection to the WebPilot leader process"));
        console.error("[WebPilot MCP] Leader connection lost, re-electing…");
        // Leader 退出后重新竞选：可能晋升为新 Leader，也可能连上新 Leader。
        setTimeout(() => void this.elect(), backoffDelay());
      });

      socket.on("error", error => {
        if (!opened) reject(error);
      });
    });
  }

  private forwardToLeader(type: string, params: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.proxySocket || this.proxySocket.readyState !== WebSocket.OPEN) {
        reject(new Error("Browser bridge is reconnecting to the leader process. Retry in a moment."));
        return;
      }
      const cmdId = ++this.cmdIdCounter;
      const startedAt = Date.now();
      const entry: ActionLog = {
        id: cmdId,
        action: type,
        session: this.sessionIdValue.slice(0, 8),
        parameters: safeParameters(params),
        startedAt: new Date(startedAt).toISOString(),
      };
      const timeout = setTimeout(() => {
        this.pendingForward.delete(cmdId);
        const error = new Error(`Forwarded request timeout (${FORWARD_TIMEOUT_MS / 1000}s)`);
        this.logAction({ ...entry, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, success: false, error: error.message });
        reject(error);
      }, FORWARD_TIMEOUT_MS);
      this.pendingForward.set(cmdId, {
        timeout,
        resolve: result => {
          this.logAction({ ...entry, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, success: true });
          resolve(result);
        },
        reject: error => {
          this.logAction({ ...entry, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, success: false, error: error.message });
          reject(error);
        },
      });
      this.proxySocket.send(JSON.stringify({ kind: "cmd", cmdId, type, params, sessionId: this.sessionIdValue }));
    });
  }

  // ===== 公共辅助 =====

  private rejectPending(pendingMap: Map<number, Pending>, error: Error): void {
    for (const [id, pending] of pendingMap) {
      clearTimeout(pending.timeout);
      pendingMap.delete(id);
      pending.reject(error);
    }
  }

  private logAction(entry: ActionLog): void {
    this.actionLog.push(entry);
    if (this.actionLog.length > MAX_ACTION_LOG_ENTRIES) this.actionLog.shift();
  }
}
