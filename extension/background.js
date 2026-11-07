/* RareSight background service worker
 * - talks to the AI provider (streaming) and relays answers to the panel in the top frame
 * - coordinates frames: question picker, auto-detect, typing the answer into the game input
 */
importScripts('defaults.js');

const REQUEST_TIMEOUT_MS = 25000;
const CACHE_MAX = 400;

const jobs = new Map();            // tabId -> current job
const lastInputFrame = new Map();  // tabId -> frameId of the game's answer box

/* ------------------------------------------------------------------ utils */

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return rsMergeSettings(settings);
}

function toTop(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => null);
}

function toAll(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch(() => null);
}

async function ensureInjected(tabId) {
  const pong = await chrome.tabs.sendMessage(tabId, { type: 'rs:ping' }, { frameId: 0 }).catch(() => null);
  if (pong && pong.ok) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['defaults.js', 'content.js'] });
    return true;
  } catch (e) {
    return false;
  }
}

const normQ = (q) => String(q || '').toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
const normA = (a) => String(a || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');

/* ------------------------------------------------------------------ cache */

function cacheKey(question, s) {
  return [s.language, s.count, s.strategy, s.extraInstructions.trim(), normQ(question)].join('␟');
}

// Cache entry: { a: first batch, more: [2nd batch, 3rd batch, …], t: last use }
async function cacheGet(key) {
  const { cache } = await chrome.storage.local.get('cache');
  return (cache && cache[key]) || null;
}

async function cachePut(key, answers, batch) {
  const { cache = {} } = await chrome.storage.local.get('cache');
  if (batch > 0) {
    const entry = cache[key];
    if (!entry) return;
    entry.more = entry.more || [];
    entry.more[batch - 1] = answers;
    entry.t = Date.now();
  } else {
    cache[key] = { a: answers, more: [], t: Date.now() };
  }
  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX) {
    keys.sort((x, y) => cache[x].t - cache[y].t);
    for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k];
  }
  await chrome.storage.local.set({ cache });
}

/* ------------------------------------------------------------------ prompt */

function buildSystemPrompt(s, withImage) {
  const lang = s.language === 'auto'
    ? 'the same language as the question'
    : s.language;
  const strategy = {
    balanced: 'Mostly rarity 4–5 answers, then finish with 2 safer rarity-3 backups.',
    rare: 'Only rarity 4–5 answers, except one safer rarity-3 backup at the very end.',
    extreme: 'Go for the most obscure answers that are still 100% valid (rarity 5), as long as they would appear in an encyclopedia list.'
  }[s.strategy] || '';

  let p = `You are a cheat sheet for a fast-paced general-knowledge party game.
A prompt appears on screen (for example "Name a country in Africa" or "Citez un peintre impressionniste"). Each player has less than 10 seconds to type ONE answer. The fewer other players give the same answer, the more points it scores. A wrong or unrecognized answer scores nothing.

Your job: list answers that are CORRECT and that the game will ACCEPT, but that most players would not think of.

Output ONLY lines in this exact format — no introduction, no numbering, no markdown, no blank lines:
R|ANSWER|HINT
- R = rarity from 1 (what everyone says) to 5 (almost nobody would think of it).
- ANSWER = the shortest usual way to type it, written in ${lang}, with standard spelling. No articles, no parentheses, no extra words.
- HINT = 2 to 6 words explaining why it is valid.

Give exactly ${s.count} lines, rarest first. ${strategy}
Rules:
- Only answers you are certain are true. Never invent names, titles or facts.
- Prefer answers notable enough to appear in Wikipedia or a reference list, so the game recognizes them.
- If the prompt has a constraint (starting letter, number of letters, period, country…), every answer must respect it.
- If the question has only ONE correct answer (e.g. "What is the capital of Australia?"), output a single line with R=0 and that answer.`;

  if (withImage) {
    p += `

The input is a screenshot of the game. FIRST output one line "Q|<the question exactly as written on screen>", then the answer lines. Ignore menus, chat, scores, player names and ads.`;
  }
  if (s.extraInstructions && s.extraInstructions.trim()) {
    p += `

Extra instructions from the player (follow them): ${s.extraInstructions.trim()}`;
  }
  return p;
}

/* ------------------------------------------------------------------ line parser */

function parseLine(raw) {
  let line = String(raw).replace(/\r/g, '').trim();
  if (!line || /^```/.test(line)) return null;
  line = line
    .replace(/^(?:[-*•–]\s+|\d{1,2}[.)]\s+)/, '')
    .replace(/\*\*/g, '')
    .trim();
  if (!line) return null;

  const qm = line.match(/^Q\s*[|:]\s*(.+)$/i);
  if (qm) return { type: 'question', text: qm[1].trim() };

  const parts = line.split('|').map((x) => x.trim());
  let rarity = null;
  let answer;
  let hint = '';
  if (parts.length >= 2 && /^R$/i.test(parts[0]) && /^ANSWER$/i.test(parts[1])) return null; // echoed header
  if (parts.length >= 2 && /^[0-5](?:\s*\/\s*5)?$/.test(parts[0])) {
    rarity = parseInt(parts[0], 10);
    answer = parts[1];
    hint = parts.slice(2).filter(Boolean).join(' · ');
  } else if (parts.length >= 2) {
    answer = parts[0];
    hint = parts.slice(1).filter(Boolean).join(' · ');
  } else {
    if (line.length > 60 || /[:：]$/.test(line) || /^(here|voici|sure|okay|ok,|note|answers?\b|réponses?\b)/i.test(line)) return null;
    answer = line;
  }
  answer = String(answer || '').replace(/^["'«“`]+|["'»”`]+$/g, '').trim();
  if (!answer || answer.length > 80) return null;
  return { type: 'answer', rarity, answer, hint };
}

/* ------------------------------------------------------------------ HTTP / SSE */

async function httpError(res) {
  let text = '';
  try { text = await res.text(); } catch (e) { /* ignore */ }
  let msg = text;
  try {
    let j = JSON.parse(text);
    if (Array.isArray(j)) j = j[0];
    msg = (j && j.error && (j.error.message || j.error)) || j.message || j.detail || text;
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
  } catch (e) { /* not json */ }
  const err = new Error(String(msg || res.statusText).slice(0, 300));
  err.status = res.status;
  return err;
}

async function postStream(url, headers, body, signal, fallbackBody) {
  const doFetch = (b) => fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers),
    body: JSON.stringify(b),
    signal
  });
  let res = await doFetch(body);
  if (res.status === 400 && fallbackBody) {
    // Usually an optional parameter this model doesn't support (thinking level, reasoning effort…). Retry without.
    await res.text().catch(() => '');
    res = await doFetch(fallbackBody);
  }
  if (!res.ok) throw await httpError(res);
  return res;
}

async function* sseData(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) {
        const d = line.slice(5).trim();
        if (d === '[DONE]') return;
        if (d) yield d;
      }
    }
  }
  const tail = buf.trim();
  if (tail.startsWith('data:')) {
    const d = tail.slice(5).trim();
    if (d && d !== '[DONE]') yield d;
  }
}

/* ------------------------------------------------------------------ providers */

async function* streamAnthropic(cfg, system, userText, image, signal) {
  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } });
  content.push({ type: 'text', text: userText });
  const res = await postStream('https://api.anthropic.com/v1/messages', {
    'x-api-key': cfg.key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  }, {
    model: cfg.model,
    max_tokens: 700,
    system,
    messages: [{ role: 'user', content }],
    stream: true
  }, signal);
  for await (const d of sseData(res)) {
    let ev;
    try { ev = JSON.parse(d); } catch (e) { continue; }
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') yield ev.delta.text;
    else if (ev.type === 'error') throw new Error((ev.error && ev.error.message) || 'Anthropic stream error');
  }
}

async function* streamOpenAI(cfg, system, userText, image, signal) {
  const user = image
    ? [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.data}` } }]
    : userText;
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const reasoning = /(^|\/)(o\d|gpt-5|gpt-oss)/i.test(cfg.model);
  const body = { model: cfg.model, stream: true, messages };
  if (reasoning) {
    body.reasoning_effort = 'low';
    body.max_completion_tokens = 3000;
  } else {
    body.max_tokens = 700;
  }
  const headers = {};
  if (cfg.key) headers.authorization = `Bearer ${cfg.key}`;
  if (/openrouter\.ai/.test(cfg.base)) {
    headers['HTTP-Referer'] = 'https://github.com/raresight';
    headers['X-Title'] = 'RareSight';
  }
  const res = await postStream(`${cfg.base}/chat/completions`, headers, body, signal, { model: cfg.model, stream: true, messages });
  for await (const d of sseData(res)) {
    let j;
    try { j = JSON.parse(d); } catch (e) { continue; }
    if (j.error) throw new Error(j.error.message || 'Stream error');
    const c = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
    if (typeof c === 'string' && c) yield c;
    else if (Array.isArray(c)) {
      for (const part of c) if (part && part.type === 'text' && part.text) yield part.text;
    }
  }
}

function geminiThinking(model) {
  const m = model.toLowerCase();
  if (/gemini-2\.5-flash/.test(m)) return { thinkingBudget: 0 };
  if (/gemini-(\d+(\.\d+)?-)?(flash|pro)|gemini-[3-9]|latest/.test(m) && !/gemini-(1|2)\./.test(m)) return { thinkingLevel: 'minimal' };
  return null;
}

async function* streamGemini(cfg, system, userText, image, signal) {
  const parts = [];
  if (image) parts.push({ inlineData: { mimeType: image.mime, data: image.data } });
  parts.push({ text: userText });
  const base = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }]
  };
  const thinking = geminiThinking(cfg.model);
  const body = Object.assign({}, base, {
    generationConfig: Object.assign({ maxOutputTokens: 2048 }, thinking ? { thinkingConfig: thinking } : {})
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`;
  const res = await postStream(url, { 'x-goog-api-key': cfg.key }, body, signal, thinking ? base : null);
  for await (const d of sseData(res)) {
    let j;
    try { j = JSON.parse(d); } catch (e) { continue; }
    if (j.error) throw new Error(j.error.message || 'Gemini stream error');
    const cand = j.candidates && j.candidates[0];
    if (!cand) {
      if (j.promptFeedback && j.promptFeedback.blockReason) throw new Error(`Blocked by Gemini (${j.promptFeedback.blockReason})`);
      continue;
    }
    const ps = (cand.content && cand.content.parts) || [];
    for (const p of ps) if (p.text && !p.thought) yield p.text;
  }
}

/* ------------------------------------------------------------------ generation */

async function generate(s, input, signal, onItem) {
  const meta = RS_PROVIDERS[s.provider];
  const p = s.providers[s.provider];
  const cfg = { key: p.key, model: p.model, base: p.base || meta.base };
  const system = buildSystemPrompt(s, !!input.image);
  let userText = input.image
    ? 'Here is the screenshot of the game. Read the question and answer in the required format.'
    : `Question: ${input.question}`;
  if (input.exclude && input.exclude.length) {
    userText += `\n\nALREADY SUGGESTED — do NOT repeat any of these, nor spelling variants, translations or alternative names of them:\n${input.exclude.slice(-120).join('; ')}\n\nGive ${s.count} NEW valid answers, different from all of the above, same format and rules, rarest first. If no other valid answers exist, output nothing.`;
  }
  const streamer = meta.kind === 'anthropic' ? streamAnthropic : meta.kind === 'gemini' ? streamGemini : streamOpenAI;

  let buf = '';
  const flush = (line) => { const it = parseLine(line); if (it) onItem(it); };
  for await (const chunk of streamer(cfg, system, userText, input.image, signal)) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      flush(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }
  if (buf.trim()) flush(buf);
}

function friendlyError(e) {
  if (!e) return 'Unknown error';
  if (e.timeout) return 'The AI took too long (over 25 s). Try a faster model.';
  const st = e.status;
  const m = e.message || String(e);
  if (st === 401 || st === 403) return `API key rejected (${st}). Check it in settings. ${m}`;
  if (st === 404) return `Model or endpoint not found (404). Check the model name in settings. ${m}`;
  if (st === 429) return `Rate limit or quota reached (429). Wait a bit or use another provider. ${m}`;
  if (st) return `Provider error ${st}: ${m}`;
  if (/Failed to fetch|NetworkError|ERR_/i.test(m)) return `Network error: cannot reach the AI provider. ${m}`;
  return m;
}

async function runAsk(tabId, opts) {
  const question = (opts.question || '').trim();
  const image = opts.image || null;
  const source = opts.source || 'manual';
  if (!tabId || (!question && !image)) return;
  const s = await getSettings();

  const prev = jobs.get(tabId);
  if (!opts.force && question && prev && normQ(prev.question) === normQ(question) && Date.now() - prev.at < 4000) return;
  if (prev && prev.controller) prev.controller.abort();

  const more = opts.more || null; // { seen: [answers already shown], batch: n } when refreshing
  const job = {
    id: Math.random().toString(36).slice(2),
    controller: new AbortController(),
    question,
    image,
    at: Date.now(),
    answers: [],
    seen: more ? more.seen.slice() : [],
    batch: more ? more.batch : 0
  };
  jobs.set(tabId, job);
  const send = (m) => toTop(tabId, Object.assign({ type: 'rs:event', id: job.id }, m));
  const meta = RS_PROVIDERS[s.provider];
  const pconf = s.providers[s.provider];
  const isSeen = (ans) => job.seen.some((x) => normA(x) === normA(ans));
  const accept = (item) => {
    if (isSeen(item.answer)) return false;
    job.answers.push(item);
    job.seen.push(item.answer);
    return true;
  };

  send({ kind: 'start', question, source, more: !!more, withImage: !!image && !question, timer: s.timerSeconds, provider: `${meta.label} · ${pconf.model}` });

  if (question && s.cacheEnabled) {
    const entry = await cacheGet(cacheKey(question, s));
    const batch = entry && (job.batch === 0 ? entry.a : entry.more && entry.more[job.batch - 1]);
    if (batch && batch.length) {
      batch.forEach(accept);
      if (job.answers.length) {
        send({ kind: 'answers', answers: job.answers });
        send({ kind: 'done', cached: true, more: !!more, ms: Date.now() - job.at, count: job.answers.length });
        return;
      }
    }
  }
  if (!pconf.key && !meta.keyOptional) {
    send({ kind: 'error', message: `No API key for ${meta.label}. Open settings (⚙) and paste one.` });
    return;
  }

  const t0 = Date.now();
  let qText = question;
  let first = 0;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; job.controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    const input = { question, image: question ? null : image, exclude: job.seen.slice() };
    await generate(s, input, job.controller.signal, (item) => {
      if (jobs.get(tabId) !== job) return;
      if (item.type === 'question') {
        qText = item.text;
        job.question = item.text;
        send({ kind: 'question', text: item.text });
        return;
      }
      if (!accept(item)) return;
      if (!first) first = Date.now() - t0;
      send({ kind: 'answer', answer: item, index: job.answers.length - 1, ms: Date.now() - t0 });
    });
    if (jobs.get(tabId) !== job) return;
    send({ kind: 'done', more: !!more, ms: Date.now() - t0, first, count: job.answers.length });
    if (s.cacheEnabled && qText && job.answers.length) cachePut(cacheKey(qText, s), job.answers, job.batch).catch(() => {});
  } catch (e) {
    if (jobs.get(tabId) !== job) return;
    if (e && e.name === 'AbortError' && !timedOut) return;
    if (timedOut) e.timeout = true;
    send({ kind: 'error', message: friendlyError(e) });
  } finally {
    clearTimeout(timer);
  }
}

// "More answers": same question, new batch, nothing already suggested.
async function moreAnswers(tabId) {
  let base = jobs.get(tabId);
  if (!base || (!base.question && !base.image)) {
    // The worker may have been restarted: rebuild the context from what the panel shows.
    const c = await chrome.tabs.sendMessage(tabId, { type: 'rs:getContext' }, { frameId: 0 }).catch(() => null);
    if (c && c.question) base = { question: c.question, image: null, seen: c.seen || [], batch: c.batch || 0 };
  }
  if (!base || (!base.question && !base.image)) {
    toTop(tabId, { type: 'rs:toast', tone: 'warn', text: 'No question yet: nothing to refresh.' });
    return;
  }
  return runAsk(tabId, {
    question: base.question,
    image: base.image,
    source: 'more',
    force: true,
    more: { seen: base.seen || [], batch: (base.batch || 0) + 1 }
  });
}

/* ------------------------------------------------------------------ screenshot */

function toBase64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

async function downscale(dataUrl, maxW) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxW / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    return { mime: 'image/jpeg', data: toBase64(new Uint8Array(await out.arrayBuffer())) };
  } catch (e) {
    return { mime: 'image/jpeg', data: dataUrl.split(',')[1] };
  }
}

async function screenshotAsk(tabId, windowId) {
  const s = await getSettings();
  if (!RS_PROVIDERS[s.provider].vision) {
    toTop(tabId, { type: 'rs:toast', tone: 'warn', text: `Screenshot mode needs a vision model. ${RS_PROVIDERS[s.provider].label}'s default model reads text only — select the question text instead, or switch provider/model in settings.` });
  }
  await toTop(tabId, { type: 'rs:prepareCapture' });
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 85 });
  } catch (e) {
    toTop(tabId, { type: 'rs:captureDone' });
    toTop(tabId, { type: 'rs:toast', tone: 'error', text: `Screenshot failed: ${e.message}` });
    return;
  }
  toTop(tabId, { type: 'rs:captureDone' });
  const image = await downscale(dataUrl, 1400);
  return runAsk(tabId, { image, source: 'screenshot', force: true });
}

/* ------------------------------------------------------------------ actions */

async function askNow(tabId, windowId) {
  if (!(await ensureInjected(tabId))) return;
  await toTop(tabId, { type: 'rs:show' });
  let sel = '';
  let tracked = '';
  let typed = '';
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({
        sel: String(getSelection() || '').trim(),
        tracked: globalThis.__rsTracked || '',
        typed: globalThis.__rsTyped || ''
      })
    });
    for (const r of res) {
      const v = r.result || {};
      if (!sel && v.sel) sel = v.sel;
      if (!tracked && v.tracked) tracked = v.tracked;
      if (!typed && v.typed) typed = v.typed;
    }
  } catch (e) { /* restricted page */ }
  if (sel) return runAsk(tabId, { question: sel.slice(0, 600), source: 'selection', force: true });
  if (tracked) return runAsk(tabId, { question: tracked, source: 'auto', force: true });
  if (typed) return runAsk(tabId, { question: typed, source: 'manual', force: true });
  const s = await getSettings();
  if (s.screenshotFallback) return screenshotAsk(tabId, windowId);
  toTop(tabId, { type: 'rs:toast', tone: 'warn', text: 'Select the question text first, pick the question element, or enable screenshot mode in settings.' });
}

async function startPicker(tabId) {
  if (!(await ensureInjected(tabId))) return;
  await toTop(tabId, { type: 'rs:show' });
  toAll(tabId, { type: 'rs:picker', on: true });
}

async function insertIntoGame(tabId, text) {
  const s = await getSettings();
  const msg = { type: 'rs:insertText', text, submit: s.autoSubmit };
  const tryFrame = (frameId) => chrome.tabs.sendMessage(tabId, msg, { frameId }).catch(() => null);

  let frameId = lastInputFrame.get(tabId);
  if (frameId === undefined) {
    const st = await chrome.storage.session.get(`if${tabId}`).catch(() => ({}));
    frameId = st[`if${tabId}`];
  }
  if (frameId !== undefined) {
    const r = await tryFrame(frameId);
    if (r && r.ok) return r;
  }
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (globalThis.__rsInputScore ? globalThis.__rsInputScore() : 0)
    });
    const cands = res.filter((r) => r.result > 0 && r.frameId !== frameId).sort((a, b) => b.result - a.result);
    for (const c of cands) {
      const r = await tryFrame(c.frameId);
      if (r && r.ok) {
        lastInputFrame.set(tabId, c.frameId);
        return r;
      }
    }
  } catch (e) { /* ignore */ }
  return { ok: false, reason: 'no-input' };
}

async function pickAnswer(tabId, index) {
  const job = jobs.get(tabId);
  let text = job && job.answers[index] && job.answers[index].answer;
  if (!text) {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'rs:getAnswer', index }, { frameId: 0 }).catch(() => null);
    text = r && r.text;
  }
  if (!text) return { ok: false, reason: 'no-answer' };
  toTop(tabId, { type: 'rs:marked', index });
  const r = await insertIntoGame(tabId, text);
  if (!r.ok) toTop(tabId, { type: 'rs:toast', tone: 'warn', text: `Couldn't find the game's answer box for “${text}”. Click into it once, then try again.` });
  return r;
}

async function testRun(question) {
  const s = await getSettings();
  const meta = RS_PROVIDERS[s.provider];
  const p = s.providers[s.provider];
  if (!p.key && !meta.keyOptional) return { error: `No API key for ${meta.label}.` };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  const t0 = Date.now();
  let first = 0;
  const answers = [];
  try {
    await generate(s, { question }, controller.signal, (it) => {
      if (it.type !== 'answer') return;
      if (!first) first = Date.now() - t0;
      answers.push(it);
    });
    return { answers, ms: Date.now() - t0, first, provider: meta.label, model: p.model };
  } catch (e) {
    if (timedOut) e.timeout = true;
    return { error: friendlyError(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

/* ------------------------------------------------------------------ listeners */

chrome.commands.onCommand.addListener(async (command, tab) => {
  tab = (tab && tab.id) ? tab : await activeTab();
  if (!tab || !tab.id) return;
  if (command === 'ask-now') askNow(tab.id, tab.windowId);
  else if (command === 'toggle-overlay') {
    if (await ensureInjected(tab.id)) toTop(tab.id, { type: 'rs:toggle' });
  } else if (command === 'pick-question') startPicker(tab.id);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  const tabId = msg.tabId != null ? msg.tabId : sender.tab && sender.tab.id;
  const windowId = msg.windowId != null ? msg.windowId : sender.tab && sender.tab.windowId;

  switch (msg.type) {
    case 'rs:ask':
      runAsk(tabId, { question: msg.question, source: msg.source || 'manual', force: true });
      break;
    case 'rs:askNow':
      askNow(tabId, windowId);
      break;
    case 'rs:more':
      moreAnswers(tabId);
      break;
    case 'rs:askScreenshot':
      ensureInjected(tabId).then(() => toTop(tabId, { type: 'rs:show' })).then(() => screenshotAsk(tabId, windowId));
      break;
    case 'rs:question':
      runAsk(tabId, { question: msg.text, source: 'auto' });
      break;
    case 'rs:inputFocused':
      if (tabId != null) {
        lastInputFrame.set(tabId, sender.frameId);
        chrome.storage.session.set({ [`if${tabId}`]: sender.frameId }).catch(() => {});
      }
      break;
    case 'rs:pickAnswer':
      pickAnswer(tabId, msg.index).then(sendResponse);
      return true;
    case 'rs:insert':
      insertIntoGame(tabId, msg.text).then(sendResponse);
      return true;
    case 'rs:startPicker':
      startPicker(tabId);
      break;
    case 'rs:pickerEnd':
      toAll(tabId, { type: 'rs:picker', on: false });
      if (msg.picked) {
        toTop(tabId, { type: 'rs:toast', tone: 'ok', text: `Auto-detect on. Watching: “${(msg.sample || '').slice(0, 80)}”` });
      }
      break;
    case 'rs:clearSelectors':
      toAll(tabId, { type: 'rs:clearSelector' });
      toTop(tabId, { type: 'rs:autoState', on: false });
      break;
    case 'rs:autoState':
      toTop(tabId, { type: 'rs:autoState', on: msg.on, sample: msg.sample });
      break;
    case 'rs:toggle':
      ensureInjected(tabId).then((ok) => ok && toTop(tabId, { type: 'rs:toggle' }));
      break;
    case 'rs:openOptions':
      chrome.runtime.openOptionsPage();
      break;
    case 'rs:test':
      testRun(msg.question).then(sendResponse);
      return true;
    default:
      break;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const j = jobs.get(tabId);
  if (j && j.controller) j.controller.abort();
  jobs.delete(tabId);
  lastInputFrame.delete(tabId);
  chrome.storage.session.remove(`if${tabId}`).catch(() => {});
});

chrome.webNavigation && chrome.webNavigation.onCommitted && chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) lastInputFrame.delete(d.tabId);
});

chrome.runtime.onInstalled.addListener(async (details) => {
  // Make the extension work in tabs that were already open.
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const t of tabs) {
    chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['defaults.js', 'content.js'] }).catch(() => {});
  }
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
