import type { CacheReport } from "./api-command-types.js";

/** Pure projection of local cache metadata, not a claim of endpoint verification. */
export function summarizeApiDomains(report: CacheReport): {
  domains: Array<{ domain: string; total: number }>;
  warnings: string[];
} {
  return {
    domains: report.domains
      .filter(entry => entry.commandCount > 0)
      .map(entry => ({ domain: entry.host, total: entry.commandCount }))
      .sort((a, b) => a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0),
    warnings: [
      ...report.errors.map(entry => `${entry.source}: ${entry.error}`),
      ...report.skippedInvalid.map(entry => `${entry.host}${entry.commandId ? `/${entry.commandId}` : ""}: skipped invalid cached command: ${entry.reason}`),
    ],
  };
}
