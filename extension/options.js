(async () => {
  const $ = (id) => document.getElementById(id);
  let stored = (await chrome.storage.local.get('settings')).settings || {};
  stored.providers = stored.providers || {};
  const merged = () => rsMergeSettings(stored);

  for (const [id, m] of Object.entries(RS_PROVIDERS)) $('provider').add(new Option(m.label, id));
  for (const [v, l] of RS_LANGUAGES) $('language').add(new Option(l, v));

  let saveTimer = null;
  let flashTimer = null;
  async function saveNow() {
    clearTimeout(saveTimer);
    await chrome.storage.local.set({ settings: stored });
    $('saved').classList.add('on');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => $('saved').classList.remove('on'), 1200);
  }
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 250); };

  /* ---------- provider ---------- */
  function renderProvider() {
    const s = merged();
    const id = s.provider;
    const meta = RS_PROVIDERS[id];
    const own = stored.providers[id] || {};
    $('provider').value = id;
    $('provNote').textContent = meta.note || '';
    $('key').value = own.key || '';
    $('key').placeholder = meta.keyOptional ? 'Optional for this provider' : 'Paste your API key';
    $('keyLink').href = meta.keyUrl || '#';
    $('keyLink').style.display = meta.keyUrl ? '' : 'none';
    $('model').value = own.model || '';
    $('model').placeholder = meta.model;
    $('baseWrap').style.display = meta.kind === 'openai' ? '' : 'none';
    $('base').value = own.base || '';
    $('base').placeholder = meta.base || '';
  }
  const setProv = (field, val) => {
    const id = merged().provider;
    stored.providers[id] = Object.assign({}, stored.providers[id], { [field]: val });
    save();
  };
  $('provider').addEventListener('change', () => {
    stored.provider = $('provider').value;
    renderProvider();
    $('testOut').textContent = '';
    save();
  });
  $('key').addEventListener('input', () => setProv('key', $('key').value.trim()));
  $('model').addEventListener('input', () => setProv('model', $('model').value.trim()));
  $('base').addEventListener('input', () => setProv('base', $('base').value.trim()));
  $('showKey').addEventListener('click', () => {
    const k = $('key');
    k.type = k.type === 'password' ? 'text' : 'password';
    $('showKey').textContent = k.type === 'password' ? 'Show' : 'Hide';
  });
  renderProvider();

  /* ---------- generic fields ---------- */
  const fields = {
    language: 'text', count: 'num', strategy: 'text', extraInstructions: 'text',
    autoSubmit: 'check', digitHotkeys: 'check', screenshotFallback: 'check',
    timerSeconds: 'num', stabilityMs: 'num', opacity: 'num', fontSize: 'num', cacheEnabled: 'check'
  };
  const s0 = merged();
  for (const [id, kind] of Object.entries(fields)) {
    const el = $(id);
    if (kind === 'check') el.checked = !!s0[id]; else el.value = s0[id];
    el.addEventListener(kind === 'check' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
      stored[id] = kind === 'check' ? el.checked : kind === 'num' ? Number(el.value) : el.value;
      save();
    });
  }

  $('resetPos').addEventListener('click', async () => {
    const { ui = {} } = await chrome.storage.local.get('ui');
    await chrome.storage.local.set({ ui: Object.assign({}, ui, { x: null, y: null }) });
    $('resetPos').textContent = 'Position reset ✓';
  });

  /* ---------- test ---------- */
  const RLABEL = { 5: 'LEGEND  ', 4: 'EPIC    ', 3: 'RARE    ', 2: 'UNCOMMON', 1: 'COMMON  ', 0: 'ONLY    ' };
  $('test').addEventListener('click', async () => {
    await saveNow();
    const out = $('testOut');
    const btn = $('test');
    btn.disabled = true;
    out.textContent = 'Asking…';
    const r = await chrome.runtime.sendMessage({ type: 'rs:test', question: $('testQ').value.trim() || 'Name a country in Africa' });
    btn.disabled = false;
    if (!r || r.error) {
      out.textContent = `✗ ${r ? r.error : 'No response from the extension.'}`;
      return;
    }
    const lines = r.answers.map((a, i) => `${String(i + 1).padStart(2)}  ${RLABEL[a.rarity] || '?       '}  ${a.answer}${a.hint ? `  — ${a.hint}` : ''}`);
    out.textContent = `✓ ${r.provider} · ${r.model}\n  first answer after ${r.first} ms, ${r.answers.length} answers in ${(r.ms / 1000).toFixed(1)} s\n\n${lines.join('\n') || '(no answers parsed — try another model)'}`;
  });

  /* ---------- cache + sites ---------- */
  async function renderStore() {
    const { cache = {}, selectors = {} } = await chrome.storage.local.get(['cache', 'selectors']);
    const n = Object.keys(cache).length;
    $('cacheInfo').textContent = n ? `${n} question${n > 1 ? 's' : ''} remembered.` : 'Nothing remembered yet.';
    const list = $('selList');
    list.textContent = '';
    const hosts = Object.keys(selectors);
    $('selEmpty').style.display = hosts.length ? 'none' : '';
    for (const h of hosts) {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = h;
      const span = document.createElement('span');
      span.textContent = `“${selectors[h].sample || ''}”  ·  ${selectors[h].selector}`;
      span.title = selectors[h].selector;
      const del = document.createElement('button');
      del.className = 'small';
      del.textContent = 'Remove';
      del.onclick = async () => {
        const d = await chrome.storage.local.get('selectors');
        const sel = d.selectors || {};
        delete sel[h];
        await chrome.storage.local.set({ selectors: sel });
      };
      li.append(code, span, del);
      list.append(li);
    }
  }
  $('clearCache').addEventListener('click', async () => {
    await chrome.storage.local.set({ cache: {} });
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && (ch.cache || ch.selectors)) renderStore();
  });
  renderStore();
})();
