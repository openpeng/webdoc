# Install WebPilot

WebPilot connects an MCP-compatible AI client to Chrome through a local Chrome extension. One MCP Server process owns the local WebSocket bridge; do not run the legacy `daemon/` package.

## Prerequisites

- Google Chrome or another Chromium browser that supports Manifest V3 extensions.
- Node.js and npm (use a current LTS release).
- An MCP-compatible AI client that can launch a local stdio server.

## 1. Install the Chrome extension

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this project's `browser-extension/` directory.
5. Open the WebPilot extension popup and keep the domain allowlist as narrow as practical. Enable read-only mode if the agent only needs to inspect pages.

After changing any file in `browser-extension/`, return to `chrome://extensions/` and select **Reload** on the WebPilot extension card.

## 2. Build the MCP Server

From the project root:

```bash
cd mcp-server
npm install
npm run build
```

This creates `mcp-server/dist/server.js`. The server starts a WebSocket bridge at `ws://localhost:8765` when the AI client starts it.

## 3. Register the MCP Server

Add the compiled server to the MCP configuration used by your AI client. Replace the path with the absolute path on your computer.

```json
{
  "mcpServers": {
    "webpilot": {
      "command": "node",
      "args": ["/absolute/path/to/webpilot-mvp/mcp-server/dist/server.js"]
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
      "args": ["F:/mycode/mcp-servers/webdoc/webpilot-mvp/mcp-server/dist/server.js"]
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

## Security controls

The extension enforces these controls locally, including for MCP clients:

- **Domain allowlist:** Enter one domain per line or separate domains with commas. Cross-domain redirects outside the allowlist are blocked. An empty allowlist permits all domains.
- **Read-only mode:** Allows observation, screenshots, waits, and navigation, but blocks clicks, typing, and page JavaScript.
- **Emergency stop:** Immediately disconnects the bridge, disables automatic reconnection, and rejects new remote commands. Select **Connect** to resume deliberately.

## Port configuration

The MCP Server reads `WEBPILOT_PORT` and defaults to `8765`. The bundled extension currently connects to `ws://localhost:8765`, so do not change the server port unless you also update and reload `browser-extension/background.js` and `browser-extension/popup.js` to use the same port.

Example for a shell that supports environment variables:

```bash
WEBPILOT_PORT=8765 node /absolute/path/to/mcp-server/dist/server.js
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Extension cannot connect | Ensure the AI client has started the MCP Server, then select **Connect** in the extension popup. Confirm that port `8765` is not in use by another application. |
| MCP client reports no browser connection | Open the extension popup, make sure emergency stop is off, and reconnect. Reload the extension if it was installed before the latest source changes. |
| Navigation is blocked | Add the target domain to the allowlist, including any expected redirect domain. |
| Click or type is blocked | Disable read-only mode only when interaction is intended. |
| Target element cannot be found | Ask the agent to call `get_page_info`, use a fresh `@eN` reference or accessible locator, and wait for the next page state with `wait_for`. |
| Build fails | Verify the Node.js installation, delete only the project's generated dependency directory if appropriate, rerun `npm install`, then rerun `npm run build`. |

For browser-task usage patterns and verified multi-step workflows, see `README.md`. For the project-distributed Codex skill, see `skills/webpilot-browser/`.
