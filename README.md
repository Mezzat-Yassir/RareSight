# RareSight: a rare-answer cheat screen for speed trivia

A Chrome / Edge / Brave extension. It reads the question as it appears in a browser trivia game and asks a fast AI model for answers that are valid but rare. The answers stream into a floating panel, rarest first, usually within about a second. Pick one with a click or **Alt+1…9** and it is typed straight into the game.

## Install (2 minutes)

1. Unzip this folder somewhere permanent (don't delete it afterwards: Chrome loads the extension from there).
2. Open `chrome://extensions` (Edge: `edge://extensions`) and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension` folder.
4. The settings page opens. Choose a provider, paste an API key and click **Run test**.
   - **Groq** is the fastest and has a free key: console.groq.com/keys. With its default model it reads text only.
   - **Google Gemini** has a free key: aistudio.google.com/apikey. It can also read questions from screenshots.
   - Anthropic, OpenAI, OpenRouter, Mistral, or any OpenAI-compatible server (Ollama…) also work.
5. Pin the RareSight icon to your toolbar.

## Use it in a game

| Step | What to do |
|---|---|
| Show the panel | **Alt+Shift+S** or toolbar icon → *Show panel on this site* |
| Set up auto mode (once per game) | When a question is on screen, click **◎** in the panel (or **Alt+Shift+E**) and click the question text. **↑/↓** make the box bigger or smaller, **Enter** confirms, **Esc** cancels. |
| Play | Every new question is answered automatically. Click into the game's answer box once at the start of the game so RareSight knows where to type. |
| Type an answer | Click it in the panel, or press **Alt+1…Alt+9** |
| More answers | Click **↻ More answers** or press **Alt+0**: a new batch, none of them already shown. Press again for even more. Earlier answers stay below as small chips you can still click. |
| No auto mode? | Select the question text and press **Alt+Shift+Q**. With nothing selected, it takes a screenshot and reads the question from it (needs Gemini, Claude, OpenAI or another vision model). |

Rarity badges: **LEGEND** (almost nobody says it) › **EPIC** › **RARE** › **UNCOMMON** › **COMMON**. **ONLY ANSWER** means the question has just one correct answer.

### Useful settings
- **Press Enter automatically** sends the answer as soon as it is typed.
- **Rarity strategy**: *Balanced* adds two safer backups at the end; *Extreme* goes for the most obscure answers that are still valid.
- **Extra instructions** let you describe the game's rules, e.g. "one word only", "no accents", "the game is in French".
- **Remember answers**: questions that come back are answered instantly, with no API call.
- **Compact mode** (– button) makes the panel smaller and **opacity** fades it.

## Troubleshooting
- **A shortcut shows "not set"** in the popup: Chrome already uses that key on your system. Pick another at `chrome://extensions/shortcuts`.
- **"Couldn't find the game's answer box"**: click into the game's text field once, then try again.
- **The question is never detected**: pick a smaller element that holds only the question text, not the timer or the whole card. You can remove saved picks in Settings → *Memory & sites*.
- **Error 401/403**: wrong key. **429**: free-tier rate limit; wait a moment or switch provider. **404**: the model name is wrong. Clear the Model field to go back to the default.
- **It does nothing on a tab that was open before you installed**: reload that tab once.
- **Ollama**: start it with `OLLAMA_ORIGINS=chrome-extension://*` so it accepts requests from the extension.

## Practice
Open `practice.html` (included) for a fake 10-second trivia game you can try it on. For `file://` pages, turn on **Allow access to file URLs** in the extension's Details page, or serve the file with `python -m http.server`.

Your API keys stay in your browser (`chrome.storage.local`) and are only sent to the provider you choose.
