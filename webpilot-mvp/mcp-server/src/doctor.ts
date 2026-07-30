#!/usr/bin/env node
/**
 * WebPilot 安装自检（npm run doctor）
 * 逐项检查运行环境并输出 PASS/WARN/FAIL 与修复建议；有 FAIL 时退出码非 0，可用于 CI。
 * 注意：不 import server.js（那会启动 MCP 服务器），只复用无副作用的模块。
 */
import { access } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adapterDefinitionDirs,
  workflowDefinitionDirs,
  loadDefinitions,
  BUILTIN_ADAPTER_DIR,
} from "./definitions.js";
import { validateAdapter } from "./adapters.js";
import { validatePresetWorkflow } from "./task-runtime.js";

const HERE = dirname(fileURLToPath(import.meta.url));

type Level = "PASS" | "WARN" | "FAIL" | "INFO";
type Check = { level: Level; name: string; detail: string; hint?: string };

const checks: Check[] = [];
const report = (level: Level, name: string, detail: string, hint?: string) => checks.push({ level, name, detail, hint });

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

// 探测本机端口：resolve "listening"（有进程监听）或 "free"（连接被拒/超时）。
function probePort(port: number): Promise<"listening" | "free"> {
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (state: "listening" | "free") => { socket.destroy(); resolve(state); };
    socket.setTimeout(1000, () => done("free"));
    socket.once("connect", () => done("listening"));
    socket.once("error", () => done("free"));
  });
}

async function checkNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 18) report("PASS", "Node 版本", `v${process.versions.node}`);
  else report("FAIL", "Node 版本", `v${process.versions.node} 低于要求`, "请升级到 Node 18 或更高版本");
}

async function checkBuildArtifacts() {
  const required = ["server.js", "bridge.js", "definitions.js", "adapters.js", "task-runtime.js", "selector-cache.js"];
  const missing: string[] = [];
  for (const file of required) if (!(await exists(join(HERE, file)))) missing.push(file);
  if (missing.length === 0) report("PASS", "构建产物", `dist/ 下 ${required.length} 个核心文件齐全`);
  else report("FAIL", "构建产物", `缺少: ${missing.join(", ")}`, "运行 npm run build 重新编译");
}

async function checkDefinitions() {
  const adapters = await loadDefinitions(adapterDefinitionDirs(), validateAdapter);
  const workflows = await loadDefinitions(workflowDefinitionDirs(), validatePresetWorkflow);
  const summary = `适配器 ${adapters.items.length} 条、预置工作流 ${workflows.items.length} 条`;
  const errors = [...adapters.errors, ...workflows.errors];
  if (adapters.items.length === 0) report("FAIL", "站点定义", `内置定义未加载（${BUILTIN_ADAPTER_DIR} 为空或缺失）`, "确认 definitions/ 目录随包分发，或运行 npm run build 后从仓库根重新安装");
  else if (errors.length > 0) report("WARN", "站点定义", `${summary}；${errors.length} 条被跳过`, errors.map(error => `${error.source}: ${error.error}`).join("; "));
  else report("PASS", "站点定义", summary);
}

async function checkBridgePorts() {
  const extensionPort = Number(process.env.WEBPILOT_PORT) || 8765;
  const proxyPort = Number(process.env.WEBPILOT_PROXY_PORT) || extensionPort + 1;
  const extension = await probePort(extensionPort);
  const proxy = await probePort(proxyPort);
  if (extension === "listening") report("INFO", `桥接端口 ${extensionPort}`, "已有进程监听——通常是运行中的 WebPilot Leader；新进程将自动以 Follower 模式接入");
  else report("PASS", `桥接端口 ${extensionPort}`, "空闲，本进程启动时将成为 Leader 并等待扩展连接");
  if (proxy === "listening") report("INFO", `转发端口 ${proxyPort}`, "已有 Leader 在接受 Follower 转发");
  else report("PASS", `转发端口 ${proxyPort}`, "空闲");
}

async function checkEnvironment() {
  const dirVars = ["WEBPILOT_ADAPTER_DIR", "WEBPILOT_WORKFLOW_DEF_DIR", "WEBPILOT_WORKFLOW_DIR", "WEBPILOT_TASK_LOG_DIR", "WEBPILOT_SELECTOR_CACHE_DIR"];
  const set = Object.keys(process.env).filter(key => key.startsWith("WEBPILOT_")).sort();
  if (set.length === 0) { report("PASS", "环境变量", "未设置 WEBPILOT_* 变量，使用全部默认值"); return; }
  report("INFO", "环境变量", `已设置: ${set.join(", ")}`);
  for (const name of dirVars) {
    const value = process.env[name]?.trim();
    if (value && !(await exists(value))) report("WARN", name, `目录不存在: ${value}`, "确认路径拼写，或移除该变量以使用默认位置");
  }
}

const LEVEL_ORDER: Level[] = ["FAIL", "WARN", "INFO", "PASS"];

async function main() {
  console.log("WebPilot doctor — 安装自检\n");
  await checkNodeVersion();
  await checkBuildArtifacts();
  await checkDefinitions();
  await checkBridgePorts();
  await checkEnvironment();
  for (const check of checks) {
    console.log(`[${check.level}] ${check.name}: ${check.detail}`);
    if (check.hint) console.log(`       ↳ ${check.hint}`);
  }
  const counts = Object.fromEntries(LEVEL_ORDER.map(level => [level, checks.filter(check => check.level === level).length]));
  console.log(`\n${counts.PASS} pass, ${counts.INFO} info, ${counts.WARN} warn, ${counts.FAIL} fail`);
  if (counts.FAIL > 0) process.exit(1);
}

main().catch(error => {
  console.error(`doctor 执行失败: ${error.message}`);
  process.exit(1);
});
