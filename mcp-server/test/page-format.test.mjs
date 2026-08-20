// page-format 模块测试：紧凑元素行与树形层级序列化。
// 树形结构由扩展端 pageTree() 生成，这里用等价的 fixture 驱动格式化逻辑。
import test from "node:test";
import assert from "node:assert/strict";
import { formatElementLine, formatPageTree } from "../dist/page-format.js";

test("formatElementLine：ref/role/name 完整时输出标准行", () => {
  assert.equal(formatElementLine({ ref: "@e3", tag: "button", role: "button", name: "提交" }), "@e3 [button] 提交");
});

test("formatElementLine：无 ref 时不留前导空格，name 缺失按 text/placeholder/id 回退", () => {
  assert.equal(formatElementLine({ tag: "a", text: "首页" }), "[a] 首页");
  assert.equal(formatElementLine({ tag: "input", placeholder: "搜索" }), "[input] 搜索");
  assert.equal(formatElementLine({ tag: "input", id: "kw" }), "[input] kw");
  assert.equal(formatElementLine({ tag: "span" }), "[span] (no name)");
});

test("formatPageTree：根节点不打印自身，容器缩进逐级加深", () => {
  const lines = formatPageTree({
    role: "page", label: "", elements: [],
    children: [{
      role: "list", label: "订单列表", elements: [],
      children: [
        { role: "listitem", label: "订单 #1023", children: [], elements: [{ ref: "@e12", tag: "button", role: "button", name: "删除" }] },
        { role: "listitem", label: "订单 #1024", children: [], elements: [{ ref: "@e15", tag: "button", role: "button", name: "删除" }] },
      ],
    }],
  });
  assert.deepEqual(lines, [
    "[list] 订单列表",
    "  [listitem] 订单 #1023",
    "    @e12 [button] 删除",
    "  [listitem] 订单 #1024",
    "    @e15 [button] 删除",
  ]);
});

test("formatPageTree：根级散落元素（无语义容器）直接顶格输出", () => {
  const lines = formatPageTree({
    role: "page", label: "",
    elements: [{ ref: "@e0", tag: "a", role: "link", name: "Home" }],
    children: [{ role: "dialog", label: "确认删除", children: [], elements: [{ ref: "@e5", tag: "button", role: "button", name: "确认" }] }],
  });
  assert.deepEqual(lines, [
    "@e0 [link] Home",
    "[dialog] 确认删除",
    "  @e5 [button] 确认",
  ]);
});

test("formatPageTree：空树与无 label 容器的边界形态", () => {
  assert.deepEqual(formatPageTree(undefined), []);
  assert.deepEqual(formatPageTree({ role: "page", label: "", children: [], elements: [] }), []);
  assert.deepEqual(
    formatPageTree({ role: "page", label: "", elements: [], children: [{ role: "form", label: "", children: [], elements: [] }] }),
    ["[form]"]
  );
});
