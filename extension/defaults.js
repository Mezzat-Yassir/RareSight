// Shared defaults — loaded by the background worker, content script, popup and options page.
/* eslint-disable no-unused-vars */
var RS_PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    kind: 'gemini',
    model: 'gemini-flash-latest',
    keyUrl: 'https://aistudio.google.com/apikey',
    vision: true,
    note: 'Free tier available with a Google account. Reads screenshots too.'
  },
  groq: {
    label: 'Groq (fastest)',
    kind: 'openai',
    base: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    keyUrl: 'https://console.groq.com/keys',
    vision: false,
    note: 'Free tier, extremely fast. The default model is text only; for screenshots use meta-llama/llama-4-scout-17b-16e-instruct.'
  },
  anthropic: {
    label: 'Anthropic Claude',
    kind: 'anthropic',
    model: 'claude-haiku-5-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    vision: true,
    note: 'Paid. Strong general knowledge, reads screenshots.'
  },
  openai: {
    label: 'OpenAI',
    kind: 'openai',
    base: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    vision: true,
    note: 'Paid. Reads screenshots.'
  },
  openrouter: {
    label: 'OpenRouter',
    kind: 'openai',
    base: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.5-flash',
    keyUrl: 'https://openrouter.ai/keys',
    vision: true,
    note: 'One key for hundreds of models. Model names look like vendor/model.'
  },
  mistral: {
    label: 'Mistral',
    kind: 'openai',
    base: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    keyUrl: 'https://console.mistral.ai/api-keys',
    vision: true,
    note: 'Free experiment tier available.'
  },
  custom: {
    label: 'Custom (OpenAI-compatible / Ollama)',
    kind: 'openai',
    base: 'http://localhost:11434/v1',
    model: 'llama3.1',
    keyUrl: '',
    keyOptional: true,
    vision: false,
    note: 'Any OpenAI-compatible endpoint. For Ollama, start it with OLLAMA_ORIGINS=chrome-extension://* so the extension is allowed in.'
  }
};

var RS_LANGUAGES = [
  ['auto', 'Same as the question'],
  ['French', 'Français'],
  ['English', 'English'],
  ['Spanish', 'Español'],
  ['German', 'Deutsch'],
  ['Italian', 'Italiano'],
  ['Portuguese', 'Português'],
  ['Arabic', 'العربية']
];

var RS_DEFAULTS = {
  provider: 'gemini',
  providers: {},
  language: 'auto',
  count: 8,
  strategy: 'balanced',
  extraInstructions: '',
  timerSeconds: 10,
  autoSubmit: false,
  screenshotFallback: true,
  stabilityMs: 300,
  digitHotkeys: true,
  cacheEnabled: true,
  opacity: 0.96,
  fontSize: 14
};

function rsMergeSettings(stored) {
  const s = Object.assign({}, RS_DEFAULTS, stored || {});
  const provs = {};
  for (const id of Object.keys(RS_PROVIDERS)) {
    const def = RS_PROVIDERS[id];
    const cur = (stored && stored.providers && stored.providers[id]) || {};
    provs[id] = {
      key: cur.key || '',
      model: (cur.model || '').trim() || def.model,
      base: ((cur.base || '').trim() || def.base || '').replace(/\/+$/, '')
    };
  }
  s.providers = provs;
  if (!RS_PROVIDERS[s.provider]) s.provider = RS_DEFAULTS.provider;
  s.count = Math.max(1, Math.min(15, parseInt(s.count, 10) || RS_DEFAULTS.count));
  s.timerSeconds = Math.max(0, Math.min(120, Number(s.timerSeconds) || 0));
  s.stabilityMs = Math.max(0, Math.min(3000, parseInt(s.stabilityMs, 10) || 0));
  return s;
}
