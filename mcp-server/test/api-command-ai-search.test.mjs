// ai_search 服务层测试：SSE 流式读取（收到结束标记即返回）+ 跨通道超时总预算。
//
// 全部离线：globalThis.fetch 被替换成可控的假实现（流式 ReadableStream / 永不返回的请求），
// 不依赖外网。覆盖 T8 三件事：
//   ① SSE 逐段读取，收到结束标记立刻收尾，不等服务端关连接；
//   ② 增量/全量只看协议显式标记（解析侧用例见 baidu-ai-search.test.mjs）；
//   ③ timeoutMs 是跨通道总预算，兜底通道不得再拿一整份超时。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApiCommandCache } from "../dist/api-command-cache.js";
import { ApiCommandService } from "../dist/api-command-service.js";

const DOMAIN = "api.example.com";
const encoder = new TextEncoder();

const sseEvent = (obj) => `event:message\ndata:${JSON.stringify(obj)}\n\n`;
const textEvent = (value) => sseEvent({
  data: { message: { metaData: { state: "generating-resp", endTurn: false },
    content: { generator: { component: "markdown-yiyan", data: { value } } } } },
});
const endEvent = sseEvent({
  data: { message: { metaData: { state: "generate-complete", endTurn: false },
    content: { generator: { component: "", isFinished: true } } } },
});

/** 造一个只返回 204 的假缓存（ai_search 不写缓存，只为构造服务）。 */
async function makeService(t) {
  const dir = await mkdtemp(join(tmpdir(), "webpilot-aisearch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cache = new ApiCommandCache(join(dir, "api-commands.json"));
  // 扩展通道永远不可用（send 抛错）→ 兜底链路从 Node 直读开始
  const service = new ApiCommandService(cache, async () => { throw new Error("扩展未连接"); });
  return service;
}

/** 临时替换 globalThis.fetch，测试结束自动还原。 */
function withFetch(t, impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  t.after(() => { globalThis.fetch = original; });
}

test("T8：SSE 逐段读取，收到结束标记即返回（不等服务端关连接）", async (t) => {
  const service = await makeService(t);
  let cancelled = false;
  let pulls = 0;
  const chunks = [textEvent("==**OpenSpec 是"), textEvent("规范驱动开发**。"), endEvent];

  withFetch(t, async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      async pull(controller) {
        pulls += 1;
        if (pulls <= chunks.length) {
          controller.enqueue(encoder.encode(chunks[pulls - 1]));
          return;
        }
        // 服务端不关连接（真实生成接口的常态）：正确实现不应等这里。
        await new Promise((resolve) => setTimeout(resolve, 8000));
        controller.close();
      },
      cancel() { cancelled = true; },
    }),
  }));

  const startedAt = Date.now();
  const result = await service.aiSearch({ query: "OpenSpec 是什么", timeoutMs: 15000 });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.found, true);
  assert.equal(result.via, "baikan-sse");
  assert.equal(result.answer, "==**OpenSpec 是规范驱动开发**。");
  assert.equal(result.finished, true, "收到 generate-complete 结束标记即视为完成");
  assert.ok(elapsed < 5000, `必须在结束标记后立刻返回（实际 ${elapsed}ms）`);
  assert.equal(cancelled, true, "收到结束标记后应主动断开流");
});

test("T8：timeoutMs 是跨通道总预算 —— 主通道耗尽预算后不再走兜底", async (t) => {
  const service = await makeService(t);
  const calls = [];
  withFetch(t, (url, init) => {
    calls.push(String(url));
    // 永不返回，只在 abort 时以 AbortError 失败
    return new Promise((_, reject) => {
      const signal = init?.signal;
      const onAbort = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  });

  const startedAt = Date.now();
  await assert.rejects(
    () => service.aiSearch({ query: "测试预算", timeoutMs: 3000 }),
    (err) => {
      assert.equal(err.code, "NETWORK_ERROR");
      assert.ok(String(err.message).includes("总超时预算"), `实际: ${err.message}`);
      return true;
    },
  );
  const elapsed = Date.now() - startedAt;

  assert.equal(calls.length, 1, "预算耗尽后不得再发起兜底请求");
  assert.ok(elapsed < 6000, `总耗时应受单份预算约束（实际 ${elapsed}ms）`);
});

test("T8：主通道快速失败时，兜底通道仍可用剩余预算", async (t) => {
  const service = await makeService(t);
  const calls = [];
  withFetch(t, async (url) => {
    calls.push(String(url));
    if (String(url).includes("baikan/conversation")) {
      throw new Error("主通道网络不可用");
    }
    // 兜底：移动站 SSR 页面（无 baikan 块 → 解析不到答案）
    return {
      ok: true,
      status: 200,
      text: async () => "<html><body>没有 AI 摘要</body></html>",
    };
  });

  const result = await service.aiSearch({ query: "测试兜底", timeoutMs: 8000 });
  assert.equal(calls.length, 2, "主通道失败后必须尝试兜底通道");
  assert.equal(result.found, false);
  assert.ok(result.warnings.length > 0, "兜底未命中必须给告警");
  assert.equal(result.attempts, 3, "attempts 必须是真实尝试次数：SSE 1 次 + 扩展 1 次 + Node 直读 1 次");
});
