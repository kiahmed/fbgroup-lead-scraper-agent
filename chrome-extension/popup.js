const statusDot = document.getElementById("statusDot");
const toggleBtn = document.getElementById("toggleBtn");
const crawlBtn = document.getElementById("crawlBtn");
const flushBtn = document.getElementById("flushBtn");
const resetBtn = document.getElementById("resetBtn");
const nextCrawlEl = document.getElementById("nextCrawl");
const groupsList = document.getElementById("groupsList");

function timeAgo(ts) {
  if (!ts) return "never";
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function updateUI(data) {
  // Stats
  document.getElementById("crawls").textContent = data.stats.crawls || 0;
  document.getElementById("extracted").textContent = data.stats.extracted;
  document.getElementById("matched").textContent = data.stats.matched;
  document.getElementById("delivered").textContent = data.stats.delivered;
  document.getElementById("intercepted").textContent = data.stats.intercepted;
  document.getElementById("pending").textContent = data.pending;

  // Status indicator
  if (data.isCrawling) {
    statusDot.className = "status crawling";
  } else {
    statusDot.className = `status ${data.enabled ? "on" : "off"}`;
  }

  // Crawl button
  crawlBtn.disabled = data.isCrawling;
  crawlBtn.textContent = data.isCrawling ? "Crawling..." : "Crawl Now";

  // Toggle button
  toggleBtn.textContent = data.enabled ? "Pause" : "Resume";
  toggleBtn.className = `btn-toggle${data.enabled ? "" : " off"}`;

  // Group list with crawl stats
  groupsList.innerHTML = "";
  for (const group of data.groups || []) {
    if (group.enabled === false) continue;
    const s = data.crawlState?.[group.id];
    const row = document.createElement("div");
    row.className = "group-row";
    const detail = s
      ? `${timeAgo(s.lastCrawl)} | ${s.newPosts != null ? s.newPosts : "-"}new / ${s.duplicates != null ? s.duplicates : "-"}dup`
      : "never";
    const newestPost = s?.newestPostDate
      ? ` | latest: ${new Date(s.newestPostDate).toLocaleDateString()}`
      : "";
    row.innerHTML = `
      <span class="group-name">${group.name}</span>
      <span class="group-time">${detail}${newestPost}</span>
    `;
    groupsList.appendChild(row);
  }

  // Next crawl
  if (data.nextAlarm) {
    const ms = data.nextAlarm - Date.now();
    if (ms > 0) {
      const min = Math.floor(ms / 60000);
      const sec = Math.floor((ms % 60000) / 1000);
      nextCrawlEl.textContent = `Next crawl in ${min}m ${sec}s`;
    } else {
      nextCrawlEl.textContent = "Crawl due now";
    }
  } else {
    nextCrawlEl.textContent = "Schedule: manual only";
  }
}

function refresh() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (resp) => {
    if (resp) updateUI(resp);
  });
}

crawlBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CRAWL_NOW" }, () => refresh());
});

toggleBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "TOGGLE_ENABLED" }, () => refresh());
});

flushBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "FLUSH_NOW" }, () => refresh());
});

resetBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "RESET_STATS" }, () => refresh());
});

document.getElementById("openSettings").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

refresh();
setInterval(refresh, 2000);
