// T10 静态推导 host 推断回归：跨源 host 交叉引用 + 客户端 baseURL 侦测。
//
// 背景（实测，B 站首页）：
//  - 接口路径在 bundle 里绝大多数是**裸相对路径**（"/x/kv-frontend/namespace/data"）；
//  - 真正的主机藏在两处：协议相对 URL（"//api.bilibili.com/x/web-interface/nav"）与
//    HTTP 客户端的 baseURL（baseURL: ... || a，a = "//api.bilibili.com"）；
//  - 裸路径若挂到扫描目标域名（www.bilibili.com）必然 404 —— 实测 api.bilibili.com 返回 200。
//
// 口径：这两个推断都必须**只在唯一解时生效**，有歧义就不猜。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanJsText, scanSources, detectBaseUrlHosts,
} from "../dist/api-command-site-scan.js";
import { SITE_SCAN_HOST_INFERRED_WARNING } from "../dist/api-command-types.js";

const DOMAIN = "www.bilibili.com";

/** 客户端 baseURL + 裸路径 —— 真实 B 站 bundle 的形态。 */
const BUNDLE_WITH_BASEURL = `
var tf = function () { this.baseURL = "//api.domain.com"; };
var nf = (function (e) {
  var t = function (n) {
    var r, a = "//api.bilibili.com", i = [new R4];
    r = e.call(this, { baseURL: !s && n.baseURL || a, middlewares: i });
    return r;
  };
  return t;
})(tf);
fetch("/x/kv-frontend/namespace/data");
fetch("/x/web-interface/nav");
`;

/** 只有协议相对 URL 写法，没有 baseURL。 */
const BUNDLE_PROTOCOL_RELATIVE = `
var u = "//api.bilibili.com/x/web-interface/nav";
fetch("/x/web-interface/nav");
`;

test("T10：detectBaseUrlHosts 从 baseURL:...||var 侦测出客户端主机", () => {
  const hosts = detectBaseUrlHosts(BUNDLE_WITH_BASEURL);
  assert.deepEqual(hosts, ["api.bilibili.com"]);
});

test("T10：detectBaseUrlHosts 忽略占位默认值 api.domain.com", () => {
  const hosts = detectBaseUrlHosts(`this.baseURL = "//api.domain.com";`);
  assert.deepEqual(hosts, [], "占位默认值不算真实 baseURL");
});

test("T10：detectBaseUrlHosts 支持 baseURL 直接字面量", () => {
  assert.deepEqual(detectBaseUrlHosts(`var c = { baseURL: "//api.example.com" };`),
    ["api.example.com"]);
});

test("T10：detectBaseUrlHosts 无 baseURL 时返回空数组（不猜）", () => {
  assert.deepEqual(detectBaseUrlHosts(`fetch("/x/web-interface/nav");`), []);
  assert.deepEqual(detectBaseUrlHosts(""), []);
});

test("T10：scanSources 把裸路径挂到客户端 baseURL 主机上（而不是扫描目标域名）", () => {
  const res = scanSources([{ kind: "js", text: BUNDLE_WITH_BASEURL }], {
    domain: DOMAIN, loose: true,
  });
  const paths = res.candidates.map((c) => `${c.host ?? ""}${c.pathTemplate}`);
  assert.ok(paths.includes("api.bilibili.com/x/kv-frontend/namespace/data"),
    `裸路径应挂到 baseURL 主机上，实际：${JSON.stringify(paths)}`);
  assert.ok(paths.includes("api.bilibili.com/x/web-interface/nav"));
  assert.ok(!paths.includes("www.bilibili.com/x/kv-frontend/namespace/data"),
    "裸路径不得默认挂到扫描目标域名（必然 404）");
  assert.ok(res.warnings.includes(SITE_SCAN_HOST_INFERRED_WARNING));
});

test("T10：跨源交叉引用 —— 协议相对写法给出的 host 被裸路径继承", () => {
  const res = scanSources([{ kind: "js", text: BUNDLE_PROTOCOL_RELATIVE }], {
    domain: DOMAIN, loose: true,
  });
  const paths = res.candidates.map((c) => `${c.host ?? ""}${c.pathTemplate}`);
  assert.ok(paths.includes("api.bilibili.com/x/web-interface/nav"),
    `协议相对写法给出的 host 应被同源裸路径继承，实际：${JSON.stringify(paths)}`);
});

test("T10：同一路径对应多个 host 时不做推断（保持扫描目标域名）", () => {
  const text = `
fetch("//a.example.com/x/thing");
fetch("//b.example.com/x/thing");
fetch("/x/thing");
`;
  const res = scanSources([{ kind: "js", text }], { domain: DOMAIN, loose: true });
  const bare = res.candidates.filter((c) => c.pathTemplate === "/x/thing" && !c.host);
  assert.equal(bare.length, 1, "有歧义时保留扫描目标域名，不猜 host");
  assert.equal(bare[0].host, undefined);
});

test("T10：多个 baseURL 主机并存时不做推断（不猜）", () => {
  const text = `
var a = "//api.one.com";
var b = "//api.two.com";
var c = { baseURL: !s && n.baseURL || a };
var d = { baseURL: !s && m.baseURL || b };
fetch("/x/thing");
`;
  const res = scanSources([{ kind: "js", text }], { domain: DOMAIN, loose: true });
  const bare = res.candidates.filter((c) => c.pathTemplate === "/x/thing" && !c.host);
  assert.equal(bare.length, 1, "baseURL 有歧义时保持扫描目标域名");
});

test("T10：scanJsText 单源解析不改变裸路径语义（host 推断在 scanSources 层做）", () => {
  const candidates = scanJsText(BUNDLE_WITH_BASEURL, { loose: true });
  const bare = candidates.find((c) => c.pathTemplate === "/x/kv-frontend/namespace/data");
  assert.ok(bare);
  assert.equal(bare.host, undefined, "单源解析保持原始语义，不在解析层猜 host");
});
