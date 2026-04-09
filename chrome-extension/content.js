/**
 * Content script - injected into facebook.com/groups/* pages.
 *
 * 1. Injects interceptor.js into the page context (to hook fetch).
 * 2. Listens for postMessage from the interceptor with GraphQL response data.
 * 3. Forwards the data to the background service worker.
 */

// Inject the fetch interceptor into the page's JS context
const script = document.createElement("script");
script.src = chrome.runtime.getURL("interceptor.js");
script.onload = () => script.remove();
(document.head || document.documentElement).appendChild(script);

// Also capture the initial page HTML for stories embedded in script tags
// (the 3-4 posts that load without scrolling)
function captureInitialPosts() {
  const scripts = document.querySelectorAll('script[type="application/json"]');
  scripts.forEach((el) => {
    try {
      chrome.runtime.sendMessage({
        type: "INITIAL_PAGE_JSON",
        payload: el.textContent,
        url: window.location.href,
      });
    } catch (e) {
      // Extension context may not be ready yet
    }
  });
}

// Wait for page load then capture initial embedded posts
if (document.readyState === "complete") {
  captureInitialPosts();
} else {
  window.addEventListener("load", captureInitialPosts);
}

// Listen for intercepted GraphQL responses from the page-level interceptor
window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  if (event.data?.type === "FB_GRAPHQL_RESPONSE") {
    chrome.runtime.sendMessage({
      type: "GRAPHQL_FEED_RESPONSE",
      query: event.data.query,
      payload: event.data.payload,
      url: window.location.href,
    });
  } else if (event.data?.type === "FB_CLIENT_STATE") {
    chrome.runtime.sendMessage({
      type: "CLIENT_STATE",
      data: event.data.data,
    });
  }
});

console.log("[FB Lead Scraper] Content script loaded");
