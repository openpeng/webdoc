// 域名级缓存 Repository 测试：持久化/重启命中、损坏备份、注入条目跳过、
// schemaVersion、full/merge 人工修正保护、失败状态机、健康度报告、写失败不阻断
// （AC-11/13/14/15/16/17/18/19/20/27）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiCommandCache, toCommand, defaultApiCommandCacheFile, buildCacheTmpName,
} from "../dist/api-command-cache.js";
import { generateCommands } from "../dist/api-command-generator.js";
import {
  ERROR_SAFE_MESSAGES, STALE_MANUAL_WARNING, CACHE_FILE_NAME,
  CACHE_WRITE_SKIPPED_WARNING, CACHE_LOAD_FAILED_WARNING,
} from "../dist/api-command-types.js";

const DOMAIN = "api.example.com";
const NOW = "2026-01-01T00:00:00.000Z";

const baseRec = (overrides = {}) => ({
  requestId: "r1", host: DOMAIN, method: "GET", path: "/v1/users/1",
  pathSegments: ["v1", "users", "1"], queryPairs: [], bodyFields: [],
  bodyIsJson: false, status: 200, mimeType: "application/json",
  resourceType: "xhr", timestamp: 1, headerNames: [],
  ...overrides,
});

// 用真实生成器产出两条合法命令，避免手写结构与白名单重建规则漂移
function makeCommands() {
  return generateCommands([
    { method: "GET", pathTemplate: "/v1/users/{id}", pathParams: ["id"], host: DOMAIN,
      records: [baseRec()] },
    { method: "GET", pathTemplate: "/v1/orders", pathParams: [], host: DOMAIN,
      records: [baseRec({ path: "/v1/orders", pathSegments: ["v1", "orders"] })] },
  ], { domain: DOMAIN, analysisId: "an_cache", generatedBy: "1.1.1",
       schema: new Map(), now: NOW }).commands;
}

const withTemp = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "webpilot-apicache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, CACHE_FILE_NAME) };
};
const writeRaw = (file, obj) => writeFile(file, JSON.stringify(obj, null, 2), "utf8");
const bucket = (commands, host = DOMAIN) => ({
  version: 1, generatedBy: "1.1.1", updatedAt: NOW,
  domains: { [host]: { host, updatedAt: NOW, commands } },
});
// 复制合法命令并改写 commandId；用 defineProperty 制造 own __proto__ / constructor 键
const clone = (base, id, mutate = () => {}) => {
  const c = JSON.parse(JSON.stringify(base));
  c.commandId = id;
  mutate(c);
  return c;
};
const ownKey = (obj, key, value) => Object.defineProperty(obj, key, {
  value, enumerable: true, writable: true, configurable: true,
});

// 为任意域名生成一条合法命令（跨进程 / 跨域名一致性用例用）
function makeCommandsFor(host) {
  return generateCommands([
    { method: "GET", pathTemplate: "/v1/users/{id}", pathParams: ["id"], host,
      records: [baseRec({ host })] },
  ], { domain: host, analysisId: "an_cache", generatedBy: "1.1.1",
       schema: new Map(), now: NOW }).commands;
}

// 可控读失败的缓存实例：failures>0 时读盘一律失败（模拟 IO 错误 / 锁占用）
class FlakyCache extends ApiCommandCache {
  constructor(file, failures = 1) {
    super(file);
    this.failures = failures;
  }
  async readCacheText() {
    if (this.failures > 0) {
      this.failures -= 1;
      return { kind: "unreadable", reason: "模拟读盘失败" };
    }
    return super.readCacheText();
  }
}

test("落盘 JSON → 新实例加载仍命中（AC-11）", async (t) => {
  const { file } = await withTemp(t);
  const commands = makeCommands();
  const cache = new ApiCommandCache(file);
  const merged = await cache.merge(DOMAIN, commands, { mode: "full", overwriteManual: false });
  assert.equal(merged.diff.added, 2);

  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.generatedBy, "1.1.1");
  assert.equal(raw.domains[DOMAIN].commands.length, 2);
  assert.ok(raw.domains[DOMAIN].commands.every((c) => c.domain === DOMAIN));

  const reloaded = new ApiCommandCache(file);
  const listed = await reloaded.list(DOMAIN);
  assert.equal(listed.cacheHit, true, "重启/重载后必须仍命中缓存");
  assert.equal(listed.total, 2);
  assert.equal(listed.autoLoaded, true);
  const one = await reloaded.get(DOMAIN, { commandId: commands[0].commandId });
  assert.equal(one.commandId, commands[0].commandId);
  assert.equal(one.request.pathTemplate, "/v1/users/{id}");
  assert.equal((await reloaded.get(DOMAIN, { name: commands[1].name })).commandId, commands[1].commandId);
});

// ---------------------------------------------------------------------------
// T5 导出 / 导入闭环（AC-7）
// ---------------------------------------------------------------------------

test("T5：导出 → 清空 → 导入，命令条数 / 名称 / 参数 / 响应裁剪规则一致且可直接调用", async (t) => {
  const { dir, file } = await withTemp(t);
  const cache = new ApiCommandCache(file);
  const commands = makeCommands();
  await cache.merge(DOMAIN, commands, { mode: "full", overwriteManual: false });
  // 人工改一条：加响应裁剪规则与备注，导出后必须原样保留。
  await cache.update(DOMAIN, commands[0].commandId, {
    responseFields: ["id", "name"],
    note: "人工确认过的字段",
  });

  const exportPath = join(dir, "exported.api-commands.json");
  const exported = await cache.export(DOMAIN, exportPath);
  assert.equal(exported.exported, 2);
  assert.equal(exported.path, exportPath);

  const raw = JSON.parse(await readFile(exportPath, "utf8"));
  assert.equal(raw.kind, "webpilot-api-command-set");
  assert.equal(raw.domain, DOMAIN);
  assert.equal(raw.commands.length, 2);
  assert.ok(!JSON.stringify(raw).includes("Cookie"), "导出件不得含凭据头");

  // 清空缓存后导入（模拟交付他人 → 对方导入）。
  const other = new ApiCommandCache(join(dir, "other.json"));
  const imported = await other.import(DOMAIN, exportPath, { overwrite: false });
  assert.equal(imported.imported, 2);
  assert.equal(imported.skipped, 0);

  const before = await cache.list(DOMAIN, { includeDisabled: true });
  const after = await other.list(DOMAIN, { includeDisabled: true });
  assert.equal(after.total, before.total, "导入后条数必须一致");
  assert.deepEqual(
    after.commands.map((c) => c.name).sort(),
    before.commands.map((c) => c.name).sort(),
    "导入后名称必须一致",
  );
  assert.deepEqual(
    after.commands.find((c) => c.name === before.commands[0].name)?.responseFields,
    before.commands.find((c) => c.name === before.commands[0].name)?.responseFields,
    "响应裁剪规则必须一致",
  );
  const importedCommand = await other.get(DOMAIN, { name: commands[0].name });
  assert.ok(importedCommand, "导入后应能按名命中");
  assert.equal(importedCommand.note, "人工确认过的字段", "备注必须保留");
  assert.equal(importedCommand.manuallyEdited, true, "人工标记必须保留");
  assert.ok(
    importedCommand.request.urlTemplate.startsWith(`https://${DOMAIN}/`),
    "导入后的 urlTemplate 必须指向目标域名，可直接调用",
  );
});

test("T5：导入到别的域名时 urlTemplate 主机被改写；同名命令默认跳过、overwrite 才覆盖", async (t) => {
  const { dir, file } = await withTemp(t);
  const cache = new ApiCommandCache(file);
  await cache.merge(DOMAIN, makeCommands(), { mode: "full", overwriteManual: false });
  const exportPath = join(dir, "exported.json");
  await cache.export(DOMAIN, exportPath);

  const other = new ApiCommandCache(join(dir, "other.json"));
  const target = "other.example.com";
  const imported = await other.import(target, exportPath, { overwrite: false });
  assert.equal(imported.imported, 2);
  const listed = await other.list(target);
  assert.equal(listed.total, 2);
  assert.ok(listed.commands.every((c) => c.urlTemplate.startsWith(`https://${target}/`)),
    "urlTemplate 主机必须改写成目标域名");

  // 再导入一次：同名跳过。
  const again = await other.import(target, exportPath, { overwrite: false });
  assert.equal(again.imported, 0);
  assert.equal(again.skipped, 2);
  // overwrite=true 才覆盖。
  const forced = await other.import(target, exportPath, { overwrite: true });
  assert.equal(forced.imported, 2);
  assert.equal((await other.list(target)).total, 2);
});

test("T5：导入非法文件（不存在 / 非 JSON / 无 commands）一律不写入并给出告警", async (t) => {
  const { dir, file } = await withTemp(t);
  const cache = new ApiCommandCache(file);
  const missing = await cache.import(DOMAIN, join(dir, "nope.json"));
  assert.equal(missing.imported, 0);
  assert.ok(missing.warnings.length > 0);

  const badPath = join(dir, "bad.json");
  await writeFile(badPath, "{ not json", "utf8");
  const bad = await cache.import(DOMAIN, badPath);
  assert.equal(bad.imported, 0);
  assert.ok(bad.warnings.some((w) => w.includes("JSON")));

  const emptyPath = join(dir, "empty.json");
  await writeFile(emptyPath, JSON.stringify({ commands: [] }), "utf8");
  const empty = await cache.import(DOMAIN, emptyPath);
  assert.equal(empty.imported, 0);
  assert.ok(empty.warnings.length > 0);
  assert.equal((await cache.list(DOMAIN)).total, 0, "非法导入不得污染缓存");
});

test("损坏 JSON → 备份 *.corrupt-<ts> 后重建空缓存，不崩溃（AC-16）", async (t) => {  const { file } = await withTemp(t);
  const cache1 = new ApiCommandCache(file);
  await cache1.merge(DOMAIN, [makeCommands()[0]], { mode: "full", overwriteManual: false });
  const broken = "{ this is not json";
  await writeFile(file, broken, "utf8");

  const cache2 = new ApiCommandCache(file);
  await assert.doesNotReject(() => cache2.ensureLoaded());
  const diag = cache2.diagnostics();
  assert.ok(diag.backupFile, "必须生成损坏文件备份");
  assert.match(diag.backupFile, /\.corrupt-\d+$/);
  assert.equal(await readFile(diag.backupFile, "utf8"), broken);
  await assert.rejects(() => access(file), "原文件应已被 rename 走");
  assert.ok(diag.errors.some((e) => e.error.includes("JSON 解析失败")));

  const listed = await cache2.list(DOMAIN);
  assert.equal(listed.cacheHit, false);
  assert.equal(listed.total, 0);
  assert.ok(listed.warnings.some((w) => w.includes("缓存加载告警")));
  // 重建后可正常写入
  const again = await cache2.merge(DOMAIN, [makeCommands()[1]], { mode: "merge", overwriteManual: false });
  assert.equal(again.diff.added, 1);
});

test("注入条目（外域 URL / 字面凭据 / 可执行字段 / 原型键）被跳过并计入 skippedInvalid[]（AC-17）", async (t) => {
  const { file } = await withTemp(t);
  const good = makeCommands()[0];
  const bad = [
    clone(good, "cmd_0000000001", (c) => { c.request.urlTemplate = "https://evil.example.net/v1/users/{{id}}"; }),
    clone(good, "cmd_0000000002", (c) => { c.request.bodyTemplate = { token: "eyJhbGciOi.x.y" }; }),
    clone(good, "cmd_0000000003", (c) => { c.note = "Bearer abcdefghijklmnopqrstuvwxyz"; }),
    clone(good, "cmd_0000000004", (c) => { c.computed = "() => 1"; }),
    clone(good, "cmd_0000000005", (c) => { c.script = "alert(1)"; }),
    clone(good, "cmd_0000000006", (c) => { c.headers = { authorization: "SECRET_HEADER" }; }),
    clone(good, "cmd_0000000007", (c) => { c.eval = "1+1"; }),
    clone(good, "cmd_0000000008", (c) => ownKey(c, "__proto__", { polluted: true })),
    clone(good, "cmd_0000000009", (c) => ownKey(c, "constructor", { polluted: true })),
    clone(good, "cmd_0000000010", (c) => { c.prototype = { polluted: true }; }),
    clone(good, "cmd_0000000011", (c) => { c.request.queryTemplate = { token: "SECRET_QUERY_VALUE" }; }),
    clone(good, "cmd_0000000012", (c) => {
      c.request.urlTemplate = `https://${DOMAIN}/v1/users/{{id}}?token=SECRET_QUERY_VALUE_2`;
    }),
  ];
  await writeRaw(file, bucket([good, ...bad]));
  const cache = new ApiCommandCache(file);
  await cache.ensureLoaded();
  const diag = cache.diagnostics();
  assert.equal(diag.skippedInvalid.length, bad.length,
    `应跳过 ${bad.length} 条注入条目，实际 ${diag.skippedInvalid.length}`);
  assert.ok(diag.skippedInvalid.every((s) => s.host === DOMAIN && typeof s.reason === "string"));
  assert.equal(diag.errors.length >= bad.length, true);
  assert.ok(await cache.get(DOMAIN, { commandId: good.commandId }), "正常条目必须保留");
  for (const injected of bad) {
    assert.equal(await cache.get(DOMAIN, { commandId: injected.commandId }), undefined);
  }
  // 原型注入不得污染全局对象
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal({}.constructor, Object);
  // 未知字段不跳过整条，但必须被白名单重建丢弃
  const withUnknown = clone(good, "cmd_0000000013", (c) => { c.mysteryField = "SHOULD_BE_DROPPED"; });
  await writeRaw(file, bucket([withUnknown]));
  const cache2 = new ApiCommandCache(file);
  await cache2.ensureLoaded();
  const rebuilt = await cache2.get(DOMAIN, { commandId: "cmd_0000000013" });
  assert.ok(rebuilt);
  assert.equal(Object.hasOwn(rebuilt, "mysteryField"), false);
  assert.equal(cache2.diagnostics().skippedInvalid.length, 0);
});

test("schemaVersion 高于支持版本跳过、低于标 needsMigration（AC-18）", async (t) => {
  const { file } = await withTemp(t);
  const [a, b] = makeCommands();
  await writeRaw(file, bucket([
    { ...a, commandId: "cmd_aaaaaaaaaa", schemaVersion: 2 },
    { ...b, commandId: "cmd_bbbbbbbbbb", schemaVersion: 0 },
    { ...a, commandId: "cmd_cccccccccc", schemaVersion: 1 },
  ]));
  const cache = new ApiCommandCache(file);
  await cache.ensureLoaded();
  assert.equal(await cache.get(DOMAIN, { commandId: "cmd_aaaaaaaaaa" }), undefined);
  assert.ok(cache.diagnostics().skippedInvalid.some((s) => s.reason.includes("高于支持版本")));
  const low = await cache.get(DOMAIN, { commandId: "cmd_bbbbbbbbbb" });
  assert.ok(low);
  assert.equal(low.health.needsMigration, true);
  assert.equal(low.schemaVersion, 0);
  assert.ok(cache.diagnostics().errors.some((e) => e.error.includes("needsMigration")));
  const normal = await cache.get(DOMAIN, { commandId: "cmd_cccccccccc" });
  assert.equal(normal.health.needsMigration, false);
  assert.equal((await cache.report(DOMAIN)).schemaVersion, 1);
});

test("full vs merge 均返回 diff；人工修正 name/params/note 默认保留（AC-13/14）", async (t) => {
  const { file } = await withTemp(t);
  const [a, b] = makeCommands();
  const cache = new ApiCommandCache(file);
  const first = await cache.merge(DOMAIN, [a, b], { mode: "merge", overwriteManual: false });
  assert.deepEqual(first.diff.added, 2);
  for (const key of ["added", "updated", "removed", "skipped", "reviewRequired"]) {
    assert.equal(typeof first.diff[key], "number");
  }

  await cache.update(DOMAIN, a.commandId, {
    name: "manual.users", note: "人工备注", responseFields: ["code"],
  });
  await cache.update(DOMAIN, b.commandId, { name: "manual.orders" });

  // merge：人工修正保留，removed 恒为 0，未观测条目标 stale
  const mergeResult = await cache.merge(DOMAIN, [a], { mode: "merge", overwriteManual: false });
  assert.equal(mergeResult.diff.removed, 0);
  assert.ok(mergeResult.preservedManualEdits.some((s) => s.includes(a.commandId)));
  assert.ok(mergeResult.stale.includes(b.commandId));
  const preserved = await cache.get(DOMAIN, { commandId: a.commandId });
  assert.equal(preserved.name, "manual.users");
  assert.equal(preserved.note, "人工备注");
  assert.deepEqual(preserved.responseFields, ["code"]);
  assert.equal(preserved.manuallyEdited, true);

  // full：未观测的人工条目保留 + stale + warnings[]（不静默删除人工资产）
  const fullResult = await cache.merge(DOMAIN, [a], { mode: "full", overwriteManual: false });
  assert.ok(fullResult.stale.includes(b.commandId));
  assert.ok(fullResult.warnings.some((w) => w.includes(STALE_MANUAL_WARNING)));
  assert.ok(await cache.get(DOMAIN, { commandId: b.commandId }));

  // 仅 overwriteManual:true 才真正覆盖/删除
  const overwrite = await cache.merge(DOMAIN, [a], { mode: "full", overwriteManual: true });
  assert.ok(overwrite.diff.removed >= 1);
  assert.equal(await cache.get(DOMAIN, { commandId: b.commandId }), undefined);
  assert.equal((await cache.get(DOMAIN, { commandId: a.commandId })).name !== "manual.users", true);
});

test("连续 4 次失败自动禁用，一次成功复活并清零计数（AC-15）", async (t) => {
  const { file } = await withTemp(t);
  const [a] = makeCommands();
  const cache = new ApiCommandCache(file);
  await cache.merge(DOMAIN, [a], { mode: "full", overwriteManual: false });
  for (let i = 0; i < 4; i += 1) {
    await cache.recordFailure(DOMAIN, a.commandId, "NETWORK_ERROR", "boom");
  }
  assert.equal(await cache.get(DOMAIN, { commandId: a.commandId }), undefined, "4 次失败后视同未命中");
  const disabledReport = await cache.report(DOMAIN);
  assert.equal(disabledReport.perCommand[0].disabled, true);
  assert.equal(disabledReport.perCommand[0].consecutiveFailures, 4);

  await cache.recordSuccess(DOMAIN, a.commandId, 120);
  const revived = await cache.get(DOMAIN, { commandId: a.commandId });
  assert.ok(revived);
  assert.equal(revived.health.disabled, false);
  assert.equal(revived.health.consecutiveFailures, 0);
  assert.equal(revived.health.hits, 1);
  assert.equal(revived.health.authRequired, false);
  assert.equal(revived.health.stale, false);
});

test("AUTH_REQUIRED 不禁用、不计连续失败；disabled / deprecated 视同未命中（AC-19）", async (t) => {
  const { file } = await withTemp(t);
  const [a, b] = makeCommands();
  const cache = new ApiCommandCache(file);
  await cache.merge(DOMAIN, [a, b], { mode: "full", overwriteManual: false });
  for (let i = 0; i < 6; i += 1) {
    await cache.recordFailure(DOMAIN, a.commandId, "AUTH_REQUIRED", ERROR_SAFE_MESSAGES.AUTH_REQUIRED);
  }
  const cmd = await cache.get(DOMAIN, { commandId: a.commandId });
  assert.ok(cmd, "登录失效绝不禁用命令");
  assert.equal(cmd.health.authRequired, true);
  assert.equal(cmd.health.consecutiveFailures, 0);
  assert.equal(cmd.health.disabled, false);
  assert.equal(cmd.health.lastError, ERROR_SAFE_MESSAGES.AUTH_REQUIRED);
  assert.equal((await cache.report(DOMAIN)).perCommand.find((p) => p.commandId === a.commandId).misses, 0);

  await cache.invalidate(DOMAIN, { commandId: b.commandId, action: "disable" });
  assert.equal(await cache.get(DOMAIN, { commandId: b.commandId }), undefined);
  assert.equal((await cache.list(DOMAIN)).total, 1);
  assert.equal((await cache.list(DOMAIN, { includeDisabled: true })).total, 2);
  await cache.update(DOMAIN, a.commandId, { deprecated: true });
  assert.equal(await cache.get(DOMAIN, { commandId: a.commandId }), undefined);
  assert.equal((await cache.list(DOMAIN, { includeDisabled: true })).total, 2);
});

test("report() 健康度：hits/misses/averageDurationMs/skippedInvalid/errors（AC-15/27）", async (t) => {
  const { file } = await withTemp(t);
  const [a] = makeCommands();
  const cache = new ApiCommandCache(file);
  await cache.merge(DOMAIN, [a], { mode: "full", overwriteManual: false });
  await cache.recordSuccess(DOMAIN, a.commandId, 100);
  await cache.recordSuccess(DOMAIN, a.commandId, 200);
  await cache.recordFailure(DOMAIN, a.commandId, "HTTP_ERROR", "HTTP 500");
  const report = await cache.report(DOMAIN);
  assert.equal(report.domains.length, 1);
  assert.equal(report.domains[0].host, DOMAIN);
  assert.equal(report.domains[0].commandCount, 1);
  assert.equal(report.perCommand[0].hits, 2);
  assert.equal(report.perCommand[0].misses, 1);
  assert.equal(report.perCommand[0].averageDurationMs, 150);
  assert.equal(report.perCommand[0].consecutiveFailures, 1);
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.skippedInvalid, []);
  assert.deepEqual(report.errors, []);
  assert.deepEqual((await cache.report()).domains.length, 1);
});

test("get()/list() 是纯读：反复查询不改变 hits/misses（关键约定）", async (t) => {
  const { file } = await withTemp(t);
  const [a] = makeCommands();
  const cache = new ApiCommandCache(file);
  await cache.merge(DOMAIN, [a], { mode: "full", overwriteManual: false });
  for (let i = 0; i < 5; i += 1) {
    await cache.get(DOMAIN, { commandId: a.commandId });
    await cache.list(DOMAIN);
  }
  const report = await cache.report(DOMAIN);
  assert.equal(report.perCommand[0].hits, 0);
  assert.equal(report.perCommand[0].misses, 0);
  assert.equal(report.perCommand[0].consecutiveFailures, 0);
  assert.deepEqual(await cache.summary(DOMAIN), [{
    commandId: a.commandId, name: a.name, method: "GET", risk: "read",
    available: true, manuallyEdited: false,
  }]);
});

test("缓存写失败只告警不阻断调用链路（AC-16 边界）", async (t) => {
  const { dir } = await withTemp(t);
  const blocker = join(dir, "blocker");
  await writeFile(blocker, "not a directory", "utf8");
  const file = join(blocker, CACHE_FILE_NAME); // 父路径是普通文件 → mkdir / rename 必然失败
  const cache = new ApiCommandCache(file);
  const original = console.error;
  console.error = () => {};
  try {
    const [a] = makeCommands();
    await assert.doesNotReject(() => cache.merge(DOMAIN, [a], { mode: "merge", overwriteManual: false }));
    const listed = await cache.list(DOMAIN);
    assert.equal(listed.cacheHit, true, "写盘失败不得影响内存态与调用链路");
    assert.equal(listed.total, 1);
    assert.ok(await cache.get(DOMAIN, { commandId: a.commandId }));
    await assert.rejects(() => readFile(file, "utf8"), "写失败时不应产生缓存文件");
    assert.ok(Array.isArray(cache.diagnostics().errors));
  } finally {
    console.error = original;
  }
});

test("invalidate: disable / delete / clear_domain 计数正确", async (t) => {
  const { file } = await withTemp(t);
  const [a, b] = makeCommands();
  const cache = new ApiCommandCache(file);
  await cache.merge(DOMAIN, [a, b], { mode: "full", overwriteManual: false });
  assert.deepEqual(await cache.invalidate(DOMAIN, { commandId: a.commandId, action: "disable" }),
    { affected: 1, remaining: 2 });
  assert.deepEqual(await cache.invalidate(DOMAIN, { commandId: b.commandId, action: "delete" }),
    { affected: 1, remaining: 1 });
  const cleared = await cache.invalidate(DOMAIN, { action: "clear_domain" });
  assert.equal(cleared.affected, 1);
  assert.equal(cleared.remaining, 0);
  assert.equal((await cache.list(DOMAIN)).cacheHit, false);
  assert.deepEqual(await cache.invalidate("missing.test", { action: "clear_domain" }),
    { affected: 0, remaining: 0 });
});

test("结构非法 / hostname 非法 / 高 version 缓存文件：告警但不崩溃", async (t) => {
  const { file } = await withTemp(t);
  await writeRaw(file, { version: 1, generatedBy: "1.1.1" }); // 缺 domains
  const c1 = new ApiCommandCache(file);
  await assert.doesNotReject(() => c1.ensureLoaded());
  assert.ok(c1.diagnostics().errors.some((e) => e.error.includes("结构非法")));

  await writeRaw(file, { version: 9, generatedBy: "x", updatedAt: NOW,
    domains: { [DOMAIN]: { host: DOMAIN, commands: [] } } });
  const c2 = new ApiCommandCache(file);
  await c2.ensureLoaded();
  assert.ok(c2.diagnostics().errors.some((e) => e.error.includes("高于支持版本")));

  await writeRaw(file, { version: 1, generatedBy: "x", updatedAt: NOW,
    domains: { "*.evil.test": { host: "*.evil.test", commands: [] } } });
  const c3 = new ApiCommandCache(file);
  await c3.ensureLoaded();
  assert.ok(c3.diagnostics().skippedInvalid.some((s) => s.reason.includes("hostname 非法")));
  assert.ok(c3.diagnostics().errors.some((e) => e.error.includes("hostname 非法")));
});

test("超长字段 / 凭据 note 被跳过，超长 responseFields 被丢弃，toCommand 逐字段重建", async (t) => {
  const { file } = await withTemp(t);
  const base = makeCommands()[0];
  const longNote = clone(base, "cmd_0000000021", (c) => { c.note = "x".repeat(600); });
  const credNote = clone(base, "cmd_0000000022", (c) => { c.note = "Bearer abcdefghijklmnop"; });
  const longField = clone(base, "cmd_0000000023", (c) => { c.responseFields = ["y".repeat(300), "code"]; });
  await writeRaw(file, bucket([longNote, credNote, longField]));
  const cache = new ApiCommandCache(file);
  await cache.ensureLoaded();
  assert.equal(await cache.get(DOMAIN, { commandId: "cmd_0000000021" }), undefined);
  assert.equal(await cache.get(DOMAIN, { commandId: "cmd_0000000022" }), undefined);
  const kept = await cache.get(DOMAIN, { commandId: "cmd_0000000023" });
  assert.deepEqual(kept.responseFields, ["code"], "超长点路径必须被丢弃");
  // 直接对 dist/toCommand 做单元级断言
  const diag = { skippedInvalid: [], errors: [] };
  assert.equal(toCommand(null, DOMAIN, diag), undefined);
  assert.equal(toCommand({ commandId: "BAD" }, DOMAIN, diag), undefined);
  const evil = clone(base, "cmd_0000000024", (c) => { c.request.urlTemplate = "https://evil.test/x"; });
  assert.equal(toCommand(evil, DOMAIN, diag), undefined);
  assert.equal(diag.skippedInvalid.length, 3);
  assert.ok(diag.skippedInvalid.every((s) => !s.reason.includes("SECRET")));

  // defaultApiCommandCacheFile 遵循 WEBPILOT_API_COMMAND_DIR
  const dir = (await withTemp(t)).dir;
  const prev = process.env.WEBPILOT_API_COMMAND_DIR;
  process.env.WEBPILOT_API_COMMAND_DIR = dir;
  try {
    assert.equal(defaultApiCommandCacheFile(), join(dir, CACHE_FILE_NAME));
  } finally {
    if (prev === undefined) delete process.env.WEBPILOT_API_COMMAND_DIR;
    else process.env.WEBPILOT_API_COMMAND_DIR = prev;
  }
});

// ---------------------------------------------------------------------------
// T6 缓存一致性：写盘前重读合并 + 唯一 tmp 名 + loadFailed 保护（AC-9）
// ---------------------------------------------------------------------------

test("T6：两个进程先后写不同域名，磁盘上两个域名的命令都存在（AC-9）", async (t) => {
  const { file } = await withTemp(t);
  const hostA = "a.example.com";
  const hostB = "b.example.com";

  // 进程 A 先加载（此刻磁盘为空）→ 进程 B 写 hostB → 进程 A 再写 hostA。
  // 基线行为：进程 A 用自己的旧快照整片覆盖磁盘，hostB 被抹除。
  const cacheA = new ApiCommandCache(file);
  await cacheA.ensureLoaded();
  const cacheB = new ApiCommandCache(file);
  await cacheB.merge(hostB, makeCommandsFor(hostB), { mode: "full", overwriteManual: false });
  await cacheA.merge(hostA, makeCommandsFor(hostA), { mode: "full", overwriteManual: false });

  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.ok(raw.domains[hostA], "先写者的域名必须仍在磁盘上");
  assert.ok(raw.domains[hostB], "后写者不得抹掉先写者的域名");
  assert.equal(raw.domains[hostA].commands.length, 1);
  assert.equal(raw.domains[hostB].commands.length, 1);

  // 两个域名各自重新加载都能命中
  assert.equal((await new ApiCommandCache(file).list(hostA)).total, 1);
  assert.equal((await new ApiCommandCache(file).list(hostB)).total, 1);
});

test("T6：tmp 文件名唯一（含 pid + 时间戳 + 序号），写盘不残留 tmp 文件", async (t) => {
  const { dir, file } = await withTemp(t);
  const name = buildCacheTmpName(file, 0, 1767225600000, 4321);
  assert.match(name, /\.tmp-4321-1767225600000-0$/, "tmp 名必须含 pid 与时间戳");
  assert.notEqual(
    buildCacheTmpName(file, 0, 1767225600000, 4321),
    buildCacheTmpName(file, 1, 1767225600000, 4321),
    "同毫秒同 pid 下序号不同，tmp 名不得撞名",
  );

  const cache = new ApiCommandCache(file);
  await cache.merge(DOMAIN, makeCommands(), { mode: "full", overwriteManual: false });
  const left = (await readdir(dir)).filter((name) => name.includes(".tmp"));
  assert.deepEqual(left, [], "写盘完成后不得残留 tmp 文件");
});

test("T6：读盘失败（结构非法）时只写本次新增的域名，其余域名以磁盘为准", async (t) => {
  const { file } = await withTemp(t);
  const hostA = "a.example.com";
  const hostX = "x.example.com";
  // 磁盘上已有 hostA 的合法命令
  await writeRaw(file, bucket(makeCommandsFor(hostA), hostA));

  // 首次读盘失败（结构非法 → loadFailed），第二次读盘恢复正常
  const flaky = new FlakyCache(file, 1);
  await flaky.ensureLoaded();
  assert.equal(flaky.diagnostics().loadFailed, true, "读盘失败必须被标记");

  await flaky.merge(hostX, makeCommandsFor(hostX), { mode: "full", overwriteManual: false });
  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.ok(raw.domains[hostA], "读盘失败状态下也不得抹掉磁盘上已有的域名");
  assert.ok(raw.domains[hostX], "本次新增的域名必须落盘");
});

test("T6：磁盘读不出来时整次写盘跳过，不用内存快照覆盖磁盘既有数据", async (t) => {
  const { file } = await withTemp(t);
  const hostA = "a.example.com";
  const hostX = "x.example.com";
  await writeRaw(file, bucket(makeCommandsFor(hostA), hostA));
  const before = await readFile(file, "utf8");

  const broken = new FlakyCache(file, Number.POSITIVE_INFINITY);
  await broken.merge(hostX, makeCommandsFor(hostX), { mode: "full", overwriteManual: false });

  assert.equal(await readFile(file, "utf8"), before, "磁盘状态未知时磁盘内容必须原样保留");
  const diag = broken.diagnostics();
  assert.equal(diag.loadFailed, true);
  assert.ok(diag.errors.some((e) => e.error === CACHE_WRITE_SKIPPED_WARNING), "必须记录跳过写盘告警");
  const listed = await broken.list(hostX);
  assert.ok(listed.warnings.includes(CACHE_LOAD_FAILED_WARNING), "读盘失败必须在 list 里告警");
});
