# FB Lead Scraper - Chrome Extension

A Chrome extension (Manifest V3) that crawls Facebook group feeds via the GraphQL API, filters posts by configurable keywords, deduplicates across sessions, and delivers matched leads in batches to a webhook. Built for monitoring real estate investment groups for deal opportunities.

## How It Works

The extension uses your authenticated Facebook session to fetch group feeds directly, paginating through posts via Facebook's internal GraphQL API. Posts flow through a multi-stage filtering pipeline before matched leads are batched and sent to your webhook.

```
Facebook Groups
       |
       v
 HTML Fetch (GET /groups/{id}/)
   - Extract session tokens (fb_dtsg, lsd, userId)
   - Extract embedded stories + pagination cursor
       |
       v
 GraphQL Pagination (POST /api/graphql/)
   - GroupsCometFeedRegularStoriesPaginationQuery
   - Chronological sort, cursor-based paging
   - Configurable max pages per group
       |
       v
 Story Extraction
   - Find Story objects with comet_sections + post_id
   - Extract message text, timestamp, author info
       |
       v
 Filter Pipeline
   1. Exclude keywords  ---> skip (no dedup write)
   2. Dedup check        ---> skip if already seen
   3. L1 keywords (OR)   ---> case-insensitive, hyphen-normalized
   4. Transform           ---> map to lead schema
   5. L2 keyword groups (AND) ---> all keywords in group must match
       |
       v
 Batch Queue
   - Configurable batch size + delay
       |
       v
 Webhook Delivery
   - JSON envelope with lead items
   - Retry with exponential backoff
```

## Installation

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top right).
4. Click **Load unpacked** and select the `chrome-extension/` folder.
5. The extension icon will appear in your toolbar. Pin it for easy access.

## Configuration

Open the extension's options page (right-click the icon > Options) to configure all settings across six tabs.

**Groups** -- Add Facebook groups by ID or use "Load My Groups" to auto-discover groups you belong to. Enable/disable individual groups. Set max pages to crawl per group and dedup retention period.

**Schedule** -- Set the crawl interval in minutes (0 for manual-only). Configure rate limiting delays between groups and between pages to avoid triggering Facebook throttling. Override the GraphQL doc_id if needed.

**Keywords** -- Define L1 keywords (one per line). Posts matching any keyword pass the filter. Set a minimum match count to require multiple keyword hits. Matching is case-insensitive with hyphen normalization ("Subject-To" matches "subject to").

**Keyword Groups** -- Define L2 AND-groups where ALL keywords in a group must be present. Multiple groups are OR'd together. Also configure exclude keywords here -- posts containing any exclude keyword are dropped before dedup.

**Delivery** -- Set the webhook URL, batch size, batch delay between sends, and retry settings. Toggle Chrome desktop notifications for lead delivery and errors.

**Logs** -- View crawl history with per-group results (new/dup/pages), browse recent errors, and configure log retention. Clear logs and errors independently.

## Usage

**Manual crawl**: Click the extension icon to open the popup, then click **Crawl Now**. The popup shows live stats (crawls, posts scanned, matched, delivered) and per-group status with time since last crawl.

**Scheduled crawls**: Set a crawl interval on the Schedule tab. The extension uses `chrome.alarms` to trigger crawls automatically, surviving Chrome restarts and service worker shutdowns.

**Pause/Resume**: Toggle crawling on and off from the popup without changing your schedule.

**Flush Queue**: Force-send any pending matched leads that haven't been batched yet.

## Interceptor (Auto Session Refresh)

The extension includes a content script (`interceptor.js`) that runs on Facebook pages. When you browse Facebook normally, it captures fresh session parameters (`__dyn`, `__csr`, `__hs`, etc.) and the current `doc_id` from real XHR requests. These are stored and used by the crawler automatically, keeping your session parameters current without manual intervention. Hardcoded defaults are included as a fallback.

## Project Structure

```
chrome-extension/          Load this folder as an unpacked extension
  background.js            Service worker: crawler, filter, dedup, delivery
  content.js               Forwards intercepted data to the background worker
  interceptor.js           Page-context script: hooks fetch/XHR on Facebook
  manifest.json            MV3 manifest with required permissions
  popup.html / popup.js    Extension popup: stats, controls, group status
  options.html / options.js  Settings page with 6 tabs
  icons/                   Extension icons

dev-utils/                 Helper scripts for development
```

## Webhook Payload Format

Each delivery sends a JSON envelope:

```json
{
  "id": "uuid",
  "type": "leads.new",
  "created": 1700000000,
  "items": [
    {
      "provider": "facebook",
      "id": "facebook_<base64-encoded-id>",
      "url": "https://www.facebook.com/groups/.../posts/...",
      "authorName": "...",
      "authorProfileUrl": "...",
      "content": "Post text...",
      "keywords": ["keyword1", "keyword2"],
      "likes": 0,
      "postedAt": "2024-01-01T00:00:00.000Z",
      "groupId": "...",
      "groupName": "...",
      "groupUrl": "..."
    }
  ],
  "liveMode": true
}
```
