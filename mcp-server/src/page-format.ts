// 页面状态的 Agent 侧文本表示：紧凑元素行 + 可选树形层级。
// get_page_info（flat/tree 两种形态）与任务循环的 compactPage 共用同一行格式，
// 保证 @eN 引用在所有观察出口中的呈现一致。

// 单个交互元素压成一行：`@eN [role] name`，与 token 成本最低的平铺形态对齐。
export function formatElementLine(element: any): string {
  return `${element.ref || ""} [${element.role || element.tag}] ${element.name || element.text || element.placeholder || element.id || "(no name)"}`.trim();
}

// 树形节点（扩展端 pageTree 生成）：{ role, label, children[], elements[] }。
// 序列化为 aria_yaml 风格的缩进文本：容器一行 `[role] label`，元素行缩进一级。
// 根节点（role === "page"）不打印自身，只展开内容。
export function formatPageTree(node: any, depth = 0): string[] {
  if (!node) return [];
  const lines: string[] = [];
  const isRoot = node.role === "page";
  if (!isRoot) {
    const indent = "  ".repeat(depth);
    lines.push(`${indent}[${node.role || "group"}]${node.label ? ` ${node.label}` : ""}`);
  }
  const childDepth = isRoot ? depth : depth + 1;
  const childIndent = "  ".repeat(childDepth);
  for (const element of node.elements || []) lines.push(`${childIndent}${formatElementLine(element)}`);
  for (const child of node.children || []) lines.push(...formatPageTree(child, childDepth));
  return lines;
}
