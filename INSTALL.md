# Install WebPilot

WebPilot connects an MCP-compatible AI client to Chrome through a local Chrome extension. Multiple MCP Server processes can run at the same time: the first process to bind port `8765` becomes the **leader** (it owns the extension connection), and every other process becomes a **follower** that forwards commands through the leader. Do not run the legacy `daemon/` package.

## Prerequisites

- Google Chrome or another Chromium browser that supports Manifest V3 extensions.
- Node.js and npm (use a current LTS release).
- An MCP-compatible AI client that can launch a local stdio server.

## 1. Install the Chrome extension

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the `browser-extension/` directory (see *Where to find the extension* below).
5. Open the WebPilot extension popup and keep the domain allowlist as narrow as practical. Enable read-only mode if the agent only needs to inspect pages.

After changing any file in `browser-extension/`, return to `chrome://extensions/` and select **Reload** on the WebPilot extension card.

#### Where to find the extension

The extension is never auto-installed into Chrome — you must load it manually once. Its files ship alongside the MCP Server package, so where you point **Load unpacked** depends on how you installed:

- **Installed from npm** (recommended): the `browser-extension/` folder is unpacked to the global package. Find it with `npm root -g`, then open the `webpilot-mcp-server/browser-extension/` subdirectory:
  ```bash
  npm root -g
  # Windows:   %APPDATA%\npm\node_modules\webpilot-mcp-server\browser-extension\
  # macOS/Linux: $(npm root -g)/webpilot-mcp-server/browser-extension/
  ```
- **Built from source**: use the project's own `browser-extension/` folder at the repository root (contains `manifest.json`, `background.js`, `page-tools.js`, `popup.html`, `popup.js`, and `icons/`).

## 2. Install the MCP Server (from npm, recommended)

The server is published to npm as [`webpilot-mcp-server`](https://www.npmjs.com/package/webpilot-mcp-server) with a `webpilot-mcp` CLI bin. Install it globally (or use `npx`):

```bash
npm install -g webpilot-mcp-server
# 或临时使用：npx webpilot-mcp-server
```

Registration then only needs the command name — no local path:

```json
{
  "mcpServers": {
    "webpilot": {
      "command": "webpilot-mcp"
    }
  }
}
```

The published package ships the compiled `dist/`, `definitions/`, `skills/`, and `browser-extension/`; the server starts a WebSocket bridge at `ws://localhost:8765` when the AI client launches it.

### Alternative: build from source

From the project root:

```bash
npm install
npm run build
```

This creates `mcp-server/dist/server.js`. Register it with an absolute path (see the Windows example below).

### Multi-agent sharing (leader-follower)

Each MCP client (for example two different AI IDEs, or two windows of the same IDE in different workspaces) launches its own MCP Server process:

- The first process binds `127.0.0.1:8765` and becomes the **leader**. It holds the single extension connection and additionally listens on `127.0.0.1:8766` as an internal proxy port for other processes.
- Later processes detect that `8765` is taken, connect to `8766`, and become **followers**. Their commands are forwarded through the leader transparently.
- When the leader exits, followers re-elect after a short random backoff: one of them binds `8765` and is promoted; the extension reconnects to the new leader automatically.

Both ports bind to `127.0.0.1` by default (`WEBPILOT_HOST` overrides the bridge interface, `WEBPILOT_PROXY_HOST` the internal proxy). No extra configuration is needed for local multi-agent use. To let a browser extension on another machine connect, set `WEBPILOT_HOST=0.0.0.0` (or a specific interface IP) and enter `ws://<server-ip>:8765` in the extension popup; to share one leader across hosts, also set `WEBPILOT_PROXY_HOST=0.0.0.0` on the leader and `WEBPILOT_LEADER_HOST=<leader-ip>` on the followers.

### Tab-group session model

Every MCP process derives **two** identity keys. They are deliberately separate, because one key cannot satisfy both isolation and restart-reuse:

| Key | Meaning | Derivation |
| --- | --- | --- |
| `agentKey` | Ownership — which logical session this is; decides which group a restarting session reclaims | `WEBPILOT_SESSION_ID` when the host injects one, otherwise the MCP client name plus a hash of the working directory |
| `instanceKey` | Isolation — which live session instance this is; decides the tab group and the default tab | `agentKey` plus a per-process suffix (pid + start time + random), so every concurrent process is unique |

The extension gives every **instance** its own Chrome tab group named `WebPilot·{agent}-{instance}`:

- Commands without an explicit `tabId` operate on the most recently used tab **inside that instance's group** (a new tab is created in the group if it has none).
- Commands with an explicit `tabId` that belongs to another instance's group are rejected — including another instance that shares the same `agentKey` — so parallel agents cannot interfere with each other.
- `list_tabs` only returns tabs from the caller's own group plus the user's ungrouped tabs; other sessions' pages are not exposed.
- Different groups run in parallel; commands on the same tab run one at a time; screenshot/click-at briefly focus the tab under a global foreground lock.

Because the `agentKey` fallback (client name + working directory) is only **host-level**, several sessions of the same host can share it. The isolation key still separates them, but restart-reuse can then be ambiguous — see below.

### Group lifecycle and reclaiming

- When a session's MCP process disconnects, its group is marked idle: the title gains an `·idle` suffix, the group turns grey and collapses. The tabs and their login state are kept.
- A restarting session **reclaims** its own idle group and lands on the same page it used before. Reclaiming follows a safety ladder:
  1. `agentKey` is session-scoped (`WEBPILOT_SESSION_ID` injected) → the most recent idle group with that `agentKey` is reclaimed.
  2. `agentKey` is host-scoped but exactly one idle group matches and no sibling instance shares the key → that group is reclaimed.
  3. Otherwise nothing is reclaimed and a fresh group is created, so a session can never inherit another session's tabs or login state.
- Manual reclaim: the `claim_session` tool (`groupId` or `agentKey`) hands a specific idle group to the calling session.
- Idle groups are garbage-collected after a TTL (default 30 minutes, env `WEBPILOT_GROUP_TTL_MIN` on the leader process) and the total number of groups is capped (default 5, env `WEBPILOT_MAX_GROUPS`; the oldest idle groups are closed first). The cap counts **live instances**, so raise it when more agents run in parallel.
- Manual cleanup: the extension popup has a **清理闲置组** button, and MCP clients can call the `cleanup_sessions` tool (`onlyIdle` defaults to `true`; pass a `sessionId` to close a specific group).
- `browser_status` reports the current role, `agentKey`, `instanceKey`, scope and every group in the browser — the fastest way to see which session owns what.

## 3. Register the MCP Server

If you installed from npm (recommended), the config only needs the command name:

```json
{
  "mcpServers": {
    "webpilot": {
      "command": "webpilot-mcp"
    }
  }
}
```

If you built from source, point `args` at the compiled server. Replace the path with the absolute path on your computer:

```json
{
  "mcpServers": {
    "webpilot": {
      "command": "node",
      "args": ["/absolute/path/to/webdoc/mcp-server/dist/server.js"]
    }
  }
}
```

On Windows, JSON paths can use forward slashes:

```json
{
  "mcpServers": {
    "webpilot": {
      "command": "node",
      "args": ["F:/mycode/mcp-servers/webdoc/mcp-server/dist/server.js"]
    }
  }
}
```

Restart or reconnect the AI client after saving its configuration.

## 4. Connect and verify

1. Start or reconnect the AI client so that it launches the MCP Server.
2. Open the WebPilot extension popup in Chrome.
3. Confirm that it reports a connection to the configured address (`ws://localhost:8765` by default). If the MCP server is remote, enter its `ws://<host>:<port>` in the popup's **MCP server address** field first. If necessary, select **Connect**.
4. Ask the AI client to call `list_tabs` or `get_page_info`.

The extension normally reconnects after installation, Chrome startup, and unexpected disconnects. Selecting **Disconnect** disables automatic reconnection; select **Connect** to enable it again.

## Read pages as Markdown

`get_page_text` can return the page as Markdown instead of plain text. The conversion runs on the server with the open-source `turndown` + `turndown-plugin-gfm` libraries, so the model does not spend tokens re-formatting HTML into Markdown, and the output is stable and reproducible.

- Pass `format: "markdown"` to get a Markdown document of the page body. The browser extension detects the main content container and strips navigation, sidebars, and toolbars automatically, so the Markdown starts at the real article. This is verified on Confluence, GitLab, and antd-style admin consoles.
- GitHub Flavored Markdown is on by default (`gfm: true`): tables, strikethrough, and task lists are converted. antd's split header/body tables are merged into a single Markdown table.
- Inline `data:` images (logos, base64 or `svg+xml` data URIs) are replaced with a placeholder (`![图片]` or `![alt](data:image/placeholder)`) so the Markdown stays compact.
- Use `baseUrl` to resolve relative links and images to absolute URLs; when reading a live tab it defaults to the current page URL.
- Extra formatting knobs: `headingStyle` (atx/setext), `bulletListMarker`, `codeBlockStyle`, `emDelimiter`, `strongDelimiter`, `linkStyle` (inlined/referenced), and `remove`/`keep` tag lists.
- Set `returnFormat: "json"` to receive `{ markdown, length }` metadata instead of the raw document.
- Convert raw HTML without a browser: pass the `html` string together with `format: "markdown"` and the conversion runs entirely server side.
- Cross-origin iframe penetration (see above) also applies in Markdown mode: when the main page body is empty, the iframe body is extracted and converted to Markdown.

## Security controls

The extension enforces these controls locally, including for MCP clients:

- **Domain allowlist:** Enter one domain per line or separate domains with commas. Cross-domain redirects outside the allowlist are blocked. An empty allowlist permits all domains.
- **Read-only mode:** Allows observation, screenshots, waits, and navigation, but blocks clicks, typing, and page JavaScript.
- **Emergency stop:** Immediately disconnects the bridge, disables automatic reconnection, and rejects new remote commands. Select **Connect** to resume deliberately.

## Port and address configuration

The MCP Server reads `WEBPILOT_PORT` (extension bridge, default `8765`), `WEBPILOT_HOST` (bridge interface, default `127.0.0.1`), `WEBPILOT_PROXY_PORT` (internal leader-follower proxy, default `WEBPILOT_PORT + 1`, i.e. `8766`), `WEBPILOT_PROXY_HOST` (proxy interface, default `127.0.0.1`), `WEBPILOT_LEADER_HOST` (leader host a follower dials, default `127.0.0.1`), and `WEBPILOT_AUTH_TOKEN` (remote bridge token, default empty — see below).

Two further variables control session identity and group reuse:

| Variable | Default | Effect |
| --- | --- | --- |
| `WEBPILOT_SESSION_ID` | unset | The host injects a **per-session** unique id. It becomes the `agentKey`, which makes group reclaiming exact: a restarted session returns to its own group, and two sessions of the same host never share one. Inject it from the client that spawns the MCP server (one value per conversation). |
| `WEBPILOT_ALLOW_CROSS_AGENT_RECLAIM` | `0` | Allows a session to adopt an idle group that belongs to a **different** `agentKey`. Off by default because that also inherits the other session's logged-in pages. |

A host that starts several conversations of the same MCP client in one workspace should inject `WEBPILOT_SESSION_ID`; without it those conversations share one `agentKey` and therefore can only be isolated, not reclaimed precisely (the safety ladder above falls back to "create a fresh group").

The extension's target address is configurable in its popup (**MCP server address**) and persisted in `chrome.storage`; it defaults to `ws://localhost:8765`. Changing the server port only requires updating that field — no source edit or extension reload is needed.

Keep the bridge bound to `127.0.0.1` unless a remote extension must connect. Exposing it as `0.0.0.0` lets any reachable host drive the browser, so restrict it with a firewall, a reverse proxy with auth, or a private network. The internal proxy is loopback-only by default for the same reason.

### Remote bridge token (`WEBPILOT_AUTH_TOKEN`)

Connections are authenticated by where they come from, so local and remote use different rules and you can switch freely by setting or unsetting one env var:

- **Loopback connections** (`127.0.0.1` / `::1`) are always exempt — your existing local setup is unchanged and needs no token.
- **Non-loopback connections** present the shared secret as a query parameter on the connection URL. If `WEBPILOT_AUTH_TOKEN` is set, a missing or mismatched token is rejected (socket closed with code `4001`); if it is unset, the connection is still allowed but the leader logs a one-time warning that the bridge is unprotected (legacy behavior).

Example for a shell that supports environment variables:

```bash
WEBPILOT_PORT=8765 WEBPILOT_HOST=127.0.0.1 webpilot-mcp
```

```bash
# Remote extension: expose the bridge and require a token
WEBPILOT_HOST=0.0.0.0 WEBPILOT_AUTH_TOKEN=<your-secret> webpilot-mcp
# then set the extension popup address to ws://<server-ip>:8765/?token=<your-secret>
```

> The token travels in the URL query because the browser `WebSocket` API cannot set custom handshake headers. Treat it as a secret: use a long random value, and prefer combining it with a source-IP firewall rule or a private network. `wss://` (TLS) additionally hides it from on-path observers.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Extension cannot connect | Ensure the AI client has started the MCP Server, then select **Connect** in the extension popup. Confirm the popup's **MCP server address** matches the server (`ws://localhost:8765` by default) and that the port is not in use. For a remote server, set `WEBPILOT_HOST=0.0.0.0` and use `ws://<server-ip>:<port>`. |
| MCP client reports no browser connection | Open the extension popup, make sure emergency stop is off, and reconnect. Reload the extension if it was installed before the latest source changes. |
| Navigation is blocked | Add the target domain to the allowlist, including any expected redirect domain. |
| Click or type is blocked | Disable read-only mode only when interaction is intended. |
| Target element cannot be found | Ask the agent to call `get_page_info`, use a fresh `@eN` reference or accessible locator, and wait for the next page state with `wait_for`. |
| A tab refuses commands ("belongs to another session instance") | The tab is inside another session instance's `WebPilot·…` tab group. Omit `tabId` to work in your own group, or operate on tabs your session created. |
| Two sessions of the same host interfere with each other | Both derived the same identity. The extension isolates them by instance key, but give each conversation its own `WEBPILOT_SESSION_ID` so ownership (and reclaiming) is unambiguous. Run `browser_status` to compare the reported `agentKey`/`instanceKey` values. |
| A restarted session did not return to its previous page | Its `agentKey` is host-scoped and ambiguous, so the safety rules refused to reclaim. Inject `WEBPILOT_SESSION_ID`, or call `claim_session` with the target `groupId`. |
| A `WebPilot·…` tab group disappeared | Idle groups are reclaimed by the TTL (`WEBPILOT_GROUP_TTL_MIN`, default 30 min) or the group cap (`WEBPILOT_MAX_GROUPS`, default 5). Just issue a new command — a fresh group is created automatically. |
| Build fails | Verify the Node.js installation, delete only the project's generated dependency directory if appropriate, rerun `npm install`, then rerun `npm run build`. |

For browser-task usage patterns and verified multi-step workflows, see `README.md`. For the project-distributed Codex skill, see `skills/webpilot-browser/`.
