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

- **Read or research one page:** Call `get_page_text`; use `get_page_info` when interactive controls or the current URL/title matter. For a supported site, call `extract_with_best_adapter` first; it returns compact structured data and transparently falls back when needed.
- **Explore an unlabelled control:** Call `inspect` with `scope: "focused"` or `scope: "composer"`; reuse its `@wpN` reference. Call `probe_selector` for a one-shot CSS check instead of retrying a failing click. Use `click_at` only with coordinates from a fresh inspection or screenshot.
- **One interaction:** Call `get_page_info`, choose a locator, act with `click` or `type`, then call `wait_for` or `get_page_info` to confirm the resulting state.
- **Multi-step work:** Use the task loop below instead of chaining raw actions.
- **Repeated routine:** After a completed, parameterized task plan, save it as a workflow. Use `recommend_workflows` only to discover matching prior workflows; it does not execute them.
- **Exceptional inspection:** Do not use arbitrary page JavaScript. `execute_js` is disabled; use `inspect`, `probe_selector`, page text, adapters, or screenshots instead.

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
Read a page:       get_page_text -> summarize with URL/title context
Search a site:     get_page_info -> type -> click -> wait_for -> verify_task_step
Structured page:   extract_with_best_adapter -> inspect fallback/evidence if any
New task:          start_task -> observe -> run_task_step -> verify -> repeat
Troubleshoot:      get_page_info / screenshot -> get_action_log -> revise locator or wait
```
