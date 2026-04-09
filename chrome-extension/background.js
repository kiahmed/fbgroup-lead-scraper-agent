/**
 * Background service worker - active Facebook group crawler + passive interceptor.
 *
 * Active mode:  crawlAllGroups() fetches group pages, extracts session tokens,
 *               then paginates via GraphQL API calls.
 * Passive mode: still processes intercepted responses from content script.
 *
 * Pipeline: extract stories -> filter -> dedup -> transform -> batch -> webhook
 */

// --- Config defaults (used when chrome.storage is empty) ---------------------

const DEFAULTS = {
  groups: [
    { id: "217210172609089", name: "Creative Real Estate with Pace Morby", enabled: true },
    { id: "1916660711978301", name: "RV Parks For Sale", enabled: true },
  ],
  keywords: [
    "subto", "sub2", "subject to", "creative", "seller finance",
    "morby method", "multi", "multifamily", "fourplex", "commercial",
    "units", "Atlanta", "Salome",
  ],
  filtering: {
    min_keyword_matches: 1,
    exclude_keywords: [
      "HOA welcome", "group admin",
      "just joined", "cleaning service", "my way", "got junk?",
      "moves & deliveries", "for rent", "infill lot", "condo",
    ],
  },
  keyword_groups: [
    { name: "All", enabled: false, keywords: [] },
    { name: "Creative Finance Multifamily", enabled: false, keywords: ["multi", "creative", "seller finance"] },
    { name: "SubTo Opportunities", enabled: true, keywords: ["subto"] },
    { name: "Atlanta Commercial", enabled: false, keywords: ["Atlanta", "commercial"] },
  ],
  webhook: {
    url: "",
    batch_size: 12,
    batch_delay_sec: 20,
    retry_attempts: 3,
    retry_backoff_sec: 2,
  },
  crawl: {
    max_pages_per_group: 5,
    delay_between_groups: [8, 15],
    delay_between_pages: [3, 6],
    doc_id: "34704208309223645",
    interval_minutes: 0,          // 0 = manual only
  },
  state: {
    retention_days: 30,
  },
};

// Live config - loaded from chrome.storage.sync, falls back to DEFAULTS
let CONFIG = structuredClone(DEFAULTS);

/**
 * Load config from chrome.storage.sync, merging with defaults.
 * Called on startup and before each crawl.
 */
async function loadConfig() {
  const stored = await chrome.storage.sync.get("config");
  if (stored.config) {
    // Deep merge: stored values override defaults
    for (const key of Object.keys(DEFAULTS)) {
      if (stored.config[key] !== undefined) {
        CONFIG[key] = stored.config[key];
      }
    }
  }
  return CONFIG;
}

/** Save current config to chrome.storage.sync. */
async function saveConfig(config) {
  CONFIG = config;
  await chrome.storage.sync.set({ config });
}

// Relay feature flags - extracted from a real request, relatively stable
const RELAY_FLAGS = {
  "__relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider": true,
  "__relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider": true,
  "__relay_internal__pv__CometFeedStory_enable_post_permalink_white_space_clickrelayprovider": false,
  "__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider": false,
  "__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider": false,
  "__relay_internal__pv__IsWorkUserrelayprovider": false,
  "__relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider": false,
  "__relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider": true,
  "__relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider": true,
  "__relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider": false,
  "__relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider": false,
  "__relay_internal__pv__IsMergQAPollsrelayprovider": false,
  "__relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider": true,
  "__relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider": false,
  "__relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider": "ORIGINAL",
  "__relay_internal__pv__CometUFIShareActionMigrationrelayprovider": true,
  "__relay_internal__pv__CometUFISingleLineUFIrelayprovider": true,
  "__relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider": true,
  "__relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider": true,
  "__relay_internal__pv__GroupsCometGYSJFeedItemHeightrelayprovider": 206,
  "__relay_internal__pv__ShouldEnableBakedInTextStoriesrelayprovider": true,
  "__relay_internal__pv__StoriesShouldIncludeFbNotesrelayprovider": true,
};

// --- State -------------------------------------------------------------------

let enabled = true;
let stats = { intercepted: 0, extracted: 0, matched: 0, delivered: 0, crawls: 0 };
let pendingItems = [];
let deliveryTimer = null;
let isCrawling = false;
let crawlLog = [];          // recent log lines for popup display

// Default client-state params captured from a real browser session.
// The interceptor updates these with fresh values when the user browses Facebook.
const DEFAULT_CLIENT_STATE = {
  "__dyn": "7xeUjGU5a5Q1ryaxG4Vp41twWwIxu13wFwhUKbgS3q2ibwNw9G2Saw8i2S1DwUx60GE5O0BU2_CxS320qa2OU7m221Fwgo9oO0-E4a3a4oaEnxO0Bo7O2l2Utwqo5W1ywiE4u9x-3m1mzXw8W58jwGzE8FU5e3ym2SU4i5oe8cEW4-5pUfEdfwxwjFovUaU3qxW2-awLyESE7i3C22390bS16xi4UK2K2WEjxK2B08-269wOxW6k1fxC13xecwBwWzUlwEKufxamEbbxG1fBG2-0P846fwk83KwHwOyUqxG0K83jxG",
  "__csr": "g8k7kj2k7A4RiM_slOgXMD113szMNkYp95Qxtdl5ihdllsH8PZkzEKJbsikBQ_qQykh8hmLmABP4TTkFGlbJn-AyP9t4bKCzTnJqGQFllQFaKF7hqHyRh4DVJbAhbWFG_FFdEgQQmDKHhJaHqAnWluKl4DinVbrHy4UxfHrQWGinUOnhQiAhq8GJaRGFWhHGYFJ6GQp9kV7y5hQHiGFaGBy9qiLgyteta-mumfDpkOd4tb-vAGiHIyKUK44FBykVUGBGGJox5hGHVGyXhKue8uHi89yUGHzEjAixp2fLyrCAXyeEzCGmu8KHJzAWghx1enGAVSdyBCzpeaCAy4uiUjCGmtBFAxTLAzFqCgnCh9qxunCxq9CV9oohUhwXUhAxG6peErK4998Ly98nylDCBKXgjz42mnx2bwwGbhUyq5BK8zUqxGmdDy98dUR2Uyh1aE-qfG4p8y2maGbWBgkxG22czpUSuVFoixGU8UO4UK2y19xS8ge8OEgCy8W0Mo8pogx-U985F2EmwXDK8K7rjK1gwMzpoGawIx23Cqq2ql09ubDxO8wWDU2Vyoy1Lwu89EfoswHo4e6ocFU4mu8ie1wxGbxswswBzQ8wgF8bUdAE3pw63wmE0gVg3Xo0dHV8kwf1w1-m3O0EBCoe404oE0qzxx04kyk0D9E07hCu01I4xu0BEvy5ofE0zu5U421ew8O0ju5kl2oF3oC2O3l0vo9k9yEW8gnw9_w3rkt0g89E4hxe3ww3zw1ZG3C3Gqawd2h7y4020jg1bE565odo0A-2J0WxJwb8FEF3q40bq48G9Aw8i04c81qQ09Cw4hw5Vguwnk5Eck3i5Eg86k2kM04cR0Iwa21_U0XG1km1yg0F29lwg8C7Fo0zcEao1k8Kdyo54KVoek3ie4wrUWu0b6w11S4Eghk6EowqA4UW0phweR08-0QiwEg2Xwi8C19U1OFW804Z21tAwcBk0vW",
  "__hs": "20551.HCSV2:comet_pkg.2.1...0",
  "__s": "6ccz45:6glb6a:er27l4",
  "__ccg": "EXCELLENT",
  "__hsdp": "g4Ixq3bM8O1OxWh0qGwq8oyA22228gGh1YgwBqaz8-Axk8huxc8VxUFMzT3x0iCMpgz132224A4YO1oOMKxq3c4eOjIFqi4hZ8bMjX8pEWEnsgwN0LQhD3kgHsr4aSzOEP2k5aEQW4dTdEgmz89KGcwyAiyF11mKpk4OGFRpAdmHy1ahAUExjKIN4P6EmBhQykyh9cH4yXP9ihaoB4EGhSeGqNpQmQCeQqQ8DgS6VWO58eJlcx0yV6bh8Jd19kAdgAVoNCxswzaCbwTpbzohwAhJkmAh5CVo-3W5WX4rhzd3roV265o9Q8zAfg5Px3gOfxbCCgB2Q3a291mexTxu2jwGxF0Bxiqm9ig-jwLG6VUrh81Hm2e1Rg9okwNwrzxK3-1czlwIx25i0n8oyQ364U3ce7E7m0iG3m0iW2KbyE2AwLw2aHwai7o882sCwiUcE8o3mw41wrU3ww4gw4ew8O1bw7xw5Sw4cw4PwoU9E28wq82vzU1_E2Iwi8mw49w5ADwcq0G88E2jwqUbE1182dw52wUwzw9a7U5O1bway1_y81jUcE5m08aw3d8rw45x22C0la0_82Ywl818o",
  "__hblp": "0wDigcQ84akxVHwFy8owjouhUaE3SwChocFohwjVUK0gqqcG68W48F285ifWx219waS7EgwBxO6Foaax93ecyEohoa8gwyzo8UOcKqqi4F-2S2K6oly8ozocFWxS4byXGUbEuG7oO3y78lwmomy8S4U4S3Ci6Ef8rwDxW3N38989k6oowxxWnx-q48jxaexK11yUyqmaKA46214wDDwiU4G7U6C1TwSxqaK2mi9xGbz9EhxqUOp5woo8UpxOu8wKwMz8WfwJG58uwKwVyEcUjwNwXx-8xqmqualxWuU6C2G1ywxxa5AazodE463i1Sx50oUKi366olwHxaq68iGHDwwz8Kez8mwn8C9yU2DwhU76ULwkEgyuq4EOcg-223fwpFElwDzoce6pEtzUaohwxK17wHx248swxx23yq58ym6Ee8nK2m2m1hxWawyG6E3Ewoohwi8covx3Uix6fwgFUrwDzE6a4E3KzVoS19w8a9z8qxecwl84K3GE4G2O5e3-1nwLwkE5y1sCwCyEaEe8pwIx-6U5J0TDGfBw5vwlEtUO58-HK3a1axe9wJByEmwro9E4-2i326UeE3sDwJg5ym3y3em3e3G4UW0AUa42Gm48pxi0RELx-58C19xqdxu18U5W9gcEvxmcK2Wm2ei2m4E9ojy8hzk48f8vG5e2248fEeUtUS1Fxl2o6V3UvwLwgoox613wJxe4UeK1Dg42XwQwWwLwl8lzK5k0REgzFEhCwa60ga1xxK3C0yUpx11e48aogyEgx232u3G48986G10wlob8e8eQ1Oz9Hx2ESE9412zE2rG7U-4Gxi",
  "__sjsp": "g4Ixq3bM8O1OxWh0qGwq8oyA22228gGh1YgwBqaz8-Axk8huxc8VyYUF8ojT3x0iCMpgz132224A4YO5ggIIbEkPR7ggXqgwEMXglqD86EANi6AeH8ty-gg2clF0HsUhRcTy8CTklCCgxixFxd1Vi5hpSZqkFq8g8VGcwwiiyF11k-pk4OGal7ggGUwiApea8kVIN4P2Aal7h4GjgQx212kOkzjigF7aAt3UQER5J9zJ2A8DgaoH8kwWQcoSUih8Jd19kAdyEoou88Ukw9h24h08i353A9gfk0xK1jgB0oA0Ok1CAwNG6U8Qi099g3Zw_w",
  "__comet_req": "15",
  "__rev": "1036913201",
  "__hsi": "7626498550830542113",
};
let clientState = { ...DEFAULT_CLIENT_STATE };

// Cached session tokens (refreshed each crawl from the first group page)
let session = null;         // { userId, fbDtsg, lsd, rev }

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(`[FB Lead Scraper] ${msg}`);
  crawlLog.push(line);
  if (crawlLog.length > 100) crawlLog.shift();
}

function randomDelay(range) {
  const [min, max] = range;
  return (min + Math.random() * (max - min)) * 1000;
}

// --- Session token extraction ------------------------------------------------

/**
 * Extract session tokens from a Facebook HTML page.
 * These are embedded in inline scripts, not cookies.
 */
function extractSessionFromHtml(html) {
  const tokens = {};

  // fb_dtsg - primary CSRF token
  // Pattern: ["DTSGInitData",[],{"token":"..."},...]
  let m = html.match(/"DTSGInitData".*?"token":"([^"]+)"/);
  if (m) tokens.fbDtsg = m[1];
  // Fallback: input field
  if (!tokens.fbDtsg) {
    m = html.match(/name="fb_dtsg"\s+value="([^"]+)"/);
    if (m) tokens.fbDtsg = m[1];
  }

  // lsd - login security data token
  m = html.match(/"LSD".*?"token":"([^"]+)"/);
  if (m) tokens.lsd = m[1];
  if (!tokens.lsd) {
    m = html.match(/name="lsd"\s+value="([^"]+)"/);
    if (m) tokens.lsd = m[1];
  }

  // User ID - from the page data
  m = html.match(/"USER_ID":"(\d+)"/);
  if (m) tokens.userId = m[1];
  if (!tokens.userId) {
    m = html.match(/"actorID":"(\d+)"/);
    if (m) tokens.userId = m[1];
  }

  // Server revision
  m = html.match(/"server_revision":(\d+)/);
  if (m) tokens.rev = m[1];
  if (!tokens.rev) {
    m = html.match(/__spin_r['":\s]+(\d+)/);
    if (m) tokens.rev = m[1];
  }

  // Haste session ID
  m = html.match(/"hsi":"(\d+)"/);
  if (m) tokens.hsi = m[1];

  // Spin token timestamp
  m = html.match(/"__spin_t":(\d+)/);
  if (m) tokens.spinT = m[1];

  // --- Extract client-state params from prefetch links and embedded data ---
  // Facebook embeds <link rel="preload"> tags with full GraphQL URLs containing
  // __dyn, __csr, __hs, __s, etc. Also look in JSON config blobs and script tags.

  // Extract from any URL containing these as query params (prefetch links, etc.)
  const paramPatterns = {
    __dyn: /__dyn=([^&"<\s]{20,})/,
    __csr: /__csr=([^&"<\s]{20,})/,
    __hs: /[&?]__hs=([^&"<\s]+)/,
    __s: /[&?]__s=([^&"<\s]+)/,
    __ccg: /[&?]__ccg=([^&"<\s]+)/,
    __hsdp: /__hsdp=([^&"<\s]{20,})/,
    __hblp: /__hblp=([^&"<\s]{20,})/,
    __sjsp: /__sjsp=([^&"<\s]{20,})/,
    __comet_req: /__comet_req=(\d+)/,
  };

  // Also try JSON patterns: "__dyn":"..."
  const jsonPatterns = {
    __dyn: /"__dyn"\s*:\s*"([^"]{20,})"/,
    __csr: /"__csr"\s*:\s*"([^"]{20,})"/,
    __hs: /"__hs"\s*:\s*"([^"]+)"/,
    __s: /"__s"\s*:\s*"([^"]+)"/,
    __ccg: /"connectionClass"\s*:\s*"([^"]+)"/,
  };

  tokens.clientParams = {};
  for (const [key, re] of Object.entries(paramPatterns)) {
    m = html.match(re);
    if (m) tokens.clientParams[key] = decodeURIComponent(m[1]);
  }
  for (const [key, re] of Object.entries(jsonPatterns)) {
    if (!tokens.clientParams[key]) {
      m = html.match(re);
      if (m) tokens.clientParams[key] = m[1];
    }
  }

  // --- Extract doc_id for GroupsCometFeedRegularStoriesPaginationQuery ---
  // Facebook embeds query-to-docID mappings in the page's module registry.
  // Look for the pagination query name near a numeric doc_id.
  m = html.match(/GroupsCometFeedRegularStoriesPaginationQuery[^}]*?"(\d{15,})"/);
  if (!m) m = html.match(/"(\d{15,})"[^}]*?GroupsCometFeedRegularStoriesPaginationQuery/);
  if (m) tokens.paginationDocId = m[1];

  return tokens;
}

/**
 * Compute jazoest from fb_dtsg (security hash).
 */
function computeJazoest(fbDtsg) {
  let sum = 0;
  for (let i = 0; i < fbDtsg.length; i++) sum += fbDtsg.charCodeAt(i);
  return "2" + sum;
}

/**
 * Extract JSON from <script type="application/json"> tags in HTML.
 * Same approach as the Python scraper.
 */
function extractJsonScripts(html) {
  const results = [];
  const re = /<script[^>]*type="application\/json"[^>]*>(.*?)<\/script>/gs;
  let match;
  while ((match = re.exec(html)) !== null) {
    try {
      results.push(JSON.parse(match[1]));
    } catch (e) { /* skip invalid JSON */ }
  }
  return results;
}

/**
 * Recursively search for page_info objects containing end_cursor.
 * Used to find the pagination cursor from the initial HTML payload.
 */
function findPageInfo(obj, depth = 0) {
  if (depth > 40) return null;
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    if (obj.page_info && obj.page_info.end_cursor && obj.page_info.has_next_page !== undefined) {
      // Real feed cursors are long base64 strings (100+ chars).
      // Skip short cursors like "3" which belong to comments/reactions pagination.
      if (obj.page_info.end_cursor.length > 20) {
        return obj.page_info;
      }
    }
    for (const v of Object.values(obj)) {
      const found = findPageInfo(v, depth + 1);
      if (found) return found;
    }
  } else if (Array.isArray(obj)) {
    for (const v of obj) {
      const found = findPageInfo(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// --- Story extraction (ported from scraper.py) -------------------------------

function parseGraphQLResponse(text) {
  const objects = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { objects.push(JSON.parse(trimmed)); } catch (e) { /* skip */ }
  }
  return objects;
}

function findStories(obj, depth = 0) {
  const stories = [];
  if (depth > 40) return stories;
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    if (obj.__typename === "Story" && obj.comet_sections && obj.post_id) {
      stories.push(obj);
    }
    for (const v of Object.values(obj)) stories.push(...findStories(v, depth + 1));
  } else if (Array.isArray(obj)) {
    for (const v of obj) stories.push(...findStories(v, depth + 1));
  }
  return stories;
}

function extractMessage(story) {
  try {
    const cs = story.comet_sections.content.story.comet_sections;
    if (cs.message) return cs.message.story.message.text;
  } catch (e) { /* fall through */ }
  const msg = story.message;
  if (msg && typeof msg === "object" && msg.text) return msg.text;
  return "";
}

function extractTimestamp(story) {
  try { return story.comet_sections.timestamp.story.creation_time; } catch (e) { /* */ }
  return story.creation_time || 0;
}

function extractPost(story) {
  const fp = story.feedback?.owning_profile || {};
  const timestamp = extractTimestamp(story);
  return {
    post_id: story.post_id || "",
    post_url: story.permalink_url || "",
    user_id: fp.id || "",
    username: fp.name || "",
    user_url: fp.id ? `https://www.facebook.com/profile.php?id=${fp.id}` : "",
    text: extractMessage(story),
    timestamp,
    time: timestamp ? new Date(timestamp * 1000).toISOString() : null,
    likes: 0,
  };
}

// --- Filtering (ported from filter.py) ---------------------------------------

function normalizeText(text) {
  // Normalize hyphens, en-dashes, em-dashes to spaces for matching
  // "Subject-To" becomes "subject to", matching keyword "subject to"
  return text.toLowerCase().replace(/[-\u2010\u2011\u2012\u2013\u2014\u2015]/g, " ");
}

function matchKeywords(text, keywords, minMatches = 1) {
  if (!text || !keywords.length) return [];
  const textNorm = normalizeText(text);
  const matched = keywords.filter((kw) => textNorm.includes(normalizeText(kw)));
  return matched.length >= minMatches ? matched : [];
}

function applyKeywordGroups(items, keywordGroups) {
  if (!keywordGroups?.length) return items;
  const enabledGroups = keywordGroups.filter((g) => g.enabled);
  if (!enabledGroups.length) return items;
  if (enabledGroups.some((g) => g.name === "All")) return items;
  return items.filter((item) => {
    const text = normalizeText(item.content || "");
    return enabledGroups.some((group) =>
      group.keywords.every((kw) => text.includes(normalizeText(kw)))
    );
  });
}

// --- Dedup -------------------------------------------------------------------

async function loadSeenPosts() {
  const result = await chrome.storage.local.get("seenPosts");
  return result.seenPosts || {};
}

async function saveSeenPosts(seen) {
  await chrome.storage.local.set({ seenPosts: seen });
}

async function isNewPost(postId) {
  const seen = await loadSeenPosts();
  if (seen[postId]) return false;
  seen[postId] = Date.now();
  const cutoff = Date.now() - CONFIG.state.retention_days * 86400000;
  for (const [id, ts] of Object.entries(seen)) {
    if (ts < cutoff) delete seen[id];
  }
  await saveSeenPosts(seen);
  return true;
}

// --- Transform + Delivery ----------------------------------------------------

function encodePostId(userId, postId) {
  return "facebook_" + btoa(`S:_I${userId}:VK:${postId}`);
}

function formatTimestamp(isoString) {
  if (!isoString) return null;
  return new Date(isoString).toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
}

function transformPost(rawPost, matchedKeywords, groupConfig) {
  return {
    provider: "facebook",
    id: encodePostId(rawPost.user_id, rawPost.post_id),
    url: rawPost.post_url,
    authorName: rawPost.username,
    authorProfileUrl: rawPost.user_url,
    authorProfilePicture: null,
    content: rawPost.text,
    keywords: matchedKeywords,
    likes: rawPost.likes || 0,
    postedAt: formatTimestamp(rawPost.time),
    groupId: groupConfig.id,
    groupName: groupConfig.name,
    groupUrl: `https://facebook.com/groups/${groupConfig.id}`,
  };
}

function buildEnvelope(items) {
  return {
    id: crypto.randomUUID(),
    type: "leads.new",
    created: Math.floor(Date.now() / 1000),
    items,
    liveMode: true,
  };
}

async function deliverSingle(envelope) {
  const { url, retry_attempts, retry_backoff_sec } = CONFIG.webhook;
  for (let attempt = 1; attempt <= retry_attempts; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      });
      if (resp.ok) {
        log(`Webhook delivered (HTTP ${resp.status}), ${envelope.items.length} items`);
        return true;
      }
      log(`Webhook HTTP ${resp.status} attempt ${attempt}/${retry_attempts}`);
    } catch (e) {
      log(`Webhook error attempt ${attempt}/${retry_attempts}: ${e.message}`);
    }
    if (attempt < retry_attempts) {
      await new Promise((r) => setTimeout(r, retry_backoff_sec * 2 ** (attempt - 1) * 1000));
    }
  }
  log("Webhook delivery FAILED after all retries");
  return false;
}

async function flushPendingItems() {
  if (!pendingItems.length) return;
  const items = pendingItems.splice(0);
  const { batch_size, batch_delay_sec } = CONFIG.webhook;
  const batches = [];
  for (let i = 0; i < items.length; i += batch_size) batches.push(items.slice(i, i + batch_size));
  log(`Delivering ${items.length} items in ${batches.length} batch(es)`);
  for (let i = 0; i < batches.length; i++) {
    const envelope = buildEnvelope(batches[i]);
    const ok = await deliverSingle(envelope);
    if (ok) stats.delivered += batches[i].length;
    if (i < batches.length - 1) await new Promise((r) => setTimeout(r, batch_delay_sec * 1000));
  }
  await chrome.storage.local.set({ stats });
}

function scheduleDelivery() {
  if (deliveryTimer) clearTimeout(deliveryTimer);
  deliveryTimer = setTimeout(() => flushPendingItems(), 10000);
}

// --- Pipeline: process stories through filter/dedup/transform ----------------

/**
 * Process stories through the pipeline.
 * Returns { total, newPosts, duplicates, newestTimestamp } for crawl tracking.
 */
async function processStories(stories, groupConfig) {
  const seenIds = new Set();
  const unique = stories.filter((s) => {
    const pid = s.post_id;
    if (!pid || seenIds.has(pid)) return false;
    seenIds.add(pid);
    return true;
  });

  const result = { total: unique.length, newPosts: 0, duplicates: 0, newestTimestamp: 0 };
  if (!unique.length) return result;

  const excludeKeywords = CONFIG.filtering?.exclude_keywords || [];

  for (const story of unique) {
    const rawPost = extractPost(story);
    if (!rawPost.text) {
      log(`   Skip (no text): post_id=${rawPost.post_id}, keys=${Object.keys(story.comet_sections || {}).join(",")}`);
      continue;
    }

    // Track the newest post timestamp across all stories
    if (rawPost.timestamp > result.newestTimestamp) {
      result.newestTimestamp = rawPost.timestamp;
    }

    stats.extracted++;

    // Exclude check FIRST - skip immediately, no dedup write, no storage cost
    if (excludeKeywords.length) {
      const textNorm = normalizeText(rawPost.text);
      if (excludeKeywords.some((kw) => textNorm.includes(normalizeText(kw)))) {
        continue;
      }
    }

    const isNew = await isNewPost(rawPost.post_id);
    if (!isNew) {
      result.duplicates++;
      continue;
    }

    result.newPosts++;

    const matched = matchKeywords(
      rawPost.text, CONFIG.keywords,
      CONFIG.filtering.min_keyword_matches,
    );
    if (!matched.length) {
      log(`   No L1 match: "${rawPost.text.substring(0, 80)}..."`);
      continue;
    }

    const lead = transformPost(rawPost, matched, groupConfig);
    const passed = applyKeywordGroups([lead], CONFIG.keyword_groups);
    if (!passed.length) {
      log(`  L2 reject: ${rawPost.post_id}`);
      continue;
    }

    stats.matched++;
    pendingItems.push(lead);
    log(`  MATCH [${matched.join(", ")}]: "${rawPost.text.substring(0, 60)}..."`);
  }

  await chrome.storage.local.set({ stats });
  return result;
}

// --- Group discovery ---------------------------------------------------------

/**
 * Recursively find Group objects in Facebook's Relay JSON.
 * Returns objects with __typename "Group" that have id and name.
 */
function findGroupObjects(obj, depth = 0) {
  const groups = [];
  if (depth > 40) return groups;
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    if (obj.__typename === "Group" && obj.id && obj.name) {
      groups.push({ id: obj.id, name: obj.name });
    }
    for (const v of Object.values(obj)) groups.push(...findGroupObjects(v, depth + 1));
  } else if (Array.isArray(obj)) {
    for (const v of obj) groups.push(...findGroupObjects(v, depth + 1));
  }
  return groups;
}

/**
 * Fetch the user's joined groups from Facebook.
 * Fetches the groups page and extracts Group objects from embedded JSON.
 */
async function fetchMyGroups() {
  log("Loading your Facebook groups...");

  const resp = await fetch("https://www.facebook.com/groups/joins/", {
    credentials: "include",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching groups page`);
  const html = await resp.text();

  // Extract all JSON script tags
  const jsonBlobs = extractJsonScripts(html);
  log(`   Parsed ${jsonBlobs.length} JSON blobs from groups page`);

  // Find all Group objects
  let allGroups = [];
  for (const blob of jsonBlobs) {
    allGroups.push(...findGroupObjects(blob));
  }

  // Deduplicate by id and sort by name ascending
  const seen = new Set();
  const unique = allGroups.filter((g) => {
    if (seen.has(g.id)) return false;
    seen.add(g.id);
    return true;
  });

  unique.sort((a, b) => a.name.localeCompare(b.name));
  log(`   Found ${unique.length} groups`);
  return unique;
}

// --- Active crawler ----------------------------------------------------------

/**
 * Fetch a Facebook group page HTML. Cookies are included automatically
 * because we have host_permissions for facebook.com.
 */
async function fetchGroupHtml(groupId) {
  const url = `https://www.facebook.com/groups/${groupId}/`;
  const resp = await fetch(url, {
    credentials: "include",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Sec-Ch-Ua": '"Chromium";v="146", "Google Chrome";v="146"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching group ${groupId}`);
  return resp.text();
}

/**
 * Build the POST body for a GraphQL pagination request.
 */
function buildGraphQLPayload(groupId, cursor, sess) {
  const variables = {
    count: 3,
    cursor: cursor,
    feedLocation: "GROUP",
    feedType: "DISCUSSION",
    feedbackSource: 0,
    filterTopicId: null,
    focusCommentID: null,
    privacySelectorRenderLocation: "COMET_STREAM",
    referringStoryRenderLocation: null,
    renderLocation: "group",
    scale: 1,
    sortingSetting: "CHRONOLOGICAL",
    stream_initial_count: 1,
    useDefaultActor: false,
    id: groupId,
    ...RELAY_FLAGS,
  };

  // Merge session tokens (from HTML) with client state (from interceptor)
  const cs = clientState || {};

  const params = new URLSearchParams();
  params.set("av", sess.userId);
  params.set("__aaid", "0");
  params.set("__user", sess.userId);
  params.set("__a", "1");
  if (cs.__hs || sess.hs) params.set("__hs", cs.__hs || sess.hs);
  params.set("dpr", "1");
  if (cs.__ccg || sess.ccg) params.set("__ccg", cs.__ccg || sess.ccg);
  if (cs.__rev || sess.rev) params.set("__rev", cs.__rev || sess.rev);
  if (cs.__s || sess.s) params.set("__s", cs.__s || sess.s);
  if (cs.__hsi || sess.hsi) params.set("__hsi", cs.__hsi || sess.hsi);
  if (cs.__dyn) params.set("__dyn", cs.__dyn);
  if (cs.__csr) params.set("__csr", cs.__csr);
  if (cs.__hsdp) params.set("__hsdp", cs.__hsdp);
  if (cs.__hblp) params.set("__hblp", cs.__hblp);
  if (cs.__sjsp) params.set("__sjsp", cs.__sjsp);
  params.set("__comet_req", cs.__comet_req || sess.cometReq || "15");
  params.set("fb_dtsg", sess.fbDtsg);
  params.set("jazoest", computeJazoest(sess.fbDtsg));
  params.set("lsd", sess.lsd || "");
  if (sess.spinT) {
    params.set("__spin_r", sess.rev || "");
    params.set("__spin_b", "trunk");
    params.set("__spin_t", sess.spinT);
  }
  params.set("fb_api_caller_class", "RelayModern");
  params.set("fb_api_req_friendly_name", "GroupsCometFeedRegularStoriesPaginationQuery");
  params.set("server_timestamps", "true");
  params.set("variables", JSON.stringify(variables));
  params.set("doc_id", CONFIG.crawl.doc_id);

  log(`   Payload: __dyn=${cs.__dyn ? "yes(" + cs.__dyn.length + ")" : "NO"}, __csr=${cs.__csr ? "yes(" + cs.__csr.length + ")" : "NO"}, __hs=${cs.__hs || "NO"}, doc_id=${CONFIG.crawl.doc_id}`);

  return params;
}

/**
 * Fetch one page of group feed via the GraphQL API.
 * Returns { stories, pageInfo } where pageInfo has end_cursor and has_next_page.
 */
async function fetchFeedPage(groupId, cursor, sess) {
  const payload = buildGraphQLPayload(groupId, cursor, sess);

  const resp = await fetch("https://www.facebook.com/api/graphql/", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-FB-Friendly-Name": "GroupsCometFeedRegularStoriesPaginationQuery",
      "X-FB-LSD": sess.lsd || "",
      "X-ASBD-ID": "359341",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      "Referer": `https://www.facebook.com/groups/${groupId}/`,
    },
    body: payload.toString(),
  });

  if (!resp.ok) throw new Error(`GraphQL HTTP ${resp.status}`);
  let text = await resp.text();

  // Strip Facebook's anti-JSON-hijacking prefix
  if (text.startsWith("for (;;);")) {
    text = text.substring(9);
  }

  log(`   GQL response: ${text.length} bytes`);
  if (text.length < 1000) log(`   GQL full: ${text}`);
  else log(`   GQL first 300: ${text.substring(0, 300)}`);

  const objects = parseGraphQLResponse(text);
  log(`   GQL parsed ${objects.length} JSON objects`);
  let allStories = [];
  let pageInfo = null;

  for (const obj of objects) {
    allStories.push(...findStories(obj));
    if (!pageInfo) pageInfo = findPageInfo(obj);
  }

  log(`   GQL found ${allStories.length} stories, cursor: ${pageInfo?.end_cursor ? "yes" : "no"}, hasNext: ${pageInfo?.has_next_page}`);

  return { stories: allStories, pageInfo };
}

/**
 * Crawl a single group: fetch HTML for initial posts + session, then paginate.
 */
async function crawlGroup(groupConfig) {
  log(`-- Crawling "${groupConfig.name}" (${groupConfig.id})`);

  // Step 1: Fetch group HTML page - gives us session tokens + initial posts
  const html = await fetchGroupHtml(groupConfig.id);
  log(`   Fetched HTML: ${html.length} bytes`);

  // Step 2: Extract/refresh session tokens
  const tokens = extractSessionFromHtml(html);
  if (tokens.fbDtsg) {
    session = tokens;
    // Merge any client params extracted from HTML into clientState
    const cp = tokens.clientParams || {};
    const cpCount = Object.keys(cp).length;
    if (cpCount) {
      Object.assign(clientState, cp);
      log(`   Session: userId=${session.userId}, fb_dtsg=${session.fbDtsg.substring(0, 20)}..., extracted ${cpCount} client params from HTML`);
    } else {
      log(`   Session: userId=${session.userId}, fb_dtsg=${session.fbDtsg.substring(0, 20)}..., no client params in HTML (using cached)`);
    }
    // Auto-update doc_id if found in HTML
    if (tokens.paginationDocId && tokens.paginationDocId !== CONFIG.crawl.doc_id) {
      log(`   doc_id auto-updated: ${CONFIG.crawl.doc_id} -> ${tokens.paginationDocId}`);
      CONFIG.crawl.doc_id = tokens.paginationDocId;
    }
  } else if (!session) {
    log(`   ERROR: No fb_dtsg found and no cached session`);
    return;
  } else {
    log(`   Using cached session (no fb_dtsg in this page)`);
  }

  // Step 3: Extract initial stories from embedded JSON
  const jsonBlobs = extractJsonScripts(html);
  log(`   Found ${jsonBlobs.length} JSON script tags`);

  let initialStories = [];
  let pageInfo = null;
  for (const blob of jsonBlobs) {
    const found = findStories(blob);
    if (found.length) log(`   Blob found ${found.length} stories`);
    initialStories.push(...found);
    if (!pageInfo) pageInfo = findPageInfo(blob);
  }

  log(`   Initial stories: ${initialStories.length}, cursor: ${pageInfo?.end_cursor ? pageInfo.end_cursor.substring(0, 40) + "..." : "no"}, hasNext: ${pageInfo?.has_next_page}`);
  if (initialStories.length) {
    for (const s of initialStories) {
      const msg = extractMessage(s);
      log(`   Story ${s.post_id}: text=${msg ? msg.substring(0, 60) : "(empty)"}...`);
    }
  }

  // Process initial stories and track counts
  let totalNew = 0;
  let totalDup = 0;
  let newestPostTime = 0;   // track the newest post timestamp we see

  if (initialStories.length) {
    const r = await processStories(initialStories, groupConfig);
    totalNew += r.newPosts;
    totalDup += r.duplicates;
    if (r.newestTimestamp > newestPostTime) newestPostTime = r.newestTimestamp;
    log(`   Initial page: ${r.newPosts} new, ${r.duplicates} already seen`);
  }

  // Step 4: Paginate via GraphQL API
  // Always crawl to max_pages - TOP_POSTS ordering is not chronological,
  // so we can't assume "all dups on this page = nothing new deeper".
  // max_pages is the user's control over crawl depth.
  let cursor = pageInfo?.end_cursor;
  let hasNext = pageInfo?.has_next_page ?? false;
  let page = 0;
  const maxPages = CONFIG.crawl.max_pages_per_group;

  while (cursor && hasNext && page < maxPages) {
    page++;
    const delay = randomDelay(CONFIG.crawl.delay_between_pages);
    log(`   Page ${page}/${maxPages} - waiting ${(delay / 1000).toFixed(1)}s...`);
    await new Promise((r) => setTimeout(r, delay));

    try {
      const result = await fetchFeedPage(groupConfig.id, cursor, session);

      if (result.stories.length) {
        const r = await processStories(result.stories, groupConfig);
        totalNew += r.newPosts;
        totalDup += r.duplicates;
        if (r.newestTimestamp > newestPostTime) newestPostTime = r.newestTimestamp;
        log(`   Page ${page}: ${r.newPosts} new, ${r.duplicates} seen`);
      } else {
        log(`   Page ${page}: 0 stories returned`);
        break;
      }

      cursor = result.pageInfo?.end_cursor;
      hasNext = result.pageInfo?.has_next_page ?? false;
    } catch (e) {
      log(`   Page ${page} ERROR: ${e.message}`);
      break;
    }
  }

  const stopReason = !hasNext ? "end of feed" : page >= maxPages ? "max pages" : "no cursor";
  log(`-- Done "${groupConfig.name}" - ${totalNew} new, ${totalDup} dups, ${page} pages (${stopReason})`);

  // Save per-group crawl state
  const crawlState = (await chrome.storage.local.get("crawlState")).crawlState || {};
  crawlState[groupConfig.id] = {
    lastCrawl: Date.now(),
    pages: page + 1,
    newPosts: totalNew,
    duplicates: totalDup,
    newestPostTime,   // unix timestamp of the most recent post we saw
    newestPostDate: newestPostTime ? new Date(newestPostTime * 1000).toISOString() : null,
  };
  await chrome.storage.local.set({ crawlState });

  // Persist crawl log to storage (ring buffer, last 500 lines)
  const stored = (await chrome.storage.local.get("crawlLogHistory")).crawlLogHistory || [];
  stored.push(...crawlLog.slice(-20).map((l) => `[${groupConfig.name}] ${l}`));
  if (stored.length > 500) stored.splice(0, stored.length - 500);
  await chrome.storage.local.set({ crawlLogHistory: stored });
}

/**
 * Crawl all configured groups sequentially.
 */
async function crawlAllGroups() {
  if (isCrawling) {
    log("Crawl already in progress - skipping");
    return;
  }
  if (!enabled) {
    log("Extension is paused - skipping crawl");
    return;
  }

  // Reload config from storage before each crawl
  await loadConfig();

  const activeGroups = CONFIG.groups.filter((g) => g.enabled !== false);
  if (!activeGroups.length) {
    log("No groups enabled - nothing to crawl");
    return;
  }

  isCrawling = true;
  stats.crawls++;
  log(`=== Starting crawl of ${activeGroups.length} group(s) ===`);

  for (let i = 0; i < activeGroups.length; i++) {
    const group = activeGroups[i];
    try {
      await crawlGroup(group);
    } catch (e) {
      log(`ERROR crawling "${group.name}": ${e.message}`);
    }

    // Delay between groups (skip after last)
    if (i < activeGroups.length - 1) {
      const delay = randomDelay(CONFIG.crawl.delay_between_groups);
      log(`Waiting ${(delay / 1000).toFixed(1)}s before next group...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // Flush any pending items immediately after crawl
  await flushPendingItems();

  isCrawling = false;
  await chrome.storage.local.set({ stats });
  log(`=== Crawl complete. Extracted: ${stats.extracted}, Matched: ${stats.matched}, Delivered: ${stats.delivered} ===`);
}

// --- Passive interception handler (from content script) ----------------------

function parseGroupFromUrl(url) {
  const match = url?.match(/facebook\.com\/groups\/(\d+)/);
  if (!match) return { id: "unknown", name: "Unknown Group" };
  const id = match[1];
  // Try to find the group name from config
  const configured = CONFIG.groups.find((g) => g.id === id);
  return configured || { id, name: `Group ${id}` };
}

async function processGraphQLPayload(payload, sourceUrl) {
  if (!enabled) return;
  stats.intercepted++;

  const objects = parseGraphQLResponse(payload);
  let allStories = [];
  for (const obj of objects) allStories.push(...findStories(obj));

  if (allStories.length) {
    const groupConfig = parseGroupFromUrl(sourceUrl);
    await processStories(allStories, groupConfig);
    scheduleDelivery();
  }
}

// --- Message listener --------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GRAPHQL_FEED_RESPONSE" || msg.type === "INITIAL_PAGE_JSON") {
    processGraphQLPayload(msg.payload, msg.url);
  } else if (msg.type === "GET_STATUS") {
    Promise.all([
      chrome.storage.local.get("crawlState"),
      chrome.alarms.get("crawl-timer"),
    ]).then(([stateResult, alarm]) => {
      sendResponse({
        enabled,
        stats,
        pending: pendingItems.length,
        isCrawling,
        crawlState: stateResult.crawlState || {},
        groups: CONFIG.groups,
        nextAlarm: alarm?.scheduledTime || null,
      });
    });
    return true; // async sendResponse
  } else if (msg.type === "TOGGLE_ENABLED") {
    enabled = !enabled;
    sendResponse({ enabled });
  } else if (msg.type === "CRAWL_NOW") {
    crawlAllGroups();
    sendResponse({ ok: true });
  } else if (msg.type === "FLUSH_NOW") {
    flushPendingItems();
    sendResponse({ ok: true });
  } else if (msg.type === "RESET_STATS") {
    stats = { intercepted: 0, extracted: 0, matched: 0, delivered: 0, crawls: 0 };
    crawlLog = [];
    chrome.storage.local.set({ stats });
    sendResponse({ stats });
  } else if (msg.type === "GET_CONFIG") {
    loadConfig().then((cfg) => sendResponse(cfg));
    return true;
  } else if (msg.type === "SAVE_CONFIG") {
    saveConfig(msg.config).then(() => {
      setupAlarm(msg.config.crawl?.interval_minutes || 0);
      sendResponse({ ok: true });
    });
    return true;
  } else if (msg.type === "LOAD_GROUPS") {
    fetchMyGroups()
      .then((groups) => sendResponse({ ok: true, groups }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  } else if (msg.type === "CLIENT_STATE") {
    clientState = { ...DEFAULT_CLIENT_STATE, ...msg.data };
    chrome.storage.local.set({ clientState: msg.data });
    // Auto-update doc_id if the browser is using a newer one
    if (msg.data.doc_id && msg.data.doc_id !== CONFIG.crawl.doc_id) {
      log(`doc_id updated: ${CONFIG.crawl.doc_id} -> ${msg.data.doc_id}`);
      CONFIG.crawl.doc_id = msg.data.doc_id;
      saveConfig(CONFIG);
    }
    log(`Client state captured from browser (${Object.keys(msg.data).length} params: ${Object.keys(msg.data).join(", ")})`);
  }
});

// --- Scheduled crawling via chrome.alarms ------------------------------------

/**
 * Force-create the crawl alarm (used when saving new settings).
 * Clears any existing alarm and creates a fresh one.
 */
function setupAlarm(intervalMinutes) {
  chrome.alarms.clear("crawl-timer").then(() => {
    if (intervalMinutes > 0) {
      chrome.alarms.create("crawl-timer", { periodInMinutes: intervalMinutes });
      log(`Alarm set: crawl every ${intervalMinutes} min`);
    } else {
      log("Alarm cleared - manual crawl only");
    }
  });
}

/**
 * On startup, only create the alarm if one doesn't already exist
 * or if the interval has changed. Preserves the existing countdown.
 */
async function ensureAlarm(intervalMinutes) {
  const existing = await chrome.alarms.get("crawl-timer");
  if (intervalMinutes <= 0) {
    if (existing) chrome.alarms.clear("crawl-timer");
    return;
  }
  if (existing) {
    // Alarm already running - check if interval matches
    const existingInterval = existing.periodInMinutes;
    if (existingInterval === intervalMinutes) return; // keep it, don't reset
  }
  // No alarm or interval changed - create new one
  chrome.alarms.create("crawl-timer", { periodInMinutes: intervalMinutes });
  log(`Alarm set: crawl every ${intervalMinutes} min`);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "crawl-timer") {
    log("Scheduled crawl triggered");
    crawlAllGroups();
  }
});

// --- Startup -----------------------------------------------------------------

chrome.storage.local.get(["stats", "clientState"], (result) => {
  if (result.stats) stats = result.stats;
  if (result.clientState) {
    clientState = { ...DEFAULT_CLIENT_STATE, ...result.clientState };
    log(`Loaded cached client state (${Object.keys(result.clientState).length} fresh params)`);
  } else {
    log(`Using default client state (${Object.keys(clientState).length} params)`);
  }
});

// Register declarativeNetRequest rule to fix Origin header on our GraphQL POSTs.
// Service worker fetch() sets Origin to chrome-extension://<id> which Facebook rejects.
chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Origin", operation: "set", value: "https://www.facebook.com" },
      ],
    },
    condition: {
      urlFilter: "https://www.facebook.com/api/graphql/",
      resourceTypes: ["xmlhttprequest"],
    },
  }],
});

// Load config and preserve existing alarm countdown on startup
loadConfig().then((cfg) => {
  ensureAlarm(cfg.crawl?.interval_minutes || 0);
  console.log("[FB Lead Scraper] Background started, config loaded");
});
