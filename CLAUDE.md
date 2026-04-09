# CLAUDE.md

## Project Purpose

A Chrome extension (Manifest V3) that actively crawls Facebook group feeds via GraphQL API, filters posts by configurable keywords, deduplicates across sessions, and delivers matched leads in batches to a webhook. Built for monitoring real estate investment groups (Atlanta REI, creative finance, seller financing) for deal opportunities.

## Origin

This project was extracted from `filtering-agent/` which contains a Python server-side scraper. The Python scraper was limited to 1 post per group (no pagination), so the approach shifted to a Chrome extension that leverages the user's authenticated Facebook session for full GraphQL API access. The Python project still exists independently at `../filtering-agent/` with its own pipeline (scraper.py, filter.py, transformer.py, delivery.py, state.py).

## Architecture

```
chrome-extension/             # Load this folder in chrome://extensions (Developer mode)
  background.js     (~1100 lines) - Service worker: crawler, filter, dedup, delivery, config
  content.js        - Injected into FB group pages, forwards intercepted data to background
  interceptor.js    - Page-context script: hooks fetch/XHR to capture GraphQL responses + client state params
  manifest.json     - MV3 manifest: storage, alarms, declarativeNetRequest permissions
  popup.html/js     - Extension popup: stats, crawl controls, per-group status
  options.html/js   - Settings UI: 5 tabs (Groups, Schedule, Keywords, Keyword Groups, Delivery)
  icons/            - Extension icons (placeholder)

dev-utils/
  graphql data.txt        - Captured curl commands showing real Facebook GraphQL requests (reference)
  restore-config.js       - Paste in service worker console to restore default config
  restore-client-state.js - Paste in service worker console to restore captured client state params

logs/                       - Console log dumps from test runs (gitignored)
```

## Data Flow

```
crawlAllGroups()
  for each enabled group:
    fetchGroupHtml(groupId)          GET https://www.facebook.com/groups/{id}/
      -> extractSessionFromHtml()    fb_dtsg, lsd, userId, rev, hsi, spinT, client params, doc_id
      -> extractJsonScripts()        <script type="application/json"> tags
      -> findStories()               __typename:"Story" with comet_sections + post_id
      -> findPageInfo()              end_cursor (>20 chars to skip comment pagination)
      -> processStories()            exclude -> dedup -> L1 keywords -> transform -> L2 groups -> queue

    while cursor && hasNext && page < maxPages:
      fetchFeedPage(groupId, cursor) POST /api/graphql/ with doc_id, variables, client state
        -> parseGraphQLResponse()    newline-delimited JSON, strip "for (;;);" prefix
        -> findStories() + findPageInfo()
        -> processStories()

  flushPendingItems()                batch -> webhook POST with retry + exponential backoff
```

## Key Technical Details

### Facebook GraphQL API
- **Endpoint**: `POST https://www.facebook.com/api/graphql/`
- **Query**: `GroupsCometFeedRegularStoriesPaginationQuery` with doc_id (currently `34704208309223645`, auto-updated)
- **Sorting**: `CHRONOLOGICAL` (newest first, no early-stop needed)
- **Pagination**: cursor-based via `end_cursor` / `has_next_page`
- **Response format**: Newline-delimited JSON prefixed with `for (;;);` (anti-hijacking, stripped before parsing)

### Session & Authentication
- **Session tokens**: `fb_dtsg` (CSRF), `lsd`, `userId`, `rev`, `hsi`, `spinT` - extracted from group HTML via regex on every crawl
- **jazoest**: `"2" + sum(charCodes(fb_dtsg))` - Facebook security hash
- **Client state params**: `__dyn`, `__csr`, `__hs`, `__s`, `__ccg`, `__hsdp`, `__hblp`, `__sjsp` - opaque Facebook client fingerprints
  - Hardcoded defaults in `DEFAULT_CLIENT_STATE` (work for weeks/months)
  - Auto-refreshed by interceptor when user browses Facebook (captures from real XHR requests)
  - Attempted extraction from HTML prefetch links / JSON blobs on each crawl
- **Origin header**: `declarativeNetRequest` rule rewrites `Origin` from `chrome-extension://` to `https://www.facebook.com` (without this, Facebook returns error 1357004)
- **doc_id auto-update**: Extracted from HTML on each crawl; also captured by interceptor. Falls back to hardcoded default.

### Story Extraction (ported from Python scraper.py)
- `findStories(obj)` - recursive search for `{__typename: "Story", comet_sections: {...}, post_id: "..."}`
- `extractMessage(story)` - navigates `comet_sections.content.story.comet_sections.message.story.message.text`
- `extractTimestamp(story)` - `comet_sections.timestamp.story.creation_time` (unix seconds)
- `extractPost(story)` - assembles {post_id, post_url, user_id, username, text, timestamp}

### Filtering Pipeline
1. **Exclude keywords**: Posts containing any exclude keyword skipped immediately (NO dedup write - saves storage)
2. **Dedup**: `isNewPost(id)` checks `chrome.storage.local` seen-posts map with configurable retention
3. **L1 keywords (OR)**: `matchKeywords()` - case-insensitive, hyphen-normalized ("Subject-To" matches "subject to"). Configurable min match count.
4. **Transform**: `transformPost()` - maps to lead schema with `facebook_` + base64 encoded ID
5. **L2 keyword groups (AND)**: `applyKeywordGroups()` - each group requires ALL keywords present. Groups OR'd between each other. "All" group = pass-through.

### Keyword Normalization
`normalizeText()` replaces hyphens and all Unicode dash characters (U+2010-U+2015) with spaces before matching. Applied consistently to L1, L2, and exclude keyword checks.

### Webhook Delivery
- **Envelope**: `{id: uuid, type: "leads.new", created: unix_ts, items: [...], liveMode: true}`
- **Lead schema**: `{provider, id, url, authorName, authorProfileUrl, content, keywords, likes, postedAt, groupId, groupName, groupUrl}`
- **Post ID encoding**: `"facebook_" + base64("S:_I{userId}:VK:{postId}")`
- **Batching**: Configurable `batch_size` (default 12), `batch_delay_sec` (default 20)
- **Retry**: Exponential backoff with configurable attempts and base delay

### Chrome Extension Specifics
- **MV3 service worker**: No persistent background page. `chrome.alarms` for scheduled crawls survive worker restarts.
- **Alarm management**: `ensureAlarm()` preserves existing countdown on startup. `setupAlarm()` force-recreates (only on config save).
- **Storage**: `chrome.storage.sync` for config (synced across Chrome profiles), `chrome.storage.local` for dedup, stats, client state, crawl logs
- **Permissions**: `storage`, `alarms`, `declarativeNetRequest`, host_permissions for `facebook.com`

## Configuration (Options Page)

All settings in `chrome.storage.sync`. 5 tabs:

| Tab | Settings |
|-----|----------|
| **Groups** | Load My Groups (auto-discover), checkbox enable/disable, manual add by ID, pages per group, dedup retention days |
| **Schedule** | Crawl interval (0=manual), rate limiting (delay between groups, delay between pages) with min/max ranges, GraphQL doc_id |
| **Keywords** | L1 keyword list (textarea, one per line), min match count |
| **Keyword Groups** | L2 AND groups (dynamic add/remove, each has checkbox + name + keywords textarea), exclude keywords list |
| **Delivery** | Webhook URL, batch size, batch delay, retry attempts, retry backoff |

## Popup UI

- Stats grid: Crawls, Posts, Matched, Delivered, Intercepted, Pending
- Per-group rows: time since last crawl, new/dup counts, latest post date
- Buttons: Crawl Now, Pause/Resume, Flush Queue, Reset
- Next crawl countdown (from chrome.alarms)
- Settings link

## Known Issues & Limitations

- **1 story from initial HTML**: Facebook only embeds ~1 post in the initial server-rendered HTML. The rest require GraphQL pagination.
- **Empty text stories**: Some stories have `comet_sections` but no extractable message text (likely image/video-only posts). These are skipped with logging.
- **MV3 service worker lifecycle**: Chrome kills idle service workers after 30s. During delay sleeps between pages/groups, the worker could theoretically be killed. Not yet addressed (Phase B).
- **Client state staleness**: `__dyn`, `__csr` etc. change when Facebook deploys. Hardcoded defaults work for weeks. Auto-refresh via interceptor requires user to browse Facebook at least once after extension install.

## Development Phases

### Completed
- **Phase 1**: Core active crawler (fetchGroupHtml -> GraphQL pagination -> processStories -> delivery)
- **Settings UI**: Full options page with 5 tabs, Load My Groups auto-discovery
- **Popup UI**: Stats, per-group status, crawl controls, alarm countdown
- **Passive interception**: content.js + interceptor.js capture responses while browsing
- **Keyword normalization**: Hyphen/dash to space for matching
- **Dedup optimization**: Exclude check before dedup write (saves storage)
- **Alarm fix**: ensureAlarm() preserves countdown across service worker restarts
- **Origin header fix**: declarativeNetRequest for GraphQL POSTs
- **Client state capture**: Interceptor hooks XHR to capture __dyn, __csr, etc. from real requests
- **doc_id auto-update**: Extracted from HTML + interceptor, with hardcoded fallback
- **Cursor fix**: Reject short cursors (<20 chars) to avoid comment/reaction pagination

### Phase A: Validate Active Crawler (COMPLETE)
- [x] Confirm HTML fetch + session extraction works
- [x] Fix GraphQL error 1357004 (Origin header via declarativeNetRequest)
- [x] Fix field_exception (stale doc_id -> auto-update)
- [x] Fix Invalid Cursor (short cursor filtering)
- [x] Confirm pagination returns actual posts
- [x] Verify matched posts delivered to webhook
- [x] Test with all 19+ groups enabled

### Phase B: Error Handling & Resilience (COMPLETE)
- [x] Failed delivery queue (pendingItems persisted to chrome.storage.local, re-queued on failure)
- [x] Session expiry detection (login redirect, checkpoint page, fb_dtsg missing → error banner in popup)
- [x] doc_id staleness detection (field_exception / unknown query errors → popup banner)
- [x] MV3 service worker keepalive during crawls (keepalive alarm at 24s interval)
- [x] Graceful handling of Facebook rate limiting (HTTP 429 + error code 1357029 detection)
- [x] Config export/import as JSON (export/import buttons on options page)

### Phase C: Notifications & Observability (COMPLETE)
- [x] Chrome desktop notifications on lead delivery (configurable checkbox in Delivery tab)
- [x] Error notifications - generic alert, no details (configurable checkbox in Delivery tab)
- [x] Crawl history log viewer (Logs tab in options page, timestamped entries)
- [x] Per-group success/failure indicators (Logs tab, shows last crawl time + new/dup/pages)
- [x] Error history viewer (Logs tab, last 50 errors, persistent across restarts)
- [x] Log retention setting (configurable days) + clear buttons for logs and errors

### Phase D: Polish & UX
- Bulk group enable/disable
- Keyword testing tool (paste post text, see which keywords match)
- Extension icon badge showing pending count
- Dark/light theme support

### Phase E: Python Scraper Decision
- Evaluate whether to retire `../filtering-agent/` Python scraper entirely
- Or keep as Azure-deployed fallback (different auth approach via cookie file)
- If keeping, sync config format between extension and Python agent
