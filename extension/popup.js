(async () => {
  const $ = (id) => document.getElementById(id);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const d = await chrome.storage.local.get(['settings', 'sites', 'selectors']);
  const s = rsMergeSettings(d.settings);
  const meta = RS_PROVIDERS[s.provider];
  const p = s.providers[s.provider];

  const prov = $('prov');
  if (!p.key && !meta.keyOptional) {
    prov.classList.add('warn');
    prov.textContent = `No API key yet for ${meta.label}. `;
    const b = document.createElement('a');
    b.href = '#';
    b.textContent = 'Add one in settings →';
    b.onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
    prov.append(b);
  } else {
    prov.textContent = `${meta.label} · ${p.model}`;
  }

  let host = '';
  let usable = false;
  try {
    const u = new URL(tab.url);
    usable = /^(https?|file):$/.test(u.protocol) && !/(^|\.)chromewebstore\.google\.com$|^chrome\.google\.com$/.test(u.hostname);
    host = u.hostname || (u.protocol === 'file:' ? 'file' : '');
  } catch (e) { usable = false; }

  const on = !!(d.sites || {})[host];
  $('toggle').textContent = on ? 'Hide panel on this site' : 'Show panel on this site';
  $('unauto').hidden = !on;

  if (!usable) {
    ['toggle', 'pick', 'ask', 'shot'].forEach((id) => { $(id).disabled = true; });
    const n = document.createElement('p');
    n.className = 'note';
    n.textContent = 'RareSight can\'t run on this page (browser pages and the Web Store are off-limits). Open your game tab.';
    prov.after(n);
  }

  const send = (type) => chrome.runtime.sendMessage({ type, tabId: tab.id, windowId: tab.windowId }).catch(() => {});
  const act = (type) => () => { send(type).finally(() => window.close()); };
  $('toggle').onclick = act('rs:toggle');
  $('pick').onclick = act('rs:startPicker');
  $('ask').onclick = act('rs:askNow');
  $('shot').onclick = act('rs:askScreenshot');
  $('unauto').onclick = act('rs:clearSelectors');
  $('opt').onclick = () => chrome.runtime.openOptionsPage();
  $('editkeys').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });

  const keys = $('keys');
  const cmds = await chrome.commands.getAll();
  const label = { 'ask-now': 'Answer now', 'toggle-overlay': 'Show / hide panel', 'pick-question': 'Pick question element' };
  for (const c of cmds) {
    if (!label[c.name]) continue;
    const li = document.createElement('li');
    const a = document.createElement('span');
    a.textContent = label[c.name];
    const k = document.createElement('kbd');
    k.textContent = c.shortcut || 'not set';
    li.append(a, k);
    keys.append(li);
  }
  const li = document.createElement('li');
  li.innerHTML = '<span>Type answer #1…9</span><kbd>Alt+1…9</kbd>';
  keys.append(li);
  const li2 = document.createElement('li');
  li2.innerHTML = '<span>More answers (all new)</span><kbd>Alt+0</kbd>';
  keys.append(li2);
})();
