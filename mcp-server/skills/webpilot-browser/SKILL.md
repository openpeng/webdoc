---
name: webpilot-browser
description: Control Chrome through the WebPilot MCP server for browser navigation, page reading, screenshots, form interaction, structured site extraction, and reliable multi-step web tasks. Use when a user asks to browse a site, inspect a page, search or submit a web form, automate a browser workflow, extract data from the current tab, or save and replay a verified WebPilot workflow.
---

# WebPilot browser automation

Use WebPilot to operate the user's locally connected Chrome extension. Prefer observations and deterministic verification over assumptions; preserve the user's control over consequential external actions.

## Start safely

- Call `list_tabs` when the target tab is unclear, then pass its `tabId` to subsequent tools.
- If the extension is disconnected, instruct the user to open the WebPilot extension and select **Connect**. Do not start the legacy `daemon/` package.
- Respect the extension's domain allowlist, read-only mode, and emergency stop. These are local safeguards; do not try to bypass them.
- Each MCP session works inside its own `WebPilot·{id}` Chrome tab group. Omit `tabId` to act in your own group; a `tabId` from another session's group is rejected. Use `cleanup_sessions` only to close idle groups (default `onlyIdle: true`) or a specific `sessionId`.
- Treat navigation, reading, adapter extraction, and screenshots as low-risk. Before any irreversible or consequential action (submitting, purchasing, deleting, sending, or publishing), describe the final effect and obtain confirmation unless the user explicitly asked for that exact action.

## Select the workflow

Use the smallest reliable tool path:

- **Check page capabilities first on an unknown site:** Call `probe_page_capabilities` to get a structured report of what the page supports. If WebMCP tools are available (`webmcp.count > 0`), prefer the native channel below.
- **Read or research one page:** Call `get_page_text`. By default it returns plain text and auto-penetrates cross-origin iframes (see below) so doc-style pages return full body text. Pass `format: "markdown"` to get clean Markdown instead — the extension detects the main content container and strips nav/sidebars/toolbars, GFM tables/strikethrough/task-lists are converted (antd split tables merge into one), and inline `data:` images become placeholders; all of this runs through the open-source `turndown` library so you avoid spending tokens re-formatting HTML yourself. Use `get_page_info` when interactive controls or the current URL/title matter. For a supported site, call `extract_with_best_adapter` first; it returns compact structured data and transparently falls back when needed.
- **Explore an unlabelled control:** Call `inspect` with `scope: "focused"` or `scope: "composer"`; reuse its `@wpN` reference. Call `probe_selector` for a one-shot CSS check instead of retrying a failing click. Use `click_at` only with coordinates from a fresh inspection or screenshot.
- **One interaction:** Call `get_page_info`, choose a locator, act with `click` or `type`, then call `wait_for` or `get_page_info` to confirm the resulting state.
- **Multi-step work:** Use the task loop below instead of chaining raw actions.
- **Repeated routine:** After a completed, parameterized task plan, save it as a workflow. Use `recommend_workflows` only to discover matching prior workflows; it does not execute them.
- **Exceptional inspection:** Do not use arbitrary page JavaScript. `execute_js` is disabled; use `inspect`, `probe_selector`, page text, adapters, or screenshots instead.

## WebMCP native channel (dual-channel)

WebPilot supports a dual-channel architecture: prefer WebMCP native tools when available, fall back to browser automation.

- **Detect:** Call `get_webmcp_health` to check if the page has `document.modelContext`. If `available` is `false`, skip this channel entirely.
- **Discover:** Call `list_webmcp_tools` to see all registered tools with their `name`, `description`, and `inputSchema`.
- **Execute:** Call `execute_webmcp_tool` with a `toolName` from the list and `input` matching its schema. This directly invokes the page's JavaScript function — faster and more reliable than DOM manipulation.
- **Probe:** Call `probe_page_capabilities` for a comprehensive 5-dimension scan: WebMCP tools, declarative forms, JSON-LD actions, DOM semantic patterns, and API endpoints. Use the report to decide the best execution strategy.

**Decision flow:**
```
probe_page_capabilities
  → webmcp.count > 0?     → use execute_webmcp_tool (native channel)
  → declarativeForms?     → browser automation on the form
  → domPatterns match?    → browser automation (click/type)
  → apiEndpoints?         → consider direct API call if appropriate
  → fallback              → standard get_page_info + click/type loop
```

## Bulk data export (paginated lists)

Exporting N rows from an admin list page is fastest via the list API, not page-by-page DOM scraping:

1. `probe_page_capabilities` to confirm the channel: if `webmcp.count > 0`, prefer `execute_webmcp_tool`; otherwise continue below.
2. `start_network_capture` (optionally with `urlContains` scoped to the site's API host) before touching the page.
3. Apply the target filters through the UI (`click` the selects, then the search button). The capture records the list API — method, URL, and request body including the filter's enum value (e.g. which `projectId` corresponds to the requested filter name).
4. `get_network_resources` to find the list request; note its `id`.
5. `replay_api_request` with `captureRequestId`, overriding the pagination fields in `body` (e.g. `size: 100`, `page: 1`). It automatically carries the session cookies and bypasses page CSP — one request returns the full page of structured JSON instead of ten DOM flips.
6. Keep capture running while replaying (`stop_network_capture` only at the end). For totals beyond one page, loop `page` until `all_item_count` is covered.
7. Post-process with a small local script into CSV/JSON; record field-enum mappings (e.g. `courseType` codes) discovered along the way.

Pitfalls observed on real admin consoles:

- Custom `Select` components may not expose a search box — don't waste time typing into them; reopen the dropdown and click the option matched by its `title`/text attribute.
- Dropdown panels close between commands; select the option in the same step that follows opening the panel, or match with `:not(.xxx-hidden)`-style visibility selectors.
- Persist no business data, session tokens, or internal hostnames into workflows or plans — keep exports as local files and use placeholders in anything saved.

## Cross-origin iframe pages

Some sites render the real content inside an **iframe from a different origin** than the main page. Example: WorkBuddy doc pages (`workbuddy.cn`) embed the document in an iframe served from `workbuddy-space-static.codebuddy.work`. In that case:

- `get_page_text` on the main page returns only the chrome/shell (a few dozen characters), because the body lives in the cross-origin iframe.
- `iframe_action` fails with `No same-origin iframe found` — the browser blocks DOM access across origins.
- `evaluate`/`execute_js` are blocked by the page's CSP (`unsafe-eval` not allowed).

This is handled automatically — no manual workaround needed:

- **`get_page_text` auto-penetrates iframes.** When the page contains an `<iframe>` and the main text looks empty, it transparently extracts the iframe body and appends it under a `--- iframe 正文 ---` separator. Same-origin iframes use DOM reads; cross-origin iframes fall back to the network layer below. Pass `iframeUrlContains` (e.g. `workbuddy-space-static`) to narrow the cross-origin match.
- **`extract_iframe_text`** is the explicit tool when you only want the iframe content. Same downgrade logic: same-origin → DOM `getText`; cross-origin → `start_network_capture` → `reload` (to trigger the iframe's `Document` request) → `get_network_resources(type:"Document")` → `replay_api_request` (carries the original session cookies and bypasses CSP) → `htmlToText`.

Why the network layer for cross-origin: the iframe document is a normal HTTP `GET` already authorized by the user's login cookies. Replaying that captured request returns the full HTML without touching the (blocked) iframe DOM. The capture must start **before** the reload so the `Document` request is recorded; stop it after replaying.

```text
Read a cross-origin doc:   get_page_text (auto iframe)  OR  extract_iframe_text (iframeUrlContains:"workbuddy-space-static")
Manual downgrade:           start_network_capture -> reload -> get_network_resources(type:"Document") -> replay_api_request -> htmlToText
```

## Markdown reading mode

`get_page_text` can return Markdown instead of plain text. The conversion uses `turndown` + `turndown-plugin-gfm` on the server (no model tokens spent re-formatting HTML), and the result is stable and reproducible.

- `format: "markdown"` → Markdown of the page body. The browser extension first isolates the main content container and drops navigation, sidebars, and toolbars, so the document starts at the real article (verified on Confluence, GitLab, and antd admin consoles).
- GFM is enabled by default (`gfm: true`): tables, strikethrough, task lists. antd's split header/body tables are merged into one Markdown table. Inline `data:` images (logos, base64/SVG) are replaced with a placeholder to keep the output compact.
- `baseUrl` resolves relative links/images to absolute URLs (defaults to the live page URL when reading a tab).
- Formatting knobs: `headingStyle` (atx/setext), `bulletListMarker`, `codeBlockStyle`, `emDelimiter`, `strongDelimiter`, `linkStyle` (inlined/referenced), plus `remove`/`keep` tag lists.
- `returnFormat: "json"` returns `{ markdown, length }` metadata instead of the raw document — handy when you need the size before deciding how to use it.
- `html` lets you convert a raw HTML string entirely server side, with no browser/tab involved.
- Cross-origin iframe penetration applies here too: if the main page body is empty, the iframe body is extracted and converted to Markdown.

## Locate and interact

- Prefer a fresh `@eN` reference from `get_page_info` for the immediate next action. It becomes invalid after the page changes. For unnamed controls returned by `inspect`, use its `@wpN` reference; it remains valid until the page navigates or the node is removed.
- Otherwise use stable, semantic locators: `role=button[name="Continue"]`, `role=textbox[name="Search"]`, or `text=Continue`. Use CSS only where it is clearly more stable.
- `click` and `type` wait for a visible, stable element. Set `timeoutMs` only when the default 10 seconds is inappropriate; the maximum is 30 seconds.
- After navigation, page transitions, or an action error, re-observe before choosing the next action. On a locator timeout, use its diagnostics plus `get_page_info`; use `get_action_log` for the redacted operation timeline.
- Avoid putting credentials, secrets, or unrelated personal data into persistent plans or workflows.

## Run verified multi-step tasks

For work that spans multiple actions:

1. Call `start_task` with a concise goal and optional `tabId`/`maxSteps`.
2. Inspect its initial observation; call `observe_task` again whenever state may have changed unexpectedly.
3. Call exactly one `run_task_step` action (`navigate`, `click`, `type`, or `wait`) at a time.
4. Call `verify_task_step` after each meaningful state change, using a deterministic assertion such as `url_includes`, `text_present`, `locator_visible`, or `locator_hidden`.
5. Set `completeOnPass: true` only on the final success assertion. Stop, diagnose, or ask the user when verification fails; do not blindly repeat actions.

The runtime automatically detects repeated action/page pairs and unchanged states. Treat a pause as a signal to inspect `get_task` and `get_task_log`, then change strategy or ask for guidance. Use `create_task_checkpoint` before a risky branch; restoring it only navigates back and checks the page fingerprint. It does not undo submitted forms or other server-side effects.

## Plan and reuse workflows

- Use `set_task_plan` to store a short action-and-verification plan for an active task, then execute one verified step at a time with `run_planned_step`.
- If a step requires external or human verification, use `advance_task_plan` only after that verification actually passes.
- Save only a completed, reusable plan with `save_task_as_workflow`. Every `type` action must use placeholders such as `{{query}}`; never save literal text, especially sensitive text.
- Run an existing workflow with `start_workflow`, supplying parameter values and then applying the same observation and verification discipline.

## Common patterns

```text
Read a page (text): get_page_text (auto iframe) -> summarize with URL/title context
Read a page (MD):   get_page_text format:"markdown" -> clean Markdown, nav/toolbar stripped
Search a site:     get_page_info -> type -> click -> wait_for -> verify_task_step
Structured page:   extract_with_best_adapter -> inspect fallback/evidence if any
New task:          start_task -> observe -> run_task_step -> verify -> repeat
WebMCP native:     get_webmcp_health -> list_webmcp_tools -> execute_webmcp_tool
Capability scan:   probe_page_capabilities -> choose best channel
Bulk export:       start_network_capture -> trigger query -> replay_api_request (size/page override)
Troubleshoot:      get_page_info / screenshot -> get_action_log -> revise locator or wait
```
