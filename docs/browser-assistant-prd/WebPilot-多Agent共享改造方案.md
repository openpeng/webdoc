# WebPilot 多 Agent 共享改造方案（Leader-Follower + 标签组会话隔离 + 组生命周期）

## 目标

- 多个 MCP 客户端（多个 Qoder 项目窗口、Codex CLI 等）可同时使用 WebPilot，不再因 8765 端口独占而启动失败
- 客户端 MCP 配置（stdio 方式）不变
- 多 agent **并行**操作浏览器互不干扰：每个 agent 有自己的标签组，只在自己的组内工作，不做全局串行
- 标签组**不无限膨胀**：复用优先、断开标记闲置、超时/超限自动回收

## 第一部分：进程共享 —— Leader-Follower 自动代理

```
Chrome 扩展 ←ws://127.0.0.1:8765→ [Leader 进程]（第一个抢到端口的 server.js）
                                     ↑ ws://127.0.0.1:8766（内部代理口）
                                     ├── [Follower 进程 1]（Qoder 窗口 2）
                                     └── [Follower 进程 2]（Codex）
```

- **Leader**：成功绑定 8765 的进程，持有扩展连接，另在 8766（仅 127.0.0.1）接受 Follower 转发
- **Follower**：绑定 8765 失败（EADDRINUSE）时不再退出，以 WS 客户端连 8766，把命令转发给 Leader
- **竞选与接管**：Follower 与 Leader 断开后，200–1000ms 随机退避重试"绑 8765 → 成则晋升 / 败则重连 8766"；晋升后扩展自动重连（扩展已有重连能力）
- **sessionId 稳定派生**：由 MCP `initialize` 的 `clientInfo.name` + 进程工作目录哈希生成（如 `qoder-a1b2c3`），同一窗口/项目重启后仍是同一 id，从根源避免组随重启膨胀；本地与转发命令都携带该 id，Leader 接管、进程重启不影响其他 agent 会话

## 第二部分：并发控制 —— 标签组会话隔离（替代全局串行）

### 核心模型：一个 agent = 一个标签组

- 扩展为每个 sessionId 创建专属标签组，命名 `WebPilot·{短id}`、不同颜色；现有 `addTabToWebPilotGroup` 升级为按 session 分组，`sessionId → {groupId, state, lastActiveAt}` 映射存 `storage.local`（service worker 休眠/浏览器重启均可恢复）
- 用户肉眼可分辨哪个 agent 在操作哪些页面

### 默认 tab 语义改造（消除互踩根源）

- 现状：`getTargetTabId` 不传 tabId 时取"当前活跃 tab"，多 agent 全指向同一个前台 tab
- 改为：**取本 session 组内最近使用的 tab**；组内无 tab 时自动新建空 tab 纳入本组
- 显式传 tabId 时：tab 属其他 session 的组 → 拒绝并提示；tab 不属任何 WebPilot 组（用户自己的 tab）→ 沿用 markTabAsManaged 行为认领进本组

### 并发执行模型（三层）

1. **跨组并行**：不同 session 的命令并发执行（`navigate`/`click`/`type`/`waitFor`/`getPageText` 等基于 executeScript/tabs API，后台 tab 可直接执行）
2. **同 tab 串行**：每个 tabId 一条命令队列（Map<tabId, promise 链>），同组不同 tab 也可并行
3. **前台锁（全局小互斥）**：仅覆盖必须可见的命令——`screenshot`（captureVisibleTab）、`click_at`（视口坐标）：抢锁 → 激活 tab → 执行 → 释放，锁粒度为单命令（百 ms 级）

### 不再需要租约

隔离取代互斥：agent 间没有共享默认 tab，写命令无需租约，前版软租约机制整体取消。

## 第三部分：标签组生命周期 —— 复用优先、闲置标记、超时回收

### 1. 复用优先（治本）

- 稳定 sessionId 使同一 agent 重启后认领**同一个组**，正常使用下组数 ≈ 实际在用的 agent 数
- 新会话启动顺序：① 找同 sessionId 组认领 → ② 找不到则认领任一 `idle` 组（复用 tab 与登录态并重命名）→ ③ 再没有才新建

### 2. 会话结束 = 标记闲置，不立即删除

- Leader 实时感知会话存活（自身 stdio 断开 = 本进程退出；Follower 代理连接断开 = 对端退出），维护"活跃 sessionId 列表"并同步扩展
- 会话断开后其组转 `idle`：**变灰 + 折叠 + 标题追加 `·idle`**，tab 全部保留（便于回看结果页、保留登录态）

### 3. 兜底回收（TTL + 上限 + 手动）

| 机制 | 行为 | 默认值 |
| --- | --- | --- |
| 闲置 TTL | idle 组超时后自动关闭整组 tab 并删映射 | 30 分钟，`WEBPILOT_GROUP_TTL_MIN` 可调，`0` = 永不自动关 |
| 组数上限 | 超上限时关闭最旧 idle 组（活跃组永不回收） | 5，`WEBPILOT_MAX_GROUPS` 可调 |
| 手动清理 | popup「清理闲置组」按钮 + MCP 工具 `cleanup_sessions`（支持只清 idle 或指定 sessionId） | — |

- TTL 回收由 `chrome.alarms` 周期触发（约每 5 分钟扫描），不依赖 service worker 常驻

## 代码变更

### 1. `mcp-server/src/bridge.ts`（新文件）

- `class BrowserBridge`：竞选循环、Leader 的扩展桥接 + 8766 代理服务、Follower 转发通道；对外暴露与 `sendToExtension(type, params)` 同签名的 `send()`
- 每条命令附加 `sessionId`（本地用自身 id，转发用 Follower 上报 id）；Leader 把"活跃 session 列表"下发扩展驱动 idle 标记
- 8765/8766 均绑定 `127.0.0.1`（修掉现在绑 `::` 全网卡的隐患）；转发超时 35s（大于扩展侧 30s）；action log 记录 sessionId 前 8 位

### 2. `mcp-server/src/server.ts`

- 删除内联 `startBrowserBridge` / `sendToExtension` / pendingRequests，实例化 `BrowserBridge`，`bridge.send` 注入 `TaskRuntime` / `AdapterRegistry`（两者零改动）
- `main()` 改为 `await bridge.start()`，日志输出角色；`get_action_log` 附带角色与会话状态
- 新增 MCP 工具 `cleanup_sessions`（参数 `onlyIdle`/`sessionId`），转发到扩展执行组回收

### 3. `browser-extension/background.js`（本版主要改动点）

- 会话分组：`ensureSessionGroup(sessionId)`，升级 `findWebPilotTabGroup` / `addTabToWebPilotGroup` 为按 session 维护；映射持久化 `storage.local`（含 state/lastActiveAt）
- `getTargetTabId(tabId, sessionId)`：默认 tab 语义与跨组校验
- per-tab 命令队列 + 全局前台锁；`screenshot`、`click_at` 标记需前台
- 生命周期：`markGroupIdle(sessionId)`（变灰+折叠+`·idle`）、`reclaimIdleGroup()`（认领复用）、`cleanupGroups({onlyIdle, sessionId})`（关闭回收）；`chrome.alarms` 周期跑 TTL 与上限回收
- 组被用户手动关闭时清理映射（`tabGroups.onRemoved` 已有监听，补 session 清理）

### 4. `browser-extension/popup.js` / popup UI（小改）

- 显示活跃/闲置 session 数与各组 tab 数；新增「清理闲置组」按钮；紧急停止语义不变（全局断开）

### 5. `INSTALL.md`

- 更新 Leader-Follower 行为、8766 内部端口、标签组会话模型与生命周期（TTL/上限环境变量）说明
- 故障排查表新增：tab 被拒绝操作 → 属其他 agent 的标签组；组消失 → 被 TTL/上限回收

## 测试计划

1. **单进程回归**：单实例成为 Leader，扩展连接、`list_tabs` / `navigate` 正常，tab 进入自己的标签组
2. **双进程共享**：第二个实例成为 Follower，各自 `navigate` 产生两个独立标签组，互不影响
3. **并行验证**：两个 session 同时连发 `navigate` + `get_page_text`（脚本模拟），并行完成且各自组内 tab 正确
4. **同 tab 串行**：同一 session 对同一 tab 连发命令，按序执行
5. **前台锁**：两个 session 同时 `screenshot`，排队执行、两张截图各自正确
6. **跨组保护**：session A 显式传 session B 的 tabId，被拒绝
7. **Leader 接管**：kill Leader，Follower 数秒内晋升，扩展重连，标签组映射不丢（storage.local 恢复）
8. **复用验证**：同一 agent 重启后认领同一个组（组不新增）；断开后组变灰 `·idle`；再启动优先复用 idle 组
9. **回收验证**：idle 组超 TTL 自动关闭；组数超上限时最旧 idle 组被关；`cleanup_sessions` 与 popup 按钮均能清理
10. **实机验证**：Qoder 保持连接 + 手动再起一个 server.js 进程，走一遍 2–9

## 假设与限制

- 扩展端本版**需要改动**（background.js 为主），改后需在 chrome://extensions 手动 Reload
- 同一时刻仅一个 tab 可见：多 agent 密集截图会有 tab 切换闪烁，属固有限制
- 域名白名单、只读模式、紧急停止仍全局生效，不按 session 拆分
- 废弃的 `daemon/` 目录不动、不复用
- 客户端 MCP 配置不变（stdio `node .../dist/server.js`）
