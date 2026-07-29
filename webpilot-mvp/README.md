# WebPilot MVP

WebPilot lets an MCP-compatible AI client control Chrome through a locally installed extension.

## Architecture

```
AI client -- stdio --> MCP Server (also WebSocket bridge) <-- ws://localhost:8765 --> Chrome extension
```

The MCP Server now includes the WebSocket bridge. Do not start the legacy `daemon/` package: one MCP process is the only required local service.

Multiple MCP processes can run at once. The first to bind `8765` becomes the **leader** and owns the extension connection; later processes become **followers** and forward commands through the leader over the internal proxy port `8766`. See `INSTALL.md` for the full leader-follower and session model.

## Setup

1. Install the extension from `browser-extension/` through `chrome://extensions/` in developer mode.
2. Install and build the MCP Server:

   ```bash
   cd mcp-server
   npm install
   npm run build
   ```

3. Add the compiled MCP Server to your AI client:

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

4. Start or reconnect the MCP client. The extension connects to the bridge built into the MCP process at `ws://localhost:8765` automatically.

The extension attempts a connection after installation, Chrome startup, and an
unexpected disconnect. It keeps an established connection alive with a 20-second
heartbeat. If the MCP process starts later, it retries every minute.
Clicking **Disconnect** intentionally disables automatic reconnection; use
**Connect** once to enable it again.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `WEBPILOT_PORT` | `8765` | Port used by the MCP Server's built-in WebSocket bridge. |
| `WEBPILOT_PROXY_PORT` | `WEBPILOT_PORT + 1` (`8766`) | Internal `127.0.0.1` proxy port used by followers to reach the leader. |
| `WEBPILOT_GROUP_TTL_MIN` | `30` | Minutes an idle session tab group is kept before it is garbage-collected (leader process). |
| `WEBPILOT_MAX_GROUPS` | `5` | Maximum number of session tab groups; the oldest idle groups are closed first. |

## Tools

| Tool | Description |
| --- | --- |
| `navigate` | Open a URL in a browser tab. |
| `get_page_info` | Read the page title, URL, and interactive elements. |
| `inspect` | Explore page or focused-editor controls, including unnamed clickable containers; returns reusable `@wpN` references and viewport bounds. |
| `probe_selector` | Test a locator once without the normal visibility wait. |
| `get_page_text` | Read the main page text without arbitrary JavaScript or `eval`. |
| `click` | Click a CSS selector. |
| `click_at` | Click a visible actionable element at coordinates returned by `inspect` or a fresh screenshot. |
| `type` | Type text into a CSS selector. |
| `screenshot` | Capture the visible browser area. |
| `execute_js` | Deprecated and disabled; use the restricted observation tools instead. |
| `list_tabs` | List browser tabs. |
| `wait_for` | Wait until a locator is visible, attached, or hidden. |
| `get_action_log` | Read recent action durations and errors (without entered text or scripts). |
| `cleanup_sessions` | Close WebPilot session tab groups; by default only idle groups (`onlyIdle`), or a specific `sessionId`. |
| `list_adapters` / `extract_with_adapter` | Discover and use a specific read-only site adapter. |
| `extract_with_best_adapter` | Select the most specific adapter and fall back to a generic summary with evidence. |
| `get_adapter_health` | Inspect adapter success, latency, and recent DOM-extraction errors. |
| `start_task` | Start a deterministic task session and capture the initial page state. |
| `observe_task` | Refresh the task's page observation and fingerprint. |
| `run_task_step` | Execute one action, then re-observe and run loop detection. |
| `verify_task_step` | Evaluate a deterministic completion assertion. |
| `get_task` / `get_task_log` / `cancel_task` | Inspect evidence or stop a task session. |
| `create_task_checkpoint` / `restore_task_checkpoint` | Save or restore a soft URL/page-fingerprint checkpoint. |
| `set_task_plan` / `run_planned_step` | Store an Agent plan and execute one verified plan step. |
| `save_task_as_workflow` / `start_workflow` | Turn a completed plan into a parameterized, reusable workflow. |
| `recommend_workflows` | Recommend completed workflows matching the current page's domain; it never executes one. |

## Reliable interaction

`click` and `type` wait for a visible, stable target before acting (10 seconds by
default). In addition to CSS selectors, the following locator formats are
supported:

- `@e0`: a reference returned by `get_page_info`; use it before the page changes.
- `@wp1`: a stable reference returned by `inspect`; valid until navigation or removal of the target node.
- `text=Continue`: an exact visible interactive-element name.
- `role=button[name="Continue"]`: an accessible role and name.

Use `wait_for` between actions when the next UI state matters. On a timeout, it
returns the latest page metadata and a small interactive-element snapshot to aid
diagnosis. `get_action_log` provides a bounded, redacted operation timeline.

For a control that is not exposed through accessibility metadata, call
`inspect` with `scope: "focused"` or `scope: "composer"` before guessing CSS.
It includes visible unnamed controls that appear actionable because of their
native semantics, pointer cursor, or common test/action attributes. Use
`probe_selector` for an immediate locator check; it never performs the normal
10-second visibility retry. As a last resort, use `click_at` only with bounds
from the latest `inspect` result or screenshot.

## Agent task loop

Use the task tools for multi-step work instead of issuing a long chain of raw
actions. A task starts with `start_task`, then repeats `observe_task` → one
`run_task_step` → `verify_task_step`. The server records URL/DOM fingerprints,
automatically pauses after three identical action/page pairs or five unchanged
steps, and writes redacted JSONL evidence to `.webpilot-task-logs/` (override
with `WEBPILOT_TASK_LOG_DIR`).

On an action error or failed deterministic verification, the task runtime saves
a failure screenshot in the same evidence directory when browser capture is
available. Checkpoints are deliberately **soft**: they restore the URL and
compare the page fingerprint, but never claim to restore form input, server
state, or prior side effects.

`verify_task_step` supports `url_includes`, `url_equals`, `title_includes`,
`text_present`, `text_absent`, `locator_visible`, `locator_hidden`, and
`interactive_count_at_least` assertions. Set `completeOnPass: true` only for
the final completion check.

## Reusable plans

An Agent can call `set_task_plan` with steps of the following shape:

```json
{
  "objective": "Search for the requested term",
  "action": { "action": "type", "selector": "role=textbox[name=\"Search\"]", "text": "{{query}}" },
  "verification": { "kind": "locator_visible", "selector": "role=button[name=\"Search\"]" }
}
```

`run_planned_step` performs the action, re-observes, and verifies it; only a
passing verification advances the plan. When every planned step passes, call
`save_task_as_workflow`. Workflow storage rejects literal `type` text: use
`{{parameter}}` placeholders and provide their values through `start_workflow`.
This keeps reusable experience separate from task-specific or sensitive input.
Saved workflows also retain the domains observed during their completed run.
Use `recommend_workflows` on a page to retrieve only matching experience before
choosing whether to instantiate a workflow.

## Site adapters

Adapters return compact, structured, read-only data for frequently visited pages;
they do not expose arbitrary JavaScript. Start with `list_adapters`, or use
`extract_with_best_adapter` to prefer the most specific matching adapter. If a
site-specific extractor breaks after a DOM change, the tool falls back to the
generic summary and returns the failed adapter list. `get_adapter_health` makes
those failures and latency visible so an adapter can be repaired deliberately.
See `docs/adapter-authoring.md` for the restricted declarative adapter contract.

## Security boundary

The extension popup enforces these controls locally, so an MCP client cannot
bypass them:

- **Domain allowlist:** enter one domain per line (or separate by commas). It
  applies to Agent-controlled tabs and blocks cross-domain redirects by taking
  the tab to a blank page. An empty list means unrestricted domains.
- **Read-only mode:** permits observation, screenshots, waits, and navigation;
  blocks clicking and typing, including coordinate clicks.
- **Emergency stop:** disconnects the bridge, disables automatic reconnection,
  and rejects new remote commands. Select **Connect** to resume deliberately.

## Session tab groups

Each MCP process derives a stable session id from its MCP client name plus working
directory, and the extension isolates that session into its own Chrome tab group
named `WebPilot·{short-id}`:

- A command without an explicit `tabId` operates on the most recently used tab
  inside its own session group, creating one if the group is empty.
- A command whose `tabId` belongs to another session's group is rejected, so
  parallel agents cannot interfere with each other.
- When a session's MCP process disconnects, its group is marked `·idle`, turns
  grey, and collapses; a returning session with the same id reclaims it.
- Idle groups are garbage-collected after `WEBPILOT_GROUP_TTL_MIN` (default 30
  minutes) and the total is capped by `WEBPILOT_MAX_GROUPS` (default 5, oldest
  idle groups closed first).
- Clean up manually with the extension popup's **清理闲置组** button or the
  `cleanup_sessions` tool (`onlyIdle` defaults to `true`; pass a `sessionId` to
  close a specific group).

## Notes

- The extension source changed to include a request ID in every response. If it was already loaded in Chrome, click Reload on its card in `chrome://extensions/` before connecting.
- Reload the extension after updating `page-tools.js`; it supplies the page-side
  locator, wait, and diagnostics helpers.
- `execute_js` is deliberately disabled. The extension uses a fixed set of
  isolated-world page tools so page CSP and arbitrary-code execution do not
  affect control exploration.
- The `daemon/` directory is retained only as legacy source and should not be started with this version.
