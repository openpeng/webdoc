import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { loadDefinitions, workflowDefinitionDirs } from "./definitions.js";

type BrowserCall = (type: string, params: Record<string, unknown>) => Promise<any>;

// 预置工作流 id 前缀：与用户保存的 UUID 工作流区分，且永不写回磁盘。
const PRESET_WORKFLOW_PREFIX = "preset-";
// type 动作文本必须是 {{参数}} 占位符，绝不能包含字面输入或凭据。
const PARAMETER_PLACEHOLDER = /^\{\{[A-Za-z_][A-Za-z0-9_]*\}\}$/;
// navigate 目标只允许 http(s)，阻止外部 JSON 定义导航到 file://、chrome:// 等非 Web scheme。
const NAVIGATE_URL = /^https?:\/\//i;
const WAIT_STATES = new Set(["visible", "hidden", "attached"]);
const VERIFICATION_KINDS = new Set(["url_includes", "url_equals", "title_includes", "text_present", "text_absent", "locator_visible", "locator_hidden", "interactive_count_at_least"]);
type TaskState = "observing" | "verifying" | "completed" | "paused" | "failed" | "cancelled";
type PageSnapshot = { url: string; title: string; readyState: string; elementCount: number; interactiveElements: any[]; fingerprint: string };
type TaskEvent = { at: string; type: string; data: Record<string, unknown> };
type Checkpoint = { id: string; label: string; createdAt: string; page: PageSnapshot };
type PlannedStep = { id: string; objective: string; action: Record<string, any>; verification?: Record<string, unknown> };
type TaskPlan = { name: string; steps: PlannedStep[]; currentStep: number };
type Workflow = { id: string; name: string; goal: string; createdAt: string; plan: TaskPlan; domains: string[] };
type Task = {
  id: string;
  goal: string;
  tabId?: number;
  maxSteps: number;
  state: TaskState;
  stepCount: number;
  lastPage?: PageSnapshot;
  events: TaskEvent[];
  lastActionPageKey?: string;
  repeatedActionCount: number;
  stagnantSteps: number;
  pauseReason?: string;
  checkpoints: Checkpoint[];
  plan?: TaskPlan;
  lastVerificationPassed?: boolean;
};

function pageFingerprint(page: any): string {
  const elementText = (page.interactiveElements || [])
    .map((element: any) => `${element.role || element.tag}|${element.name || ""}|${element.href || ""}`)
    .join("\n");
  return createHash("sha256").update(`${page.url}\n${page.title}\n${page.elementCount}\n${elementText}`).digest("hex").slice(0, 16);
}

function sanitizePage(page: any): PageSnapshot {
  const interactiveElements = (page.interactiveElements || []).map((element: any) => {
    const isField = ["input", "textarea", "select"].includes(element.tag);
    return isField ? { ...element, text: undefined } : element;
  });
  const sanitized = { ...page, interactiveElements };
  return { ...sanitized, fingerprint: pageFingerprint(sanitized) };
}

function safeAction(action: Record<string, any>): Record<string, unknown> {
  const { text, script, ...safe } = action;
  return safe;
}

// 校验并重建一个步骤动作：与适配器一致，只保留各动作的白名单键，不透传未知字段。
function toStepAction(raw: any, where: string): Record<string, any> {
  if (!raw || typeof raw !== "object" || !["navigate", "click", "type", "wait"].includes(raw.action)) throw new Error(`${where}: action must be navigate, click, type, or wait`);
  if (raw.action === "navigate") {
    if (typeof raw.url !== "string") throw new Error(`${where}: navigate requires url`);
    if (!NAVIGATE_URL.test(raw.url) && !PARAMETER_PLACEHOLDER.test(raw.url)) throw new Error(`${where}: navigate url must be http(s) or a {{param}} placeholder`);
    return { action: "navigate", url: raw.url };
  }
  if (typeof raw.selector !== "string" || !raw.selector.trim()) throw new Error(`${where}: ${raw.action} requires a selector`);
  if (raw.action === "type") {
    if (typeof raw.text !== "string") throw new Error(`${where}: type requires text`);
    if (!PARAMETER_PLACEHOLDER.test(raw.text)) throw new Error(`${where}: type text must be a {{param}} placeholder`);
    return { action: "type", selector: raw.selector, text: raw.text };
  }
  if (raw.action === "wait") {
    const safe: Record<string, any> = { action: "wait", selector: raw.selector };
    if (raw.state !== undefined) {
      if (!WAIT_STATES.has(raw.state)) throw new Error(`${where}: wait state must be one of visible|hidden|attached`);
      safe.state = raw.state;
    }
    return safe;
  }
  return { action: "click", selector: raw.selector };
}

// 校验并重建验证断言：kind 必须在白名单内，只保留 value/selector 两个已知字段。
function toVerification(raw: any, where: string): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || typeof raw.kind !== "string" || !VERIFICATION_KINDS.has(raw.kind)) throw new Error(`${where}: verification.kind must be a supported assertion`);
  const safe: Record<string, unknown> = { kind: raw.kind };
  if (raw.value !== undefined) {
    if (typeof raw.value !== "string" && typeof raw.value !== "number") throw new Error(`${where}: verification.value must be a string or number`);
    safe.value = raw.value;
  }
  if (raw.selector !== undefined) {
    if (typeof raw.selector !== "string") throw new Error(`${where}: verification.selector must be a string`);
    safe.selector = raw.selector;
  }
  return safe;
}

// 校验并重建一条预置工作流：外部 JSON 定义必须通过与手写工作流一致的安全门槛。
// id 必须带 preset- 前缀，步骤动作与验证断言都按白名单重建，type 文本必须是 {{参数}} 占位符。
function validatePresetWorkflow(raw: any): Workflow {
  if (!raw || typeof raw !== "object") throw new Error("workflow must be an object");
  if (typeof raw.id !== "string" || !raw.id.startsWith(PRESET_WORKFLOW_PREFIX)) throw new Error(`preset workflow id must start with ${PRESET_WORKFLOW_PREFIX}`);
  const where = `workflow ${raw.id}`;
  if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error(`${where}: requires a name`);
  if (typeof raw.goal !== "string" || !raw.goal.trim()) throw new Error(`${where}: requires a goal`);
  if (!Array.isArray(raw.domains) || !raw.domains.every((domain: any) => typeof domain === "string")) throw new Error(`${where}: domains must be an array of strings`);
  const plan = raw.plan;
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > 50) throw new Error(`${where}: plan requires 1–50 steps`);
  const steps: PlannedStep[] = plan.steps.map((rawStep: any, index: number): PlannedStep => {
    const stepWhere = `${where} step ${index + 1}`;
    const action = toStepAction(rawStep?.action, stepWhere);
    return { id: typeof rawStep.id === "string" ? rawStep.id : `step-${index + 1}`, objective: String(rawStep.objective || action.action), action, verification: toVerification(rawStep.verification, stepWhere) };
  });
  return { id: raw.id, name: raw.name, goal: raw.goal, createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(), plan: { name: String(plan.name || raw.name), steps, currentStep: 0 }, domains: raw.domains };
}

export class TaskRuntime {
  private readonly tasks = new Map<string, Task>();
  private readonly logDir = process.env.WEBPILOT_TASK_LOG_DIR || join(process.cwd(), ".webpilot-task-logs");
  private readonly workflowFile = join(process.env.WEBPILOT_WORKFLOW_DIR || this.logDir, "workflows.json");
  private readonly workflows = new Map<string, Workflow>();
  private workflowsLoaded = false;

  constructor(private readonly browser: BrowserCall) {}

  async start(goal: string, options: { tabId?: number; maxSteps?: number } = {}) {
    if (!goal?.trim()) throw new Error("Task goal is required");
    const task: Task = {
      id: randomUUID(), goal: goal.trim(), tabId: options.tabId,
      maxSteps: Math.max(1, Math.min(Math.floor(options.maxSteps || 30), 100)),
      state: "observing", stepCount: 0, events: [], repeatedActionCount: 0, stagnantSteps: 0, checkpoints: []
    };
    this.tasks.set(task.id, task);
    await this.event(task, "task_started", { goal: task.goal, maxSteps: task.maxSteps, tabId: task.tabId });
    await this.observeInternal(task);
    return this.publicTask(task);
  }

  async observe(taskId: string) {
    const task = this.requireActive(taskId);
    await this.observeInternal(task);
    task.state = "observing";
    return this.publicTask(task);
  }

  async act(taskId: string, action: Record<string, any>) {
    const task = this.requireActive(taskId);
    if (task.stepCount >= task.maxSteps) return this.pause(task, `Maximum step budget (${task.maxSteps}) reached`);
    const actionName = this.actionName(action);
    task.lastVerificationPassed = undefined;
    const before = await this.observeInternal(task);
    const params: Record<string, any> = { ...action, tabId: action.tabId ?? task.tabId };
    let result: any;
    try {
      switch (actionName) {
        case "navigate": result = await this.browser("navigate", params); break;
        case "click": result = await this.browser("click", params); break;
        case "type": result = await this.browser("type", params); break;
        case "wait": result = await this.browser("waitFor", { ...params, state: params.state || "visible" }); break;
        default: throw new Error("Task actions must be one of: navigate, click, type, wait");
      }
    } catch (error: any) {
      const artifact = await this.captureFailure(task, "action", error.message);
      return this.pause(task, `Action ${actionName} failed: ${error.message}`, artifact);
    }
    if (typeof result.tabId === "number") task.tabId = result.tabId;
    task.stepCount += 1;
    await this.event(task, "action", { step: task.stepCount, action: actionName, parameters: safeAction(params), success: result.success !== false });
    const after = await this.observeInternal(task);
    const actionKey = this.actionKey(actionName, params);
    const actionPageKey = `${actionKey}|${after.fingerprint}`;
    task.repeatedActionCount = task.lastActionPageKey === actionPageKey ? task.repeatedActionCount + 1 : 1;
    task.lastActionPageKey = actionPageKey;
    task.stagnantSteps = before.fingerprint === after.fingerprint ? task.stagnantSteps + 1 : 0;
    if (task.repeatedActionCount >= 3) return this.pause(task, "Repeated the same action on an unchanged page three times");
    if (task.stagnantSteps >= 5) return this.pause(task, "Page fingerprint did not change for five steps");
    task.state = "verifying";
    await this.event(task, "action_evidence", { step: task.stepCount, before: before.fingerprint, after: after.fingerprint, pageChanged: before.fingerprint !== after.fingerprint });
    return { ...this.publicTask(task), result, pageChanged: before.fingerprint !== after.fingerprint };
  }

  async verify(taskId: string, assertion: Record<string, unknown>, completeOnPass = false) {
    const task = this.requireActive(taskId);
    const result = await this.browser("verify", { assertion, tabId: task.tabId });
    await this.event(task, "verification", { assertion, pass: result.pass === true, evidence: result.evidence });
    task.lastVerificationPassed = result.pass === true;
    if (result.pass && completeOnPass) task.state = "completed";
    else if (!result.pass) {
      const artifact = await this.captureFailure(task, "verification", "Deterministic assertion did not pass");
      task.state = "observing";
      await this.event(task, "verification_failed", { artifact });
    }
    return { ...this.publicTask(task), verification: result };
  }

  async setPlan(taskId: string, input: { name?: string; steps?: unknown }) {
    const task = this.requireActive(taskId);
    if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > 50) throw new Error("Plan requires 1–50 steps");
    const steps = input.steps.map((raw: any, index): PlannedStep => {
      const action = raw?.action;
      if (!action || !["navigate", "click", "type", "wait"].includes(action.action)) throw new Error(`Plan step ${index + 1} requires a supported action`);
      if (action.action === "navigate" && typeof action.url !== "string") throw new Error(`Plan step ${index + 1} navigate requires url`);
      if (["click", "type", "wait"].includes(action.action) && typeof action.selector !== "string") throw new Error(`Plan step ${index + 1} requires selector`);
      if (action.action === "type" && typeof action.text !== "string") throw new Error(`Plan step ${index + 1} type requires text`);
      return { id: typeof raw.id === "string" ? raw.id : `step-${index + 1}`, objective: String(raw.objective || action.action), action: { ...action }, verification: raw.verification };
    });
    task.plan = { name: String(input.name || task.goal).slice(0, 160), steps, currentStep: 0 };
    await this.event(task, "plan_set", { name: task.plan.name, stepCount: steps.length });
    return this.publicTask(task);
  }

  async runPlannedStep(taskId: string) {
    const task = this.requireActive(taskId);
    const plan = task.plan;
    if (!plan) throw new Error("Task has no plan. Call set_task_plan first.");
    const step = plan.steps[plan.currentStep];
    if (!step) throw new Error("Plan has no remaining steps");
    await this.event(task, "planned_step_started", { stepId: step.id, index: plan.currentStep, objective: step.objective });
    const actionResult = await this.act(taskId, step.action);
    if (task.state === "paused") return { ...actionResult, planStep: step };
    if (!step.verification) return { ...actionResult, planStep: step, needsVerification: true };
    const verification = await this.verify(taskId, step.verification);
    if (!verification.verification.pass) return { ...verification, planStep: step, needsReplan: true };
    return this.advancePlan(taskId);
  }

  async advancePlan(taskId: string) {
    const task = this.requireActive(taskId);
    if (!task.plan) throw new Error("Task has no plan");
    if (task.lastVerificationPassed !== true) throw new Error("The current plan step requires a passing verification before it can advance");
    const completedStep = task.plan.steps[task.plan.currentStep];
    task.plan.currentStep += 1;
    const isComplete = task.plan.currentStep >= task.plan.steps.length;
    task.state = isComplete ? "completed" : "observing";
    await this.event(task, "plan_step_advanced", { stepId: completedStep?.id, nextStep: task.plan.currentStep, completed: isComplete });
    return this.publicTask(task);
  }

  async saveWorkflow(taskId: string, name?: string) {
    const task = this.requireTask(taskId);
    if (task.state !== "completed") throw new Error("Only completed tasks can be saved as reusable workflows");
    if (!task.plan) throw new Error("A task plan is required to save a workflow");
    this.assertWorkflowSafe(task.plan);
    await this.loadWorkflows();
    const workflow: Workflow = {
      id: randomUUID(), name: String(name || task.plan.name).slice(0, 160), goal: task.goal,
      createdAt: new Date().toISOString(), plan: structuredClone(task.plan), domains: this.workflowDomains(task)
    };
    workflow.plan.currentStep = 0;
    this.workflows.set(workflow.id, workflow);
    await this.persistWorkflows();
    await this.event(task, "workflow_saved", { workflowId: workflow.id, name: workflow.name });
    return this.workflowSummary(workflow);
  }

  async listWorkflows() {
    await this.loadWorkflows();
    return [...this.workflows.values()].map(workflow => this.workflowSummary(workflow));
  }

  async recommendWorkflows(url: string) {
    await this.loadWorkflows();
    const host = this.hostname(url);
    if (!host) throw new Error(`Invalid URL: ${url}`);
    return [...this.workflows.values()]
      .filter(workflow => (workflow.domains || []).some(domain => host === domain || host.endsWith(`.${domain}`)))
      .map(workflow => this.workflowSummary(workflow));
  }

  async startWorkflow(workflowId: string, parameters: Record<string, unknown> = {}, options: { tabId?: number; maxSteps?: number } = {}) {
    await this.loadWorkflows();
    const workflow = this.workflows.get(workflowId);
    if (!workflow) throw new Error(`Unknown workflow: ${workflowId}`);
    const task = await this.start(this.applyParameters(workflow.goal, parameters), options);
    await this.setPlan(task.id, this.applyParameters(workflow.plan, parameters));
    return this.get(task.id);
  }

  async checkpoint(taskId: string, label = "checkpoint") {
    const task = this.requireRunnable(taskId);
    const page = await this.observeInternal(task);
    const checkpoint: Checkpoint = { id: randomUUID(), label: label.slice(0, 120), createdAt: new Date().toISOString(), page };
    task.checkpoints.push(checkpoint);
    if (task.checkpoints.length > 10) task.checkpoints.shift();
    await this.event(task, "checkpoint_created", { checkpointId: checkpoint.id, label: checkpoint.label, url: page.url, fingerprint: page.fingerprint });
    return { ...this.publicTask(task), checkpoint };
  }

  async restore(taskId: string, checkpointId: string) {
    const task = this.requireRunnable(taskId);
    const checkpoint = task.checkpoints.find(item => item.id === checkpointId);
    if (!checkpoint) throw new Error(`Unknown checkpoint: ${checkpointId}`);
    const result = await this.browser("navigate", { url: checkpoint.page.url, tabId: task.tabId });
    if (typeof result.tabId === "number") task.tabId = result.tabId;
    const page = await this.observeInternal(task);
    task.state = "observing";
    task.pauseReason = undefined;
    const urlRestored = page.url === checkpoint.page.url;
    await this.event(task, "checkpoint_restored", { checkpointId, urlRestored, expectedFingerprint: checkpoint.page.fingerprint, actualFingerprint: page.fingerprint });
    return { ...this.publicTask(task), checkpoint, urlRestored, fingerprintMatched: page.fingerprint === checkpoint.page.fingerprint };
  }

  async cancel(taskId: string, reason = "Cancelled by caller") {
    const task = this.requireTask(taskId);
    task.state = "cancelled";
    task.pauseReason = reason;
    await this.event(task, "task_cancelled", { reason });
    return this.publicTask(task);
  }

  get(taskId: string) { return this.publicTask(this.requireTask(taskId)); }
  list() { return [...this.tasks.values()].map(task => this.publicTask(task)); }
  log(taskId: string, limit = 50) { return this.requireTask(taskId).events.slice(-Math.max(1, Math.min(limit, 200))); }

  private async observeInternal(task: Task): Promise<PageSnapshot> {
    const page = sanitizePage(await this.browser("getPageInfo", { tabId: task.tabId }));
    task.lastPage = page;
    await this.event(task, "observation", { url: page.url, title: page.title, elementCount: page.elementCount, fingerprint: page.fingerprint });
    return page;
  }

  private actionName(action: Record<string, any>) {
    if (typeof action.action === "string") return action.action;
    if (typeof action.type === "string") return action.type;
    throw new Error("Task action requires an action field");
  }

  private actionKey(name: string, action: Record<string, any>) {
    const identity = name === "navigate" ? action.url : action.selector || action.state || "";
    return `${name}|${String(identity)}`;
  }

  private requireTask(id: string) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return task;
  }

  private requireActive(id: string) {
    const task = this.requireTask(id);
    if (["completed", "paused", "failed", "cancelled"].includes(task.state)) throw new Error(`Task ${id} is ${task.state}: ${task.pauseReason || "no further actions allowed"}`);
    return task;
  }

  private requireRunnable(id: string) {
    const task = this.requireTask(id);
    if (["completed", "cancelled", "failed"].includes(task.state)) throw new Error(`Task ${id} is ${task.state}`);
    return task;
  }

  private async pause(task: Task, reason: string, artifact?: string) {
    task.state = "paused";
    task.pauseReason = reason;
    await this.event(task, "task_paused", { reason, artifact });
    return this.publicTask(task);
  }

  private async captureFailure(task: Task, kind: string, reason: string) {
    try {
      const screenshot = await this.browser("screenshot", { tabId: task.tabId });
      if (!screenshot?.data) return undefined;
      await mkdir(this.logDir, { recursive: true });
      const path = join(this.logDir, `${task.id}-${Date.now()}-${kind}.png`);
      await writeFile(path, Buffer.from(screenshot.data, "base64"));
      await this.event(task, "failure_screenshot", { kind, reason, path });
      return path;
    } catch (error: any) {
      await this.event(task, "failure_screenshot_error", { kind, reason, error: error.message });
      return undefined;
    }
  }

  private async event(task: Task, type: string, data: Record<string, unknown>) {
    const event = { at: new Date().toISOString(), type, data };
    task.events.push(event);
    await mkdir(this.logDir, { recursive: true });
    await appendFile(join(this.logDir, `${task.id}.jsonl`), `${JSON.stringify(event)}\n`, "utf8");
  }

  private async loadWorkflows() {
    if (this.workflowsLoaded) return;
    this.workflowsLoaded = true;
    // 预置工作流以 JSON 数据文件沉淀，运行时加载并只在内存中合并；保存的工作流使用 UUID，不会与 preset- 前缀冲突。
    const { items, errors } = await loadDefinitions(workflowDefinitionDirs(), validatePresetWorkflow);
    for (const preset of items) this.workflows.set(preset.id, preset);
    for (const error of errors) console.error(`[workflows] skipped preset from ${error.source}: ${error.error}`);
    try {
      const workflows = JSON.parse(await readFile(this.workflowFile, "utf8"));
      if (Array.isArray(workflows)) workflows.forEach((workflow: Workflow) => {
        if (workflow?.id && workflow?.plan && !workflow.id.startsWith(PRESET_WORKFLOW_PREFIX)) this.workflows.set(workflow.id, { ...workflow, domains: Array.isArray(workflow.domains) ? workflow.domains : [] });
      });
    } catch (error: any) {
      if (error.code !== "ENOENT") throw new Error(`Could not load workflows: ${error.message}`);
    }
  }

  private async persistWorkflows() {
    await mkdir(dirname(this.workflowFile), { recursive: true });
    const saved = [...this.workflows.values()].filter(workflow => !workflow.id.startsWith(PRESET_WORKFLOW_PREFIX));
    await writeFile(this.workflowFile, JSON.stringify(saved, null, 2), "utf8");
  }

  private assertWorkflowSafe(plan: TaskPlan) {
    for (const step of plan.steps) {
      if (step.action.action === "type" && typeof step.action.text === "string" && !PARAMETER_PLACEHOLDER.test(step.action.text)) {
        throw new Error(`Plan step ${step.id} has literal typed text. Replace it with a parameter such as {{query}} before saving a workflow.`);
      }
    }
  }

  private applyParameters<T>(value: T, parameters: Record<string, unknown>): T {
    if (typeof value === "string") {
      return value.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_match, name) => {
        if (!(name in parameters)) throw new Error(`Missing workflow parameter: ${name}`);
        return String(parameters[name]);
      }) as T;
    }
    if (Array.isArray(value)) return value.map(item => this.applyParameters(item, parameters)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, this.applyParameters(item, parameters)])) as T;
    return value;
  }

  private workflowSummary(workflow: Workflow) {
    return { id: workflow.id, name: workflow.name, goal: workflow.goal, createdAt: workflow.createdAt, stepCount: workflow.plan.steps.length, domains: workflow.domains || [], preset: workflow.id.startsWith(PRESET_WORKFLOW_PREFIX) };
  }

  private workflowDomains(task: Task) {
    const urls = [task.lastPage?.url, ...(task.plan?.steps || []).filter(step => step.action.action === "navigate").map(step => step.action.url)];
    return [...new Set(urls.map(url => typeof url === "string" ? this.hostname(url) : undefined).filter((host): host is string => Boolean(host)))];
  }

  private hostname(url: string) {
    try { return new URL(url).hostname.toLowerCase(); } catch { return undefined; }
  }

  private publicTask(task: Task) {
    return {
      id: task.id, goal: task.goal, tabId: task.tabId, state: task.state, stepCount: task.stepCount,
      maxSteps: task.maxSteps, pauseReason: task.pauseReason, page: task.lastPage,
      checkpoints: task.checkpoints.map(checkpoint => ({ id: checkpoint.id, label: checkpoint.label, createdAt: checkpoint.createdAt, url: checkpoint.page.url, fingerprint: checkpoint.page.fingerprint })),
      plan: task.plan && { name: task.plan.name, currentStep: task.plan.currentStep, stepCount: task.plan.steps.length, nextStep: task.plan.steps[task.plan.currentStep] && { id: task.plan.steps[task.plan.currentStep].id, objective: task.plan.steps[task.plan.currentStep].objective } },
      logEntries: task.events.length
    };
  }
}
