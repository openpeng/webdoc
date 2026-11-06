import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const expected = ["browser_page", "browser_read", "browser_act", "browser_debug",
  "api_discover", "api_commands", "api_call"];

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function withClient(run, extraEnv = {}) {
  // Separate ports prevent this test from joining a user's live extension bridge.
  const extension = await reservePort();
  const proxy = await reservePort();
  const ports = [extension.address().port, proxy.address().port];
  await Promise.all([extension, proxy].map(server => new Promise(resolve => server.close(resolve))));
  const isolated = fileURLToPath(new URL(`../test-artifacts/protocol-${randomUUID()}/`, import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/server.js", import.meta.url))],
    cwd: root,
    stderr: "pipe",
    env: {
      WEBPILOT_PORT: String(ports[0]), WEBPILOT_PROXY_PORT: String(ports[1]),
      WEBPILOT_HOST: "127.0.0.1", WEBPILOT_PROXY_HOST: "127.0.0.1",
      WEBPILOT_API_COMMAND_DIR: isolated, WEBPILOT_TASK_LOG_DIR: isolated,
      WEBPILOT_SELECTOR_CACHE_DIR: isolated, WEBPILOT_WORKFLOW_DIR: isolated,
      ...extraEnv,
    },
  });
  const client = new Client({ name: "tool-surface-protocol-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
    await transport.close();
  }
}

function payload(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return JSON.parse(result.content.find(item => item.type === "text").text);
}

test("MCP protocol: default discovery returns exactly seven unique tools", { timeout: 20000 }, async () => {
  await withClient(async client => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...expected].sort());
    for (const tool of tools) assert.equal(tool.inputSchema.type, "object");
  });
});

test("MCP protocol: advanced discovery is explicit and contains no duplicate names", { timeout: 20000 }, async () => {
  await withClient(async client => {
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name);
    assert.equal(new Set(names).size, names.length);
    assert.equal(names.length, 17);
    assert.ok(!names.includes("api_manage"));
    for (const name of [...expected, "browser_task", "task_workflow", "browser_status", "browser_cookie", "ai_search"]) assert.ok(names.includes(name), name);
    assert.ok(!names.includes("execute_js"));
    assert.ok(!names.includes("list_api_commands"));
  }, { WEBPILOT_ENABLE_ADVANCED_TOOLS: "1" });
});

test("MCP protocol: domains enumerates an empty cache without a browser or domain argument", { timeout: 20000 }, async () => {
  await withClient(async client => {
    const result = payload(await client.callTool({ name: "api_commands", arguments: { action: "domains" } }));
    assert.deepEqual(result.domains, []);
    assert.ok(Array.isArray(result.warnings));
    assert.equal(Object.hasOwn(result, "perCommand"), false);
  });
});

test("MCP protocol: new list and legacy list share the local command service", { timeout: 20000 }, async () => {
  await withClient(async client => {
    const current = payload(await client.callTool({ name: "api_commands", arguments: { action: "list", domain: "example.com" } }));
    const legacy = payload(await client.callTool({ name: "list_api_commands", arguments: { domain: "example.com" } }));
    assert.deepEqual(current, legacy);
    assert.equal(current.domain, "example.com");
    assert.deepEqual(current.commands, []);
  });
});

test("MCP protocol: malformed aggregate calls fail before browser or cache operations", { timeout: 20000 }, async () => {
  await withClient(async client => {
    for (const call of [
      { name: "api_manage", arguments: { domain: "example.com" } },
      { name: "api_manage", arguments: { action: "not_an_action", domain: "example.com" } },
      { name: "browser_act", arguments: { action: "click" } },
      { name: "api_commands", arguments: { action: "domains", tabId: 1 } },
      { name: "api_commands", arguments: { action: "list", domain: "example.com", unexpected: true } },
      { name: "api_call", arguments: { domain: "example.com", commandId: "test", confirm: "true" } },

    ]) {
      const result = await client.callTool(call);
      assert.equal(result.isError, true, JSON.stringify(call));
      assert.match(JSON.stringify(result.content), /INVALID_PARAMS|invalid|参数|required|unexpected/i);
      assert.doesNotMatch(JSON.stringify(result.content), /extension.*disconnect|扩展.*未连接/i);
    }
    // The SDK rejects a constructor override during request parsing, before our handler.
    await assert.rejects(client.callTool({
      name: "api_commands",
      arguments: JSON.parse('{"action":"list","domain":"example.com","constructor":"unexpected"}'),
    }), /Invalid input|invalid_type|INVALID_PARAMS/i);
  });
});
