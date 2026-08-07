/**
 * prepublish.js — 发布前准备：将 SKILL.md、INSTALL.md、browser-extension/ 复制到 mcp-server 目录
 * 这些文件位于上级目录，npm files 字段不支持 ../ 路径，所以发布前拷贝进来
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const mvpRoot = resolve(pkgRoot, '..');

// 要复制的文件/目录映射：[源路径（相对于 mvpRoot）, 目标路径（相对于 pkgRoot）]
const targets = [
  ['INSTALL.md', 'INSTALL.md'],
  ['skills/webpilot-browser/SKILL.md', 'skill/SKILL.md'],
  ['browser-extension', 'browser-extension'],
];

// 清理旧拷贝
for (const [, dest] of targets) {
  const destPath = resolve(pkgRoot, dest);
  if (existsSync(destPath)) rmSync(destPath, { recursive: true, force: true });
}

// 复制
for (const [src, dest] of targets) {
  const srcPath = resolve(mvpRoot, src);
  const destPath = resolve(pkgRoot, dest);
  if (!existsSync(srcPath)) {
    console.warn(`[prepublish] WARNING: source not found, skipping: ${srcPath}`);
    continue;
  }
  const destDir = dirname(destPath);
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  cpSync(srcPath, destPath, { recursive: true });
  console.log(`[prepublish] copied: ${src} -> ${dest}`);
}

console.log('[prepublish] done.');
