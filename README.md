# X Bookmarks Exporter

A Chrome extension (MV3) that scrapes, categorizes, and exports your X (Twitter) bookmarks with AI-powered tagging.

## Features

- **Auto-scrape bookmarks** — Navigate to your X Bookmarks page and scroll; the extension automatically captures tweet cards as they load.
- **AI categorization** — Uses DeepSeek API to assign categories, tags, and one-sentence summaries to your bookmarks.
- **Filter & search** — Search by keyword, filter by category or tag, sort by date.
- **Multi-format export** — Download your bookmarks as Markdown, JSON, or CSV.

## Installation

### From source (Developer mode)

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome (or any Chromium browser).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `x-bookmarks-exporter` directory.
5. The extension icon should appear in your toolbar.

### Configuration

1. Click the extension icon, then click the settings (gear) button.
2. Enter your DeepSeek API key — get one at [platform.deepseek.com](https://platform.deepseek.com).
3. Adjust storage limits and auto-categorization behavior as needed.
4. Click **Save**.

## Usage

1. Navigate to `x.com/i/bookmarks` (or `x.com/<your-handle>/bookmarks`).
2. Scroll through your bookmarks — the extension automatically scrapes new tweets as they load.
3. Open the side panel by clicking the extension icon.
4. Use the **Search** bar, **Category**, and **Tag** dropdowns to filter your bookmarks.
5. Select specific tweets (via checkboxes) and click **AI Categorize** to run AI tagging.
6. Click **Export** to download your bookmarks in Markdown, JSON, or CSV format.

## Architecture

| Module | Responsibility |
|--------|----------------|
| `content.js` | Scrapes tweet cards on the X Bookmarks page |
| `background.js` | Service worker — AI API calls, storage management, message routing |
| `sidepanel.js` | Side panel UI — tweet list, filters, export |
| `options.js` | Settings page — API key, storage limits, behavior toggles |
| `settings.js` | Shared configuration module (loaded by both background and options) |
| `prompts/` | AI categorization/summary prompt templates |

## Tech stack

- **Chrome Extension Manifest V3**
- **Side Panel API** for the main UI
- **DeepSeek API** (OpenAI-compatible `/chat/completions` endpoint)
- **chrome.storage.local** for bookmark persistence
- No build step — plain JavaScript, no dependencies

## Privacy

- All bookmarks are stored locally in `chrome.storage.local`. Nothing is sent to any server except the DeepSeek API for categorization (only tweet text is sent, never credentials).
- Your DeepSeek API key is stored locally and never transmitted anywhere except directly to `api.deepseek.com`.

## License

MIT
