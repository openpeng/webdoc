// 适配器白名单校验与注册表加载测试。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAdapter, AdapterRegistry } from "../dist/adapters.js";
import { loadDefinitions, BUILTIN_ADAPTER_DIR, BUILTIN_WORKFLOW_DIR } from "../dist/definitions.js";
import { validatePresetWorkflow } from "../dist/task-runtime.js";

const baseAdapter = () => ({
  id: "demo",
  name: "Demo",
  description: "demo adapter",
  domains: ["example.com"],
  spec: { fields: { title: { selector: "h1" } } },
});

test("合法定义通过校验并保留白名单字段", () => {
  const adapter = validateAdapter(baseAdapter(), "test");
  assert.equal(adapter.id, "demo");
  assert.deepEqual(adapter.spec.fields.title, { selector: "h1" });
});

test("恶意 computed 字段被丢弃，不出现在重建后的 spec 中", () => {
  const raw = baseAdapter();
  raw.spec.computed = "process.exit(1)";
  raw.spec.fields.title.computed = "javascript:alert(1)";
  const adapter = validateAdapter(raw, "test");
  assert.equal("computed" in adapter.spec, false);
  assert.equal("computed" in adapter.spec.fields.title, false);
});

test("attribute 白名单只接受 href/content，拒绝 text 等其它值", () => {
  const good = baseAdapter();
  good.spec.fields.title.attribute = "href";
  assert.equal(validateAdapter(good, "test").spec.fields.title.attribute, "href");
  const bad = baseAdapter();
  bad.spec.fields.title.attribute = "text";
  assert.throws(() => validateAdapter(bad, "test"), /attribute must be href or content/);
});

test("非法 pathPattern 正则抛错（加载器将跳过该条）", () => {
  const raw = baseAdapter();
  raw.pathPattern = "([unclosed";
  assert.throws(() => validateAdapter(raw, "test"), /invalid pathPattern/);
});

test("spec 至少需要 fields/list/table 之一", () => {
  const raw = baseAdapter();
  raw.spec = {};
  assert.throws(() => validateAdapter(raw, "test"), /requires at least one of/);
});

test("注册表按 URL 匹配：精确域名、子域后缀、* 通配", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "webpilot-adapters-"));
  t.after(async () => {
    delete process.env.WEBPILOT_ADAPTER_DIR;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, "test.json"), JSON.stringify([
    { ...baseAdapter(), id: "exact", domains: ["example.com"] },
    { ...baseAdapter(), id: "wildcard", domains: ["*"] },
    { ...baseAdapter(), id: "other", domains: ["other.org"] },
  ]), "utf8");
  process.env.WEBPILOT_ADAPTER_DIR = dir;
  const registry = new AdapterRegistry(() => Promise.reject(new Error("browser not needed")));
  const ids = (await registry.list("https://sub.example.com/page")).map(item => item.id);
  assert.ok(ids.includes("exact"), "子域后缀应命中 example.com");
  assert.ok(ids.includes("wildcard"), "* 通配应命中任意 URL");
  assert.ok(!ids.includes("other"), "不相关域名不应命中");
});

test("内置 adapters 定义目录全量加载无错误", async () => {
  const { items, errors } = await loadDefinitions([BUILTIN_ADAPTER_DIR], validateAdapter);
  assert.ok(items.length > 0, "内置适配器不应为空");
  assert.deepEqual(errors, []);
});

test("内置 workflows 定义目录全量加载无错误", async () => {
  const { items, errors } = await loadDefinitions([BUILTIN_WORKFLOW_DIR], validatePresetWorkflow);
  assert.ok(items.length > 0, "内置预置工作流不应为空");
  assert.deepEqual(errors, []);
  assert.ok(items.every(workflow => workflow.id.startsWith("preset-")));
});
