# Pipeline Button

> Add any LinkedIn company to your Monday pipeline in one click. No copy-paste, no tab switching.

## How it works

- Visit any LinkedIn company page — a blue **＋ Add to Pipeline** button appears below the company name
- Click it once — the extension scrapes the company's name, industry, size, description, HQ, and website
- A new item is created on your Monday board and a structured comment with all details is posted automatically

## Install

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `pipeline-button` folder

## Setup

1. Click the Pipeline Button extension icon in the Chrome toolbar
2. Paste your **Monday API token** (Personal API Token from monday.com → Profile → API)
3. Enter your **Board ID** (the number in the URL of your Monday board, e.g. `1234567890`)
4. Click **Save Settings** — the popup verifies the connection and shows your board name

## What gets added to Monday

A new **item** is created with the company name, plus a **comment** containing:

```
🔗 LinkedIn: https://www.linkedin.com/company/acme/
🏭 Industry: Software Development
👥 Size: 501–1,000 employees
📍 HQ: San Francisco, CA
🌐 Website: https://acme.com
📝 About: Acme builds...
➕ Added via Pipeline Button on 2026-05-27
```

## Generating icons

Icons are generated programmatically (no design tool needed):

```bash
node generate-icons.js
```

This creates `icons/icon-16.png`, `icons/icon-48.png`, `icons/icon-128.png` — blue circles with a white + symbol.

## Running tests

```bash
node --test tests/logic.test.js
```

All 10 scenarios must pass before deploying.

## Security

- **Token stored encrypted** — `chrome.storage.sync` is encrypted by Chrome at rest and synced via your Google account. It is never written to `localStorage`, `sessionStorage`, or the DOM.
- **Token never leaves your browser** except in the `Authorization` header of requests to `https://api.monday.com` only.
- **Token masked in the popup** — after saving, only the last 4 characters are visible (`••••••••xxxx`).
- **No hardcoded secrets** — grep for any token pattern returns nothing.
- **GraphQL variables** — all Monday mutations use `$variables`, so company names with `"`, `{`, `}`, `\` cannot inject into the query.
- **`assertSafe()` guard** — background.js blocks any GraphQL string containing destructive operations (`delete_item`, `delete_board`, etc.) before the network call is made.
- **Minimal permissions** — the manifest requests only `storage`. No `tabs`, no `webRequest`, no `browsingData`, no broad host permissions.
- **Content script isolation** — all button DOM manipulation uses `textContent` and `createElement`. No `eval()`, no `innerHTML` with dynamic data, no `document.write()`.
- **Prototype pollution guard** — company names equal to `__proto__`, `constructor`, or `prototype` are rejected before any object operations.

## Permissions explained

| Permission | Why |
|---|---|
| `storage` | Saves your API token and board ID securely |
| `https://www.linkedin.com/company/*` | Injects the button on company pages |
| `https://api.monday.com/*` | Lets the background service worker call the Monday API |

## License

MIT
