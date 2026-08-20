// 选择器缓存单元测试：直接驱动 dist 产物中的 SelectorCache。
// 运行: npm test（或 node --test test/）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelectorCache, isCacheableSelector, isValidIntent } from "../dist/selector-cache.js";

const withTempFile = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "webpilot-selcache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "selector-cache.json");
};

test("存储后可命中，host 大小写不敏感", async (t) => {
  const cache = new SelectorCache(await withTempFile(t));
  await cache.recordSuccess("www.baidu.com", "search-input", "#kw", 120);
  const hit = await cache.lookup("WWW.BAIDU.COM", "search-input");
  assert.equal(hit?.selector, "#kw");
  assert.equal(hit?.hits, 1);
});

test("4 次连续失败禁用条目，成功后复活并重置计数", async (t) => {
  const cache = new SelectorCache(await withTempFile(t));
  await cache.recordSuccess("www.baidu.com", "search-input", "#kw", 120);
  for (let i = 0; i < 4; i += 1) await cache.recordFailure("www.baidu.com", "search-input", "timeout");
  assert.equal(await cache.lookup("www.baidu.com", "search-input"), undefined);
  assert.equal(await cache.status("www.baidu.com", "search-input"), "disabled");
  assert.equal(await cache.status("www.baidu.com", "nope"), "missing");
  await cache.recordSuccess("www.baidu.com", "search-input", "#kw", 90);
  const revived = await cache.lookup("www.baidu.com", "search-input");
  assert.equal(revived?.disabled, false);
  assert.equal(revived?.consecutiveFailures, 0);
});

test("持久化后新实例可加载", async (t) => {
  const file = await withTempFile(t);
  const cache = new SelectorCache(file);
  await cache.recordSuccess("www.baidu.com", "search-input", "#kw", 120);
  const reloaded = new SelectorCache(file);
  assert.equal((await reloaded.lookup("www.baidu.com", "search-input"))?.selector, "#kw");
});

test("篡改文件注入 @wpN/@eN 条目被跳过，正常条目保留", async (t) => {
  const file = await withTempFile(t);
  const cache = new SelectorCache(file);
  await cache.recordSuccess("www.baidu.com", "search-input", "#kw", 120);
  const raw = JSON.parse(await readFile(file, "utf8"));
  raw.push({ host: "evil.com", intent: "steal", selector: "@wp1" });
  raw.push({ host: "evil.com", intent: "steal2", selector: "@e3" });
  await writeFile(file, JSON.stringify(raw), "utf8");
  const tampered = new SelectorCache(file);
  assert.equal(await tampered.lookup("evil.com", "steal"), undefined);
  assert.equal(await tampered.lookup("evil.com", "steal2"), undefined);
  assert.equal((await tampered.lookup("www.baidu.com", "search-input"))?.selector, "#kw");
});

test("intent 白名单：小写字母数字 ._- 且不超过 64 字符", async (t) => {
  assert.equal(isValidIntent("Search-Input"), false);
  assert.equal(isValidIntent("search input!"), false);
  assert.equal(isValidIntent("a".repeat(65)), false);
  assert.equal(isValidIntent("search-input.v2_x"), true);
  const cache = new SelectorCache(await withTempFile(t));
  await assert.rejects(() => cache.recordSuccess("www.baidu.com", "BAD!", "#kw", 1));
});

test("@eN/@wpN 文档级临时引用不可入缓存", async (t) => {
  assert.equal(isCacheableSelector("@e5"), false);
  assert.equal(isCacheableSelector("@wp12"), false);
  assert.equal(isCacheableSelector("#kw"), true);
  assert.equal(isCacheableSelector("text=登录"), true);
  const cache = new SelectorCache(await withTempFile(t));
  await assert.rejects(() => cache.recordSuccess("www.baidu.com", "search-input", "@wp9", 1));
});
