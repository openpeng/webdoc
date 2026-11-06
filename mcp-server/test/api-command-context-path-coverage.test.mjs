import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyContextPath, scanSources } from '../dist/api-command-site-scan.js';

const options = { domain: 'example.com', loose: true, contextPath: '/portal' };
const scan = text => scanSources([{ kind: 'js', text }], options);

for (const expression of [
  'contextPath()', 'getContextPath()', 'app.contextPath ( )',
  'app.getContextPath ( )', '(app.CONTEXT_PATH)', '(contextPath())',
  '(contextPath)()', '(app.getContextPath)()',
]) {
  test(`context prefix expression: ${expression}`, () => {
    const result = scan(`fetch(${expression} + "/rest/items");`);
    assert.ok(result.candidates.some(c => c.pathTemplate === '/portal/rest/items'));
    assert.equal(result.contextPathAppliedCount, 1);
  });
}

for (const reverse of [false, true]) {
  test(`root and context-relative occurrences survive independently (reverse=${reverse})`, () => {
    const parts = ['fetch("/rest/items");', 'fetch(app.contextPath()+"/rest/items");'];
    const result = scan((reverse ? parts.reverse() : parts).join('\n'));
    assert.deepEqual(result.candidates.map(c => c.pathTemplate).sort(), ['/portal/rest/items', '/rest/items']);
  });
}

test('unrelated suffixes must not be recognized as context variables', () => {
  for (const expression of ['notcontextPath()', 'othergetContextPath()', 'contextPathSuffix', 'CONTEXT_PATH_EXTRA']) {
    const result = scan(`fetch(${expression} + "/rest/items");`);
    assert.equal(result.contextPathAppliedCount, 0);
  }
});

test('known context does not rewrite root paths or already complete paths', () => {
  const result = scan('fetch("/rest/heartbeat"); fetch("/portal/rest/items");');
  assert.deepEqual(result.candidates.map(c => c.pathTemplate).sort(), ['/portal/rest/items', '/rest/heartbeat']);
  assert.equal(result.contextPathAppliedCount, 0);
});

test('absolute and protocol-relative URLs never receive an application prefix', () => {
  for (const path of ['https://other.example/rest/items', '//other.example/rest/items']) {
    assert.equal(applyContextPath(path, '/portal', true), path);
  }
});

test('arbitrary function wrappers are not evidence of the returned prefix', () => {
  for (const expression of ['rewrite(contextPath())', 'rewrite(app.CONTEXT_PATH)', 'rewrite((contextPath()))']) {
    assert.equal(scan(`fetch(${expression} + "/rest/items");`).contextPathAppliedCount, 0);
  }
});

test('missing context preserves the candidate and emits the existing warning', () => {
  const result = scanSources([{ kind: 'js', text: 'fetch(getContextPath()+"/rest/items");' }], { domain: 'example.com', loose: true });
  assert.equal(result.contextPathAppliedCount, 0);
  assert.equal(result.relativePathCount, 1);
  assert.ok(result.warnings.length > 0);
});
