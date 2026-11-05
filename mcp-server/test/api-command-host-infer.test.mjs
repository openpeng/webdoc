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

// ============================================================================
// T11 代码审查回归：detectBaseUrlHosts 的三个缺陷
// ============================================================================

test("T11：detectBaseUrlHosts 的 `baseURL:...||var` 形态也排除占位默认值", () => {
  // 缺陷：占位默认值只在 `baseURL:"//host"` 直写形态被排除；
  // 变量形态（`|| a`，a = "//api.domain.com"）没排除，占位符被当成真实 baseURL。
  const text = `
var a = "//api.domain.com";
var c = { baseURL: !s && n.baseURL || a };
`;
  assert.deepEqual(detectBaseUrlHosts(text), [], "占位默认值不得计入 baseURL 主机");
});

test("T11：占位默认值与真实主机并存时，占位符不得污染唯一解", () => {
  // 缺陷后果：占位符与真实主机一起进 hosts → 唯一解判据失效；
  // 或占位符单独成为唯一解 → 裸路径被挂到 api.domain.com，命令必然打不通。
  const text = `
var a = "//api.domain.com";
var b = "//api.real.com";
var c = { baseURL: !s && n.baseURL || a };
var d = { baseURL: !s && m.baseURL || b };
`;
  assert.deepEqual(detectBaseUrlHosts(text), ["api.real.com"]);
});

test("T11：占位默认值不得成为扫描产物的 host（端到端）", () => {
  const text = `
var a = "//api.domain.com";
var c = { baseURL: !s && n.baseURL || a };
fetch("/x/web-interface/nav");
`;
  const res = scanSources([{ kind: "js", text }], { domain: DOMAIN, loose: true });
  const hosts = res.candidates.map((c) => c.host).filter(Boolean);
  assert.ok(!hosts.includes("api.domain.com"),
    `占位 host 不得出现在候选里，实际：${JSON.stringify(hosts)}`);
});

test("T11：同一变量被绑到多个 host 时视为歧义（不做推断）", () => {
  // 缺陷：回查变量绑定时只取**首个**匹配，把「变量被重新赋值」这一真实歧义藏起来；
  // 压缩 bundle 里短变量名跨作用域复用极常见，首绑定命中会让裸路径挂到任意一个 host 上。
  const text = `
var a = "//api.one.com";
a = "//api.two.com";
var c = { baseURL: !s && n.baseURL || a };
fetch("/x/thing");
`;
  assert.deepEqual(detectBaseUrlHosts(text), [], "同一变量绑定不一致 → 有歧义，不猜");
  const res = scanSources([{ kind: "js", text }], { domain: DOMAIN, loose: true });
  const bare = res.candidates.filter((c) => c.pathTemplate === "/x/thing" && !c.host);
  assert.equal(bare.length, 1, "有歧义时保留扫描目标域名，不猜 host");
  assert.equal(bare[0].host, undefined);
});

test("T11：同一变量绑定到同一个 host（多处赋值）仍算唯一解", () => {
  // 收紧不得误伤：多处赋值但指向同一个 host 时没有歧义，应当照常推断。
  const text = `
var a = "//api.real.com";
a = "//api.real.com";
var c = { baseURL: !s && n.baseURL || a };
fetch("/x/thing");
`;
  assert.deepEqual(detectBaseUrlHosts(text), ["api.real.com"]);
});

test("T11：单一绑定的真实 baseURL 仍能侦测出来（收紧不得丢召回）", () => {
  assert.deepEqual(detectBaseUrlHosts(BUNDLE_WITH_BASEURL), ["api.bilibili.com"]);
});
