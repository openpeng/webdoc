/** Public tool surface. Routes only: execution and safety remain in the legacy handlers. */
type Schema = Record<string, any>;
export type ToolDefinition = { name: string; description?: string; inputSchema: Schema };
type Route = { target: string; schema: Schema; fixedAction?: string };
export const ADVANCED_TOOLS_ENV = "WEBPILOT_ENABLE_ADVANCED_TOOLS";
export const ADVANCED_TOOL_NAMES = ["cleanup_sessions", "claim_session", "browser_status", "browser_config", "browser_cookie", "browser_task", "task_workflow", "adapter", "webmcp", "ai_search"];

// Validate the JSON Schema vocabulary used below, including nested declared objects.
function validate(schema: Schema, value: any, path = "arguments"): void {
  const fail = (message: string): never => { throw new Error(`INVALID_PARAMS: ${path} ${message}`); };
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((s: Schema) => { try { validate(s, value, path); return true; } catch { return false; } });
    if (matches.length !== 1) fail("must match exactly one action branch");
  }
  if (schema.anyOf && !schema.anyOf.some((s: Schema) => { try { validate(s, value, path); return true; } catch { return false; } })) fail("is missing a required alternative");
  if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(", ")}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t: string) => t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : t === "array" ? Array.isArray(value) : t === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === t)) fail(`must be ${types.join(" or ")}`);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`requires ${key}`);
    for (const [key, entry] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) validate(schema.properties[key], entry, `${path}.${key}`);
      else if (schema.additionalProperties === false) fail(`does not allow ${key}`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((entry, i) => validate(schema.items, entry, `${path}[${i}]`));
}
function strict(schema: Schema): Schema {
  const copy = { ...schema };
  if (copy.properties) {
    copy.properties = Object.fromEntries(Object.entries(copy.properties).map(([key, value]) => [key, strict(value as Schema)]));
    copy.additionalProperties = false;
  }
  if (copy.items) copy.items = strict(copy.items);
  return copy;
}

export function createToolSurface(legacy: ToolDefinition[]) {
  const catalog = new Map<string, ToolDefinition>();
  for (const tool of legacy) if (!catalog.has(tool.name)) catalog.set(tool.name, tool);
  const groups = new Map<string, Map<string, Route>>();
  function add(group: string, action: string, target: string, fields?: string[], required?: string[], fixedAction?: string) {
    const original = catalog.get(target);
    if (!original) throw new Error(`Missing legacy tool: ${target}`);
    const source = original.inputSchema;
    const keys = fields ?? Object.keys(source.properties ?? {}).filter(key => key !== "action");
    const schema = strict({ type: "object", properties: Object.fromEntries(keys.map(key => [key, source.properties[key]])), required: required ?? (source.required ?? []).filter((key: string) => key !== "action") });
    if (["click", "type"].includes(target)) schema.anyOf = [{ required: ["selector"] }, { required: ["intent"] }];
    if (target === "shadow_dom_action" && fixedAction !== "getText") schema.anyOf = [{ required: ["innerSelector"] }, { required: ["selector"] }];
    if (schema.properties.filter) schema.properties.filter = strict({ type: "object", properties: { urlContains: { type: "string" }, mimeType: { type: "string" } } });
    if (["get_api_command", "call_api_command"].includes(target)) schema.anyOf = [{ required: ["commandId"] }, { required: ["name"] }];
    if (!groups.has(group)) groups.set(group, new Map());
    groups.get(group)!.set(action, { target, schema, fixedAction });
  }
  const page: Record<string, string[]> = {
    get_url: [], reload: ["bypassCache"], go_back: [], go_forward: [], full_screenshot: [],
    element_screenshot: ["selector"], upload_file: ["selector", "filePath"], download_file: ["url", "filename"],
    save_pdf: ["filename", "landscape", "printBackground", "scale", "paperWidth", "paperHeight", "marginTop", "marginBottom", "marginLeft", "marginRight", "displayHeaderFooter"], handle_dialog: ["dialogAction"],
  };
  for (const [action, fields] of Object.entries(page)) add("browser_page", action, "browser_page", ["tabId", ...fields], action === "upload_file" ? ["selector", "filePath"] : action === "element_screenshot" ? ["selector"] : action === "download_file" ? ["url"] : action === "handle_dialog" ? ["dialogAction"] : [], action);
  for (const name of ["list_tabs", "navigate", "screenshot"]) add("browser_page", name, name);
  groups.set("api_commands", new Map([["domains", {
    target: "list_api_domains", schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  }]]));
  const mappings: Record<string, Record<string, string>> = {
    browser_read: { info: "get_page_info", inspect: "inspect", text: "get_page_text", table: "extract_table", resources: "get_resources", iframe_text: "extract_iframe_text" },
    browser_act: { click: "click", type: "type", hover: "hover", press_key: "press_key", scroll: "scroll", select_option: "select_option", drag_drop: "drag_drop", wait: "wait_for", wait_dynamic: "wait_for_dynamic", click_at: "click_at" },
    browser_debug: { evaluate: "evaluate", network_start: "start_network_capture", network_stop: "stop_network_capture", network_resources: "get_network_resources", replay: "replay_api_request", console: "get_console_logs", probe_selector: "probe_selector", selector_cache: "get_selector_cache", action_log: "get_action_log" },
    api_commands: { list: "list_api_commands", get: "get_api_command" },
    api_manage: { import: "import_api_commands", export: "export_api_commands", update: "update_api_command", health: "get_api_command_cache" },
  };
  for (const [group, actions] of Object.entries(mappings)) for (const [action, target] of Object.entries(actions)) add(group, action, target);
  add("browser_read", "iframe_query", "iframe_action", undefined, ["selector"], "query");
  add("browser_act", "iframe_click", "iframe_action", undefined, ["selector"], "click");
  for (const [group, action] of [["browser_read", "query"], ["browser_read", "getText"], ["browser_act", "click"], ["browser_act", "type"]]) {
    add(group, action === "getText" ? "shadow_text" : `shadow_${action}`, "shadow_dom_action", action === "type" ? undefined : ["tabId", "hostSelector", "innerSelector", "selector"], action === "type" ? ["text"] : [], action);
  }
  const analysisCommon = ["domain", "tabId"];
  const analyze = ["analysisId", "includeStaticAssets", "maxEndpoints", "mode", "overwriteManual", "provenance"];
  add("api_discover", "start", "analyze_page_apis", [...analysisCommon, "filter", "captureResponseBody"], [], "start");
  for (const action of ["stop_and_analyze", "analyze_current"]) add("api_discover", action, "analyze_page_apis", [...analysisCommon, ...analyze], [], action);
  const scanFields = Object.keys(catalog.get("analyze_page_apis")!.inputSchema.properties).filter(key => !["action", "analysisId", "filter", "captureResponseBody", "includeStaticAssets"].includes(key));
  add("api_discover", "scan_site", "analyze_page_apis", scanFields, [], "scan_site");
  for (const action of ["disable", "delete", "clear_domain"]) add("api_manage", action, "invalidate_api_commands", action === "clear_domain" ? ["domain", "tabId"] : undefined, action === "clear_domain" ? [] : ["commandId"], action);
  const callSchema = strict(catalog.get("call_api_command")!.inputSchema);
  callSchema.anyOf = [{ required: ["commandId"] }, { required: ["name"] }];
  const descriptions: Record<string, string> = {
    browser_page: "页面导航、标签列表、截图、上传下载、PDF 与弹窗。",
    browser_read: "读取页面结构、正文、表格与资源，支持 iframe 和 Shadow DOM。text 支持 Markdown/直接 HTML；iframe_text 可跨域降级。",
    browser_act: "页面交互与等待。click/type 需 selector 或 intent；shadow 操作需 innerSelector 或 selector。",
    browser_debug: "执行脚本、网络捕获与重放、控制台及定位诊断。evaluate 为本地全权限 JavaScript，可使用 fetch/document.cookie/window.open；replay 复用已捕获请求。",
    api_discover: "发现页面 API 并保存域名命令集。start → 操作页面 → stop_and_analyze；analyze_current 分析现有抓包；scan_site 解析 JS/HAR/SAZ/OpenAPI/命令包。远端源默认同源且拒绝私网；跨域/私网须显式开关。静态推导需复核。",
    api_commands: "domains 纯本地列出有缓存命令的域名及总数（包含禁用命令，不代表实测通过），无需 domain/tabId/浏览器；list 查看域名能力；get 查看完整接口定义，需 commandId 或 name。",
    api_manage: "导入导出、人工更新、禁用删除及缓存健康度。disable/delete 需 commandId；clear_domain 清除整个域名缓存。",
  };
  const order = ["browser_page", "browser_read", "browser_act", "browser_debug", "api_discover", "api_commands", "api_call"];
  const tools = order.map(name => {
    if (name === "api_call") return { ...catalog.get("call_api_command")!, name, inputSchema: callSchema };
    const routes = groups.get(name)!;
    return { name, description: `${descriptions[name]} actions: ${[...routes.keys()].join(" / ")}.`, inputSchema: {
      type: "object", oneOf: [...routes].map(([action, route]) => ({ ...route.schema, properties: { action: { type: "string", enum: [action] }, ...route.schema.properties }, required: ["action", ...route.schema.required] })),
    } };
  });
  return {
    list(advanced = process.env[ADVANCED_TOOLS_ENV] === "1"): ToolDefinition[] {
      return advanced ? [...tools, ...ADVANCED_TOOL_NAMES.map(name => catalog.get(name)!)] : tools;
    },
    resolve(name: string, args: Record<string, any>): { name: string; args: Record<string, any> } {
      if (name === "api_call") { validate(callSchema, args); return { name: "call_api_command", args }; }
      const routes = groups.get(name);
      if (!routes) return { name, args }; // Keep all legacy call names, including unlisted aliases.
      const route = routes.get(args.action);
      if (!route) throw new Error(`INVALID_PARAMS: unknown ${name} action: ${String(args.action)}`);
      const { action: _, ...payload } = args;
      validate(route.schema, payload);
      return { name: route.target, args: route.fixedAction === undefined ? payload : { ...payload, action: route.fixedAction } };
    },
  };
}
