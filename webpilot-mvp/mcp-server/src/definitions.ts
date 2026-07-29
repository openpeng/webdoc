// 站点定义加载器：适配器与预置工作流都以 JSON 数据文件沉淀，运行时加载。
// 这样新增/修改/分享站点定义只需编辑 JSON，无需改 TS 或重新编译。
//
// 加载来源按顺序合并，后者按 id 覆盖前者：
//   1. 仓库内置目录（definitions/adapters、definitions/workflows）
//   2. 环境变量指定的外部目录（个人/团队自定义与覆盖）
//
// 目录内每个 *.json 文件可以是单个定义对象，或定义对象数组。
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// 编译后本文件位于 mcp-server/dist/definitions.js，定义文件在 mcp-server/definitions/ 下。
export const BUILTIN_ADAPTER_DIR = join(HERE, "..", "definitions", "adapters");
export const BUILTIN_WORKFLOW_DIR = join(HERE, "..", "definitions", "workflows");

export type LoadError = { source: string; error: string };
export type LoadResult<T> = { items: T[]; errors: LoadError[] };

export function adapterDefinitionDirs(): string[] {
  const external = process.env.WEBPILOT_ADAPTER_DIR?.trim();
  return external ? [BUILTIN_ADAPTER_DIR, external] : [BUILTIN_ADAPTER_DIR];
}

export function workflowDefinitionDirs(): string[] {
  const external = process.env.WEBPILOT_WORKFLOW_DEF_DIR?.trim();
  return external ? [BUILTIN_WORKFLOW_DIR, external] : [BUILTIN_WORKFLOW_DIR];
}

async function readRawDefsFromDir(dir: string, errors: LoadError[]): Promise<Array<{ raw: any; source: string }>> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter(file => file.toLowerCase().endsWith(".json")).sort();
  } catch (error: any) {
    // 目录不存在是正常情况（例如未配置外部目录）；其它错误才上报。
    if (error.code !== "ENOENT") errors.push({ source: dir, error: error.message });
    return [];
  }
  const out: Array<{ raw: any; source: string }> = [];
  for (const file of files) {
    const source = join(dir, file);
    try {
      const parsed = JSON.parse(await readFile(source, "utf8"));
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const raw of entries) out.push({ raw, source });
    } catch (error: any) {
      errors.push({ source, error: error.message });
    }
  }
  return out;
}

// 依次读取多个目录，用 validate 校验并转换每条定义；同 id 定义后加载者覆盖先加载者。
// 单条定义校验失败只记录错误、跳过该条，不影响其它定义加载。
export async function loadDefinitions<T extends { id: string }>(
  dirs: string[],
  validate: (raw: any, source: string) => T
): Promise<LoadResult<T>> {
  const errors: LoadError[] = [];
  const byId = new Map<string, T>();
  for (const dir of dirs) {
    for (const { raw, source } of await readRawDefsFromDir(dir, errors)) {
      try {
        const item = validate(raw, source);
        byId.set(item.id, item);
      } catch (error: any) {
        errors.push({ source, error: error.message });
      }
    }
  }
  return { items: [...byId.values()], errors };
}
