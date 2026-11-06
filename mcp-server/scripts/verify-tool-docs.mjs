// Read-only documentation parity check; does not start a server or contact Chrome.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = relative => fs.readFileSync(path.resolve(root, relative), 'utf8');
const loadTs = async text => import('data:text/javascript;base64,' + Buffer.from(ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText).toString('base64'));
const source = ts.createSourceFile('server.ts', read('mcp-server/src/server.ts'), ts.ScriptTarget.Latest, true);
let catalogText;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'toolSurface') {
    catalogText = node.initializer.arguments[0].arguments[0].getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(catalogText, 'server tool catalog exists');
const { default: catalog } = await loadTs('export default ' + catalogText);
const { createToolSurface, ADVANCED_TOOLS_ENV, ADVANCED_TOOL_NAMES } = await loadTs(read('mcp-server/src/tool-surface.ts'));
const surface = createToolSurface(catalog);
const tools = surface.list(false);
assert.equal(tools.length, 7);
assert.equal(surface.list(true).length, 17);
assert.ok(!surface.list(true).some(tool => tool.name === 'api_manage'));
assert.deepEqual(surface.resolve('api_commands', { action: 'domains' }), { name: 'list_api_domains', args: {} });
assert.throws(() => surface.resolve('api_commands', { action: 'domains', domain: 'example.com' }), /INVALID_PARAMS/);
assert.throws(() => surface.resolve('api_commands', { action: 'domains', tabId: 1 }), /INVALID_PARAMS/);
const browserPath = 'mcp-server/skills/webpilot-browser/SKILL.md';
const maintenanceExamples = [...read(browserPath).matchAll(/\| `(\{"action":[^`]+\})` \|/g)].map(match => JSON.parse(match[1]));
assert.equal(maintenanceExamples.length, 7, 'seven maintenance argument examples');
for (const args of maintenanceExamples) assert.doesNotThrow(() => surface.resolve('api_manage', args), `maintenance ${args.action} example matches routing schema`);
for (const relative of [browserPath, 'mcp-server/README.md', 'README.md']) {
  const text = read(relative);
  assert.ok(!text.includes('| `api_manage` |'), `${relative}: maintenance absent from entrance table`);
  for (const tool of tools) {
    const row = text.split(/\r?\n/).find(line => line.startsWith('| `' + tool.name + '` |'));
    assert.ok(row, `${relative}: missing ${tool.name}`);
    if (tool.name === 'api_call') continue;
    const expected = tool.inputSchema.oneOf.map(branch => branch.properties.action.enum[0]).sort();
    const actual = [...row.split('|').slice(2).join('|').matchAll(/`([a-z_]+)`/g)].map(match => match[1]).filter(value => value !== 'analyze_page_apis').sort();
    assert.deepEqual(actual, expected, `${relative}: ${tool.name} action parity`);
  }
  assert.ok(text.includes(`${ADVANCED_TOOLS_ENV}=1`) || text.includes('`' + ADVANCED_TOOLS_ENV + '`'), `${relative}: advanced switch documented`);
  for (const name of ADVANCED_TOOL_NAMES) assert.ok(text.includes('`' + name + '`'), `${relative}: advanced ${name}`);
  assert.ok(!text.includes('Deprecated and disabled') && !text.includes('`execute_js` is disabled'), `${relative}: stale script ban`);
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  assert.ok(!(crlf && lf), `${relative}: mixed line endings`);
  console.log(`${relative}: 7 entrance rows and all actions match; ${crlf ? 'CRLF' : 'LF'}`);
}
// Local project mirrors are optional: a clean checkout contains the packaged Skills.
const apiPath = 'mcp-server/skills/webdoc-api-replication/SKILL.md';
const mirrorPath = '.minimax/skills/webdoc-api-replication/SKILL.md';
const localSkills = [mirrorPath, '.minimax/skills/webdoc-replication-deliverables/SKILL.md']
  .filter(relative => fs.existsSync(path.resolve(root, relative)));
if (localSkills.includes(mirrorPath)) {
  assert.equal(read(apiPath), read(mirrorPath), 'API Skill copies match');
  console.log('Local API Skill mirror: identical');
}
for (const relative of [browserPath, apiPath, ...localSkills]) {
  const text = read(relative);
  assert.match(text, /^---\r?\nname: [^\r\n]+\r?\ndescription:/);
  assert.ok(Buffer.byteLength(text) < 100_000, `${relative}: Skill size limit`);
}
if (process.argv[2]) {
  assert.ok(fs.readFileSync(path.resolve(root, browserPath)).equals(fs.readFileSync(process.argv[2])), 'installed browser Skill is byte-identical');
  console.log('Installed browser Skill: byte-identical');
}
console.log('PASS: documentation tool/action parity, advanced names, Skill shape/size, API Skill parity');
