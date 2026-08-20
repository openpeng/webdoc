// html-to-markdown 模块测试：基于开源库 turndown 的 HTML→Markdown 转换。
import test from "node:test";
import assert from "node:assert/strict";
import { htmlToMarkdown } from "../dist/html-to-markdown.js";

test("基础转换：标题/段落/加粗/斜体", () => {
  const md = htmlToMarkdown("<h1>标题</h1><p>这是<strong>加粗</strong>与<em>斜体</em>。</p>");
  assert.match(md, /# 标题/);
  assert.match(md, /\*\*加粗\*\*/);
  assert.match(md, /\*斜体\*/);
});

test("列表：无序列表用 - 标记", () => {
  const md = htmlToMarkdown("<ul><li>甲</li><li>乙</li></ul>");
  assert.match(md, /- +甲/);
  assert.match(md, /- +乙/);
});

test("链接：默认内联", () => {
  const md = htmlToMarkdown('<p><a href="https://example.com">示例</a></p>');
  assert.match(md, /\[示例\]\(https:\/\/example\.com\)/);
});

test("gfm 默认开启：表格转换为 GFM 表格", () => {
  const html = "<table><thead><tr><th>名</th><th>值</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>";
  const md = htmlToMarkdown(html);
  assert.match(md, /\| 名 \| 值 \|/);
  assert.match(md, /\| --- \| --- \|/);
});

test("gfm=false：表格降级为纯文本", () => {
  const html = "<table><tr><td>a</td><td>b</td></tr></table>";
  const md = htmlToMarkdown(html, { gfm: false });
  assert.doesNotMatch(md, /\| --- \|/);
});

test("gfm 表格：无 <th> 的表以首行作表头", () => {
  const html = "<table><tr><td>列A</td><td>列B</td></tr><tr><td>x</td><td>y</td></tr></table>";
  const md = htmlToMarkdown(html);
  assert.match(md, /\| 列A \| 列B \|/);
  assert.match(md, /\| --- \| --- \|/);
  assert.match(md, /\| x \| y \|/);
});

test("gfm 表格：antd 拆分表（表头表+表体表）合并为一张", () => {
  const html =
    '<div class="ant-table">' +
    '<div class="ant-table-header"><table><thead class="ant-table-thead"><tr><th>项目ID</th><th>名称</th></tr></thead></table></div>' +
    '<div class="ant-table-body"><table><tbody class="ant-table-tbody"><tr><td>1</td><td>甲</td></tr><tr><td>2</td><td>乙</td></tr></tbody></table></div>' +
    "</div>";
  const md = htmlToMarkdown(html);
  assert.doesNotMatch(md, /<table/); // 不能泄漏原始 HTML
  assert.match(md, /\| 项目ID \| 名称 \|/);
  assert.match(md, /\| 1 \| 甲 \|/);
  assert.match(md, /\| 2 \| 乙 \|/);
  // 合并后应为「表头 + 分隔 + 2 行」，不应出现第二张独立表头（即分隔行只出现一次）
  assert.equal((md.match(/\|\s*-+\s*\|/g) || []).length, 1, "分隔行应仅 1 行");
});

test("baseUrl：相对链接解析为绝对地址", () => {
  const md = htmlToMarkdown('<a href="/docs/intro">介绍</a>', { baseUrl: "https://example.com/base/" });
  assert.match(md, /\[介绍\]\(https:\/\/example\.com\/docs\/intro\)/);
});

test("baseUrl：锚点/邮件链接保持原样", () => {
  const md = htmlToMarkdown('<a href="#top">顶部</a><a href="mailto:a@b.com">邮</a>', { baseUrl: "https://example.com/" });
  assert.match(md, /\[顶部\]\(#top\)/);
  assert.match(md, /\[邮\]\(mailto:a@b\.com\)/);
});

test("remove：剔除指定选择器", () => {
  const md = htmlToMarkdown('<nav>菜单</nav><p>正文</p>', { remove: ["nav"] });
  assert.doesNotMatch(md, /菜单/);
  assert.match(md, /正文/);
});

test("headingStyle=setext：h1 用下划线形式", () => {
  const md = htmlToMarkdown("<h1>大标题</h1>", { headingStyle: "setext" });
  assert.match(md, /大标题\n=+/);
});

test("空输入：返回空字符串不抛错", () => {
  assert.equal(htmlToMarkdown(""), "");
  assert.equal(htmlToMarkdown("<div></div>"), "");
});

test("sanitize：剥离 <style> 内的 CSS 噪声（SPA 常把样式注入 body）", () => {
  const html = "<style>@font-face{font-family:'x'}</style><h1>标题</h1><p>正文</p>";
  const md = htmlToMarkdown(html);
  assert.doesNotMatch(md, /@font-face/);
  assert.match(md, /# 标题/);
  assert.match(md, /正文/);
});

test("sanitize：剥离 <script> 内的 JS 噪声", () => {
  const html = "<script>const a=1;alert(2)</script><p>内容</p>";
  const md = htmlToMarkdown(html);
  assert.doesNotMatch(md, /const a/);
  assert.match(md, /内容/);
});

test("sanitize：剥离 <svg> 矢量噪声", () => {
  const html = "<svg><path d='M0 0 L1 1'/></svg><p>文本</p>";
  const md = htmlToMarkdown(html);
  assert.doesNotMatch(md, /<path/);
  assert.match(md, /文本/);
});

test("data 图片：过长的 base64 图片转为占位，避免污染 MD", () => {
  const big = "data:image/png;base64," + "A".repeat(500);
  const md = htmlToMarkdown(`<p>见下图</p><img alt="架构图" src="${big}">`);
  assert.doesNotMatch(md, /data:image\/png;base64/);
  assert.match(md, /!\[架构图\]\(data:image\/placeholder\)/);
});

test("data 图片：普通 http(s) 图片保留原样（baseUrl 时解析为绝对地址）", () => {
  const md = htmlToMarkdown('<img alt="图" src="/a/b.png">', { baseUrl: "https://x.com/p/" });
  assert.match(md, /!\[图\]\(https:\/\/x\.com\/a\/b\.png\)/);
});
