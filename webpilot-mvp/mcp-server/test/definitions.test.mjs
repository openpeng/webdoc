// 定义加载器单元测试：多目录合并、覆盖、坏文件容错。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDefinitions } from "../dist/definitions.js";

// 最小校验器：要求非空字符串 id，原样返回。
const requireId = (raw) => {
  if (typeof raw?.id !== "string" || !raw.id.trim()) throw new Error("missing id");
  return raw;
};

const makeDir = async (t, files) => {
  const dir = await mkdtemp(join(tmpdir(), "webpilot-defs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof content === "string" ? content : JSON.stringify(content), "utf8");
  }
  return dir;
};

test("单对象与数组两种文件形态都可加载", async (t) => {
  const dir = await makeDir(t, {
    "single.json": { id: "a" },
    "many.json": [{ id: "b" }, { id: "c" }],
  });
  const { items, errors } = await loadDefinitions([dir], requireId);
  assert.deepEqual(items.map(item => item.id).sort(), ["a", "b", "c"]);
  assert.equal(errors.length, 0);
});

test("多目录合并，同 id 后加载者覆盖先加载者", async (t) => {
  const base = await makeDir(t, { "a.json": { id: "x", from: "base" } });
  const override = await makeDir(t, { "a.json": { id: "x", from: "override" }, "b.json": { id: "y" } });
  const { items } = await loadDefinitions([base, override], requireId);
  assert.equal(items.find(item => item.id === "x")?.from, "override");
  assert.equal(items.length, 2);
});

test("坏 JSON 与校验失败只跳过该条，不影响其它定义", async (t) => {
  const dir = await makeDir(t, {
    "bad.json": "{ not json",
    "invalid.json": { name: "no id" },
    "good.json": { id: "ok" },
  });
  const { items, errors } = await loadDefinitions([dir], requireId);
  assert.deepEqual(items.map(item => item.id), ["ok"]);
  assert.equal(errors.length, 2);
  assert.ok(errors.every(error => error.source.includes(dir)));
});

test("目录不存在（ENOENT）静默返回空，不记错误", async (t) => {
  const dir = await makeDir(t, {});
  const missing = join(dir, "does-not-exist");
  const { items, errors } = await loadDefinitions([missing], requireId);
  assert.equal(items.length, 0);
  assert.equal(errors.length, 0);
});

test("只读取 .json 文件，忽略其它扩展名与子目录", async (t) => {
  const dir = await makeDir(t, {
    "a.json": { id: "a" },
    "notes.txt": "not a definition",
  });
  await mkdir(join(dir, "sub"), { recursive: true });
  const { items, errors } = await loadDefinitions([dir], requireId);
  assert.deepEqual(items.map(item => item.id), ["a"]);
  assert.equal(errors.length, 0);
});
