// 预置工作流安全门槛、TaskRuntime 加载隔离与登录页人工接管测试。
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRuntime, validatePresetWorkflow, looksLikeLoginPage, compactPage } from "../dist/task-runtime.js";

const baseWorkflow = () => ({
  id: "preset-demo",
  name: "Demo",
  goal: "demo goal",
  domains: ["example.com"],
  plan: {
    steps: [
      { objective: "打开页面", action: { action: "navigate", url: "https://example.com" } },
      { objective: "输入关键词", action: { action: "type", selector: "#kw", text: "{{query}}" }, verification: { kind: "locator_visible", selector: "#kw" } },
    ],
  },
});

test("合法预置工作流通过校验，步骤按白名单重建", () => {
  const workflow = validatePresetWorkflow(baseWorkflow());
  assert.equal(workflow.id, "preset-demo");
  assert.equal(workflow.plan.steps.length, 2);
  assert.equal(workflow.plan.currentStep, 0);
});

test("id 必须带 preset- 前缀", () => {
  const raw = { ...baseWorkflow(), id: "demo" };
  assert.throws(() => validatePresetWorkflow(raw), /must start with preset-/);
});

test("navigate 只允许 http(s) 或 {{param}}，拒绝 file://", () => {
  const raw = baseWorkflow();
  raw.plan.steps[0].action.url = "file:///etc/passwd";
  assert.throws(() => validatePresetWorkflow(raw), /must be http\(s\) or a \{\{param\}\} placeholder/);
  raw.plan.steps[0].action.url = "{{startUrl}}";
  assert.equal(validatePresetWorkflow(raw).plan.steps[0].action.url, "{{startUrl}}");
});

test("type 文本必须是 {{param}} 占位符，拒绝字面文本", () => {
  const raw = baseWorkflow();
  raw.plan.steps[1].action.text = "literal secret";
  assert.throws(() => validatePresetWorkflow(raw), /must be a \{\{param\}\} placeholder/);
});

test("verification.kind 必须在白名单内", () => {
  const raw = baseWorkflow();
  raw.plan.steps[1].verification = { kind: "run_script", value: "alert(1)" };
  assert.throws(() => validatePresetWorkflow(raw), /verification\.kind must be a supported assertion/);
});

test("未知动作键被剥离，不透传到重建后的步骤", () => {
  const raw = baseWorkflow();
  raw.plan.steps[0].action.script = "process.exit(1)";
  raw.plan.steps[1].action.onFailure = "eval";
  const workflow = validatePresetWorkflow(raw);
  assert.equal("script" in workflow.plan.steps[0].action, false);
  assert.equal("onFailure" in workflow.plan.steps[1].action, false);
});

test("TaskRuntime 加载预置工作流：出现在列表中但不写回 workflows.json", async (t) => {
  const defDir = await mkdtemp(join(tmpdir(), "webpilot-wfdef-"));
  const storeDir = await mkdtemp(join(tmpdir(), "webpilot-wfstore-"));
  const previous = { def: process.env.WEBPILOT_WORKFLOW_DEF_DIR, store: process.env.WEBPILOT_WORKFLOW_DIR };
  t.after(async () => {
    if (previous.def === undefined) delete process.env.WEBPILOT_WORKFLOW_DEF_DIR; else process.env.WEBPILOT_WORKFLOW_DEF_DIR = previous.def;
    if (previous.store === undefined) delete process.env.WEBPILOT_WORKFLOW_DIR; else process.env.WEBPILOT_WORKFLOW_DIR = previous.store;
    await rm(defDir, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  });
  await writeFile(join(defDir, "demo.json"), JSON.stringify(baseWorkflow()), "utf8");
  process.env.WEBPILOT_WORKFLOW_DEF_DIR = defDir;
  process.env.WEBPILOT_WORKFLOW_DIR = storeDir;
  const runtime = new TaskRuntime(() => Promise.reject(new Error("browser not needed")));
  const workflows = await runtime.listWorkflows();
  const preset = workflows.find(workflow => workflow.id === "preset-demo");
  assert.ok(preset, "外部目录的预置工作流应加载");
  assert.equal(preset.preset, true);
  await assert.rejects(() => access(join(storeDir, "workflows.json")), { code: "ENOENT" });
});

// —— 登录页检测与人工接管 ——

test("looksLikeLoginPage：URL 登录路径段命中，非边界子串不命中", () => {
  assert.equal(looksLikeLoginPage({ url: "https://example.com/login" }), true);
  assert.equal(looksLikeLoginPage({ url: "https://example.com/sso/start" }), true);
  assert.equal(looksLikeLoginPage({ url: "https://example.com/blog/login-tips" }), false);
});

test("looksLikeLoginPage：登录类主机名命中", () => {
  assert.equal(looksLikeLoginPage({ url: "https://accounts.google.com/v3/signin" }), true);
  assert.equal(looksLikeLoginPage({ url: "https://id.atlassian.com/" }), true);
  assert.equal(looksLikeLoginPage({ url: "https://www.example.com/" }), false);
});

test("looksLikeLoginPage：密码输入框命中，普通输入框不命中", () => {
  assert.equal(looksLikeLoginPage({ url: "https://example.com/session", interactiveElements: [{ tag: "input", type: "password" }] }), true);
  assert.equal(looksLikeLoginPage({ url: "https://example.com/search", interactiveElements: [{ tag: "input", type: "text" }] }), false);
});

const normalPage = () => ({ url: "https://example.com/dashboard", title: "Dashboard", readyState: "complete", elementCount: 1, interactiveElements: [{ tag: "a", name: "Home", href: "https://example.com" }] });
const loginPage = () => ({ url: "https://example.com/session", title: "Sign in", readyState: "complete", elementCount: 1, interactiveElements: [{ tag: "input", type: "password", name: "密码" }] });

// 按 getPageInfo 调用次序返回预排的页面快照（超出后复用最后一个），其余命令直接成功。
function scriptedBrowser(pages) {
  let index = 0;
  return async (command) => {
    if (command === "getPageInfo") return pages[Math.min(index++, pages.length - 1)]();
    if (command === "screenshot") return {};
    return { success: true };
  };
}

async function withTaskLogDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "webpilot-tasklog-"));
  const previous = process.env.WEBPILOT_TASK_LOG_DIR;
  process.env.WEBPILOT_TASK_LOG_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.WEBPILOT_TASK_LOG_DIR; else process.env.WEBPILOT_TASK_LOG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
}

test("动作后新进入登录页：任务暂停并提示 resume_task", async (t) => {
  await withTaskLogDir(t);
  // start 观察 + act 前观察都是普通页，act 后观察变成登录页
  const runtime = new TaskRuntime(scriptedBrowser([normalPage, normalPage, loginPage]));
  const task = await runtime.start("导出报表");
  const result = await runtime.act(task.id, { action: "click", selector: "#export" });
  assert.equal(result.state, "paused");
  assert.match(result.pauseReason, /login page/i);
  assert.match(result.pauseReason, /resume_task/);
});

test("已在登录页上继续操作：不重复触发暂停", async (t) => {
  await withTaskLogDir(t);
  const runtime = new TaskRuntime(scriptedBrowser([loginPage, loginPage, loginPage]));
  const task = await runtime.start("在登录页上操作");
  const result = await runtime.act(task.id, { action: "click", selector: "#next" });
  assert.equal(result.state, "verifying");
  assert.equal(result.pauseReason, undefined);
});

test("resume：人工登录完成后恢复为 observing 并报告 stillOnLoginPage", async (t) => {
  await withTaskLogDir(t);
  // 暂停后 resume 的观察回到普通页（人工已登录）
  const runtime = new TaskRuntime(scriptedBrowser([normalPage, normalPage, loginPage, normalPage]));
  const task = await runtime.start("导出报表");
  await runtime.act(task.id, { action: "click", selector: "#export" });
  const resumed = await runtime.resume(task.id);
  assert.equal(resumed.state, "observing");
  assert.equal(resumed.pauseReason, undefined);
  assert.equal(resumed.stillOnLoginPage, false);
});

test("resume：非 paused 任务拒绝恢复", async (t) => {
  await withTaskLogDir(t);
  const runtime = new TaskRuntime(scriptedBrowser([normalPage]));
  const task = await runtime.start("普通任务");
  await assert.rejects(() => runtime.resume(task.id), /only paused tasks can be resumed/);
});

// —— 任务循环观察压缩 ——

test("compactPage：只保留摘要字段，元素压成索引行，富字段不透传", () => {
  const compact = compactPage({
    url: "https://example.com", title: "Demo", readyState: "complete", elementCount: 2, fingerprint: "abc123",
    interactiveElements: [
      { ref: "@e0", tag: "button", role: "button", name: "提交", box: { x: 1, y: 2 }, testId: "submit", classHint: "btn" },
      { tag: "a", name: "Home", href: "https://example.com" },
    ],
  });
  assert.deepEqual(Object.keys(compact).sort(), ["elementCount", "elements", "fingerprint", "readyState", "title", "url"]);
  assert.equal(compact.elements[0], "@e0 [button] 提交");
  assert.equal(compact.elements[1], "[a] Home");
});

test("任务返回的 page 是紧凑表示：无 interactiveElements，指纹保留", async (t) => {
  await withTaskLogDir(t);
  const runtime = new TaskRuntime(scriptedBrowser([normalPage]));
  const task = await runtime.start("普通任务");
  assert.equal("interactiveElements" in task.page, false);
  assert.ok(Array.isArray(task.page.elements));
  assert.equal(typeof task.page.elements[0], "string");
  assert.ok(task.page.fingerprint, "指纹仍随观察回传，停滞检测证据链不受影响");
});
