# CLAUDE.md

## Project Purpose

A Chrome extension (Manifest V3) that actively crawls Facebook group feeds via GraphQL API, filters posts by configurable keywords, deduplicates across sessions, and delivers matched leads in batches to a webhook.

## Architecture

```
chrome-extension/
  background.js     - Service worker: crawler, filter, dedup, delivery, config
  content.js        - Injected into FB pages, forwards intercepted data to background
  interceptor.js    - Page-context script: hooks fetch/XHR to capture GraphQL responses + client state
  manifest.json     - MV3 manifest with storage, alarms, declarativeNetRequest permissions
  popup.html/js     - Extension popup: stats, crawl controls, group status
  options.html/js   - Settings UI: groups, schedule, keywords, keyword groups, delivery
  icons/            - Extension icons
```

## Data Flow

```
fetchGroupHtml (GET) -> extract session tokens + initial stories + cursor + client params
  -> fetchFeedPage (POST GraphQL) x max_pages -> extract stories per page
    -> processStories: exclude check -> dedup -> L1 keywords (OR) -> transform -> L2 groups (AND) -> queue
      -> flushPendingItems: batch -> webhook POST with retry
```

## Key Technical Details

- **GraphQL pagination**: POST to `/api/graphql/` with `doc_id` for `GroupsCometFeedRegularStoriesPaginationQuery`
- **Session tokens**: `fb_dtsg`, `lsd`, `userId`, `rev`, `hsi`, `spinT` extracted from HTML via regex
- **Client state**: `__dyn`, `__csr`, `__hs`, `__s`, `__ccg`, `__hsdp`, `__hblp`, `__sjsp` - captured from interceptor or extracted from HTML, with hardcoded defaults as fallback
- **doc_id auto-update**: Extracted from HTML page on each crawl; also captured by interceptor from real browser requests
- **Origin header fix**: `declarativeNetRequest` rewrites `Origin` from `chrome-extension://` to `https://www.facebook.com` for GraphQL POSTs
- **Cursor filtering**: `findPageInfo` rejects short cursors (< 20 chars) to avoid picking up comment/reaction pagination
- **Keyword matching**: Normalizes hyphens/dashes to spaces before matching (e.g., "Subject-To" matches "subject to")
- **Dedup**: `chrome.storage.local` with configurable retention days
- **Webhook**: Batched delivery with configurable batch size, delay, retry with exponential backoff

## Filtering Pipeline

1. **Exclude keywords**: Posts containing any exclude keyword are skipped immediately (no dedup write)
2. **Dedup**: Seen post IDs stored in `chrome.storage.local`
3. **Level 1 (OR)**: Post matches if N+ keywords from the keywords list are found (case-insensitive, hyphen-normalized)
4. **Level 2 (AND)**: Each enabled keyword group requires ALL its keywords present. Groups are OR'd between each other. "All" group = pass-through

## Configuration

All settings stored in `chrome.storage.sync` via the options page. Key settings:
- `groups` - Facebook group IDs with enabled/disabled toggle
- `keywords` - Level 1 OR keyword list
- `filtering.exclude_keywords` - Immediate reject list
- `filtering.min_keyword_matches` - Min L1 matches required (default 1)
- `keyword_groups` - Level 2 AND groups
- `crawl.max_pages_per_group` - GraphQL pagination depth
- `crawl.delay_between_groups` / `delay_between_pages` - Rate limiting ranges
- `crawl.doc_id` - GraphQL query ID (auto-updated)
- `crawl.interval_minutes` - Scheduled crawl interval (0 = manual)
- `webhook.url` - Delivery endpoint
- `webhook.batch_size` / `batch_delay_sec` / `retry_attempts` / `retry_backoff_sec`

## Dev Utils

- `dev-utils/graphql data.txt` - Captured curl commands for reference
- `logs/` - Service worker console logs from test runs
