import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createToolSurface, ADVANCED_TOOLS_ENV, ADVANCED_TOOL_NAMES } from '../dist/tool-surface.js';
import { ApiCommandService } from '../dist/api-command-service.js';

// Read the compiled catalog without starting a bridge or touching a live browser.
const source = readFileSync(new URL('../dist/server.js', import.meta.url), 'utf8');
const start = source.indexOf('const toolSurface = createToolSurface(');
const end = source.indexOf('server.setRequestHandler(ListToolsRequestSchema', start);
let legacy;
vm.runInNewContext(source.slice(start, end), {
  createToolSurface(tools) { legacy = JSON.parse(JSON.stringify(tools)); },
  dedupeTools(tools) { return tools; },
});
const surface = createToolSurface(legacy);

test('default surface is exactly seven tools; advanced catalog is unique and SDK compatible', () => {
  const names = ['browser_page', 'browser_read', 'browser_act', 'browser_debug', 'api_discover', 'api_commands', 'api_call'];
  assert.deepEqual(surface.list(false).map(t => t.name), names);
  assert.deepEqual(surface.list(true).map(t => t.name), [...names, ...ADVANCED_TOOL_NAMES]);
  assert.equal(new Set(surface.list(true).map(t => t.name)).size, surface.list(true).length);
  const parsed = ListToolsResultSchema.parse({ tools: surface.list(true) });
  assert.equal(parsed.tools[0].inputSchema.oneOf.length, 13);
  assert.equal(parsed.tools[0].inputSchema.type, 'object');
  assert.ok(parsed.tools[0].inputSchema.oneOf.every(s => s.additionalProperties === false));
});

test('advanced advertisement requires explicit environment value 1', () => {
  const old = process.env[ADVANCED_TOOLS_ENV];
  try {
    for (const value of ['', '0', 'true']) {
      process.env[ADVANCED_TOOLS_ENV] = value;
      assert.equal(surface.list().length, 7);
    }
    process.env[ADVANCED_TOOLS_ENV] = '1';
    assert.equal(surface.list().length, 17);
  } finally {
    if (old === undefined) delete process.env[ADVANCED_TOOLS_ENV]; else process.env[ADVANCED_TOOLS_ENV] = old;
  }
});

test('legacy names and original browser_page actions retain routing', () => {
  for (const tool of legacy.filter(t => t.name !== 'browser_page')) {
    const args = { legacyPayload: true };
    assert.deepEqual(surface.resolve(tool.name, args), { name: tool.name, args });
  }
  for (const name of ['upload_file', 'handle_dialog', 'download_file', 'reload', 'go_back_forward', 'get_url', 'full_page_screenshot', 'element_screenshot']) {
    assert.equal(surface.resolve(name, {}).name, name);
  }
  assert.deepEqual(surface.resolve('browser_page', { action: 'upload_file', selector: '#file', filePath: '/file' }), { name: 'browser_page', args: { action: 'upload_file', selector: '#file', filePath: '/file' } });
  assert.deepEqual(surface.resolve('browser_page', { action: 'navigate', url: 'https://example.com' }), { name: 'navigate', args: { url: 'https://example.com' } });
  assert.deepEqual(surface.resolve('browser_read', { action: 'iframe_query', selector: 'a' }), { name: 'iframe_action', args: { action: 'query', selector: 'a' } });
  assert.deepEqual(surface.resolve('browser_read', { action: 'iframe_text', iframeIndex: 1 }), { name: 'extract_iframe_text', args: { iframeIndex: 1 } });
  assert.deepEqual(surface.resolve('browser_act', { action: 'shadow_type', innerSelector: 'input', text: 'hello' }), { name: 'shadow_dom_action', args: { action: 'type', innerSelector: 'input', text: 'hello' } });
  assert.deepEqual(surface.resolve('api_commands', { action: 'domains' }), { name: 'list_api_domains', args: {} });
  assert.deepEqual(surface.resolve('api_manage', { action: 'disable', commandId: 'c1' }), { name: 'invalidate_api_commands', args: { action: 'disable', commandId: 'c1' } });
});

test('action branches reject missing, unknown, extra, wrong-type and nested invalid parameters', () => {
  const invalid = [
    ['browser_page', {}], ['browser_page', { action: 'unknown' }],
    ['browser_page', JSON.parse('{"action":"reload","__proto__":{}}')],
    ['browser_page', JSON.parse('{"action":"reload","constructor":"extra"}')],
    ['browser_page', JSON.parse('{"action":"reload","toString":"extra"}')],
    ['browser_page', { action: 'navigate' }], ['browser_page', { action: 'reload', url: 'https://example.com' }],
    ['browser_page', { action: 'navigate', url: 42 }], ['browser_act', { action: 'click' }],
    ['browser_act', { action: 'type', selector: '#x' }], ['browser_act', { action: 'shadow_click' }],
    ['browser_read', { action: 'iframe_query' }], ['browser_debug', { action: 'evaluate', expression: '1', globals: [1] }],
    ['api_commands', { action: 'domains', domain: 'example.com' }],
    ['api_commands', { action: 'domains', tabId: 1 }],
    ['api_commands', { action: 'get' }], ['api_manage', { action: 'delete' }],
    ['api_manage', { action: 'clear_domain', commandId: 'c1' }],
    ['api_call', { name: 'write', confirm: 'true' }], ['api_call', { name: 'write', risk: 'read' }],
    ['api_discover', { action: 'start', sources: [] }],
    ['api_discover', { action: 'start', filter: { mimeType: 42 } }],
    ['api_discover', { action: 'scan_site', sources: [{ kind: 'js', text: 42 }] }],
    ['api_discover', { action: 'scan_site', sources: [{ kind: 'js', text: '', extra: true }] }],
  ];
  for (const [name, args] of invalid) assert.throws(() => surface.resolve(name, args), /INVALID_PARAMS/, `${name} ${JSON.stringify(args)}`);
  assert.equal(surface.resolve('browser_act', { action: 'click', intent: 'submit' }).name, 'click');
  assert.equal(surface.resolve('api_call', { name: 'read', params: { arbitrary: [1, true] } }).name, 'call_api_command');
});

test('api_call preserves confirmation gate with zero transport calls for unconfirmed writes', async () => {
  let sent = 0;
  const command = { commandId: 'write1', name: 'create.item', domain: 'example.com', request: { method: 'POST', urlTemplate: 'https://example.com/api/items' }, risk: 'write', params: [], responseFields: [], health: {}, source: {} };
  const service = new ApiCommandService({ get: async () => command }, async () => { sent++; throw new Error('unexpected transport'); });
  for (const confirm of [undefined, false]) {
    const resolved = surface.resolve('api_call', { domain: 'example.com', name: 'create.item', ...(confirm === undefined ? {} : { confirm }) });
    assert.equal(resolved.name, 'call_api_command');
    assert.equal(resolved.args.confirm, confirm);
    const result = await service.call(resolved.args);
    assert.equal(result.confirmationRequired, true);
  }
  assert.equal(sent, 0);
  assert.equal(surface.resolve('api_call', { name: 'create.item', confirm: true }).args.confirm, true);
});
