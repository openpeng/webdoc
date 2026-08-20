// HTML → Markdown 转换（纯服务端，借助开源库 turndown + turndown-plugin-gfm）。
// 相比让大模型「读 HTML 再吐 Markdown」，用代码转能省下大量 token，且输出稳定可复现。
// 本模块是无副作用的纯函数，便于单测；不直接依赖浏览器桥。

import TurndownService from "turndown";
import gfm from "turndown-plugin-gfm";

export interface HtmlToMarkdownOptions {
  /** 是否启用 GitHub Flavored Markdown（表格 / 删除线 / 任务列表）。默认 true */
  gfm?: boolean;
  /** 标题样式：atx 用 `#`，setext 用下划线。默认 "atx" */
  headingStyle?: "setext" | "atx";
  /** 无序列表标记。默认 "-" */
  bulletListMarker?: "-" | "+" | "*";
  /** 代码块样式：fenced 用 ```，indented 用缩进。默认 "fenced" */
  codeBlockStyle?: "indented" | "fenced";
  /** fenced 代码块围栏符。默认 "```" */
  fence?: "```" | "~~~";
  /** 斜体定界符。默认 "*" */
  emDelimiter?: "_" | "*";
  /** 粗体定界符。默认 "**" */
  strongDelimiter?: "__" | "**";
  /** 链接样式：inlined 内联，referenced 引用式。默认 "inlined" */
  linkStyle?: "inlined" | "referenced";
  /** referenced 链接的引用样式。默认 "full" */
  linkReferenceStyle?: "full" | "collapsed" | "shortcut";
  /** 基址：把相对链接 / 图片解析成绝对地址。设置后链接统一输出为内联绝对链接 */
  baseUrl?: string;
  /** 是否保留 <pre><code> 原始缩进。默认 false */
  preformattedCode?: boolean;
  /** 需要整段剔除的 CSS 选择器（script/style 已由库默认忽略）。如 ["nav", "footer", ".ads"] */
  remove?: string[];
  /** 需要原样保留为 HTML 的选择器（不走转换）。 */
  keep?: string[];
}

// 转换前剥离无意义的噪声节点：脚本/样式/模板/SVG 等。Markdown 不支持样式与脚本，
// 而很多 SPA 会把 <style>/<script> 注入到 <body>，turndown 默认会原样输出其文本，造成巨量噪声。
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ");
}

// 跳过不需要绝对化的协议/锚点，其余按 baseUrl 解析为绝对地址。
function absoluteUrl(href: string, base?: string): string {
  if (!base || !href) return href;
  if (/^(#|mailto:|tel:|javascript:)/i.test(href)) return href;
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/**
 * 将 HTML 字符串转换为 Markdown。
 * @param html 输入 HTML
 * @param opts 转换选项（见 HtmlToMarkdownOptions）
 */
export function htmlToMarkdown(html: string, opts: HtmlToMarkdownOptions = {}): string {
  const service = new TurndownService({
    headingStyle: opts.headingStyle ?? "atx",
    hr: "---",
    bulletListMarker: opts.bulletListMarker ?? "-",
    codeBlockStyle: opts.codeBlockStyle ?? "fenced",
    fence: opts.fence ?? "```",
    emDelimiter: opts.emDelimiter ?? "*",
    strongDelimiter: opts.strongDelimiter ?? "**",
    linkStyle: opts.linkStyle ?? "inlined",
    linkReferenceStyle: opts.linkReferenceStyle ?? "full",
    preformattedCode: opts.preformattedCode ?? false,
  });

  // GitHub Flavored Markdown：删除线、任务列表，以及自定义表格规则。
  // 表格不用 gfm 自带规则——它只识别含 <th> 的表，而 antd 等框架在 scroll 模式下会把
  // 表头/表体拆成两张 <table>（表体仅有 <td>），导致表体以原始 HTML 泄漏。下面用自定义的
  // gfmTable 规则统一处理（含「无表头表」与「拆分表合并」）。gfm=false 时全部不启用，
  // 表格回退为 turndown 默认的纯文本降级。
  if (opts.gfm !== false) {
    service.use(gfm.strikethrough);
    service.use(gfm.taskListItems);

    // 表格 → GFM：兼容「无 <th> 的表」（首行视作表头）以及 antd 拆分出的「表头表 + 表体表」，
    // 后者合并为一张完整 Markdown 表，避免两张表堆叠或原始 HTML 泄漏。
    const skipTables = new WeakSet<object>();
    const cellText = (cell: any) => (cell.textContent || "").replace(/\s+/g, " ").trim();
    const rowCells = (tr: any) => Array.from(tr.querySelectorAll("th, td")).map(cellText);
    const colCount = (tr: any) => Array.from(tr.querySelectorAll("th, td")).length;
    // 查找「下一个兄弟表」：antd 把表头表/表体表分别包在 .ant-table-header / .ant-table-body 里，
    // 两张 <table> 不是直接兄弟。故从当前表的父级开始，逐层向上、向后扫描兄弟节点中含 <table> 的容器。
    const nextTable = (node: any): any => {
      let depth = 0;
      let scope: any = node.parentElement;
      while (scope && depth < 5) {
        let el = scope.nextElementSibling;
        while (el) {
          if (el.tagName === "TABLE") return el;
          if (el.querySelector && el.querySelector("table")) return el.querySelector("table");
          el = el.nextElementSibling;
        }
        scope = scope.parentElement;
        depth++;
      }
      return null;
    };
    service.addRule("gfmTable", {
      filter: "table",
      replacement: (_content, node: any) => {
        if (skipTables.has(node)) return "";
        const rows = Array.from(node.querySelectorAll("tr"));
        if (!rows.length) return "";
        const thead = node.querySelector("thead tr");
        const hasTh = !!node.querySelector("th");
        let headerCells: string[];
        let bodyRows: any[];
        if (thead) {
          headerCells = rowCells(thead);
          bodyRows = Array.from(node.querySelectorAll("tbody tr"));
          // 表头表无表体时，尝试与下一个兄弟「表体表」合并为一张完整表
          if (bodyRows.length === 0) {
            const sib = nextTable(node);
            if (sib) {
              const sibBody = Array.from(sib.querySelectorAll("tbody tr"));
              if (sibBody.length && colCount(sibBody[0]) === headerCells.length) {
                bodyRows = sibBody;
                skipTables.add(sib);
              }
            }
          }
        } else if (hasTh) {
          headerCells = rowCells(rows[0]);
          bodyRows = rows.slice(1);
        } else {
          // 无 thead 也无 th：首行视作表头（常见于 antd 拆分出的表体表）
          headerCells = rowCells(rows[0]);
          bodyRows = rows.slice(1);
        }
        if (!headerCells.length) return "";
        const esc = (s: string) => s.replace(/\|/g, "\\|");
        const renderRow = (cells: string[]) => "| " + cells.map(esc).join(" | ") + " |";
        const sep = "| " + headerCells.map(() => "---").join(" | ") + " |";
        const out = [renderRow(headerCells), sep];
        for (const tr of bodyRows) {
          const cells = rowCells(tr);
          if (cells.length) out.push(renderRow(cells));
        }
        return "\n" + out.join("\n") + "\n";
      },
    });
  }

  // 剔除 / 保留指定节点（turndown 的 remove/keep 按标签名匹配，如 nav、footer、script）
  if (opts.remove?.length) {
    for (const sel of opts.remove) service.remove(sel as any);
  }
  if (opts.keep?.length) {
    for (const sel of opts.keep) service.keep(sel as any);
  }

  // 设置基址时，把相对链接 / 图片重写为绝对地址（覆盖库默认规则）
  if (opts.baseUrl) {
    service.addRule("absoluteLink", {
      filter: "a",
      replacement: (content, node) => {
        const href = node.getAttribute("href");
        if (!href) return content;
        const abs = absoluteUrl(href, opts.baseUrl);
        const title = node.getAttribute("title");
        return title ? `[${content}](${abs} "${title}")` : `[${content}](${abs})`;
      },
    });
  }

  // 图片统一处理：过长的 base64 图片（logo 等）转为占位避免污染 MD；
  // 普通图片按 baseUrl 解析为绝对地址（未设则原样）。
  service.addRule("normalizeImage", {
    filter: "img",
    replacement: (_content, node) => {
      const src = node.getAttribute("src") || "";
      const alt = node.getAttribute("alt") || "";
      const title = node.getAttribute("title");
      // 所有内联 data:image（base64 或 utf8 的 svg）对 Markdown 均无可读价值，统一占位避免污染
      if (/^data:image\//i.test(src)) {
        return alt ? `![${alt}](data:image/placeholder)` : "![图片]";
      }
      const finalSrc = opts.baseUrl && !/^data:/i.test(src) ? absoluteUrl(src, opts.baseUrl) : src;
      return title ? `![${alt}](${finalSrc} "${title}")` : `![${alt}](${finalSrc})`;
    },
  });


  return service.turndown(sanitizeHtml(html ?? ""));
}
