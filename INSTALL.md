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

Both ports bind to `127.0.0.1` only. No extra configuration is needed for multi-agent use.

### Tab-group session model

Every MCP process derives a stable session id from the MCP client name plus its working directory. The extension isolates each session into its own Chrome tab group named `WebPilot·{short-id}`:

- Commands without an explicit `tabId` operate on the most recently used tab **inside that session's group** (a new tab is created in the group if it has none).
- Commands with an explicit `tabId` that belongs to another session's group are rejected, so parallel agents cannot interfere with each other.
- Different groups run in parallel; commands on the same tab run one at a time; screenshot/click-at briefly focus the tab under a global foreground lock.

### Group lifecycle

- When a session's MCP process disconnects, its group is marked idle: the title gains an `·idle` suffix, the group turns grey and collapses. A returning session with the same id reclaims its group.
- Idle groups are garbage-collected after a TTL (default 30 minutes, env `WEBPILOT_GROUP_TTL_MIN` on the leader process) and the total number of groups is capped (default 5, env `WEBPILOT_MAX_GROUPS`; the oldest idle groups are closed first).
- Manual cleanup: the extension popup has a **清理闲置组** button, and MCP clients can call the `cleanup_sessions` tool (`onlyIdle` defaults to `true`; pass a `sessionId` to close a specific group).

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
3. Confirm that it reports a connection to `ws://localhost:8765`. If necessary, select **Connect**.
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

## Port configuration

The MCP Server reads `WEBPILOT_PORT` (extension bridge, default `8765`) and `WEBPILOT_PROXY_PORT` (internal leader-follower proxy, default `WEBPILOT_PORT + 1`, i.e. `8766`). The bundled extension currently connects to `ws://localhost:8765`, so do not change the server port unless you also update and reload `browser-extension/background.js` and `browser-extension/popup.js` to use the same port. Keep `8766` free for the internal proxy; only local processes on `127.0.0.1` can reach it.

Example for a shell that supports environment variables:

```bash
WEBPILOT_PORT=8765 webpilot-mcp
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Extension cannot connect | Ensure the AI client has started the MCP Server, then select **Connect** in the extension popup. Confirm that port `8765` is not in use by another application. |
| MCP client reports no browser connection | Open the extension popup, make sure emergency stop is off, and reconnect. Reload the extension if it was installed before the latest source changes. |
| Navigation is blocked | Add the target domain to the allowlist, including any expected redirect domain. |
| Click or type is blocked | Disable read-only mode only when interaction is intended. |
| Target element cannot be found | Ask the agent to call `get_page_info`, use a fresh `@eN` reference or accessible locator, and wait for the next page state with `wait_for`. |
| A tab refuses commands ("belongs to another session") | The tab is inside another agent's `WebPilot·…` tab group. Omit `tabId` to work in your own group, or operate on tabs your session created. |
| A `WebPilot·…` tab group disappeared | Idle groups are reclaimed by the TTL (`WEBPILOT_GROUP_TTL_MIN`, default 30 min) or the group cap (`WEBPILOT_MAX_GROUPS`, default 5). Just issue a new command — a fresh group is created automatically. |
| Build fails | Verify the Node.js installation, delete only the project's generated dependency directory if appropriate, rerun `npm install`, then rerun `npm run build`. |

For browser-task usage patterns and verified multi-step workflows, see `README.md`. For the project-distributed Codex skill, see `skills/webpilot-browser/`.
