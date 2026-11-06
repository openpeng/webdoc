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
- **Data from a site's own API (preferred when a persisted command exists):** Call `list_api_commands(domain)` **first** — it is a pure local cache read, works without opening the page, and never executes anything. If it hits, use `call_api_command`. Only if there is no usable command should you run `analyze_page_apis` (start → operate the UI → stop_and_analyze). See "Per-domain API command set" below.
- **Changing the command pipeline itself (not just using it):** Read the companion skill `webdoc-api-replication/SKILL.md` first — it fixes the evidence tiering and coverage contract that every command, report, and cache entry must satisfy. See "REA evidence discipline" below.
- **Need an overview answer, not a specific page:** Call `ai_search({query})` first. One call returns a synthesized answer plus cited sources without opening any page, tab, or login session — much cheaper than `navigate` → `get_page_text` → read several results. Use the real browser only when you need a specific site's own content, or when `ai_search` returns `found:false`.
- **Exceptional inspection:** Do not use arbitrary page JavaScript. `execute_js` is disabled; use `inspect`, `probe_selector`, page text, adapters, or screenshots instead.

## WebMCP native channel (dual-channel)

WebPilot supports a dual-channel architecture: prefer WebMCP native tools when available, fall back to browser automation.

- **Detect:** Call `get_webmcp_health` to check if the page has `document.modelContext`. If `available` is `false`, skip this channel entirely.
- **Discover:** Call `list_webmcp_tools` to see all registered tools with their `name`, `description`, and `inputSchema`.
- **Execute:** Call `execute_webmcp_tool` with a `toolName` from the list and `input` matching its schema. This directly invokes the page's JavaScript function — faster and more reliable than DOM manipulation.
- **Probe:** Call `probe_page_capabilities` for a comprehensive 5-dimension scan: WebMCP tools, declarative forms, JSON-LD actions, DOM semantic patterns, and API endpoints. Use the report to decide the best execution strategy.

**Decision flow:**
```
list_api_commands(domain)          ← try this FIRST (local, no page needed)
  → usable command found? → call_api_command (params, confirm for write)
  → not found / empty     → analyze_page_apis(start → operate UI → stop_and_analyze)
                            → list_api_commands again → call_api_command
probe_page_capabilities
  → webmcp.count > 0?     → use execute_webmcp_tool (native channel)
  → declarativeForms?     → browser automation on the form
  → domPatterns match?    → browser automation (click/type)
  → apiEndpoints?         → hint only; NOT a parsing source (methods are XHR/fetch pseudo-values)
  → fallback              → standard get_page_info + click/type loop
```

## Per-domain API command set

Seven dedicated tools turn captured XHR/fetch traffic into a local, per-hostname command set:

| Tool | When to use |
| --- | --- |
| `list_api_commands` | **First stop on any site.** Pure local cache read; `autoLoaded`, `cacheHit`, `stale[]`, `warnings[]`. Requires no open page and executes nothing. |
| `get_api_command` | Inspect one command's `params[]`, `responseFields[]`, `responseSchema`, `risk`, `health`, `manuallyEdited` before calling. |
| `call_api_command` | Execute by `commandId` or `name`; pass values in `params`. No page/tab/capture buffer needed. |
| `analyze_page_apis` | Only when `list_api_commands` misses. `start` → operate the UI → `stop_and_analyze`; `analyze_current` parses an existing capture buffer (always flagged for review, empty `responseSchema`). For whole-site coverage without touching the UI, use `scan_site` with `sources[]` (JS/HAR/OpenAPI/declarative set); if those bundles need a login session (plain read returns 401), add `collectViaExtension:true` — or `discoverBundles:true` to auto-discover the current tab's loaded scripts — and the extension fetches the text with the page's own session (page context → service worker → browser cache). Parsing stays on the MCP side, identical in both cases. |
| `update_api_command` | Rename / edit params / narrow `responseFields` / annotate / deprecate. Sets `manuallyEdited:true`, preserved by later `merge` and `full`. |
| `invalidate_api_commands` | Disable / delete one command, or clear a whole hostname. |
| `get_api_command_cache` | Inspect hits / misses / consecutiveFailures / disabled / average latency and skipped-invalid entries. |

- `navigate` and `probe_page_capabilities` automatically append an `apiCommands` summary. **It is a recommendation only — never an execution, and it makes zero network requests.** You still decide whether to call anything.
- `{{param}}` (double braces) in `urlTemplate` / `queryTemplate` / `bodyTemplate` is filled from `call_api_command.params`; `{id}` (single braces) in `pathTemplate` is only a structural marker and is never substituted at call time. Query/path values are URL-encoded; body values keep their JSON type; a path value containing `/`, `?`, or `#` is refused.
- **Write commands:** a command with `risk:"write"` returns `confirmationRequired:true` plus a redacted `preview` and sends **no request** unless you pass `confirm:true`. Confirm with the user before doing so (see "Start safely"). `confirm` is only a mis-click gate; the extension independently enforces the domain allowlist, exact hostname match, read-only mode and emergency stop.
- **Error handling:** `authRequired:true` / `AUTH_REQUIRED` means the login session likely expired — ask the user to log in manually, do not retry blindly (it does not disable the command). `DRIFTED` means the response shape changed — consider re-running `analyze_page_apis`. `REDIRECT_BLOCKED` is fail-closed; do not try to follow the redirect yourself.
- **Credentials discipline:** the cache stores only header **field names**, never values; no cookies, CSRF tokens, credentials, or business sample values are persisted. Real enum values are not recorded (only `enumCount`). Never copy internal hostnames, endpoint paths, enum values, or business data into workflows, adapters, or this Skill — the cache is a local runtime asset, not a distributable one. `apiEndpoints` from `probe_page_capabilities` is based on `performance.getEntriesByType('resource')` and its `method` is an `XHR`/`fetch` pseudo-value: **never use it as a parsing source**; real methods come from CDP `Network.requestWillBeSent`.

## REA evidence discipline (companion skill)

The per-domain API command set is only trustworthy under an explicit evidence contract. When the task is to **design, implement, review, or change that contract** — evidence tiers, coverage semantics, ambiguity handling, provenance labelling — read the companion skill before writing any code:

- `webdoc-api-replication/SKILL.md` — the sibling directory next to this file (repo path `mcp-server/skills/webdoc-api-replication/SKILL.md`; package path `skills/webdoc-api-replication/SKILL.md`). Tier every endpoint as `observed` / `derived` / `inferred` / `unknown`; keep `discovered` / `applicable` / `examined` / `retained` scopes separate; record ambiguity instead of guessing; never let missing coverage read as absence.
  - `references/evidence-model.md` — tier semantics and the source→tier mapping.
  - `references/rea-principles.md` — REA's first-hand principles; quote from here instead of paraphrasing them into second-hand conclusions.
  - `references/repo-map.md` — where each contract lives in this repo; read it before editing, because line numbers drift.
  - `references/route-and-capture-playbook.md` — route definition rules and capture-analysis priorities.
  - `references/web-design-replication.md` — design cues treated as endpoint-discovery leads.

Do **not** load it for ordinary browser automation, or for plain bug-hunting that needs no contract change — read the implementation directly in those cases.

## Search-engine AI summary (`ai_search`)

`ai_search({query, maxChars?, maxCitations?, timeoutMs?})` returns:

- `answer` — the AI summary as cleaned Markdown (Baidu's private `:ml-*` markers and `==` highlights already stripped);
- `citations[]` — `{title, url, source}`, deduplicated (`source` is the site name, e.g. `腾讯云`);
- `sections[]` — per-block fragments when the fallback channel produced them;
- `via` — `baikan-sse` (primary stream), `extension:page|worker|cache`, or `node`;
- `warnings[]` — read these before concluding "no answer".

Decision rules:

- **`found:false` is a normal result, not an error.** Baidu does not generate a summary for every query. If `warnings[]` says the query has no summary, refine the question (longer / more specific / phrased as a question) rather than retrying the same string.
- **Latency is 2–13 s** because the primary channel is a *generative* stream. Do not fire many queries in parallel to save time — concurrency raises the chance of tripping Baidu's rate limiting, which can block for tens of minutes. Run them sequentially.
- **Partial answers are kept.** If `warnings[]` mentions the stream did not finish, you got a truncated answer; it is still usable, or re-call with a larger `timeoutMs`.
- **Do not reuse as a site API.** This tool is stateless and writes no cache; it is not part of the per-domain command set. For a specific site's own API, use `list_api_commands` → `call_api_command`.
- `sseEndpoint` / `urlTemplate` in the response are reusable templates (`{{query}}` placeholder) if you need the raw stream.

## Bulk data export (paginated lists)

Exporting N rows from an admin list page is fastest via the list API, not page-by-page DOM scraping:

**Prefer the persisted command path first:** `list_api_commands(domain)` → `call_api_command({name, params:{page, size}})`. Only fall back to the manual capture/replay sequence below if no command exists yet; in that case use `analyze_page_apis` to sediment one for next time.

Manual sequence (legacy / one-off, when no persisted command exists):

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
Site API (first):  list_api_commands(domain) -> call_api_command(params)
Overview answer:   ai_search(query) -> use answer + citations; fall back to browser only if found:false
Site API (new):    analyze_page_apis(start -> operate UI -> stop_and_analyze) -> list_api_commands -> call_api_command
Bulk export:       list_api_commands -> call_api_command (page/size params)
Bulk export (one-off): start_network_capture -> trigger query -> replay_api_request (size/page override)
Cache health:      get_api_command_cache(domain?) -> hits/misses/consecutiveFailures/disabled
Troubleshoot:      get_page_info / screenshot -> get_action_log -> revise locator or wait
```
