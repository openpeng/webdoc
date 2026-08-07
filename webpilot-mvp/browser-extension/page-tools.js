// Injected in the extension's isolated world.  Keep this dependency-free: it
// runs on arbitrary pages, including pages with restrictive CSP rules.
(() => {
  // This file is injected before every command. Keep a single instance per
  // document so stable references returned by inspect() remain reusable until
  // the page navigates or replaces the target node.
  if (globalThis.__webpilot) return;

  const INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input', 'textarea', 'select', 'summary',
    '[role="button"]', '[role="link"]', '[role="textbox"]', '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  const stableElements = new Map();
  let nextStableElementId = 1;

  const normalise = value => (value || '').replace(/\s+/g, ' ').trim();
  const visible = element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const implicitRole = element => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset'].includes(element.type))) return 'button';
    if (tag === 'textarea' || (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(element.type))) return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'input' && element.type === 'checkbox') return 'checkbox';
    if (tag === 'input' && element.type === 'radio') return 'radio';
    return '';
  };
  const name = element => normalise(
    element.getAttribute('aria-label') ||
    element.labels?.[0]?.innerText ||
    element.getAttribute('title') ||
    element.getAttribute('placeholder') ||
    element.innerText ||
    element.value
  );
  const elements = () => Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter(visible);
  const isSemanticInteractive = element => element.matches(INTERACTIVE_SELECTOR);
  const isPotentiallyClickable = element => {
    if (!visible(element)) return false;
    if (isSemanticInteractive(element)) return true;
    const style = getComputedStyle(element);
    return style.cursor === 'pointer'
      || element.hasAttribute('onclick')
      || element.hasAttribute('data-testid')
      || element.hasAttribute('data-test')
      || element.hasAttribute('data-action');
  };
  const remember = element => {
    for (const [id, known] of stableElements) {
      if (!known.isConnected) stableElements.delete(id);
      else if (known === element) return `@wp${id}`;
    }
    const id = nextStableElementId++;
    stableElements.set(id, element);
    return `@wp${id}`;
  };
  const classHint = element => Array.from(element.classList || [])
    .filter(value => /^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/.test(value))
    .slice(0, 4)
    .join(' ');
  const describe = (element, index) => {
    const rect = element.getBoundingClientRect();
    return {
      ref: index === undefined ? undefined : `@e${index}`,
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || implicitRole(element),
      name: name(element).slice(0, 120),
      text: normalise(element.innerText || element.value).slice(0, 120),
      placeholder: element.getAttribute('placeholder') || undefined,
      id: element.id || undefined,
      type: element.getAttribute('type') || undefined,
      href: element.href?.slice(0, 200),
      src: element.tagName?.toLowerCase() === 'img' ? (element.currentSrc || element.src || '')?.slice(0, 500) || undefined : undefined,
      testId: element.getAttribute('data-testid') || element.getAttribute('data-test') || undefined,
      classHint: classHint(element) || undefined,
      clickable: isPotentiallyClickable(element),
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
      box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
  };
  const fail = (message, selector, candidates = []) => ({ error: message, selector, candidates: candidates.slice(0, 8).map((el, index) => describe(el, index)) });
  const resolve = selector => {
    if (typeof selector !== 'string' || !selector.trim()) return fail('A non-empty selector is required', selector);
    const value = selector.trim();
    const current = elements();
    const stableRef = /^@wp(\d+)$/.exec(value);
    if (stableRef) {
      const element = stableElements.get(Number(stableRef[1]));
      return element?.isConnected ? { element, strategy: 'stable-ref', index: current.indexOf(element) }
        : fail(`Stable reference ${value} is stale or unavailable`, value, current);
    }
    const ref = /^@e(\d+)$/.exec(value);
    if (ref) {
      const element = current[Number(ref[1])];
      return element ? { element, strategy: 'snapshot-ref', index: Number(ref[1]) } : fail(`Snapshot reference ${value} is stale or unavailable`, value, current);
    }
    if (value.startsWith('text=')) {
      const expected = normalise(value.slice(5)).toLowerCase();
      const matches = current.filter(el => name(el).toLowerCase() === expected || normalise(el.innerText).toLowerCase() === expected);
      if (matches.length === 1) return { element: matches[0], strategy: 'text', index: current.indexOf(matches[0]) };
      return fail(matches.length ? `Text locator matched ${matches.length} elements; make it more specific` : `No visible interactive element has text "${value.slice(5)}"`, value, matches);
    }
    const role = /^role=([^\[]+)(?:\[name=["'](.+)["']\])?$/.exec(value);
    if (role) {
      const expectedRole = role[1].trim().toLowerCase();
      const expectedName = role[2] && normalise(role[2]).toLowerCase();
      const matches = current.filter(el => (el.getAttribute('role') || implicitRole(el)).toLowerCase() === expectedRole && (!expectedName || name(el).toLowerCase() === expectedName));
      if (matches.length === 1) return { element: matches[0], strategy: 'role', index: current.indexOf(matches[0]) };
      return fail(matches.length ? `Role locator matched ${matches.length} elements; add [name="…"]` : `No visible element matched ${value}`, value, matches);
    }
    try {
      const element = document.querySelector(value);
      return element ? { element, strategy: 'css', index: current.indexOf(element) } : fail(`No element matched CSS selector: ${value}`, value, current);
    } catch (error) {
      return fail(`Invalid CSS selector: ${error.message}`, value);
    }
  };
  // 为选择器缓存派生可跨会话复用的定位符：每个候选都用 resolve() 复验，
  // 必须唯一命中同一元素才采用；@eN/@wpN 不可序列化，永不作为结果。
  const durableLocator = element => {
    const candidates = [];
    if (element.id && /^[A-Za-z][\w-]*$/.test(element.id)) candidates.push(`#${CSS.escape(element.id)}`);
    for (const attr of ['data-testid', 'data-test']) {
      const value = element.getAttribute(attr);
      if (value && !/["\\]/.test(value)) candidates.push(`[${attr}="${value}"]`);
    }
    const label = name(element);
    if (label && label.length <= 80 && !/["']/.test(label)) {
      const role = element.getAttribute('role') || implicitRole(element);
      if (role) candidates.push(`role=${role}[name="${label}"]`);
      candidates.push(`text=${label}`);
    }
    const hint = classHint(element);
    if (hint) candidates.push(`${element.tagName.toLowerCase()}.${hint.split(' ').join('.')}`);
    for (const candidate of candidates) {
      // CSS 候选额外要求全文档唯一；text=/role= 的唯一性由 resolve 自身保证。
      if (!candidate.startsWith('text=') && !candidate.startsWith('role=')) {
        try { if (document.querySelectorAll(candidate).length !== 1) continue; } catch { continue; }
      }
      if (resolve(candidate).element === element) return candidate;
    }
    return undefined;
  };
  const focusedScope = () => {
    let focus = document.activeElement;
    if (!focus || focus === document.body || focus === document.documentElement) {
      focus = document.querySelector('textarea:focus, input:focus, [contenteditable="true"]:focus')
        || document.querySelector('textarea, input:not([type="hidden"]), [contenteditable="true"]');
    }
    if (!focus || !visible(focus)) return document.body;
    let root = focus;
    for (let depth = 0; depth < 4 && root.parentElement; depth += 1) {
      const parent = root.parentElement;
      if (!visible(parent)) break;
      const rect = parent.getBoundingClientRect();
      if (rect.width < 180 || rect.height < 48 || rect.height > innerHeight * 0.75) break;
      root = parent;
    }
    return root;
  };
  const inspect = (options = {}) => {
    const scope = options.scope === 'focused' || options.scope === 'composer' ? focusedScope() : document.body;
    const maxCandidates = Math.max(1, Math.min(Number(options.maxCandidates) || 30, 100));
    const includeUnnamed = options.includeUnnamed !== false;
    const clickableOnly = options.clickableOnly !== false;
    const candidates = [];
    const seen = new Set();
    const add = element => {
      if (!element || seen.has(element) || !visible(element)) return;
      if (clickableOnly && !isPotentiallyClickable(element)) return;
      if (!includeUnnamed && !name(element)) return;
      seen.add(element);
      const candidate = describe(element, elements().indexOf(element));
      candidate.ref = remember(element);
      candidates.push(candidate);
    };
    scope.querySelectorAll(INTERACTIVE_SELECTOR).forEach(add);
    // Modern apps often put a click listener on a plain div around an SVG.
    // Limit this broad scan to the requested scope and a bounded result set.
    for (const element of scope.querySelectorAll('*')) {
      if (candidates.length >= maxCandidates) break;
      add(element);
    }
    const rect = scope.getBoundingClientRect();
    return {
      url: location.href,
      title: document.title,
      scope: options.scope || 'page',
      scopeBox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      candidates: candidates.slice(0, maxCandidates),
      page: snapshot()
    };
  };
  const probe = selector => {
    const startedAt = performance.now();
    const resolved = resolve(selector);
    return {
      selector,
      matched: Boolean(resolved.element),
      strategy: resolved.strategy,
      durationMs: Math.round(performance.now() - startedAt),
      element: resolved.element ? { ...describe(resolved.element, resolved.index), ref: remember(resolved.element) } : undefined,
      error: resolved.error,
      candidates: resolved.candidates
    };
  };
  const nearestActionable = element => {
    let current = element;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      if (isPotentiallyClickable(current)) return current;
    }
    return null;
  };
  const page = (limit = 60) => {
    const current = elements();
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
      elementCount: current.length,
      interactiveElements: current.slice(0, limit).map((el, index) => describe(el, index))
    };
  };
  // —— 树形页面表示：把交互元素按语义容器（landmark/dialog/list 行等）分组 ——
  // 只收录“能帮 Agent 消歧义”的容器，不是完整 aria 树；元素集合与平铺 page() 一致，
  // 因此 @eN 索引在两种形态间可互换。
  const CONTAINER_ROLES = new Set(['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'dialog', 'alertdialog', 'form', 'list', 'listitem', 'row', 'table', 'grid', 'tablist', 'menu', 'region', 'article']);
  const containerRole = element => {
    const explicit = element.getAttribute?.('role');
    if (explicit && CONTAINER_ROLES.has(explicit)) return explicit;
    const tag = element.tagName?.toLowerCase();
    return {
      main: 'main', nav: 'navigation', header: 'banner', footer: 'contentinfo', aside: 'complementary',
      dialog: 'dialog', form: 'form', ul: 'list', ol: 'list', li: 'listitem', tr: 'row', table: 'table',
      article: 'article', fieldset: 'form', section: element.getAttribute?.('aria-label') ? 'region' : ''
    }[tag] || '';
  };
  const containerLabel = element => normalise(
    element.getAttribute?.('aria-label') ||
    element.querySelector?.(':scope > legend, :scope > summary, :scope h1, :scope h2, :scope h3')?.innerText ||
    (['listitem', 'row'].includes(containerRole(element)) ? element.innerText : '')
  ).slice(0, 60);
  const containerPath = element => {
    const path = [];
    let current = element.parentElement;
    while (current && current !== document.body && path.length < 4) {
      const role = containerRole(current);
      if (role) path.unshift(current);
      current = current.parentElement;
    }
    return path;
  };
  const pageTree = (limit = 60) => {
    const current = elements();
    const root = { role: 'page', label: '', children: [], elements: [] };
    const nodeFor = new Map(); // 容器 DOM 节点 -> 树节点，同一容器只建一次
    current.slice(0, limit).forEach((el, index) => {
      let parent = root;
      for (const container of containerPath(el)) {
        let node = nodeFor.get(container);
        if (!node) {
          node = { role: containerRole(container), label: containerLabel(container), children: [], elements: [] };
          nodeFor.set(container, node);
          parent.children.push(node);
        }
        parent = node;
      }
      parent.elements.push(describe(el, index));
    });
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      elementCount: current.length,
      tree: root
    };
  };
  const snapshot = () => ({ url: location.href, title: document.title, readyState: document.readyState, timestamp: new Date().toISOString() });
  const readText = (maxChars = 50_000) => {
    const limit = Math.max(1_000, Math.min(Number(maxChars) || 50_000, 200_000));
    const root = document.querySelector('#main-content, .wiki-content, [role="main"], article') || document.body;
    const fullText = (root?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    return {
      url: location.href,
      title: document.title,
      text: fullText.slice(0, limit),
      characterCount: fullText.length,
      truncated: fullText.length > limit
    };
  };
  const verify = assertion => {
    const kind = assertion?.kind;
    const expected = assertion?.value;
    let pass = false;
    let actual;
    if (kind === 'url_includes') {
      actual = location.href;
      pass = typeof expected === 'string' && actual.includes(expected);
    } else if (kind === 'url_equals') {
      actual = location.href;
      pass = actual === expected;
    } else if (kind === 'title_includes') {
      actual = document.title;
      pass = typeof expected === 'string' && actual.includes(expected);
    } else if (kind === 'text_present') {
      actual = normalise(document.body?.innerText).slice(0, 2000);
      pass = typeof expected === 'string' && actual.includes(expected);
    } else if (kind === 'text_absent') {
      actual = normalise(document.body?.innerText).slice(0, 2000);
      pass = typeof expected === 'string' && !actual.includes(expected);
    } else if (kind === 'locator_visible' || kind === 'locator_hidden') {
      const resolved = resolve(assertion?.selector);
      actual = resolved.element ? describe(resolved.element, resolved.index) : resolved.error;
      pass = kind === 'locator_visible' ? Boolean(resolved.element && visible(resolved.element)) : !resolved.element || !visible(resolved.element);
    } else if (kind === 'interactive_count_at_least') {
      actual = elements().length;
      pass = Number.isFinite(expected) && actual >= expected;
    } else {
      return { pass: false, error: `Unsupported assertion kind: ${kind}`, evidence: { page: page(12) } };
    }
    return { pass, assertion: { kind, value: expected, selector: assertion?.selector }, evidence: { actual, page: snapshot() } };
  };
  const extract = spec => {
    const read = (root, field) => {
      const selector = field?.selector;
      if (typeof selector !== 'string') return null;
      let matches;
      try { matches = selector === '$self' ? [root] : Array.from(root.querySelectorAll(selector)); }
      catch (error) { throw new Error(`Invalid adapter selector "${selector}": ${error.message}`); }
      const value = element => {
        if (!element) return null;
        if (field.attribute === 'href') return element.href || element.getAttribute('href');
        if (field.attribute === 'content') return element.getAttribute('content');
        if (field.computed) {
          try {
            const fn = new Function('el', `return (${field.computed});`);
            return String(fn(element) ?? '').slice(0, 500);
          } catch (e) { return null; }
        }
        if (field.attribute) return element.getAttribute(field.attribute);
        return normalise(element.innerText || element.textContent).slice(0, 500);
      };
      if (field.multiple) return matches.slice(0, Math.max(1, Math.min(field.limit || 20, 100))).map(value).filter(Boolean);
      return value(matches[0]);
    };
    const data = {};
    for (const [name, field] of Object.entries(spec?.fields || {})) data[name] = read(document, field);
    if (spec?.list) {
      let roots;
      try { roots = Array.from(document.querySelectorAll(spec.list.selector)); }
      catch (error) { throw new Error(`Invalid adapter list selector "${spec.list.selector}": ${error.message}`); }
      data.items = roots.slice(0, Math.max(1, Math.min(spec.list.limit || 20, 100))).map(root => {
        const item = {};
        for (const [name, field] of Object.entries(spec.list.fields || {})) item[name] = read(root, field);
        return item;
      });
    }
    if (spec?.table) {
      const tableSpec = spec.table;
      try {
        const tableEl = tableSpec.selector ? document.querySelector(tableSpec.selector) : document.querySelector('table');
        if (!tableEl) {
          data.table = { headers: [], rows: [], error: `No table found for selector: ${tableSpec.selector || 'table'}` };
        } else {
          const headerSelector = tableSpec.header || 'thead th, tr:first-child th';
          const rowSelector = tableSpec.rows || 'tbody tr';
          const cellSelector = tableSpec.cells || 'td';
          const limit = Math.max(1, Math.min(tableSpec.limit || 100, 500));
          const headers = Array.from(tableEl.querySelectorAll(headerSelector)).map(th => normalise(th.innerText || th.textContent));
          const rows = Array.from(tableEl.querySelectorAll(rowSelector)).slice(0, limit).map(tr =>
            Array.from(tr.querySelectorAll(cellSelector)).map(td => normalise(td.innerText || td.textContent))
          );
          data.table = { headers, rows, rowCount: rows.length, columnCount: headers.length || (rows[0]?.length || 0) };
        }
      } catch (error) { throw new Error(`Invalid table selector: ${error.message}`); }
    }
    return { url: location.href, title: document.title, extractedAt: new Date().toISOString(), data };
  };

  // ---- 方案 2: 受控 evaluate ----
  const FORBIDDEN_PATTERNS = [
    /\beval\s*\(/,
    /\bFunction\s*\(/,
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bnavigator\s*\.\s*sendBeacon\b/,
    /\bdocument\s*\.\s*cookie\b/,
    /\bwindow\s*\.\s*open\b/,
    /\blocation\s*\.\s*(assign|replace)\b/,
    /\bimport\s*\(/,
  ];

  const safeEvaluate = (expression, options = {}) => {
    if (typeof expression !== 'string' || !expression.trim()) {
      return { error: 'A non-empty expression is required' };
    }
    if (expression.length > 2000) {
      return { error: `Expression too long (${expression.length} chars, max 2000)` };
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(expression)) {
        return { error: `Expression contains forbidden pattern: ${pattern.source}` };
      }
    }
    const allowedGlobals = options.globals || [];
    const sandbox = {};
    for (const g of allowedGlobals) {
      if (g in globalThis) {
        try { sandbox[g] = globalThis[g]; } catch { /* some globals throw on access */ }
      }
    }
    sandbox.document = document;
    sandbox.location = { href: location.href, hostname: location.hostname, pathname: location.pathname, title: document.title };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const argNames = Object.keys(sandbox);
    const argValues = Object.values(sandbox);
    try {
      const fn = new Function(...argNames, `"use strict"; return (${expression});`);
      const timeoutMs = Math.max(100, Math.min(Number(options.timeoutMs) || 3000, 10000));
      const result = fn.apply(null, argValues);
      const safe = value => {
        if (value === null || value === undefined) return value;
        const t = typeof value;
        if (t === 'string' || t === 'number' || t === 'boolean') return value;
        if (t === 'function') return `[Function: ${value.name || 'anonymous'}]`;
        if (Array.isArray(value)) return value.slice(0, 100).map(safe);
        if (t === 'object') {
          if (value instanceof Element) {
            const rect = value.getBoundingClientRect();
            return { tagName: value.tagName.toLowerCase(), text: normalise(value.innerText || '').slice(0, 200), id: value.id || undefined, className: value.className || undefined, box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
          }
          try { return JSON.parse(JSON.stringify(value, (k, v) => typeof v === 'function' ? `[Function]` : v)); }
          catch { return String(value).slice(0, 500); }
        }
        return String(value).slice(0, 500);
      };
      const safeResult = safe(result);
      return { result: safeResult, type: t === 'object' ? (Array.isArray(result) ? 'array' : 'object') : t, url: location.href, title: document.title };
    } catch (e) {
      return { error: `Evaluation failed: ${e.message}`, expression: expression.slice(0, 200) };
    }
  };

  const getResourceList = (options = {}) => {
    const entries = performance.getEntriesByType('resource');
    const resources = entries
      .filter(entry => {
        if (options.type === 'image') {
          const isImage = entry.initiatorType === 'img' ||
                          /\.(jpg|jpeg|png|gif|webp|svg|avif|bmp|ico)(\?|#|$)/i.test(entry.name);
          if (!isImage) return false;
        }
        if (typeof options.minSize === 'number' && (entry.transferSize || 0) < options.minSize) return false;
        if (options.urlContains && !entry.name.includes(options.urlContains)) return false;
        if (typeof options.since === 'number' && entry.startTime < options.since) return false;
        return true;
      })
      .map(entry => ({
        url: entry.name,
        initiatorType: entry.initiatorType,
        transferSize: entry.transferSize || 0,
        decodedBodySize: entry.decodedBodySize || 0,
        duration: Math.round(entry.duration),
        startTime: Math.round(entry.startTime),
        responseEnd: Math.round(entry.responseEnd)
      }))
      .sort((a, b) => b.responseEnd - a.responseEnd);
    return { resources, count: resources.length, url: location.href, title: document.title };
  };

  // ===== 鼠标悬停 =====
  const hover = selector => {
    const resolved = resolve(selector);
    if (!resolved.element) return resolved.error || { error: 'Element not found' };
    const el = resolved.element;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    el.dispatchEvent(new MouseEvent('mousemove', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mousemove', opts));
    return { success: true, tagName: el.tagName, text: name(el), diagnostics: { locator: selector, strategy: resolved.strategy, element: describe(el, resolved.index) } };
  };

  // ===== 特殊键/键盘按键 =====
  const KEY_MAP = {
    enter: 'Enter', escape: 'Escape', escape2: 'Esc',
    tab: 'Tab', space: ' ', arrowup: 'ArrowUp', arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
    backspace: 'Backspace', delete: 'Delete',
  };
  const pressKey = (selector, key) => {
    const resolved = resolve(selector);
    const el = resolved.element || document.activeElement || document.body;
    const normalized = (key || '').toLowerCase().replace(/^key/, '');
    const keyValue = KEY_MAP[normalized] || (normalized.length === 1 ? normalized.toUpperCase() : normalized);
    const keyboardOpts = { key: keyValue, code: keyValue, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', keyboardOpts));
    el.dispatchEvent(new KeyboardEvent('keypress', keyboardOpts));
    el.dispatchEvent(new KeyboardEvent('keyup', keyboardOpts));
    if (keyValue === 'Enter' && el.tagName === 'TEXTAREA') {
      // For textarea, Enter inserts a newline; for form, submit
    } else if (keyValue === 'Enter' && el.form) {
      el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
    return { success: true, key: keyValue, tagName: el.tagName, diagnostics: { locator: selector, strategy: resolved.strategy, element: el === document.body ? null : describe(el) } };
  };

  // ===== 滚动 =====
  const scroll = options => {
    const target = options?.selector ? resolve(options.selector) : null;
    if (options?.selector && target?.element) {
      target.element.scrollIntoView({ block: options.block || 'center', inline: options.inline || 'center', behavior: options.smooth ? 'smooth' : 'auto' });
      return { success: true, mode: 'intoView', element: describe(target.element) };
    }
    if (options?.direction) {
      const dx = options.direction === 'right' ? (options.amount || 300) : options.direction === 'left' ? -(options.amount || 300) : 0;
      const dy = options.direction === 'down' ? (options.amount || 300) : options.direction === 'up' ? -(options.amount || 300) : 0;
      window.scrollBy({ left: dx, top: dy, behavior: options.smooth ? 'smooth' : 'auto' });
      return { success: true, mode: 'by', direction: options.direction, amount: options.amount || 300 };
    }
    const x = typeof options?.x === 'number' ? options.x : window.scrollX;
    const y = typeof options?.y === 'number' ? options.y : window.scrollY;
    window.scrollTo({ left: x, top: y, behavior: options?.smooth ? 'smooth' : 'auto' });
    return { success: true, mode: 'to', x, y };
  };

  // ===== 下拉选择框 =====
  const selectOption = (selector, value, options = {}) => {
    const resolved = resolve(selector);
    if (!resolved.element) return { error: resolved.error || 'Element not found' };
    const el = resolved.element;
    if (el.tagName.toLowerCase() !== 'select') return { error: `Element is ${el.tagName}, not a <select>`, diagnostics: { element: describe(el, resolved.index) } };
    let matched = false;
    if (options.byLabel) {
      for (const opt of el.options) {
        if (normalise(opt.textContent) === value || opt.textContent.includes(value)) { opt.selected = true; matched = true; break; }
      }
    } else if (options.byText) {
      for (const opt of el.options) {
        if (normalise(opt.textContent) === value) { opt.selected = true; matched = true; break; }
      }
    } else {
      el.value = value;
      matched = el.value === value;
    }
    if (!matched && options.fuzzy) {
      for (const opt of el.options) {
        if (normalise(opt.textContent).includes(value) || normalise(opt.value).includes(value)) { opt.selected = true; matched = true; break; }
      }
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      success: matched,
      value: el.value,
      selectedText: el.options[el.selectedIndex]?.textContent?.trim() || '',
      selectedIndex: el.selectedIndex,
      optionCount: el.options.length,
      diagnostics: { locator: selector, strategy: resolved.strategy, element: describe(el, resolved.index) }
    };
  };

  // ===== 拖拽 =====
  const dragDrop = (fromSelector, toSelector) => {
    const fromResolved = resolve(fromSelector);
    const toResolved = resolve(toSelector);
    if (!fromResolved.element) return { error: `Source element not found: ${fromResolved.error || ''}` };
    if (!toResolved.element) return { error: `Target element not found: ${toResolved.error || ''}` };
    const fromEl = fromResolved.element;
    const toEl = toResolved.element;
    fromEl.scrollIntoView({ block: 'center' });
    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();
    const fromX = fromRect.x + fromRect.width / 2;
    const fromY = fromRect.y + fromRect.height / 2;
    const toX = toRect.x + toRect.width / 2;
    const toY = toRect.y + toRect.height / 2;
    const opts = (x, y) => ({ bubbles: true, cancelable: true, view: window, clientX: x, clientY: y });
    // HTML5 drag events
    const dataTransfer = new DataTransfer();
    fromEl.dispatchEvent(new DragEvent('dragstart', { ...opts(fromX, fromY), dataTransfer }));
    fromEl.dispatchEvent(new DragEvent('drag', { ...opts(fromX, fromY), dataTransfer }));
    toEl.dispatchEvent(new DragEvent('dragenter', { ...opts(toX, toY), dataTransfer }));
    toEl.dispatchEvent(new DragEvent('dragover', { ...opts(toX, toY), dataTransfer }));
    toEl.dispatchEvent(new DragEvent('drop', { ...opts(toX, toY), dataTransfer }));
    fromEl.dispatchEvent(new DragEvent('dragend', { ...opts(toX, toY), dataTransfer }));
    // Also fire mouse events for libraries that use mouse-based dragging
    fromEl.dispatchEvent(new MouseEvent('mousedown', opts(fromX, fromY)));
    document.dispatchEvent(new MouseEvent('mousemove', opts((fromX + toX) / 2, (fromY + toY) / 2)));
    toEl.dispatchEvent(new MouseEvent('mouseup', opts(toX, toY)));
    return {
      success: true,
      from: describe(fromEl, fromResolved.index),
      to: describe(toEl, toResolved.index),
      diagnostics: { fromX: Math.round(fromX), fromY: Math.round(fromY), toX: Math.round(toX), toY: Math.round(toY) }
    };
  };

  // ===== SPA 动态内容等待 (MutationObserver) =====
  const waitForDynamic = options => {
    return new Promise(resolvePromise => {
      const timeoutMs = Math.min(options?.timeoutMs || 10000, 30000);
      const startedAt = performance.now();
      const selector = options?.selector;
      const textPattern = options?.textContains;
      const elementCount = options?.minElementCount;
      const settled = result => resolvePromise({ ...result, durationMs: Math.round(performance.now() - startedAt) });

      // Check initial state
      const check = () => {
        if (selector) {
          const el = document.querySelector(selector);
          if (el && visible(el)) return { success: true, reason: 'selector_visible', element: describe(el) };
        }
        if (textPattern) {
          const bodyText = document.body?.innerText || '';
          if (bodyText.includes(textPattern)) return { success: true, reason: 'text_found', match: textPattern };
        }
        if (elementCount) {
          const count = document.querySelectorAll(INTERACTIVE_SELECTOR).length;
          if (count >= elementCount) return { success: true, reason: 'element_count', count };
        }
        if (options?.networkIdle && performance.now() - lastActivity > 800) {
          return { success: true, reason: 'network_idle', idleMs: Math.round(performance.now() - lastActivity) };
        }
        return null;
      };
      let lastActivity = performance.now();

      const initial = check();
      if (initial) return settled(initial);

      const observer = new MutationObserver(() => {
        lastActivity = performance.now();
        const result = check();
        if (result) { observer.disconnect(); settled(result); }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });

      setTimeout(() => { observer.disconnect(); settled({ success: false, error: `Timed out after ${timeoutMs}ms`, diagnostics: { selector, textPattern, elementCount, page: snapshot() } }); }, timeoutMs);
    });
  };

  // ===== iframe 内容操作 =====
  const iframeAction = (options = {}) => {
    const frames = Array.from(document.querySelectorAll('iframe')).filter(f => {
      try { return f.contentDocument; } catch { return false; }
    });
    if (!frames.length) return { error: 'No same-origin iframe found on page', iframeCount: document.querySelectorAll('iframe').length };
    let targetFrame = null;
    if (options.iframeSelector) {
      targetFrame = frames.find(f => f.matches(options.iframeSelector));
    } else if (options.iframeIndex !== undefined) {
      targetFrame = frames[options.iframeIndex];
    } else {
      targetFrame = frames[0];
    }
    if (!targetFrame) return { error: 'Specified iframe not found or cross-origin', iframeCount: frames.length };
    const iframeDoc = targetFrame.contentDocument;
    if (options.action === 'getText') {
      const text = (iframeDoc.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 50000);
      return { success: true, action: 'getText', iframeSrc: targetFrame.src, text, characterCount: text.length };
    }
    if (options.action === 'query') {
      const elements = Array.from(iframeDoc.querySelectorAll(options.selector || INTERACTIVE_SELECTOR)).filter(visible);
      return { success: true, action: 'query', iframeSrc: targetFrame.src, count: elements.length, elements: elements.slice(0, 30).map((el, i) => describe(el, i)) };
    }
    if (options.action === 'click') {
      const el = options.selector ? iframeDoc.querySelector(options.selector) : null;
      if (!el) return { error: `Element not found in iframe: ${options.selector}` };
      el.click();
      return { success: true, action: 'click', iframeSrc: targetFrame.src, element: describe(el) };
    }
    return { error: `Unknown iframe action: ${options.action}. Supported: getText, query, click` };
  };

  // ===== Shadow DOM 穿透操作 =====
  const pierceShadow = (hostSelector, innerSelector) => {
    const host = document.querySelector(hostSelector);
    if (!host) return { error: `Shadow host not found: ${hostSelector}` };
    if (!host.shadowRoot) return { error: `Element has no shadow root: ${hostSelector}`, element: describe(host) };
    const el = host.shadowRoot.querySelector(innerSelector);
    if (!el) return { error: `Element not found in shadow DOM: ${innerSelector}`, hostElement: describe(host) };
    return { host, el };
  };

  const shadowDomAction = (options = {}) => {
    const action = options.action;
    const hostSelector = options.hostSelector;
    const innerSelector = options.innerSelector;

    // Auto-pierce: find element across all shadow roots
    const deepQuery = selector => {
      const allHosts = [];
      document.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) allHosts.push(el);
      });
      for (const host of allHosts) {
        const found = host.shadowRoot.querySelector(selector);
        if (found) return { host, el: found };
      }
      return null;
    };

    if (action === 'query') {
      const results = [];
      const hosts = [];
      document.querySelectorAll('*').forEach(el => { if (el.shadowRoot) hosts.push(el); });
      const targetSelector = innerSelector || options.selector;
      if (!targetSelector) return { error: 'innerSelector or selector is required for query' };
      for (const host of hosts) {
        const elements = Array.from(host.shadowRoot.querySelectorAll(targetSelector)).filter(visible);
        for (const el of elements.slice(0, 20)) {
          results.push({ ...describe(el, results.length), hostTag: host.tagName.toLowerCase(), hostId: host.id || undefined });
        }
      }
      return { success: true, action: 'query', shadowHostCount: hosts.length, count: results.length, elements: results };
    }

    if (action === 'click') {
      if (!hostSelector) {
        const found = deepQuery(innerSelector || options.selector);
        if (!found) return { error: `Element not found in any shadow root: ${innerSelector || options.selector}` };
        found.el.click();
        return { success: true, action: 'click', hostTag: found.host.tagName.toLowerCase(), element: describe(found.el) };
      }
      const pierced = pierceShadow(hostSelector, innerSelector || options.selector);
      if (pierced.error) return pierced;
      pierced.el.click();
      return { success: true, action: 'click', hostTag: pierced.host.tagName.toLowerCase(), element: describe(pierced.el) };
    }

    if (action === 'getText') {
      const texts = [];
      const hosts = [];
      document.querySelectorAll('*').forEach(el => { if (el.shadowRoot) hosts.push(el); });
      for (const host of hosts) {
        const text = (host.shadowRoot.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) texts.push({ hostTag: host.tagName.toLowerCase(), hostId: host.id || undefined, text: text.slice(0, 500) });
      }
      return { success: true, action: 'getText', shadowHostCount: hosts.length, hosts: texts };
    }

    if (action === 'type') {
      const text = options.text || '';
      if (!hostSelector) {
        const found = deepQuery(innerSelector || options.selector);
        if (!found) return { error: `Input element not found in any shadow root: ${innerSelector || options.selector}` };
        found.el.focus();
        found.el.value = text;
        found.el.dispatchEvent(new Event('input', { bubbles: true }));
        found.el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, action: 'type', hostTag: found.host.tagName.toLowerCase(), element: describe(found.el) };
      }
      const pierced = pierceShadow(hostSelector, innerSelector || options.selector);
      if (pierced.error) return pierced;
      pierced.el.focus();
      pierced.el.value = text;
      pierced.el.dispatchEvent(new Event('input', { bubbles: true }));
      pierced.el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, action: 'type', hostTag: pierced.host.tagName.toLowerCase(), element: describe(pierced.el) };
    }

    return { error: `Unknown shadow DOM action: ${action}. Supported: query, click, getText, type` };
  };

  // ===== WebMCP 桥接：发现并调用页面通过 document.modelContext 注册的工具 =====
  const getModelContext = () => {
    // 标准 API: document.modelContext（W3C 孵化）；部分 polyfill 挂在 navigator 上
    return document.modelContext || navigator.modelContext || null;
  };

  const webmcpHealth = () => {
    const ctx = getModelContext();
    const hasGetTools = typeof ctx?.getTools === 'function';
    return {
      available: Boolean(ctx && hasGetTools),
      api: ctx ? (document.modelContext ? 'document.modelContext' : 'navigator.modelContext') : null,
      url: location.href,
      title: document.title
    };
  };

  const webmcpGetTools = async () => {
    const ctx = getModelContext();
    if (!ctx || typeof ctx.getTools !== 'function') {
      return { available: false, tools: [], error: 'WebMCP is not available on this page. The page must register tools via document.modelContext.registerTool().' };
    }
    try {
      // getTools() 返回已注册工具的快照数组，每项含 name/description/inputSchema/annotations
      const tools = await ctx.getTools();
      const serialised = (Array.isArray(tools) ? tools : []).map(tool => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema || null,
        annotations: tool.annotations || {}
      }));
      return { available: true, tools: serialised, count: serialised.length, url: location.href, title: document.title };
    } catch (e) {
      return { available: true, tools: [], error: `getTools() threw: ${e.message}`, url: location.href, title: document.title };
    }
  };

  const webmcpExecuteTool = async (toolName, input) => {
    const ctx = getModelContext();
    if (!ctx || typeof ctx.getTools !== 'function') {
      return { success: false, error: 'WebMCP is not available on this page' };
    }
    if (typeof toolName !== 'string' || !toolName.trim()) {
      return { success: false, error: 'toolName is required' };
    }
    try {
      const tools = await ctx.getTools();
      const tool = (Array.isArray(tools) ? tools : []).find(t => t.name === toolName);
      if (!tool) {
        const available = (Array.isArray(tools) ? tools : []).map(t => t.name);
        return { success: false, error: `Tool "${toolName}" not found`, availableTools: available };
      }
      if (typeof tool.execute !== 'function') {
        return { success: false, error: `Tool "${toolName}" has no execute function` };
      }
      const startedAt = performance.now();
      const result = await tool.execute(input || {});
      return {
        success: true,
        tool: toolName,
        result,
        durationMs: Math.round(performance.now() - startedAt),
        url: location.href,
        title: document.title
      };
    } catch (e) {
      return { success: false, error: `Tool "${toolName}" execution failed: ${e.message}`, tool: toolName };
    }
  };

  // ===== 多维度页面能力探测 =====
  const probeCapabilities = async (options = {}) => {
    const startedAt = performance.now();
    const result = {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      webmcp: null,
      declarativeForms: [],
      structuredData: [],
      domPatterns: [],
      apiEndpoints: []
    };

    // --- 维度 1: WebMCP 命令式工具 ---
    const ctx = getModelContext();
    if (ctx && typeof ctx.getTools === 'function') {
      try {
        const tools = await ctx.getTools();
        const list = (Array.isArray(tools) ? tools : []).map(t => ({
          name: t.name,
          description: t.description || '',
          inputSchema: t.inputSchema || null,
          annotations: t.annotations || {}
        }));
        result.webmcp = {
          available: true,
          api: document.modelContext ? 'document.modelContext' : 'navigator.modelContext',
          tools: list,
          count: list.length
        };
      } catch (e) {
        result.webmcp = { available: true, error: e.message, tools: [], count: 0 };
      }
    } else {
      result.webmcp = { available: false, tools: [], count: 0 };
    }

    // --- 维度 2: 声明式 WebMCP 表单 ---
    // 扫描带有 toolname / webmcp-tool / tooldescription 属性的 <form>
    const DECL_ATTRS = ['toolname', 'webmcp-tool'];
    const declarativeForms = [];
    for (const form of document.querySelectorAll('form')) {
      let toolName = null;
      for (const attr of DECL_ATTRS) {
        const val = form.getAttribute(attr);
        if (val) { toolName = val; break; }
      }
      if (!toolName) continue;
      const toolDesc = form.getAttribute('tooldescription') || form.getAttribute('webmcp-description') || '';
      const autoSubmit = form.hasAttribute('toolautosubmit') || form.hasAttribute('webmcp-autosubmit');
      const fields = [];
      for (const input of form.querySelectorAll('input, select, textarea')) {
        if (!input.name) continue;
        const field = { name: input.name, type: input.type || input.tagName.toLowerCase() };
        if (input.required) field.required = true;
        if (input.placeholder) field.placeholder = input.placeholder;
        const label = input.getAttribute('toolparamtitle') || input.labels?.[0]?.innerText || input.getAttribute('aria-label');
        if (label) field.label = normalise(label).slice(0, 120);
        if (input.tagName === 'SELECT') {
          field.options = Array.from(input.querySelectorAll('option')).map(o => ({ value: o.value, label: normalise(o.textContent) })).filter(o => o.value);
        }
        fields.push(field);
      }
      declarativeForms.push({ toolName, description: toolDesc.slice(0, 300), autoSubmit, fields, action: form.action || undefined, method: (form.method || 'get').toLowerCase() });
    }
    result.declarativeForms = declarativeForms;

    // --- 维度 3: Schema.org / JSON-LD 结构化数据 ---
    const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of jsonLdScripts) {
      try {
        const data = JSON.parse(script.textContent);
        const extractActions = (node) => {
          const items = [];
          if (!node || typeof node !== 'object') return items;
          const arr = Array.isArray(node) ? node : [node];
          for (const item of arr) {
            const type = item['@type'];
            if (typeof type === 'string' && /(Action|Form|Product|ItemList|FAQPage|HowTo|Recipe|Event|JobPosting|Offer)/i.test(type)) {
              items.push({ type, name: item.name || item['@name'] || '', target: typeof item.target === 'string' ? item.target : (item.target?.url || ''), description: (item.description || '').slice(0, 200) });
            }
            // 递归搜索嵌套结构
            for (const key of ['potentialAction', 'action', 'result', 'itemListElement', 'offers']) {
              if (item[key]) items.push(...extractActions(item[key]));
            }
          }
          return items;
        };
        result.structuredData.push(...extractActions(data));
      } catch { /* 非法 JSON 跳过 */ }
    }
    // 去重
    const seen = new Set();
    result.structuredData = result.structuredData.filter(item => {
      const key = `${item.type}|${item.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // --- 维度 4: DOM 语义模式推断 ---
    const domPatterns = [];

    // 4a. 搜索表单/搜索框
    const searchInputs = document.querySelectorAll('input[type="search"], input[name*="search" i], input[name*="query" i], input[name*="keyword" i], input[placeholder*="search" i], input[placeholder*="搜索" i], [role="search"] input, [role="searchbox"]');
    if (searchInputs.length > 0) {
      domPatterns.push({ pattern: 'search', count: searchInputs.length, elements: Array.from(searchInputs).slice(0, 3).map(el => ({ name: el.name, placeholder: el.placeholder || '', role: el.getAttribute('role') || '' })) });
    }

    // 4b. 登录/认证入口
    const loginSignals = document.querySelectorAll('input[type="password"], input[name*="password" i], input[name*="passwd" i], [role="dialog"] form, form[action*="login" i], form[action*="auth" i], form[action*="signin" i]');
    if (loginSignals.length > 0) {
      domPatterns.push({ pattern: 'authentication', count: loginSignals.length });
    }

    // 4c. 数据表格
    const tables = document.querySelectorAll('table, [role="table"], [role="grid"]');
    if (tables.length > 0) {
      domPatterns.push({ pattern: 'data_table', count: tables.length });
    }

    // 4d. 分页控件
    const paginations = document.querySelectorAll('[class*="pagination" i], [class*="pager" i], [aria-label*="pagination" i], [aria-label*="page" i], nav[aria-label*="页"]');
    if (paginations.length > 0) {
      domPatterns.push({ pattern: 'pagination', count: paginations.length });
    }

    // 4e. 筛选/过滤器
    const filters = document.querySelectorAll('select[name*="filter" i], select[name*="sort" i], select[name*="category" i], [class*="filter" i] select, [role="listbox"], [class*="facet" i]');
    if (filters.length > 0) {
      domPatterns.push({ pattern: 'filter_sort', count: filters.length });
    }

    // 4f. 弹窗/对话框
    const dialogs = document.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"]');
    if (dialogs.length > 0) {
      domPatterns.push({ pattern: 'dialog', count: dialogs.length });
    }

    // 4g. 文件上传
    const uploads = document.querySelectorAll('input[type="file"], [class*="upload" i], [class*="dropzone" i]');
    if (uploads.length > 0) {
      domPatterns.push({ pattern: 'file_upload', count: uploads.length });
    }

    // 4h. 富文本编辑器
    const editors = document.querySelectorAll('[contenteditable="true"], .ql-editor, .ProseMirror, .tox-edit-area, [class*="editor" i][contenteditable]');
    if (editors.length > 0) {
      domPatterns.push({ pattern: 'rich_text_editor', count: editors.length });
    }

    // 4i. 地图/嵌入式内容
    const maps = document.querySelectorAll('[class*="map" i] iframe, [class*="google-map" i], [class*="leaflet" i], [class*="amap" i]');
    if (maps.length > 0) {
      domPatterns.push({ pattern: 'embedded_map', count: maps.length });
    }

    // 4j. 表单（通用，排除已扫描的声明式）
    const allForms = document.querySelectorAll('form');
    const declarativeNames = new Set(declarativeForms.map(f => f.toolName));
    const genericForms = [];
    for (const form of allForms) {
      const fname = form.getAttribute('toolname') || form.getAttribute('webmcp-tool');
      if (fname && declarativeNames.has(fname)) continue;
      const inputs = form.querySelectorAll('input:not([type="hidden"]), select, textarea');
      if (inputs.length === 0) continue;
      const action = form.action || '';
      const method = (form.method || 'get').toLowerCase();
      genericForms.push({ action: action.slice(0, 200), method, fieldCount: inputs.length });
    }
    if (genericForms.length > 0) {
      domPatterns.push({ pattern: 'generic_form', count: genericForms.length, samples: genericForms.slice(0, 5) });
    }

    result.domPatterns = domPatterns;

    // --- 维度 5: 网络 API 端点嗅探 ---
    const resourceEntries = performance.getEntriesByType('resource');
    const apiEntries = resourceEntries
      .filter(entry => {
        if (entry.initiatorType !== 'xmlhttprequest' && entry.initiatorType !== 'fetch') return false;
        try {
          const u = new URL(entry.name);
          return u.protocol === 'https:' || u.protocol === 'http:';
        } catch { return false; }
      })
      .map(entry => {
        let path = '';
        try { path = new URL(entry.name).pathname + (new URL(entry.name).search || ''); } catch { path = entry.name; }
        return {
          method: entry.initiatorType === 'xmlhttprequest' ? 'XHR' : 'fetch',
          url: entry.name.slice(0, 300),
          path: path.slice(0, 200),
          duration: Math.round(entry.duration),
          transferSize: entry.transferSize || 0
        };
      });
    // 按 path 前缀聚合，避免返回几百条
    const pathPrefixes = {};
    for (const entry of apiEntries) {
      const prefix = entry.path.split('/').slice(0, 3).join('/') || '/';
      if (!pathPrefixes[prefix]) pathPrefixes[prefix] = { prefix, count: 0, methods: new Set(), sampleUrl: entry.url, avgDuration: 0, totalDuration: 0 };
      pathPrefixes[prefix].count++;
      pathPrefixes[prefix].methods.add(entry.method);
      pathPrefixes[prefix].totalDuration += entry.duration;
    }
    result.apiEndpoints = Object.values(pathPrefixes)
      .map(g => ({ prefix: g.prefix, count: g.count, methods: [...g.methods], sampleUrl: g.sampleUrl, avgDurationMs: Math.round(g.totalDuration / g.count) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    result.durationMs = Math.round(performance.now() - startedAt);
    return result;
  };

  globalThis.__webpilot = {
    page,
    pageTree,
    inspect,
    probe,
    readText,
    verify,
    extract,
    getResourceList,
    safeEvaluate,
    hover,
    pressKey,
    scroll,
    selectOption,
    dragDrop,
    waitForDynamic,
    iframeAction,
    shadowDomAction,
    webmcpHealth,
    webmcpGetTools,
    webmcpExecuteTool,
    probeCapabilities,
    async waitFor(selector, state = 'visible', timeoutMs = 10000, stableMs = 150) {
      const startedAt = performance.now();
      const deadline = startedAt + timeoutMs;
      let attempts = 0;
      let stableSince = 0;
      let lastBox = '';
      let lastFailure;
      while (performance.now() < deadline) {
        attempts += 1;
        const resolved = resolve(selector);
        const element = resolved.element;
        const isVisible = Boolean(element && visible(element));
        const satisfied = state === 'attached' ? Boolean(element) : state === 'hidden' ? !isVisible : isVisible;
        if (satisfied) {
          if (!element || stableMs <= 0 || state === 'hidden') return { success: true, state, attempts, durationMs: Math.round(performance.now() - startedAt), element: element && describe(element, resolved.index), page: snapshot() };
          const rect = element.getBoundingClientRect();
          const box = `${rect.x},${rect.y},${rect.width},${rect.height}`;
          if (box !== lastBox) { lastBox = box; stableSince = performance.now(); }
          if (performance.now() - stableSince >= stableMs) return { success: true, state, attempts, durationMs: Math.round(performance.now() - startedAt), element: describe(element, resolved.index), page: snapshot() };
        } else {
          stableSince = 0;
          lastFailure = resolved.error || `Element is not ${state}`;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { success: false, error: `Timed out after ${timeoutMs}ms waiting for ${state}`, diagnostics: { selector, attempts, lastFailure, page: page(12) } };
    },
    async click(selector, waitForMs = 10000) {
      const waited = await this.waitFor(selector, 'visible', waitForMs);
      if (!waited.success) return waited;
      const resolved = resolve(selector);
      const element = resolved.element;
      if (element.disabled || element.getAttribute('aria-disabled') === 'true') return { success: false, error: 'Element is disabled', diagnostics: { element: describe(element, resolved.index) } };
      const before = snapshot();
      // 点击可能触发导航，耐久定位符必须在点击前派生。
      const durableSelector = durableLocator(element);
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.click();
      await new Promise(resolve => setTimeout(resolve, 100));
      const after = snapshot();
      return { success: true, tagName: element.tagName, text: name(element), diagnostics: { locator: selector, strategy: resolved.strategy, durableSelector, element: describe(element, resolved.index), before, after, pageChanged: before.url !== after.url || before.title !== after.title } };
    },
    async clickAt(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
        return { success: false, error: 'Coordinates must be inside the current viewport', diagnostics: { viewport: { width: innerWidth, height: innerHeight } } };
      }
      const element = nearestActionable(document.elementFromPoint(x, y));
      if (!element) return { success: false, error: 'No visible actionable element at the requested coordinates', diagnostics: { x, y } };
      if (element.disabled || element.getAttribute('aria-disabled') === 'true') return { success: false, error: 'Element is disabled', diagnostics: { element: describe(element) } };
      const before = snapshot();
      element.click();
      await new Promise(resolve => setTimeout(resolve, 100));
      const after = snapshot();
      return { success: true, tagName: element.tagName, text: name(element), diagnostics: { x, y, element: { ...describe(element), ref: remember(element) }, before, after, pageChanged: before.url !== after.url || before.title !== after.title } };
    },
    async fill(selector, value, waitForMs = 10000) {
      const waited = await this.waitFor(selector, 'visible', waitForMs);
      if (!waited.success) return waited;
      const resolved = resolve(selector);
      const element = resolved.element;
      const before = snapshot();
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.focus();
      let mode;
      if (element.isContentEditable) {
        element.textContent = value;
        mode = 'contenteditable';
      } else if ('value' in element) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
        setter ? setter.call(element, value) : element.value = value;
        mode = 'value';
      } else {
        return { success: false, error: 'Target is not an input, textarea, select, or contenteditable element', diagnostics: { element: describe(element, resolved.index) } };
      }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 50));
      return { success: true, tagName: element.tagName, mode, diagnostics: { locator: selector, strategy: resolved.strategy, durableSelector: durableLocator(element), element: describe(element, resolved.index), before, after: snapshot() } };
    }
  };
})();
