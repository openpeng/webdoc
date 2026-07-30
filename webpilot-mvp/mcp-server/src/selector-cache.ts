import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// (站点, intent) → 定位符缓存：命中时 Agent 无需重新观察页面即可执行
// click/type，未命中或失效时回退显式 selector 并回写。条目健康度结构对齐
// adapters.ts 的 Health，持久化模式对齐 task-runtime.ts（懒加载 + 整写），
// 但采用临时文件 + rename 的原子写。

export type SelectorCacheEntry = {
  host: string;
  intent: string;
  selector: string;
  hits: number;
  misses: number;
  consecutiveFailures: number;
  disabled: boolean;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  totalDurationMs: number;
  createdAt: string;
  updatedAt: string;
};

const INTENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// @eN/@wpN 引用只在单个 document 内有效，禁止入缓存。
const EPHEMERAL_SELECTOR = /^@(e|wp)\d+$/;
const MAX_CONSECUTIVE_FAILURES = 4;

export function isValidIntent(intent: unknown): intent is string {
  return typeof intent === "string" && INTENT_PATTERN.test(intent);
}

export function isCacheableSelector(selector: unknown): selector is string {
  return typeof selector === "string" && Boolean(selector.trim()) && !EPHEMERAL_SELECTOR.test(selector.trim());
}

// 加载时逐条白名单校验，坏条目（含被篡改注入的 @eN/@wpN）直接跳过。
function toEntry(raw: any): SelectorCacheEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.host !== "string" || !raw.host.trim()) return undefined;
  if (!isValidIntent(raw.intent) || !isCacheableSelector(raw.selector)) return undefined;
  const count = (value: any) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
  const at = (value: any) => (typeof value === "string" ? value : undefined);
  return {
    host: raw.host.toLowerCase(),
    intent: raw.intent,
    selector: raw.selector.trim(),
    hits: count(raw.hits),
    misses: count(raw.misses),
    consecutiveFailures: count(raw.consecutiveFailures),
    disabled: raw.disabled === true,
    lastSuccessAt: at(raw.lastSuccessAt),
    lastFailureAt: at(raw.lastFailureAt),
    lastError: at(raw.lastError),
    totalDurationMs: count(raw.totalDurationMs),
    createdAt: at(raw.createdAt) || new Date().toISOString(),
    updatedAt: at(raw.updatedAt) || new Date().toISOString(),
  };
}

export class SelectorCache {
  private readonly entries = new Map<string, SelectorCacheEntry>();
  private readonly file: string;
  private loaded = false;

  constructor(file?: string) {
    const dir = process.env.WEBPILOT_SELECTOR_CACHE_DIR
      || process.env.WEBPILOT_TASK_LOG_DIR
      || join(process.cwd(), ".webpilot-task-logs");
    this.file = file || join(dir, "selector-cache.json");
  }

  private key(host: string, intent: string) {
    return `${host.toLowerCase()}\u0000${intent}`;
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(parsed)) return;
      for (const raw of parsed) {
        const entry = toEntry(raw);
        if (entry) this.entries.set(this.key(entry.host, entry.intent), entry);
        else console.error(`[selector-cache] skipped invalid entry in ${this.file}`);
      }
    } catch (error: any) {
      if (error.code !== "ENOENT") console.error(`[selector-cache] could not load ${this.file}: ${error.message}`);
    }
  }

  // 原子写：先写 .tmp 再 rename，写失败只告警，不阻断操作链路。
  private async persist() {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify([...this.entries.values()], null, 2), "utf8");
      await rename(tmp, this.file);
    } catch (error: any) {
      console.error(`[selector-cache] could not persist ${this.file}: ${error.message}`);
    }
  }

  // 返回可用的缓存条目；disabled 条目视同未命中。
  async lookup(host: string, intent: string): Promise<SelectorCacheEntry | undefined> {
    await this.ensureLoaded();
    const entry = this.entries.get(this.key(host, intent));
    return entry && !entry.disabled ? entry : undefined;
  }

  // 区分未命中原因，供调用方给 Agent 可行动的提示。
  async status(host: string, intent: string): Promise<"active" | "disabled" | "missing"> {
    await this.ensureLoaded();
    const entry = this.entries.get(this.key(host, intent));
    return entry ? (entry.disabled ? "disabled" : "active") : "missing";
  }

  async recordSuccess(host: string, intent: string, selector: string, durationMs: number) {
    if (!isValidIntent(intent)) throw new Error(`intent must match ${INTENT_PATTERN}`);
    if (!isCacheableSelector(selector)) throw new Error("selector is not cacheable (@eN/@wpN references are document-scoped)");
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const key = this.key(host, intent);
    const entry = this.entries.get(key) || {
      host: host.toLowerCase(), intent, selector: selector.trim(),
      hits: 0, misses: 0, consecutiveFailures: 0, disabled: false, totalDurationMs: 0,
      createdAt: now, updatedAt: now,
    };
    entry.selector = selector.trim();
    entry.hits += 1;
    entry.consecutiveFailures = 0;
    entry.disabled = false;
    entry.lastSuccessAt = now;
    entry.totalDurationMs += Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
    entry.updatedAt = now;
    this.entries.set(key, entry);
    await this.persist();
  }

  async recordFailure(host: string, intent: string, error?: string) {
    await this.ensureLoaded();
    const entry = this.entries.get(this.key(host, intent));
    if (!entry) return;
    const now = new Date().toISOString();
    entry.misses += 1;
    entry.consecutiveFailures += 1;
    entry.lastFailureAt = now;
    entry.lastError = error;
    entry.updatedAt = now;
    if (entry.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) entry.disabled = true;
    await this.persist();
  }

  async report(host?: string) {
    await this.ensureLoaded();
    const wanted = host?.toLowerCase();
    return [...this.entries.values()]
      .filter(entry => !wanted || entry.host === wanted)
      .map(entry => ({
        ...entry,
        averageDurationMs: entry.hits ? Math.round(entry.totalDurationMs / entry.hits) : 0,
      }));
  }
}
