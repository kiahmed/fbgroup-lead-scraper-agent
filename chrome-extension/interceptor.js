/**
 * Injected into the Facebook page context to intercept fetch() and XHR calls.
 * Captures responses from /api/graphql/ that contain group feed data
 * and posts them back to the content script via window.postMessage.
 */
(function () {
  const GRAPHQL_PATH = "/api/graphql/";
  const FEED_QUERIES = [
    "GroupsCometFeedRegularStoriesPaginationQuery",
    "CometGroupDiscussionRootSuccessQuery",
    "GroupsCometFeedRegularStories",
  ];

  function isFeedQuery(name) {
    return FEED_QUERIES.some((q) => name.includes(q));
  }

  function postPayload(queryName, text) {
    window.postMessage(
      { type: "FB_GRAPHQL_RESPONSE", query: queryName, payload: text },
      "*"
    );
  }

  /**
   * Extract the friendly name from either:
   * - Request headers (X-FB-Friendly-Name)
   * - Request body (fb_api_req_friendly_name=...)
   */
  function getFriendlyName(args) {
    // Check headers first (works for both Request objects and init objects)
    try {
      const input = args[0];
      const init = args[1] || {};

      // Headers from init object
      if (init.headers) {
        if (init.headers instanceof Headers) {
          const name = init.headers.get("X-FB-Friendly-Name");
          if (name) return name;
        } else if (typeof init.headers === "object") {
          const name = init.headers["X-FB-Friendly-Name"];
          if (name) return name;
        }
      }

      // Headers from Request object
      if (input instanceof Request) {
        const name = input.headers.get("X-FB-Friendly-Name");
        if (name) return name;
      }
    } catch (e) { /* fall through to body check */ }

    // Fallback: check body for fb_api_req_friendly_name
    try {
      const body = args[1]?.body || (args[0] instanceof Request ? null : null);
      if (!body) return "";

      const bodyStr =
        typeof body === "string"
          ? body
          : body instanceof URLSearchParams
            ? body.toString()
            : "";

      const match = bodyStr.match(/fb_api_req_friendly_name=([^&]+)/);
      if (match) return decodeURIComponent(match[1]);
    } catch (e) { /* ignore */ }

    return "";
  }

  // --- Capture client-state params from real requests -------------------------

  const CLIENT_STATE_KEYS = [
    "__dyn", "__csr", "__hs", "__s", "__ccg", "__hsdp", "__hblp", "__sjsp",
    "__comet_req", "__req", "__rev", "__hsi", "doc_id",
  ];

  let clientStateCaptured = false;

  function captureClientState(body) {
    if (clientStateCaptured) return;
    try {
      let bodyStr = "";
      if (typeof body === "string") bodyStr = body;
      else if (body instanceof URLSearchParams) bodyStr = body.toString();
      else if (body instanceof FormData) {
        // Convert FormData to URLSearchParams string
        const parts = [];
        body.forEach((v, k) => parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v)));
        bodyStr = parts.join("&");
      }
      if (!bodyStr) return;
      const params = new URLSearchParams(bodyStr);
      const state = {};
      let found = 0;
      for (const key of CLIENT_STATE_KEYS) {
        if (params.has(key)) { state[key] = params.get(key); found++; }
      }
      console.log(`[FB Lead Scraper] captureClientState: found ${found} params, bodyType=${typeof body}, bodyLen=${bodyStr.length}`);
      if (found >= 3) {
        clientStateCaptured = true;
        console.log(`[FB Lead Scraper] Captured ${found} client-state params: ${Object.keys(state).join(", ")}`);
        window.postMessage({ type: "FB_CLIENT_STATE", data: state }, "*");
      }
    } catch (e) { /* ignore */ }
  }

  // --- Hook fetch() -----------------------------------------------------------

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (!url.includes(GRAPHQL_PATH)) return response;

      // Capture client state from any graphql request body
      const init = args[1] || {};
      captureClientState(init.body);

      const friendlyName = getFriendlyName(args);

      // Log ALL graphql requests so we can see what's flowing through
      console.log(`[FB Lead Scraper] fetch GraphQL: ${friendlyName || "(unknown)"}`);

      if (!friendlyName || !isFeedQuery(friendlyName)) return response;

      console.log(`[FB Lead Scraper] MATCHED feed query: ${friendlyName}`);

      const cloned = response.clone();
      cloned.text().then((text) => {
        console.log(`[FB Lead Scraper] Captured response: ${text.length} bytes`);
        postPayload(friendlyName, text);
      });
    } catch (e) {
      console.warn("[FB Lead Scraper] fetch intercept error:", e);
    }

    return response;
  };

  // --- Hook XMLHttpRequest ----------------------------------------------------

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  const originalXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._fbUrl = url;
    this._fbHeaders = {};
    return originalXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._fbHeaders) this._fbHeaders[name] = value;
    return originalXHRSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this._fbUrl && this._fbUrl.includes(GRAPHQL_PATH)) {
        captureClientState(body);
        const friendlyName =
          this._fbHeaders["X-FB-Friendly-Name"] || "";

        console.log(`[FB Lead Scraper] XHR GraphQL: ${friendlyName || "(unknown)"}`);

        if (friendlyName && isFeedQuery(friendlyName)) {
          console.log(`[FB Lead Scraper] MATCHED XHR feed query: ${friendlyName}`);

          this.addEventListener("load", function () {
            try {
              console.log(`[FB Lead Scraper] XHR response: ${this.responseText.length} bytes`);
              postPayload(friendlyName, this.responseText);
            } catch (e) {
              console.warn("[FB Lead Scraper] XHR response read error:", e);
            }
          });
        }
      }
    } catch (e) { /* never break XHR */ }

    return originalXHRSend.call(this, body);
  };

  console.log("[FB Lead Scraper] Interceptor installed (fetch + XHR)");
})();
