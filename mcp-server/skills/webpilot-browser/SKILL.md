---
name: webpilot-browser
description: Control Chrome through the WebPilot MCP server for browser navigation, page reading, screenshots, form interaction, structured site extraction, and reliable multi-step web tasks. Use when a user asks to browse a site, inspect a page, search or submit a web form, automate a browser workflow, extract data from the current tab, or save and replay a verified WebPilot workflow.
---

# WebPilot browser automation

Use WebPilot to operate the user's locally connected Chrome extension. Prefer observations and deterministic verification over assumptions; preserve the user's control over consequential external actions.

## Default tool surface

Only these seven tools are advertised by default. Except for `api_call`, choose an `action` and pass only that branch's parameters. Branch schemas are strict: fields from another action and missing required fields are rejected before execution. Consult the live tool schema for required fields and limits.

| Tool | Actions / purpose |
| --- | --- |
| `browser_page` | `list_tabs`, `navigate`, `screenshot`, `get_url`, `reload`, `go_back`, `go_forward`, `full_screenshot`, `element_screenshot`, `upload_file`, `download_file`, `save_pdf`, `handle_dialog` |
| `browser_read` | `info`, `inspect`, `text`, `table`, `resources`, `iframe_text`, `iframe_query`, `shadow_query`, `shadow_text` |
| `browser_act` | `click`, `type`, `hover`, `press_key`, `scroll`, `select_option`, `drag_drop`, `wait`, `wait_dynamic`, `click_at`, `iframe_click`, `shadow_click`, `shadow_type` |
| `browser_debug` | `evaluate`, `network_start`, `network_stop`, `network_resources`, `replay`, `console`, `probe_selector`, `selector_cache`, `action_log` |
| `api_discover` | `start`, `stop_and_analyze`, `analyze_current`, `scan_site` |
| `api_commands` | `domains`, `list`, `get` — local command lookup, never execution |
| `api_call` | Execute a persisted command by `commandId` or `name`, with values in `params`; **no `action` field**. Writes require `confirm:true`. |

Old standalone names remain callable for compatibility but are not advertised by default. Use the seven entrances in new calls. Advanced tools are advertised only when the server environment contains `WEBPILOT_ENABLE_ADVANCED_TOOLS=1` (the literal string `1`; other values do not enable them). This adds `cleanup_sessions`, `claim_session`, `browser_status`, `browser_config`, `browser_cookie`, `browser_task`, `task_workflow`, `adapter`, `webmcp`, and `ai_search`. Restart/reconnect the MCP client after changing the server configuration; do not assume these tools are present. Task loops additionally require `enable_task_mode` in the calling environment.

## Start safely

- Call `browser_page({action:"list_tabs"})` when the target tab is unclear, then pass its `tabId` to subsequent browser calls.
- If the extension is disconnected, instruct the user to open the WebPilot extension and select **Connect**. Do not start the legacy `daemon/` package.
- Respect the extension's domain allowlist, read-only mode, and emergency stop. These are local safeguards; do not try to bypass them.
- Each MCP session works inside its own `WebPilot·{id}` Chrome tab group. Omit `tabId` to act in your own group; a `tabId` from another session's group is rejected. Session cleanup is an advanced operation, not a prerequisite for ordinary browsing.
- Treat navigation, reading, adapter extraction, and screenshots as low-risk. Before any irreversible or consequential action (submitting, purchasing, deleting, sending, or publishing), describe the final effect and obtain confirmation unless the user explicitly asked for that exact action.

## Select the workflow

Use the smallest reliable tool path:

- **Read one page:** `browser_read({action:"text"})`; use `action:"info"` for URL/title and interactive elements, or `action:"inspect"` for focused/composer controls. Text supports `format:"markdown"` and automatic iframe extraction.
- **One interaction or multi-step work:** read the state, choose a locator, call `browser_act`, then re-read or wait and verify the resulting state. Repeat this observation/action/verification cycle for each meaningful change. A task session is not required.
- **Explore an unlabelled control:** `browser_read({action:"inspect", scope:"focused"})` or `scope:"composer"`; reuse its `@wpN` reference. Use `browser_debug({action:"probe_selector"})` for a one-shot locator check. Use `browser_act({action:"click_at"})` only with coordinates from fresh inspection or a screenshot.
- **Data from a site's own API:** first call `api_commands({action:"domains"})` for cached domains, then `api_commands({action:"list", domain})` for that domain's capabilities, then `api_commands({action:"get", domain, commandId})` (or `name`) for one definition. Call the separate `api_call` only after inspecting it. `domains` is purely local, accepts no `domain` or `tabId`, and needs no browser; summaries mean cached commands exist, not that endpoints have been verified callable. If no usable command exists, use `api_discover` to capture or scan and look up the resulting commands again.
- **Exceptional inspection:** `browser_debug({action:"evaluate", expression:"..."})` executes page JavaScript; legacy `evaluate` and `execute_js` are compatibility aliases, not disabled tools. Prefer narrowly read-only expressions for inspection. JavaScript can mutate page state. CDP may execute scripts where page CSP blocks injected eval; never use it to evade authorization or local safety controls.
- **Optional advanced channels:** use adapters, native WebMCP tools, AI search, or reusable workflows only when the corresponding tools are visible. Their availability does not change the default read/act/verify path.
- **Changing the command pipeline's evidence contract:** read the companion `webdoc-api-replication/SKILL.md` first, as described below.

## Per-domain API command set

```text
api_commands(action:"domains") -> api_commands(action:"list", domain)
  -> usable command -> api_commands(action:"get", domain, commandId/name) -> api_call(domain, params, confirm for write)
  -> no usable command -> api_discover(action:"start") -> operate UI
     -> api_discover(action:"stop_and_analyze") -> api_commands(action:"list", domain)
     -> api_commands(action:"get", domain, commandId/name) -> api_call
Static sources: api_discover(action:"scan_site", domain, sources)
```

### On-demand maintenance (compatibility clients only)

This Skill describes the maintenance procedure; it is not an execution engine. `api_manage` and the original maintenance names remain server-side compatibility routes, absent from both default and advanced `tools/list`. Use them only through a client that supports direct MCP calls to unlisted names; do not assume every host can invoke them. If unavailable, report the client limitation rather than inventing a tool or performing an unauthorized external write.

For authorized maintenance in a compatible client, call the unlisted `api_manage` route with the following argument shapes. Replace example values with the authorized target and local package path; these examples are not instructions to execute them now.

| Purpose | Arguments | Optional fields / scope |
| --- | --- | --- |
| Export package | `{"action":"export","domain":"example.com","path":"api-commands.json"}` | `includeDisabled` boolean |
| Import package | `{"action":"import","domain":"example.com","path":"api-commands.json"}` | `overwrite` boolean, default false |
| Edit annotation | `{"action":"update","domain":"example.com","commandId":"command-id","note":"Reviewed"}` | `note` is optional; also supports `name`, `params`, `responseFields`, `deprecated` |
| Disable command | `{"action":"disable","domain":"example.com","commandId":"command-id"}` | Requires `commandId` |
| Delete command | `{"action":"delete","domain":"example.com","commandId":"command-id"}` | Requires `commandId` |
| Clear hostname cache | `{"action":"clear_domain","domain":"example.com"}` | Clears the whole selected domain |
| Cache diagnostics | `{"action":"health"}` | Optional `domain`; omitted means all cached domains |

All branches require `action`. Export/import additionally require `domain` and `path`; update/disable/delete require `commandId`. For update/disable/delete/clear_domain, explicitly pass `domain` as above to avoid relying on the current tab, even though the schema allows omission. Ordinary discovery and execution continue through the seven advertised tools.

### Discovery and execution details

- `api_discover` preserves the discovery pipeline: `start` → operate the UI → `stop_and_analyze`; `analyze_current` parses an existing capture buffer and is flagged for review. `scan_site` accepts source material such as JS/HAR/OpenAPI/declarative sets. For bundles requiring login, `collectViaExtension:true` uses the browser session; `discoverBundles:true` discovers loaded scripts. Parsing remains on the MCP side.
- Navigation may append an `apiCommands` summary. It is a recommendation only: zero network requests and no command execution. A capability probe, when available through advanced WebMCP tools, also only recommends commands.
- `api_commands({action:"domains"})` returns `{domains:[{domain,total}],warnings:[]}` with nonempty cached domains sorted lexicographically. `total` counts cached commands including disabled/deprecated entries, not currently callable endpoints. `list` may exclude disabled entries by default; pass `includeDisabled:true` to inspect them. Read `warnings` before drawing coverage conclusions. Lookup and maintenance never substitute for **the independent `api_call` execution entry**.
- `{{param}}` in `urlTemplate` / `queryTemplate` / `bodyTemplate` is filled from `api_call.params`; `{id}` in `pathTemplate` is only a structural marker. Query/path values are URL-encoded; body values retain JSON types; path values containing `/`, `?`, or `#` are refused.
- **Write commands:** `risk:"write"` returns `confirmationRequired:true` and a redacted preview with **no request sent** unless `confirm:true` is passed to `api_call`. Obtain user authorization for the effect before confirming. This gate does not replace the extension's domain allowlist, exact-hostname check, read-only mode, emergency stop or target-URL/redirect validation.
- **Errors:** `authRequired:true` / `AUTH_REQUIRED` means the login session likely expired; ask the user to log in manually rather than retrying blindly. `DRIFTED` means the response shape changed; consider rediscovery. `REDIRECT_BLOCKED` is fail-closed; do not follow the redirect yourself.
- **Credentials:** never put cookies, credentials, tokens, internal hostnames or business data into shared Skills/workflows/adapters. Command caches are local runtime assets; non-credential header values and business defaults may be retained under the configured pipeline policy. Do not claim the cache contains field names only. Performance-resource API hints are not proof of HTTP methods; actual methods come from captured requests or explicit source evidence.

## Reading and locating

- `browser_read({action:"text", format:"markdown"})` uses server-side `turndown` + GFM conversion. It removes navigation/toolbars, merges split tables and replaces inline data images with placeholders. `html` can convert a supplied HTML string without a tab. Consult the branch schema for formatting options.
- Text extraction automatically attempts iframe content when the main document looks empty. `browser_read({action:"iframe_text", iframeUrlContains:"..."})` explicitly targets iframe text. Same-origin content uses DOM reads; cross-origin content can fall back to capture → reload → document replay. This may reload the page; re-observe before continuing interactions.
- `iframe_query` / `iframe_click` target same-origin iframe DOM; cross-origin DOM restrictions still apply. Shadow DOM reads use `shadow_query`, and interactions use `shadow_click` / `shadow_type`.
- Prefer a fresh `@eN` from `browser_read` action `info` for the next action; it becomes invalid after page changes. `@wpN` from `inspect` remains valid until navigation or node removal.
- Otherwise prefer semantic locators such as `role=button[name="Continue"]`, `role=textbox[name="Search"]`, or `text=Continue`. Use CSS when clearly more stable.
- `browser_act` actions `click` and `type` wait for visible, stable elements. The default timeout is 10 seconds; the maximum is 30 seconds. After navigation, transitions, or errors, re-observe before acting again.
- On locator timeout, use diagnostics plus `browser_read({action:"info"})`; `browser_debug({action:"action_log"})` returns the redacted operation timeline. Selector-cache statistics use `action:"selector_cache"`.

## Bulk export and one-off network inspection

Prefer `api_commands({action:"domains"})` → `api_commands({action:"list", domain})` → `api_commands({action:"get", domain, name})` → `api_call({domain, name, params:{page, size}})` for repeated pagination. If no command exists, discover one for reuse. For a one-off captured request:

1. `browser_debug({action:"network_start", ...})` before triggering the UI query; scope `urlContains` where appropriate.
2. Apply filters with `browser_act` and verify the page state.
3. `browser_debug({action:"network_resources", ...})` to find the request and its capture ID.
4. `browser_debug({action:"replay", captureRequestId, ...})` with the required pagination overrides. Replaying a request retains its external effects; assess the actual request before executing it.
5. Keep capture active while replaying, then stop with `browser_debug({action:"network_stop"})`. Export authorized results locally; do not persist business samples in reusable workflows.

## Optional advanced tasks and workflows

Use task/workflow tools only when they are advertised **and** the calling environment has enabled `enable_task_mode`. Otherwise use `browser_read` → `browser_act` → read/wait and verify; do not call hidden task aliases to force task mode.

When enabled, consult the live `browser_task` / `task_workflow` action schemas. Start a task, observe, execute one step, and verify each meaningful change using deterministic URL/text/locator assertions. Mark completion only on the final success assertion. Pause and diagnose failed verification rather than blindly repeating steps. Checkpoint restoration navigates back and checks a page fingerprint; it cannot undo server-side effects. Save only completed reusable plans, with placeholders such as `{{query}}` instead of literal typed input. Workflow recommendations never execute workflows.

## REA evidence discipline (companion skill)

When designing, implementing, reviewing, or changing the command pipeline's evidence/coverage contract, read `webdoc-api-replication/SKILL.md` (sibling directory; repo path `mcp-server/skills/webdoc-api-replication/SKILL.md`). Tier endpoints as `observed` / `derived` / `inferred` / `unknown`; keep `discovered` / `applicable` / `examined` / `retained` scopes distinct; record ambiguity rather than guessing; missing coverage is not absence.

Its references cover `evidence-model.md`, `rea-principles.md`, `repo-map.md`, `route-and-capture-playbook.md`, and `web-design-replication.md`. Do not load the evidence-contract workflow for ordinary browsing or bug-hunting with no contract change.

## Common patterns

```text
Read:          browser_page(navigate) -> browser_read(text/info)
Search:        browser_read(info) -> browser_act(type) -> browser_act(click) -> browser_act(wait) -> browser_read(info)
Site API:      api_commands(domains) -> api_commands(list, domain) -> api_commands(get, domain, commandId/name) -> api_call
New commands:  api_discover(start) -> browser_act(...) -> api_discover(stop_and_analyze) -> api_commands(list, domain) -> api_commands(get, domain, commandId/name) -> api_call
Static scan:   api_discover(scan_site) -> api_commands(list, domain) -> api_commands(get, domain, commandId/name)
Troubleshoot:  browser_read(inspect) / browser_page(screenshot) -> browser_debug(probe_selector/action_log)
```
