import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeApiDomains } from '../dist/api-domain-summary.js';
import { ApiCommandService } from '../dist/api-command-service.js';

const report = (overrides = {}) => ({ domains: [], perCommand: [], skippedInvalid: [], errors: [], schemaVersion: 1, ...overrides });

test('domains is an explicit empty array for an empty cache', () => {
  assert.deepEqual(summarizeApiDomains(report()), { domains: [], warnings: [] });
});

test('domain summary sorts multiple domains, excludes empty buckets, and only exposes cache totals', () => {
  const input = report({ domains: [
    { host: 'z.example', commandCount: 2, updatedAt: 'now' },
    { host: 'empty.example', commandCount: 0, updatedAt: 'now' },
    { host: 'a.example', commandCount: 3, updatedAt: 'now' },
  ] });
  const original = structuredClone(input);
  assert.deepEqual(summarizeApiDomains(input), { domains: [
    { domain: 'a.example', total: 3 }, { domain: 'z.example', total: 2 },
  ], warnings: [] });
  assert.deepEqual(input, original, 'projection must not mutate the cache report');
});

test('a domain with only disabled commands remains in the summary, without an availability claim', () => {
  const input = report({
    domains: [{ host: 'disabled.example', commandCount: 1, updatedAt: 'now' }],
    perCommand: [{ commandId: 'disabled1', disabled: true, hits: 0 }],
  });
  assert.deepEqual(summarizeApiDomains(input), { domains: [{ domain: 'disabled.example', total: 1 }], warnings: [] });
});

test('load failures and skipped corrupt entries remain warnings, even with no cached domains', () => {
  const result = summarizeApiDomains(report({
    errors: [{ source: 'cache.json', error: 'invalid JSON' }],
    skippedInvalid: [{ host: 'bad.example', commandId: 'bad1', reason: 'invalid schemaVersion' }],
  }));
  assert.deepEqual(result.domains, []);
  assert.deepEqual(result.warnings, ['cache.json: invalid JSON', 'bad.example/bad1: skipped invalid cached command: invalid schemaVersion']);
});

test('service cacheReport + projection needs no domain, browser lookup or transport', async () => {
  let reads = 0;
  let sends = 0;
  const service = new ApiCommandService({ report: async (...args) => {
    reads++;
    assert.deepEqual(args, [undefined]);
    return report({ domains: [{ host: 'local.example', commandCount: 4, updatedAt: 'now' }] });
  } }, async () => { sends++; throw new Error('transport is unavailable'); });
  assert.deepEqual(summarizeApiDomains(await service.cacheReport()), { domains: [{ domain: 'local.example', total: 4 }], warnings: [] });
  assert.equal(reads, 1);
  assert.equal(sends, 0);
});
