import { adapterDefinitionDirs, loadDefinitions } from "./definitions.js";

type BrowserCall = (type: string, params: Record<string, unknown>) => Promise<any>;

type Field = { selector: string; attribute?: "href" | "content"; multiple?: boolean; limit?: number };
type ListSpec = { selector: string; fields: Record<string, Field>; limit?: number };
type TableSpec = { selector: string; header?: string; rows?: string; cells?: string; limit?: number };
type ExtractSpec = { fields?: Record<string, Field>; list?: ListSpec; table?: TableSpec };
type Adapter = {
  id: string;
  name: string;
  description: string;
  domains: string[];
  pathPattern?: RegExp;
  spec: ExtractSpec;
};
type Health = { calls: number; successes: number; failures: number; lastSuccessAt?: string; lastFailureAt?: string; lastError?: string; totalDurationMs: number };

const ATTRIBUTES = new Set(["href", "content"]);

// 校验并重建单个字段：只保留白名单键，绝不透传 computed 等可执行内容。
// 取文本是默认行为（省略 attribute）；attribute 只接受 href/content 两种 DOM 属性。
// 这是"声明式只读"安全边界的关键——外部 JSON 定义不能注入任意 JS。
function toField(raw: any, where: string): Field {
  if (!raw || typeof raw !== "object") throw new Error(`${where}: field must be an object`);
  if (typeof raw.selector !== "string" || !raw.selector.trim()) throw new Error(`${where}: field requires a non-empty selector`);
  const field: Field = { selector: raw.selector };
  if (raw.attribute !== undefined) {
    if (!ATTRIBUTES.has(raw.attribute)) throw new Error(`${where}: attribute must be href or content (omit it to read text)`);
    field.attribute = raw.attribute;
  }
  if (raw.multiple !== undefined) {
    if (typeof raw.multiple !== "boolean") throw new Error(`${where}: multiple must be a boolean`);
    field.multiple = raw.multiple;
  }
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== "number" || !Number.isFinite(raw.limit) || raw.limit <= 0) throw new Error(`${where}: limit must be a positive number`);
    field.limit = Math.floor(raw.limit);
  }
  return field;
}

function toFieldMap(raw: any, where: string): Record<string, Field> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: fields must be an object`);
  const entries = Object.entries(raw);
  if (entries.length === 0) throw new Error(`${where}: fields must not be empty`);
  return Object.fromEntries(entries.map(([key, value]) => [key, toField(value, `${where}.${key}`)]));
}

// 重建 spec，只保留 fields / list / table 三种只读提取形态的白名单键。
function toSpec(raw: any, where: string): ExtractSpec {
  if (!raw || typeof raw !== "object") throw new Error(`${where}: spec must be an object`);
  const spec: ExtractSpec = {};
  if (raw.fields !== undefined) spec.fields = toFieldMap(raw.fields, `${where}.fields`);
  if (raw.list !== undefined) {
    const list = raw.list;
    if (!list || typeof list !== "object") throw new Error(`${where}.list must be an object`);
    if (typeof list.selector !== "string" || !list.selector.trim()) throw new Error(`${where}.list requires a selector`);
    const listSpec: ListSpec = { selector: list.selector, fields: toFieldMap(list.fields, `${where}.list.fields`) };
    if (list.limit !== undefined) {
      if (typeof list.limit !== "number" || !Number.isFinite(list.limit) || list.limit <= 0) throw new Error(`${where}.list.limit must be a positive number`);
      listSpec.limit = Math.floor(list.limit);
    }
    spec.list = listSpec;
  }
  if (raw.table !== undefined) {
    const table = raw.table;
    if (!table || typeof table !== "object") throw new Error(`${where}.table must be an object`);
    if (typeof table.selector !== "string" || !table.selector.trim()) throw new Error(`${where}.table requires a selector`);
    const tableSpec: TableSpec = { selector: table.selector };
    for (const key of ["header", "rows", "cells"] as const) {
      if (table[key] !== undefined) {
        if (typeof table[key] !== "string") throw new Error(`${where}.table.${key} must be a string`);
        tableSpec[key] = table[key];
      }
    }
    if (table.limit !== undefined) {
      if (typeof table.limit !== "number" || !Number.isFinite(table.limit) || table.limit <= 0) throw new Error(`${where}.table.limit must be a positive number`);
      tableSpec.limit = Math.floor(table.limit);
    }
    spec.table = tableSpec;
  }
  if (!spec.fields && !spec.list && !spec.table) throw new Error(`${where}: spec requires at least one of fields, list, or table`);
  return spec;
}

// 导出仅供测试直接断言白名单重建行为；运行时入口仍是 AdapterRegistry。
export function validateAdapter(raw: any, source: string): Adapter {
  if (!raw || typeof raw !== "object") throw new Error("adapter must be an object");
  if (typeof raw.id !== "string" || !raw.id.trim()) throw new Error("adapter requires a non-empty id");
  const where = `adapter ${raw.id}`;
  if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error(`${where}: requires a name`);
  if (typeof raw.description !== "string") throw new Error(`${where}: requires a description`);
  if (!Array.isArray(raw.domains) || raw.domains.length === 0 || !raw.domains.every((domain: any) => typeof domain === "string" && domain.trim())) {
    throw new Error(`${where}: domains must be a non-empty array of strings`);
  }
  const adapter: Adapter = { id: raw.id, name: raw.name, description: raw.description, domains: raw.domains, spec: toSpec(raw.spec, where) };
  if (raw.pathPattern !== undefined) {
    if (typeof raw.pathPattern !== "string") throw new Error(`${where}: pathPattern must be a string`);
    try {
      adapter.pathPattern = new RegExp(raw.pathPattern);
    } catch (error: any) {
      throw new Error(`${where}: invalid pathPattern (${error.message})`);
    }
  }
  return adapter;
}

function matches(adapter: Adapter, url: string) {
  try {
    const parsed = new URL(url);
    const hostMatches = adapter.domains.includes("*") || adapter.domains.some(domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`));
    return hostMatches && (!adapter.pathPattern || adapter.pathPattern.test(parsed.pathname));
  } catch {
    return false;
  }
}

export class AdapterRegistry {
  private readonly health = new Map<string, Health>();
  private adapters: Adapter[] = [];
  private loaded = false;

  constructor(private readonly browser: BrowserCall) {}

  // 首次使用时从 JSON 定义目录加载并缓存；单条定义校验失败只跳过并打印告警。
  private async ensureLoaded() {
    if (this.loaded) return;
    const { items, errors } = await loadDefinitions(adapterDefinitionDirs(), validateAdapter);
    this.adapters = items;
    this.loaded = true;
    for (const error of errors) console.error(`[adapters] skipped definition from ${error.source}: ${error.error}`);
  }

  async list(url?: string) {
    await this.ensureLoaded();
    return this.adapters.filter(adapter => !url || matches(adapter, url)).map(adapter => ({ id: adapter.id, name: adapter.name, description: adapter.description, domains: adapter.domains, health: this.healthSummary(adapter.id) }));
  }

  async extract(id: string, tabId?: number) {
    await this.ensureLoaded();
    const adapter = this.adapters.find(item => item.id === id);
    if (!adapter) throw new Error(`Unknown adapter: ${id}`);
    const page = await this.browser("getPageInfo", { tabId });
    if (!matches(adapter, page.url)) throw new Error(`Adapter ${id} does not match ${page.url}`);
    return this.execute(adapter, tabId);
  }

  async extractBest(tabId?: number) {
    await this.ensureLoaded();
    const page = await this.browser("getPageInfo", { tabId });
    const candidates = this.adapters.filter(adapter => matches(adapter, page.url)).sort((left, right) => Number(left.domains.includes("*")) - Number(right.domains.includes("*")));
    const failures: Array<{ adapterId: string; error: string }> = [];
    for (const adapter of candidates) {
      try {
        const result = await this.execute(adapter, tabId);
        return { ...result, fallbackUsed: failures.length > 0, failedCandidates: failures };
      } catch (error: any) {
        failures.push({ adapterId: adapter.id, error: error.message });
      }
    }
    throw new Error(`No adapter could extract ${page.url}: ${failures.map(item => `${item.adapterId}: ${item.error}`).join("; ")}`);
  }

  async healthReport() {
    await this.ensureLoaded();
    return this.adapters.map(adapter => ({ id: adapter.id, name: adapter.name, ...this.healthSummary(adapter.id) }));
  }

  private async execute(adapter: Adapter, tabId?: number) {
    const startedAt = Date.now();
    try {
      const result = await this.browser("extract", { tabId, spec: adapter.spec });
      this.record(adapter.id, true, Date.now() - startedAt);
      return { adapter: { id: adapter.id, name: adapter.name, domains: adapter.domains, readOnly: true }, ...result };
    } catch (error: any) {
      this.record(adapter.id, false, Date.now() - startedAt, error.message);
      throw error;
    }
  }

  private record(id: string, success: boolean, durationMs: number, error?: string) {
    const health = this.health.get(id) || { calls: 0, successes: 0, failures: 0, totalDurationMs: 0 };
    health.calls += 1;
    health.totalDurationMs += durationMs;
    if (success) { health.successes += 1; health.lastSuccessAt = new Date().toISOString(); }
    else { health.failures += 1; health.lastFailureAt = new Date().toISOString(); health.lastError = error; }
    this.health.set(id, health);
  }

  private healthSummary(id: string) {
    const health = this.health.get(id) || { calls: 0, successes: 0, failures: 0, totalDurationMs: 0 };
    return { calls: health.calls, successes: health.successes, failures: health.failures, averageDurationMs: health.calls ? Math.round(health.totalDurationMs / health.calls) : 0, lastSuccessAt: health.lastSuccessAt, lastFailureAt: health.lastFailureAt, lastError: health.lastError };
  }
}
