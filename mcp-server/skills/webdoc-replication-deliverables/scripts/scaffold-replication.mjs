#!/usr/bin/env node
/**
 * 复刻交付物脚手架：按规范生成一个站点的交付目录骨架。
 *
 * 用法：
 *   node scaffold-replication.mjs --slug <slug> --out-dir <目录> --name "<站点中文名>" [--force]
 *
 * 例：
 *   node scaffold-replication.mjs --slug arms --out-dir docs --name "阿里云 ARMS 应用监控"
 *
 * 产出：
 *   <out-dir>/<slug>-replication/<slug>-api.mjs        目录驱动客户端
 *   <out-dir>/<slug>-replication/<slug>-catalog.json   目录（唯一事实源）
 *   <out-dir>/<slug>-replication/gen-catalog-doc.mjs    目录文档生成器（fail-closed）
 *   <out-dir>/<slug>-replication/README.md              快速上手骨架
 *   <out-dir>/<slug>-replication-report.md              逆向报告骨架（九章）
 *
 * 纪律：
 *  - 已存在的文件默认不覆盖（要覆盖加 --force），避免把已填好的交付物洗掉；
 *  - 生成器是本 skill 的唯一实现，复制一份进交付目录，让交付物自包含；
 *  - 只写文件，不联网、不读凭据。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { out._.push(arg); continue; }
    const eq = arg.indexOf("=");
    if (eq > 0) { out[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { out[key] = true; continue; }
    out[key] = next;
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const slug = typeof args.slug === "string" ? args.slug.trim() : "";
const outDir = typeof args["out-dir"] === "string" ? args["out-dir"].trim() : "docs";
const siteName = typeof args.name === "string" ? args.name.trim() : "";
const force = args.force === true;

if (!slug) {
  process.stderr.write("用法: node scaffold-replication.mjs --slug <slug> --out-dir <目录> --name \"<站点中文名>\" [--force]\n");
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  process.stderr.write(`slug 只能用小写字母/数字/连字符：${slug}\n`);
  process.exit(2);
}

const deliveryDir = resolve(process.cwd(), outDir, `${slug}-replication`);
const reportPath = resolve(process.cwd(), outDir, `${slug}-replication-report.md`);
const catalogFile = `${slug}-catalog.json`;

const targets = [
  { path: join(deliveryDir, `${slug}-api.mjs`), template: join(HERE, "templates", "client.template.mjs"), render: true },
  { path: join(deliveryDir, catalogFile), template: join(HERE, "templates", "catalog.template.json"), render: true },
  { path: join(deliveryDir, "README.md"), template: join(HERE, "templates", "readme.template.md"), render: true },
  { path: join(deliveryDir, "gen-catalog-doc.mjs"), template: join(HERE, "catalog-doc-generator.mjs"), render: false },
  { path: reportPath, template: join(HERE, "templates", "report.template.md"), render: true },
];

const existing = targets.filter((t) => existsSync(t.path));
if (existing.length && !force) {
  process.stderr.write("以下文件已存在，未覆盖（要覆盖加 --force）：\n");
  for (const item of existing) process.stderr.write(`  - ${item.path}\n`);
  process.exit(1);
}

mkdirSync(deliveryDir, { recursive: true });
const substitutions = {
  __SLUG__: slug,
  __SITE_NAME__: siteName || slug,
  __CATALOG_FILE__: catalogFile,
};

for (const target of targets) {
  let content = readFileSync(target.template, "utf8");
  if (target.render) {
    for (const [key, value] of Object.entries(substitutions)) content = content.split(key).join(value);
  }
  mkdirSync(dirname(target.path), { recursive: true });
  writeFileSync(target.path, content, "utf8");
}

process.stdout.write(`脚手架已生成：\n`);
for (const target of targets) process.stdout.write(`  ${target.path}\n`);
process.stdout.write(`\n下一步：\n`);
process.stdout.write(`  1. 填 ${join(deliveryDir, catalogFile)} 的 site / transport / resources / entries\n`);
process.stdout.write(`  2. 每个 entry 的 resource 必须是 resources[] 里登记过的域（生成器会 fail-closed 校验）\n`);
process.stdout.write(`  3. 填 ${reportPath} 的九章骨架\n`);
process.stdout.write(`  4. 跑 node ${join(deliveryDir, "gen-catalog-doc.mjs")} 生成按资源域的可读目录\n`);
