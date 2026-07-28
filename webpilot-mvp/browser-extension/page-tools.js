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
    return { url: location.href, title: document.title, extractedAt: new Date().toISOString(), data };
  };

  globalThis.__webpilot = {
    page,
    inspect,
    probe,
    readText,
    verify,
    extract,
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
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.click();
      await new Promise(resolve => setTimeout(resolve, 100));
      const after = snapshot();
      return { success: true, tagName: element.tagName, text: name(element), diagnostics: { locator: selector, strategy: resolved.strategy, element: describe(element, resolved.index), before, after, pageChanged: before.url !== after.url || before.title !== after.title } };
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
      return { success: true, tagName: element.tagName, mode, diagnostics: { locator: selector, strategy: resolved.strategy, element: describe(element, resolved.index), before, after: snapshot() } };
    }
  };
})();
