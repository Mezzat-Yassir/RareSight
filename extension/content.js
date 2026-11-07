/* RareSight content script — runs in every frame.
 *  every frame : question picker, auto-detect observer, typing answers into the game's input, Alt+1…9
 *  top frame   : the floating answer panel (shadow DOM, isolated from the page's CSS)
 */
(() => {
  if (globalThis.__rsLoaded) return;
  globalThis.__rsLoaded = true;

  const IS_TOP = window === window.top;
  const HOST = location.hostname || (location.protocol === 'file:' ? 'file' : 'local');
  const TOP_HOST = (() => {
    if (IS_TOP) return HOST;
    try { return window.top.location.hostname || 'file'; } catch (e) { /* cross-origin */ }
    const ao = location.ancestorOrigins;
    if (ao && ao.length) {
      try { return new URL(ao[ao.length - 1]).hostname || 'file'; } catch (e) { /* ignore */ }
    }
    return HOST;
  })();
  const PANEL_TAG = 'raresight-panel';

  let dead = false;
  let settings = rsMergeSettings({});
  let sites = {};
  let selectors = {};
  const siteOn = () => !!sites[TOP_HOST];

  function safeSend(msg, cb) {
    if (dead) return;
    try {
      chrome.runtime.sendMessage(msg).then((r) => cb && cb(r), () => cb && cb(null));
    } catch (e) {
      die();
    }
  }

  function die() {
    // The extension was reloaded/updated: this copy of the script is orphaned. Clean up quietly.
    dead = true;
    stopObserver();
    stopPicker();
    if (ui) ui.host.remove();
  }

  // Remove a panel left behind by a previous version of the extension (after an update/reload).
  if (IS_TOP) document.querySelectorAll(PANEL_TAG).forEach((n) => n.remove());

  /* ================================================================ storage */

  chrome.storage.local.get(['settings', 'sites', 'selectors', 'ui']).then((d) => {
    settings = rsMergeSettings(d.settings);
    sites = d.sites || {};
    selectors = d.selectors || {};
    uiPrefs = Object.assign(uiPrefs, d.ui || {});
    applySettings();
    refreshObserver();
    if (IS_TOP && siteOn()) showUI();
  });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (dead || area !== 'local') return;
    if (ch.settings) { settings = rsMergeSettings(ch.settings.newValue); applySettings(); }
    if (ch.selectors) {
      selectors = ch.selectors.newValue || {};
      refreshObserver();
      const old = ch.selectors.oldValue || {};
      if (IS_TOP && ui && old[HOST] && !selectors[HOST]) setAuto(false);
    }
    if (ch.ui && IS_TOP) { uiPrefs = Object.assign(uiPrefs, ch.ui.newValue || {}); applyPrefs(); }
    if (ch.sites) {
      sites = ch.sites.newValue || {};
      refreshObserver();
      if (IS_TOP) { if (siteOn()) showUI(); else hideUI(); }
    }
  });

  async function setSite(on) {
    const d = await chrome.storage.local.get('sites');
    const s = d.sites || {};
    if (on) s[TOP_HOST] = true; else delete s[TOP_HOST];
    sites = s;
    await chrome.storage.local.set({ sites: s });
  }

  async function saveSelector(conf) {
    const d = await chrome.storage.local.get('selectors');
    const s = d.selectors || {};
    if (conf) s[HOST] = conf; else delete s[HOST];
    selectors = s;
    await chrome.storage.local.set({ selectors: s });
  }

  /* ================================================================ helpers */

  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 600);

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) return false;
    if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function isTextField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === PANEL_TAG.toUpperCase()) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
    if (el.tagName !== 'INPUT') return false;
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    return ['text', 'search', 'email', 'url', 'tel', ''].includes(t) && !el.disabled && !el.readOnly;
  }

  const fromPanel = (e) => !!(e.composedPath && e.composedPath().some((n) => n && n.tagName === PANEL_TAG.toUpperCase()));

  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  /* ================================================================ game input tracking */

  let lastInput = null;
  let lastFocusMsg = 0;

  document.addEventListener('focusin', (e) => {
    if (dead || fromPanel(e)) return;
    const el = e.composedPath ? e.composedPath()[0] : e.target;
    if (!isTextField(el)) return;
    const changed = el !== lastInput;
    lastInput = el;
    const now = Date.now();
    if (changed || now - lastFocusMsg > 3000) {
      lastFocusMsg = now;
      safeSend({ type: 'rs:inputFocused' });
    }
  }, true);

  function candidateInputs() {
    return [...document.querySelectorAll('input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')]
      .filter((el) => isTextField(el) && isVisible(el));
  }

  globalThis.__rsInputScore = () => {
    const c = candidateInputs();
    if (!c.length) return 0;
    let score = 10;
    if (lastInput && lastInput.isConnected) score += 50;
    if (selectors[HOST]) score += 100;
    return score;
  };

  function bestInput() {
    if (lastInput && isTextField(lastInput) && isVisible(lastInput)) return lastInput;
    const ae = deepActive();
    if (isTextField(ae) && isVisible(ae)) return ae;
    const c = candidateInputs();
    if (!c.length) return null;
    let q = null;
    try { q = selectors[HOST] && document.querySelector(selectors[HOST].selector); } catch (e) { /* bad selector */ }
    if (q && c.length > 1) {
      const qr = q.getBoundingClientRect();
      const dist = (el) => { const r = el.getBoundingClientRect(); return Math.hypot(r.left - qr.left, r.top - qr.bottom); };
      c.sort((a, b) => dist(a) - dist(b));
    }
    return c[0];
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  }

  function pressEnter(el) {
    const base = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    const notPrevented = el.dispatchEvent(new KeyboardEvent('keydown', base));
    el.dispatchEvent(new KeyboardEvent('keypress', Object.assign({}, base, { charCode: 13 })));
    el.dispatchEvent(new KeyboardEvent('keyup', base));
    if (notPrevented && el.form) {
      try { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); } catch (e) { /* ignore */ }
    }
  }

  function insertText(text, submit) {
    const el = bestInput();
    if (!el) return { ok: false, reason: 'no-input' };
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }

    if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      if (!document.execCommand('insertText', false, text)) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    } else {
      try { el.select(); } catch (e) { /* some types can't select */ }
      let ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
      if (!ok || el.value !== text) {
        setNativeValue(el, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (submit) setTimeout(() => pressEnter(el), 20);
    return { ok: true, submitted: !!submit };
  }

  /* ================================================================ Alt+1…9 (type answer) · Alt+0 (more answers) */

  window.addEventListener('keydown', (e) => {
    if (dead || picker || !settings.digitHotkeys || !siteOn()) return;
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
    if (!m) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (m[1] === '0') safeSend({ type: 'rs:more' });
    else safeSend({ type: 'rs:pickAnswer', index: Number(m[1]) - 1 });
  }, true);

  /* ================================================================ question picker */

  let picker = null;

  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const cls = [...el.classList].slice(0, 2);
    if (cls.length) s += `.${cls.join('.')}`;
    return s;
  }

  function makeSelector(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && node !== document.body) {
      if (node.id && !/\d{3,}|:/.test(node.id)) {
        try {
          if (document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
        } catch (e) { /* ignore */ }
      }
      let part = node.tagName.toLowerCase();
      const classes = [...node.classList]
        .filter((c) => !/^(rs-|is-|has-)|hover|active|focus|selected|visible|hidden|show|animat|fade|enter|leave|transition/i.test(c) && !/\d{4,}/.test(c))
        .slice(0, 3);
      if (classes.length) part += classes.map((c) => `.${CSS.escape(c)}`).join('');
      const parent = node.parentElement;
      if (parent) {
        let same = [];
        try { same = [...parent.children].filter((ch) => ch.matches(part)); } catch (e) { same = []; }
        if (same.length > 1) {
          const idx = [...parent.children].filter((ch) => ch.tagName === node.tagName).indexOf(node) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(part);
      node = parent;
    }
    // Shortest suffix that still points uniquely at this element (and is specific enough to survive re-renders).
    for (let i = parts.length - 1; i >= 0; i--) {
      const suffix = parts.slice(i);
      const sel = suffix.join(' > ');
      const specific = suffix.length >= 3 || /[#.]/.test(sel);
      if (!specific) continue;
      try {
        const m = document.querySelectorAll(sel);
        if (m.length === 1 && m[0] === el) return sel;
      } catch (e) { /* ignore */ }
    }
    return parts.join(' > ');
  }

  function startPicker() {
    if (picker || dead) return;
    const box = document.createElement('div');
    box.style.cssText = 'all:initial;position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #ffb43b;background:rgba(255,180,59,.13);border-radius:4px;box-sizing:border-box;display:none;';
    const tag = document.createElement('div');
    tag.style.cssText = 'all:initial;position:fixed;z-index:2147483647;pointer-events:none;background:#121318;color:#ffd79a;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:5px 8px;border-radius:5px;max-width:440px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none;box-shadow:0 6px 18px rgba(0,0,0,.45);';
    const nodes = [box, tag];
    if (IS_TOP) {
      const banner = document.createElement('div');
      banner.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:50%;top:14px;transform:translateX(-50%);background:#121318;color:#f1efe9;font:600 13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:9px 14px;border-radius:999px;border:1px solid #ffb43b;box-shadow:0 10px 30px rgba(0,0,0,.45);pointer-events:none;';
      banner.textContent = 'Click the QUESTION text  ·  ↑ bigger  ·  ↓ smaller  ·  Enter confirm  ·  Esc cancel';
      nodes.push(banner);
    }
    document.documentElement.append(...nodes);

    const st = { nodes, box, tag, base: null, cur: null };
    picker = st;

    const draw = () => {
      if (!st.cur) return;
      const r = st.cur.getBoundingClientRect();
      Object.assign(box.style, { display: 'block', left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
      const txt = clean(st.cur.innerText || st.cur.textContent).slice(0, 90);
      tag.textContent = `${describe(st.cur)}  —  ${txt ? `“${txt}”` : '(no text)'}`;
      const top = r.top > 34 ? r.top - 30 : r.bottom + 6;
      Object.assign(tag.style, { display: 'block', left: `${Math.max(4, Math.min(r.left, innerWidth - 450))}px`, top: `${top}px` });
    };
    const block = (e) => {
      if (fromPanel(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const onMove = (e) => {
      if (fromPanel(e)) return;
      const t = e.target;
      if (!(t instanceof Element) || nodes.includes(t)) return;
      if (t !== st.base) { st.base = t; st.cur = t; draw(); }
    };
    const onClick = (e) => {
      if (fromPanel(e)) return;
      block(e);
      if (st.cur) finishPick(st.cur);
    };
    const onKey = (e) => {
      if (fromPanel(e)) return;
      if (e.key === 'Escape') { block(e); endPicker(false); return; }
      if (!st.cur) return;
      if (e.key === 'ArrowUp') {
        block(e);
        const p = st.cur.parentElement;
        if (p && p !== document.body && p !== document.documentElement) { st.cur = p; draw(); }
      } else if (e.key === 'ArrowDown') {
        block(e);
        let n = st.base;
        while (n && n.parentElement && n.parentElement !== st.cur) n = n.parentElement;
        if (n && n !== st.cur && st.cur.contains(n)) { st.cur = n; draw(); }
      } else if (e.key === 'Enter') {
        block(e);
        finishPick(st.cur);
      }
    };
    const blockers = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'contextmenu'];
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    blockers.forEach((t) => window.addEventListener(t, block, true));
    window.addEventListener('scroll', draw, true);
    st.cleanup = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
      blockers.forEach((t) => window.removeEventListener(t, block, true));
      window.removeEventListener('scroll', draw, true);
      nodes.forEach((n) => n.remove());
    };
  }

  function stopPicker() {
    if (!picker) return;
    picker.cleanup();
    picker = null;
  }

  function endPicker(picked, sample) {
    stopPicker();
    safeSend({ type: 'rs:pickerEnd', picked, sample });
  }

  async function finishPick(el) {
    const text = clean(el.innerText || el.textContent);
    if (!text) {
      picker.tag.textContent = 'This element has no text — move the mouse or press ↑ for a bigger box';
      return;
    }
    const conf = { selector: makeSelector(el), sample: text.slice(0, 140), at: Date.now() };
    endPicker(true, conf.sample);
    await saveSelector(conf);
    await setSite(true);
    lastKey = '';
    startObserver();
    fireQuestion(text); // answer the question that's on screen right now
  }

  /* ================================================================ auto-detect observer */

  let observer = null;
  let poll = null;
  let checkTimer = null;
  let cand = '';
  let candAt = 0;
  let lastKey = '';

  const keyOf = (t) => t.toLowerCase().replace(/\d+/g, '#');

  function fireQuestion(text) {
    lastKey = keyOf(text);
    safeSend({ type: 'rs:question', text });
  }

  function schedule(delay) {
    if (checkTimer || dead) return;
    checkTimer = setTimeout(() => { checkTimer = null; check(); }, delay == null ? 60 : delay);
  }

  function check() {
    const conf = selectors[HOST];
    if (!conf || !observer) return;
    let el = null;
    try { el = document.querySelector(conf.selector); } catch (e) { el = null; }
    const text = el && isVisible(el) ? clean(el.innerText || el.textContent) : '';
    globalThis.__rsTracked = text;
    const now = performance.now();
    if (text !== cand) { cand = text; candAt = now; }
    const age = now - candAt;
    if (age < settings.stabilityMs) { schedule(settings.stabilityMs - age + 10); return; }
    if (text.length < 2) { lastKey = ''; return; }
    if (keyOf(text) === lastKey) return; // same question (ignoring changing numbers like a countdown)
    fireQuestion(text);
  }

  function startObserver() {
    stopObserver();
    if (!selectors[HOST] || dead) return;
    observer = new MutationObserver(() => schedule());
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    poll = setInterval(() => schedule(), 700);
    safeSend({ type: 'rs:autoState', on: true, sample: selectors[HOST].sample });
    schedule(0);
  }

  function stopObserver() {
    if (observer) observer.disconnect();
    observer = null;
    clearInterval(poll);
    poll = null;
    clearTimeout(checkTimer);
    checkTimer = null;
  }

  function refreshObserver() {
    if (selectors[HOST] && siteOn()) { if (!observer) startObserver(); } else stopObserver();
  }

  /* ================================================================ panel (top frame) */

  let ui = null;
  let uiPrefs = { compact: false, x: null, y: null };
  let job = { id: null, question: '', answers: [], prev: [], used: new Set(), busy: false, raf: 0 };

  const ICONS = {
    bolt: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
    cam: '<svg viewBox="0 0 24 24"><path d="M4 7h3l2-3h6l2 3h3v13H4z"/><circle cx="12" cy="13" r="4"/></svg>',
    target: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>',
    min: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>'
  };

  const RARITY = {
    5: ['LEGEND', '#ff8b3d'],
    4: ['EPIC', '#bc8cff'],
    3: ['RARE', '#5aa9ff'],
    2: ['UNCOMMON', '#4fd08a'],
    1: ['COMMON', '#8d929c'],
    0: ['ONLY ANSWER', '#ffd54a']
  };

  const PANEL_CSS = `
    :host { all: initial; }
    [hidden] { display: none !important; }
    * { box-sizing: border-box; }
    .panel {
      position: fixed; width: 330px; max-height: calc(100vh - 24px);
      display: flex; flex-direction: column;
      font: 400 var(--fs, 14px)/1.35 system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif;
      color: #ecebe6; background: rgba(14, 15, 19, var(--alpha, .96));
      border: 1px solid rgba(255,255,255,.08); border-radius: 12px;
      box-shadow: 0 20px 50px rgba(0,0,0,.5), 0 0 0 1px rgba(0,0,0,.5);
      backdrop-filter: blur(12px) saturate(1.2); -webkit-backdrop-filter: blur(12px) saturate(1.2);
      overflow: hidden; user-select: none; -webkit-user-select: none;
    }
    .bar { display: flex; align-items: center; gap: 6px; padding: 7px 6px 7px 11px; cursor: grab; background: rgba(255,255,255,.025); border-bottom: 1px solid rgba(255,255,255,.06); }
    .bar:active { cursor: grabbing; }
    .logo { width: 9px; height: 9px; transform: rotate(45deg); background: #ffb43b; border-radius: 2px; box-shadow: 0 0 10px rgba(255,180,59,.6); flex: none; }
    .name { font-weight: 750; font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: #f6f3ea; }
    .status { font: 600 10.5px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #8d929c; padding: 4px 7px; border-radius: 999px; background: rgba(255,255,255,.05); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
    .status[data-s="busy"] { color: #ffcf7d; }
    .status[data-s="busy"]::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #ffb43b; margin-right: 5px; vertical-align: 1px; animation: blink .8s infinite alternate; }
    .status[data-s="ok"] { color: #7fe0a7; }
    .status[data-s="err"] { color: #ff8a8a; }
    .sp { flex: 1; }
    button.i { all: unset; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 7px; cursor: pointer; color: #b8bbc2; }
    button.i:hover { background: rgba(255,255,255,.08); color: #fff; }
    button.i svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    button.i[data-act="ask"] svg { fill: #ffb43b; stroke: #ffb43b; }
    .tbar { height: 3px; background: rgba(255,255,255,.05); }
    .tbar i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #ffb43b, #ff7a3d); transition: background .2s; }
    .hurry .tbar i { background: #ff5a5a; }
    .q { display: flex; gap: 10px; align-items: flex-start; padding: 9px 11px 8px; }
    .qt { flex: 1; font-size: .93em; color: #c9cbd1; overflow-wrap: anywhere; max-height: 5.4em; overflow: hidden; user-select: text; -webkit-user-select: text; }
    .qt.empty { color: #6f737c; font-style: italic; }
    .clock { font: 700 20px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #ffb43b; min-width: 46px; text-align: right; font-variant-numeric: tabular-nums; }
    .hurry .clock { color: #ff5a5a; }
    .clock:empty { display: none; }
    ol { list-style: none; margin: 0; padding: 0 0 4px; overflow-y: auto; flex: 1 1 auto; min-height: 0; }
    li {
      --rc: #8d929c;
      display: grid; grid-template-columns: 20px 1fr auto; column-gap: 8px; align-items: center;
      padding: 6px 10px 6px 8px; margin: 0 6px 3px; border-radius: 8px; cursor: pointer;
      border-left: 3px solid var(--rc); background: rgba(255,255,255,.025);
      animation: pop .16s ease-out;
    }
    li:hover { background: rgba(255,255,255,.07); }
    li:active { transform: scale(.99); }
    kbd { font: 700 10.5px/18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #9ba0aa; border: 1px solid rgba(255,255,255,.13); border-bottom-width: 2px; border-radius: 5px; text-align: center; height: 20px; }
    .t { font-weight: 680; font-size: 1.06em; color: #fff; overflow-wrap: anywhere; }
    .r { font: 750 9.5px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .07em; color: var(--rc); padding: 3px 6px; border-radius: 999px; border: 1px solid var(--rc); opacity: .9; white-space: nowrap; }
    .h { grid-column: 2 / 4; font-size: .8em; color: #8e929b; margin-top: 1px; overflow-wrap: anywhere; }
    li.used { opacity: .45; }
    li.used .t::after { content: "  ✓"; color: #4fd08a; }
    .msg { margin: 2px 10px 6px; font-size: .84em; color: #c9cbd1; padding: 7px 9px; border-radius: 8px; background: rgba(255,255,255,.05); }
    .msg:empty { display: none; }
    .msg.err { color: #ffb1b1; background: rgba(255,80,80,.12); }
    .msg.warn { color: #ffd79a; background: rgba(255,180,59,.12); }
    .msg.ok { color: #9ff0c1; background: rgba(79,208,138,.12); }
    form { display: flex; gap: 6px; padding: 6px 8px 8px; border-top: 1px solid rgba(255,255,255,.06); }
    input { all: unset; flex: 1; min-width: 0; font: inherit; font-size: .9em; color: #f1efe9; padding: 7px 9px; border-radius: 8px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.08); user-select: text; -webkit-user-select: text; }
    input:focus { border-color: rgba(255,180,59,.6); }
    input::placeholder { color: #6f737c; }
    .foot { display: flex; gap: 8px; align-items: center; padding: 0 11px 8px; font: 500 10.5px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #6f737c; }
    .keys { white-space: nowrap; }
    .auto { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 130px; }
    .auto.on { color: #7fe0a7; }
    .linkish { all: unset; cursor: pointer; color: #8d929c; text-decoration: underline; text-underline-offset: 2px; }
    .linkish:hover { color: #fff; }
    .compact { width: 250px; }
    .more { all: unset; display: flex; align-items: center; justify-content: center; gap: 8px; margin: 2px 6px 6px; padding: 7px; border-radius: 8px; border: 1px dashed rgba(255,180,59,.45); color: #ffcf7d; font-weight: 650; font-size: .88em; cursor: pointer; }
    .more:hover { background: rgba(255,180,59,.1); border-style: solid; }
    .more.busy { opacity: .5; cursor: progress; }
    .more kbd { height: auto; line-height: 16px; padding: 0 5px; font-weight: 600; }
    .prev { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; padding: 0 10px 7px; max-height: 5.5em; overflow-y: auto; }
    .prev .pl { font: 700 9.5px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .08em; text-transform: uppercase; color: #6f737c; margin-right: 3px; }
    .chip { all: unset; font-size: .8em; color: #a9acb3; padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,.06); cursor: pointer; }
    .chip:hover { color: #fff; background: rgba(255,255,255,.12); }
    .chip.used { text-decoration: line-through; opacity: .5; }
    .compact .h, .compact form, .compact .foot, .compact .q .qt, .compact .prev { display: none; }
    .compact .more { padding: 4px; margin-top: 0; }
    .compact .more kbd { display: none; }
    .compact .q { padding: 6px 10px 4px; justify-content: flex-end; }
    .compact .clock { font-size: 15px; }
    .compact li { padding: 4px 8px 4px 6px; }
    @keyframes pop { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
    @keyframes blink { from { opacity: 1; } to { opacity: .25; } }
  `;

  const HTML = `
    <div class="panel" part="panel">
      <div class="bar">
        <span class="logo" title="RareSight"></span>
        <span class="status" data-s="idle">ready</span>
        <span class="sp"></span>
        <button class="i" data-act="ask" title="Answer now — selected text, detected question or screenshot (Alt+Shift+Q)">${ICONS.bolt}</button>
        <button class="i" data-act="shot" title="Read the question from a screenshot">${ICONS.cam}</button>
        <button class="i" data-act="pick" title="Pick the question element for auto-detect (Alt+Shift+E)">${ICONS.target}</button>
        <button class="i" data-act="settings" title="Settings">${ICONS.gear}</button>
        <button class="i" data-act="min" title="Compact mode">${ICONS.min}</button>
        <button class="i" data-act="close" title="Hide on this site (Alt+Shift+S)">${ICONS.x}</button>
      </div>
      <div class="tbar"><i></i></div>
      <div class="q"><div class="qt empty">Waiting for a question…</div><div class="clock"></div></div>
      <ol></ol>
      <button class="more" data-act="more" title="New answers, none of the ones already shown (Alt+0)" hidden>↻&nbsp; More answers <kbd>Alt+0</kbd></button>
      <div class="prev" hidden><span class="pl">Shown before</span></div>
      <div class="msg"></div>
      <form><input type="text" placeholder="Type a question + Enter" autocomplete="off" spellcheck="false"></form>
      <div class="foot"><span class="keys">Alt+1…9 type · Alt+0 more</span><span class="sp"></span><span class="auto">auto: off</span><button class="linkish" data-act="unauto" hidden>stop</button></div>
    </div>`;

  function buildUI() {
    if (ui) return ui;
    const host = document.createElement(PANEL_TAG);
    host.style.cssText = 'all:initial !important;position:fixed !important;top:0 !important;left:0 !important;width:0 !important;height:0 !important;z-index:2147483647 !important;display:block !important;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${PANEL_CSS}</style>${HTML}`;
    document.documentElement.appendChild(host);
    const $ = (s) => root.querySelector(s);
    ui = {
      host, root, $,
      panel: $('.panel'), status: $('.status'), qt: $('.qt'), clock: $('.clock'), tbar: $('.tbar i'),
      list: $('ol'), moreBtn: $('.more'), prev: $('.prev'), msg: $('.msg'), form: $('form'), input: $('input'), auto: $('.auto'), unauto: $('[data-act="unauto"]'), keys: $('.keys')
    };

    // Buttons
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'ask') safeSend({ type: 'rs:askNow' });
      else if (act === 'more') { if (!job.busy) safeSend({ type: 'rs:more' }); }
      else if (act === 'shot') safeSend({ type: 'rs:askScreenshot' });
      else if (act === 'pick') safeSend({ type: 'rs:startPicker' });
      else if (act === 'settings') safeSend({ type: 'rs:openOptions' });
      else if (act === 'min') { uiPrefs.compact = !uiPrefs.compact; applyPrefs(); savePrefs(); }
      else if (act === 'close') setSite(false);
      else if (act === 'unauto') { safeSend({ type: 'rs:clearSelectors' }); setAuto(false); }
    });
    // Keep keyboard focus in the game when clicking the panel (except our own text box).
    ui.panel.addEventListener('mousedown', (e) => { if (e.target !== ui.input) e.preventDefault(); });

    // Answers
    ui.list.addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (li) choose(Number(li.dataset.i));
    });
    ui.prev.addEventListener('click', (e) => {
      const c = e.target.closest('.chip');
      if (c) typeAnswer(c.dataset.answer);
    });

    // Manual question
    ui.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = ui.input.value.trim();
      globalThis.__rsTyped = q;
      if (q) safeSend({ type: 'rs:ask', question: q });
    });
    ['keydown', 'keyup', 'keypress'].forEach((t) => ui.input.addEventListener(t, (e) => {
      e.stopPropagation();
      if (t === 'keydown' && e.key === 'Escape') ui.input.blur();
    }));

    // Drag
    const bar = $('.bar');
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = ui.panel.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      bar.setPointerCapture(e.pointerId);
      const move = (ev) => { uiPrefs.x = ev.clientX - dx; uiPrefs.y = ev.clientY - dy; place(); };
      const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); savePrefs(); };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
    });
    window.addEventListener('resize', place);

    // Follow the game into fullscreen when possible.
    document.addEventListener('fullscreenchange', () => {
      const fs = document.fullscreenElement;
      const target = fs && !/^(CANVAS|VIDEO|IMG|IFRAME)$/.test(fs.tagName) ? fs : document.documentElement;
      if (host.parentNode !== target) target.appendChild(host);
    });

    applySettings();
    applyPrefs();
    if (selectors[HOST]) setAuto(true, selectors[HOST].sample);
    return ui;
  }

  function place() {
    if (!ui) return;
    const w = ui.panel.offsetWidth || 330;
    const h = ui.panel.offsetHeight || 200;
    let x = uiPrefs.x == null ? innerWidth - w - 16 : uiPrefs.x;
    let y = uiPrefs.y == null ? 16 : uiPrefs.y;
    x = Math.max(4, Math.min(x, innerWidth - w - 4));
    y = Math.max(4, Math.min(y, innerHeight - Math.min(h, 60)));
    ui.panel.style.left = `${x}px`;
    ui.panel.style.top = `${y}px`;
  }

  function applyPrefs() {
    if (!ui) return;
    ui.panel.classList.toggle('compact', !!uiPrefs.compact);
    place();
  }

  function savePrefs() {
    chrome.storage.local.set({ ui: { compact: uiPrefs.compact, x: uiPrefs.x, y: uiPrefs.y } }).catch(() => {});
  }

  function applySettings() {
    if (!ui) return;
    ui.panel.style.setProperty('--alpha', String(settings.opacity));
    ui.panel.style.setProperty('--fs', `${settings.fontSize}px`);
    ui.keys.textContent = settings.digitHotkeys ? 'Alt+1…9 type · Alt+0 more' : 'click = type';
    ui.moreBtn.querySelector('kbd').hidden = !settings.digitHotkeys;
  }

  function showUI() {
    if (!IS_TOP || dead) return;
    buildUI();
    ui.host.style.setProperty('display', 'block', 'important');
    requestAnimationFrame(place);
  }

  function hideUI() {
    if (ui) ui.host.style.setProperty('display', 'none', 'important');
  }

  const uiVisible = () => !!ui && ui.host.style.display !== 'none';

  function setStatus(text, s) {
    if (!ui) return;
    ui.status.textContent = text;
    ui.status.dataset.s = s || 'idle';
  }

  let msgTimer = null;
  function toast(text, tone, ms) {
    if (!IS_TOP) return;
    showUI();
    ui.msg.textContent = text;
    ui.msg.className = `msg ${tone || ''}`;
    clearTimeout(msgTimer);
    if (ms !== 0) msgTimer = setTimeout(() => { ui.msg.textContent = ''; }, ms || 5000);
  }

  function setAuto(on, sample) {
    if (!ui) return;
    ui.auto.textContent = on ? `auto: “${(sample || 'on').slice(0, 40)}”` : 'auto: off';
    ui.auto.title = on ? `Auto-detect watches: ${sample || ''}` : 'Click ◎ to pick the question element';
    ui.auto.classList.toggle('on', !!on);
    ui.unauto.hidden = !on;
  }

  const fmt = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

  function rowFor(a, i) {
    const li = document.createElement('li');
    li.dataset.i = String(i);
    const r = a.rarity != null && RARITY[a.rarity] ? RARITY[a.rarity] : ['?', '#8d929c'];
    li.style.setProperty('--rc', r[1]);
    const kbd = document.createElement('kbd');
    kbd.textContent = i < 9 ? String(i + 1) : '·';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = a.answer;
    const badge = document.createElement('span');
    badge.className = 'r';
    badge.textContent = r[0];
    li.append(kbd, t, badge);
    if (a.hint) {
      const h = document.createElement('span');
      h.className = 'h';
      h.textContent = a.hint;
      li.append(h);
    }
    li.title = 'Click to type it into the game (also copied)';
    return li;
  }

  function startClock(sec) {
    cancelAnimationFrame(job.raf);
    if (!ui) return;
    ui.panel.classList.remove('hurry');
    if (!sec) { ui.clock.textContent = ''; ui.tbar.style.width = '0'; return; }
    const t0 = performance.now();
    const tick = () => {
      const left = Math.max(0, sec - (performance.now() - t0) / 1000);
      ui.clock.textContent = left.toFixed(1);
      ui.tbar.style.width = `${(left / sec) * 100}%`;
      ui.panel.classList.toggle('hurry', left <= 3);
      if (left > 0) job.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
  }

  function choose(i) {
    const a = job.answers[i];
    if (!a) return;
    markUsed(i);
    typeAnswer(a.answer);
  }

  function typeAnswer(text) {
    if (!text) return;
    copy(text);
    markUsedText(text);
    safeSend({ type: 'rs:insert', text }, (r) => {
      if (r && r.ok) toast(r.submitted ? `Typed and sent “${text}”` : `Typed “${text}” — press Enter`, 'ok', 2500);
      else toast(`Copied “${text}”. Click the game's answer box once so I know where to type.`, 'warn', 4500);
    });
  }

  const usedKey = (t) => String(t || '').toLowerCase().trim();

  function markUsed(i) {
    if (!ui) return;
    const a = job.answers[i];
    if (a) job.used.add(usedKey(a.answer));
    const li = ui.list.querySelector(`li[data-i="${i}"]`);
    if (li) li.classList.add('used');
  }

  function markUsedText(text) {
    job.used.add(usedKey(text));
    if (!ui) return;
    ui.prev.querySelectorAll('.chip').forEach((c) => { if (usedKey(c.dataset.answer) === usedKey(text)) c.classList.add('used'); });
  }

  function renderPrev() {
    if (!ui) return;
    ui.prev.querySelectorAll('.chip').forEach((c) => c.remove());
    for (const a of job.prev) {
      const c = document.createElement('button');
      c.className = 'chip';
      c.dataset.answer = a.answer;
      c.textContent = a.answer;
      c.title = a.hint ? `${a.hint} — click to type it` : 'Click to type it';
      if (job.used.has(usedKey(a.answer))) c.classList.add('used');
      ui.prev.append(c);
    }
    ui.prev.hidden = !job.prev.length;
  }

  function setBusy(b) {
    job.busy = b;
    if (!ui) return;
    ui.moreBtn.classList.toggle('busy', b);
    ui.moreBtn.hidden = !b && !job.question && !job.answers.length;
    ui.moreBtn.firstChild.textContent = b ? '↻\u00a0 Finding answers… ' : '↻\u00a0 More answers ';
  }

  function onEvent(m) {
    if (!IS_TOP) return;
    if (m.kind === 'start') {
      showUI();
      if (m.more) {
        // Refresh: keep the question and the countdown, move the current batch into "Shown before".
        const last = job.answers.filter(Boolean);
        job = Object.assign(job, { id: m.id, prev: job.prev.concat(last), lastBatch: last, answers: [] });
        setStatus('more…', 'busy');
      } else {
        job = { id: m.id, question: m.question || '', answers: [], prev: [], used: new Set(), busy: false, raf: job.raf };
        const q = m.question || (m.withImage ? 'Reading the question from the screen…' : '');
        ui.qt.textContent = q || '…';
        ui.qt.classList.toggle('empty', !m.question);
        setStatus('thinking', 'busy');
        startClock(m.timer);
      }
      ui.qt.title = m.provider || '';
      ui.list.textContent = '';
      ui.msg.textContent = '';
      renderPrev();
      setBusy(true);
      return;
    }
    if (m.id !== job.id || !ui) return;
    if (m.kind === 'question') {
      job.question = m.text;
      ui.qt.textContent = m.text;
      ui.qt.classList.remove('empty');
    } else if (m.kind === 'answer') {
      job.answers[m.index] = m.answer;
      ui.list.append(rowFor(m.answer, m.index));
      if (m.index === 0) setStatus(`1st ${fmt(m.ms)}`, 'busy');
    } else if (m.kind === 'answers') {
      job.answers = m.answers.slice();
      ui.list.textContent = '';
      m.answers.forEach((a, i) => ui.list.append(rowFor(a, i)));
    } else if (m.kind === 'done') {
      setBusy(false);
      if (m.cached) setStatus('cache · instant', 'ok');
      else setStatus(`${m.count} · ${fmt(m.ms)}`, m.count ? 'ok' : 'err');
      if (!m.count && m.more) {
        // Nothing new: put the previous batch back so Alt+1…9 still work.
        const last = job.lastBatch || [];
        job.answers = last.length ? job.prev.splice(-last.length) : [];
        job.answers.forEach((a, i) => ui.list.append(rowFor(a, i)));
        job.answers.forEach((a, i) => { if (job.used.has(usedKey(a.answer))) markUsed(i); });
        renderPrev();
        toast('No other valid answers found for this question.', 'warn');
      } else if (!m.count) toast('The AI returned no usable answer. Try again or change model.', 'warn');
    } else if (m.kind === 'error') {
      setBusy(false);
      setStatus('error', 'err');
      toast(m.message, 'err', 0);
    }
  }

  // Read-only snapshot of the panel (used by the "Answer now" fallback and for troubleshooting).
  globalThis.__rsState = () => ({
    top: IS_TOP,
    host: HOST,
    topHost: TOP_HOST,
    visible: uiVisible(),
    status: ui ? ui.status.textContent : null,
    question: ui ? ui.qt.textContent : null,
    answers: job.answers.map((a) => a && a.answer),
    prev: job.prev.map((a) => a && a.answer),
    message: ui ? ui.msg.textContent : null,
    auto: ui ? ui.auto.textContent : null,
    tracked: globalThis.__rsTracked || '',
    observing: !!observer
  });

  /* ================================================================ messages */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (dead || !msg) return;
    switch (msg.type) {
      case 'rs:ping':
        sendResponse({ ok: true, top: IS_TOP });
        return;
      case 'rs:picker':
        if (msg.on) startPicker(); else stopPicker();
        return;
      case 'rs:insertText':
        sendResponse(insertText(msg.text, msg.submit));
        return;
      case 'rs:clearSelector':
        if (selectors[HOST]) { saveSelector(null); stopObserver(); }
        return;
      default:
        break;
    }
    if (!IS_TOP) return;
    switch (msg.type) {
      case 'rs:event': onEvent(msg); break;
      case 'rs:toggle': setSite(!uiVisible()); if (!uiVisible()) showUI(); else hideUI(); break;
      case 'rs:show': if (!siteOn()) setSite(true); showUI(); break;
      case 'rs:toast': toast(msg.text, msg.tone, msg.ms); break;
      case 'rs:autoState': showUI(); setAuto(msg.on, msg.sample); break;
      case 'rs:marked': markUsed(msg.index); break;
      case 'rs:getAnswer': sendResponse({ text: job.answers[msg.index] && job.answers[msg.index].answer }); break;
      case 'rs:getContext':
        sendResponse({ question: job.question, seen: job.prev.concat(job.answers).filter(Boolean).map((a) => a.answer) });
        break;
      case 'rs:prepareCapture':
        if (ui) ui.host.style.setProperty('visibility', 'hidden', 'important');
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => sendResponse({ ok: true }), 30)));
        return true;
      case 'rs:captureDone':
        if (ui) ui.host.style.removeProperty('visibility');
        break;
      default:
        break;
    }
  });
})();
