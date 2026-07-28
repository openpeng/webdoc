type BrowserCall = (type: string, params: Record<string, unknown>) => Promise<any>;

type Field = { selector: string; attribute?: "text" | "href" | "content"; multiple?: boolean; limit?: number };
type ExtractSpec = { fields?: Record<string, Field>; list?: { selector: string; fields: Record<string, Field>; limit?: number } };
type Adapter = {
  id: string;
  name: string;
  description: string;
  domains: string[];
  pathPattern?: RegExp;
  spec: ExtractSpec;
};
type Health = { calls: number; successes: number; failures: number; lastSuccessAt?: string; lastFailureAt?: string; lastError?: string; totalDurationMs: number };

const adapters: Adapter[] = [
  {
    id: "generic-page-summary",
    name: "通用页面摘要",
    description: "提取标题、描述、规范链接、标题层级和前 20 个链接；适用于任何 HTTPS 页面。",
    domains: ["*"],
    spec: {
      fields: {
        title: { selector: "title" },
        description: { selector: 'meta[name="description"]', attribute: "content" },
        canonicalUrl: { selector: 'link[rel="canonical"]', attribute: "href" },
        headings: { selector: "h1, h2", multiple: true, limit: 20 },
        links: { selector: "a[href]", attribute: "href", multiple: true, limit: 20 }
      }
    }
  },
  {
    id: "github-repository",
    name: "GitHub 仓库",
    description: "读取 GitHub 仓库的名称、描述、Star、Fork、主要语言、主题和 README 标题。只读。",
    domains: ["github.com"],
    pathPattern: /^\/[^/]+\/[^/]+\/?$/,
    spec: {
      fields: {
        repository: { selector: 'meta[property="og:title"]', attribute: "content" },
        description: { selector: 'meta[name="description"]', attribute: "content" },
        stars: { selector: 'a[href$="/stargazers"]' },
        forks: { selector: 'a[href$="/forks"]' },
        primaryLanguage: { selector: '[itemprop="programmingLanguage"]' },
        topics: { selector: 'a[data-ga-click*="topic"]', multiple: true, limit: 20 },
        readmeHeadings: { selector: 'article.markdown-body h1, article.markdown-body h2', multiple: true, limit: 30 }
      }
    }
  },
  {
    id: "github-issues",
    name: "GitHub Issues",
    description: "将当前 GitHub 仓库的 Issues 列表提取成标题和链接数组。只读。",
    domains: ["github.com"],
    pathPattern: /^\/[^/]+\/[^/]+\/issues\/?$/,
    spec: {
      list: {
        selector: 'a.Link--primary[href*="/issues/"]',
        limit: 50,
        fields: {
          title: { selector: "$self" },
          url: { selector: "$self", attribute: "href" }
        }
      }
    }
  }
];

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

  constructor(private readonly browser: BrowserCall) {}

  list(url?: string) {
    return adapters.filter(adapter => !url || matches(adapter, url)).map(adapter => ({ id: adapter.id, name: adapter.name, description: adapter.description, domains: adapter.domains, health: this.healthSummary(adapter.id) }));
  }

  async extract(id: string, tabId?: number) {
    const adapter = adapters.find(item => item.id === id);
    if (!adapter) throw new Error(`Unknown adapter: ${id}`);
    const page = await this.browser("getPageInfo", { tabId });
    if (!matches(adapter, page.url)) throw new Error(`Adapter ${id} does not match ${page.url}`);
    return this.execute(adapter, tabId);
  }

  async extractBest(tabId?: number) {
    const page = await this.browser("getPageInfo", { tabId });
    const candidates = adapters.filter(adapter => matches(adapter, page.url)).sort((left, right) => Number(left.domains.includes("*")) - Number(right.domains.includes("*")));
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

  healthReport() {
    return adapters.map(adapter => ({ id: adapter.id, name: adapter.name, ...this.healthSummary(adapter.id) }));
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
