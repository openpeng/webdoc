// T12 回归：MCP 工具入参归一化不得摧毁编排层的默认值语义。
//
// 缺陷背景（T12，deploy_to_test 阶段经**真实 MCP 调用**发现）：
// 传输层（server.ts）原先用 `args.X === true` 归一化可选布尔开关，把
// 「调用方没传」压成「显式 false」，而编排层正是用 undefined 表达「走默认值」。
// 于是三个文档默认值在 MCP 工具层**永远不可达**：
//   · loosePaths     默认 true  → 压成 false → 现代站点 /x/... 一条端点都产不出；
//   · trustSpec      默认 true  → 压成 false → 静态命令一律按 write 保守处理；
//   · discoverBundles 默认 auto → 压成 false → 扩展侧 bundle 自动发现永不触发。
//
// 本文件锁两件事：
//   ① 纯函数层 toAnalyzeArgs 的三态语义（未传 = undefined，显式 false = false）；
//   ② 端到端：经同一归一化路径进编排层，scan_site 在默认参数下
//      能认出现代站点路径（/x/...），且 read 命令按来源 method 判 risk。
//
// 全部离线：不联网、不碰浏览器；只 import ../dist/*.js 编译产物。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toAnalyzeArgs, toBooleanArg } from "../dist/api-command-args.js";
import { ApiCommandCache } from "../dist/api-command-cache.js";
import { ApiCommandService } from "../dist/api-command-service.js";

/** 现代站点风格的裸路径：只有放宽模式（loosePaths 默认 true）才认。 */
const MODERN_SITE_JS = [
  'var tf=function(){this.baseURL="//api.domain.com";};',
  'var nf=function(e){var t=function(n){var r,a="//api.bilibili.com";',
  'r=e.call(this,{baseURL:!s&&n.baseURL||a,method:"GET"})}return t};',
  'function fetchIt(){return fetch("/x/web-interface/nav",{method:"GET"})}',
].join("\n");

async function withService(run) {
  const dir = await mkdtemp(join(tmpdir(), "wp-t12-"));
  const file = join(dir, "api-commands.json");
  const cache = new ApiCommandCache(file);
  // scan_site 是纯 Node 通道，不发任何扩展消息 —— 发送器直接抛错即可暴露误用。
  const service = new ApiCommandService(cache, async () => { throw new Error("不应调用扩展"); });
  try {
    return await run(service);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ============================================================================
// ① 纯函数层：三态语义
// ============================================================================

test("T12：toAnalyzeArgs 对未传的开关保留 undefined（不压成 false）", () => {
  const args = toAnalyzeArgs({ action: "scan_site", domain: "www.example.com" });
  assert.equal(args.loosePaths, undefined, "loosePaths 未传必须是 undefined");
  assert.equal(args.trustSpec, undefined, "trustSpec 未传必须是 undefined");
  assert.equal(args.discoverBundles, undefined, "discoverBundles 未传必须是 undefined");
  assert.equal(args.bundleUseBrowserCache, undefined, "bundleUseBrowserCache 未传必须是 undefined");
});

test("T12：toAnalyzeArgs 对默认即 false 的开关把未传收敛成 false", () => {
  const args = toAnalyzeArgs({ action: "scan_site", domain: "www.example.com" });
  for (const key of [
    "includeStaticAssets", "captureResponseBody", "overwriteManual",
    "allowPrivateHosts", "allowCrossHost", "collectViaExtension",
  ]) {
    assert.equal(args[key], false, `${key} 未传必须是 false`);
  }
});

test("T12：toAnalyzeArgs 保留显式 false（放开是默认值，不是强制值）", () => {
  const args = toAnalyzeArgs({
    action: "scan_site",
    domain: "www.example.com",
    loosePaths: false,
    trustSpec: false,
    discoverBundles: false,
    bundleUseBrowserCache: false,
  });
  assert.equal(args.loosePaths, false);
  assert.equal(args.trustSpec, false);
  assert.equal(args.discoverBundles, false);
  assert.equal(args.bundleUseBrowserCache, false);
});

test("T12：toAnalyzeArgs 保留显式 true 与其余字段的类型归一", () => {
  const args = toAnalyzeArgs({
    action: "scan_site",
    domain: "www.example.com",
    loosePaths: true,
    trustSpec: true,
    discoverBundles: true,
    tabId: 7,
    maxEndpoints: 30,
    mode: "full",
    sources: [{ kind: "js", text: "x" }],
    extraHosts: ["cdn.example.com", 42],
    filter: { urlContains: "/api/" },
  });
  assert.equal(args.loosePaths, true);
  assert.equal(args.trustSpec, true);
  assert.equal(args.discoverBundles, true);
  assert.equal(args.tabId, 7);
  assert.equal(args.maxEndpoints, 30);
  assert.equal(args.mode, "full");
  assert.equal(args.sources.length, 1);
  assert.deepEqual(args.extraHosts, ["cdn.example.com"], "extraHosts 只保留字符串项");
  assert.deepEqual(args.filter, { urlContains: "/api/" });
});

test("T12：toBooleanArg 三态与二态行为一致", () => {
  assert.equal(toBooleanArg({}, "loosePaths", true), undefined);
  assert.equal(toBooleanArg({ loosePaths: false }, "loosePaths", true), false);
  assert.equal(toBooleanArg({ loosePaths: true }, "loosePaths", true), true);
  assert.equal(toBooleanArg({}, "allowCrossHost", false), false);
  assert.equal(toBooleanArg({ allowCrossHost: true }, "allowCrossHost", false), true);
  // 非布尔值（脏输入）一律按「未传」处理。
  assert.equal(toBooleanArg({ loosePaths: "yes" }, "loosePaths", true), undefined);
  assert.equal(toBooleanArg({ loosePaths: "yes" }, "loosePaths", false), false);
});

// ============================================================================
// ② 端到端：默认参数下 scan_site 能认出现代站点路径（原本被压成 false → 0 条）
// ============================================================================

test("T12：默认参数下 scan_site 能认出现代站点裸路径（宽松模式生效）", async () => {
  await withService(async (service) => {
    const args = toAnalyzeArgs({
      action: "scan_site",
      domain: "www.example.com",
      sources: [{ kind: "js", text: MODERN_SITE_JS }],
    });
    const report = await service.analyze(args);
    assert.equal(report.endpointCount, 1, "默认参数下应产出 1 条端点候选");
    assert.equal(report.commandCount, 1, "默认参数下应产出 1 条命令");
    assert.equal(report.commands[0].name, "get.web-interface.nav");
  });
});

test("T12：显式 loosePaths=false 回到保守模式（回退路径完好，产出 0 条）", async () => {
  await withService(async (service) => {
    const args = toAnalyzeArgs({
      action: "scan_site",
      domain: "www.example.com",
      loosePaths: false,
      sources: [{ kind: "js", text: MODERN_SITE_JS }],
    });
    const report = await service.analyze(args);
    assert.equal(report.endpointCount, 0, "显式关闭宽松模式后不应产出端点");
  });
});

test("T12：默认 trustSpec 下 GET 命令按来源 method 判 read（不被一律降级成 write）", async () => {
  await withService(async (service) => {
    const args = toAnalyzeArgs({
      action: "scan_site",
      domain: "www.example.com",
      sources: [{ kind: "js", text: MODERN_SITE_JS }],
    });
    const report = await service.analyze(args);
    assert.equal(report.commands[0].risk, "read", "GET 来源应判为 read");
    assert.ok(
      !report.warnings.some((w) => w.includes("一律按 write 保守处理")),
      "默认 trustSpec 下不应出现保守模式告警",
    );
  });
});

test("T12：显式 trustSpec=false 时命令降级为 write（保守模式仍可回退）", async () => {
  await withService(async (service) => {
    const args = toAnalyzeArgs({
      action: "scan_site",
      domain: "www.example.com",
      // 显式打开宽松模式，好让本用例只考察 trustSpec 这一条语义。
      loosePaths: true,
      trustSpec: false,
      sources: [{ kind: "js", text: MODERN_SITE_JS }],
    });
    const report = await service.analyze(args);
    assert.equal(report.commands[0].risk, "write", "显式关闭信任来源时应按 write 保守处理");
  });
});
