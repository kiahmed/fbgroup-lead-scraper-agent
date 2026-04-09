/**
 * Options page - loads config from background, renders forms, saves back.
 */

let config = null; // current working copy

// --- Tab switching -----------------------------------------------------------

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
  });
});

// --- Toast -------------------------------------------------------------------

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2000);
}

// --- Group list rendering ----------------------------------------------------

function renderGroups() {
  const container = document.getElementById("groupList");
  container.innerHTML = "";
  config.groups.forEach((group, i) => {
    const el = document.createElement("div");
    el.className = "group-item";
    el.innerHTML = `
      <input type="checkbox" ${group.enabled !== false ? "checked" : ""} data-idx="${i}">
      <div class="group-info">
        <div class="group-name">${group.name}</div>
        <div class="group-id">${group.id}</div>
      </div>
      <button class="btn-del" data-idx="${i}">&times;</button>
    `;
    container.appendChild(el);
  });

  // Checkbox toggles
  container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      config.groups[parseInt(cb.dataset.idx)].enabled = cb.checked;
    });
  });

  // Delete buttons
  container.querySelectorAll(".btn-del").forEach((btn) => {
    btn.addEventListener("click", () => {
      config.groups.splice(parseInt(btn.dataset.idx), 1);
      renderGroups();
    });
  });
}

document.getElementById("addGroupBtn").addEventListener("click", () => {
  const idInput = document.getElementById("newGroupId");
  const nameInput = document.getElementById("newGroupName");
  const id = idInput.value.trim();
  const name = nameInput.value.trim();
  if (!id) return;

  config.groups.push({ id, name: name || `Group ${id}`, enabled: true });
  renderGroups();
  idInput.value = "";
  nameInput.value = "";
});

document.getElementById("loadGroupsBtn").addEventListener("click", () => {
  const btn = document.getElementById("loadGroupsBtn");
  const status = document.getElementById("loadGroupsStatus");
  btn.disabled = true;
  btn.textContent = "Loading...";
  status.textContent = "Fetching your groups from Facebook...";

  chrome.runtime.sendMessage({ type: "LOAD_GROUPS" }, (resp) => {
    btn.disabled = false;
    btn.textContent = "Load My Groups";

    if (!resp?.ok) {
      status.textContent = `Error: ${resp?.error || "unknown"}`;
      status.style.color = "#f87171";
      return;
    }

    const fetched = resp.groups || [];
    status.textContent = `Found ${fetched.length} groups`;
    status.style.color = "#4ade80";

    // Merge with existing: keep enabled state for groups already in config
    const existingById = {};
    for (const g of config.groups) existingById[g.id] = g;

    config.groups = fetched.map((g) => ({
      id: g.id,
      name: g.name,
      enabled: existingById[g.id]?.enabled ?? false, // new groups default to unchecked
    }));

    renderGroups();
  });
});

// --- Keyword group list rendering --------------------------------------------

function renderKwGroups() {
  const container = document.getElementById("kwGroupList");
  container.innerHTML = "";
  config.keyword_groups.forEach((group, i) => {
    const el = document.createElement("div");
    el.className = "kw-group-item";
    el.innerHTML = `
      <div class="kw-group-header">
        <input type="checkbox" ${group.enabled ? "checked" : ""} data-idx="${i}">
        <input type="text" value="${group.name}" data-idx="${i}" data-field="name" placeholder="Group name" style="flex:1">
        <button class="btn-del" data-idx="${i}">&times;</button>
      </div>
      <div class="kw-group-keywords">
        <textarea rows="2" data-idx="${i}" data-field="keywords" placeholder="Keywords (one per line)">${(group.keywords || []).join("\n")}</textarea>
      </div>
    `;
    container.appendChild(el);
  });

  // Bind events
  container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      config.keyword_groups[parseInt(cb.dataset.idx)].enabled = cb.checked;
    });
  });

  container.querySelectorAll('input[data-field="name"]').forEach((input) => {
    input.addEventListener("input", () => {
      config.keyword_groups[parseInt(input.dataset.idx)].name = input.value;
    });
  });

  container.querySelectorAll('textarea[data-field="keywords"]').forEach((ta) => {
    ta.addEventListener("input", () => {
      config.keyword_groups[parseInt(ta.dataset.idx)].keywords =
        ta.value.split("\n").map((s) => s.trim()).filter(Boolean);
    });
  });

  container.querySelectorAll(".btn-del").forEach((btn) => {
    btn.addEventListener("click", () => {
      config.keyword_groups.splice(parseInt(btn.dataset.idx), 1);
      renderKwGroups();
    });
  });
}

document.getElementById("addKwGroupBtn").addEventListener("click", () => {
  config.keyword_groups.push({ name: "", enabled: false, keywords: [] });
  renderKwGroups();
});

// --- Load config into form ---------------------------------------------------

function populateForm(cfg) {
  config = structuredClone(cfg);

  // Groups
  renderGroups();
  document.getElementById("maxPages").value = cfg.crawl?.max_pages_per_group ?? 5;
  document.getElementById("retentionDays").value = cfg.state?.retention_days ?? 30;

  // Schedule
  document.getElementById("intervalMinutes").value = cfg.crawl?.interval_minutes ?? 0;
  document.getElementById("delayGroupsMin").value = cfg.crawl?.delay_between_groups?.[0] ?? 8;
  document.getElementById("delayGroupsMax").value = cfg.crawl?.delay_between_groups?.[1] ?? 15;
  document.getElementById("delayPagesMin").value = cfg.crawl?.delay_between_pages?.[0] ?? 3;
  document.getElementById("delayPagesMax").value = cfg.crawl?.delay_between_pages?.[1] ?? 6;
  document.getElementById("docId").value = cfg.crawl?.doc_id ?? "";

  // Keywords
  document.getElementById("keywords").value = (cfg.keywords || []).join("\n");
  document.getElementById("minMatches").value = cfg.filtering?.min_keyword_matches ?? 1;
  document.getElementById("excludeKeywords").value = (cfg.filtering?.exclude_keywords || []).join("\n");

  // Keyword groups
  renderKwGroups();

  // Delivery
  document.getElementById("webhookUrl").value = cfg.webhook?.url ?? "";
  document.getElementById("batchSize").value = cfg.webhook?.batch_size ?? 12;
  document.getElementById("batchDelay").value = cfg.webhook?.batch_delay_sec ?? 20;
  document.getElementById("retryAttempts").value = cfg.webhook?.retry_attempts ?? 3;
  document.getElementById("retryBackoff").value = cfg.webhook?.retry_backoff_sec ?? 2;

  // Notifications
  document.getElementById("notifyDelivery").checked = cfg.notifications?.on_delivery ?? true;
  document.getElementById("notifyError").checked = cfg.notifications?.on_error ?? true;

  // Logs
  document.getElementById("logRetention").value = cfg.logs?.retention_days ?? 7;
}

// --- Collect form back into config -------------------------------------------

function collectForm() {
  // Groups - already live-updated via event handlers

  // Crawl
  config.crawl = {
    max_pages_per_group: parseInt(document.getElementById("maxPages").value) || 5,
    delay_between_groups: [
      parseInt(document.getElementById("delayGroupsMin").value) || 8,
      parseInt(document.getElementById("delayGroupsMax").value) || 15,
    ],
    delay_between_pages: [
      parseInt(document.getElementById("delayPagesMin").value) || 3,
      parseInt(document.getElementById("delayPagesMax").value) || 6,
    ],
    doc_id: document.getElementById("docId").value.trim() || "27304630699126132",
    interval_minutes: parseInt(document.getElementById("intervalMinutes").value) || 0,
  };

  // State
  config.state = {
    retention_days: parseInt(document.getElementById("retentionDays").value) || 30,
  };

  // Keywords
  config.keywords = document.getElementById("keywords").value
    .split("\n").map((s) => s.trim()).filter(Boolean);

  config.filtering = {
    min_keyword_matches: parseInt(document.getElementById("minMatches").value) || 1,
    exclude_keywords: document.getElementById("excludeKeywords").value
      .split("\n").map((s) => s.trim()).filter(Boolean),
  };

  // Keyword groups - already live-updated

  // Webhook
  config.webhook = {
    url: document.getElementById("webhookUrl").value.trim(),
    batch_size: parseInt(document.getElementById("batchSize").value) || 12,
    batch_delay_sec: parseInt(document.getElementById("batchDelay").value) || 20,
    retry_attempts: parseInt(document.getElementById("retryAttempts").value) || 3,
    retry_backoff_sec: parseInt(document.getElementById("retryBackoff").value) || 2,
  };

  // Notifications
  config.notifications = {
    on_delivery: document.getElementById("notifyDelivery").checked,
    on_error: document.getElementById("notifyError").checked,
  };

  // Logs retention
  config.logs = {
    retention_days: parseInt(document.getElementById("logRetention").value) || 7,
  };

  return config;
}

// --- Save / Cancel -----------------------------------------------------------

document.getElementById("saveBtn").addEventListener("click", () => {
  const cfg = collectForm();
  chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config: cfg }, (resp) => {
    if (resp?.ok) {
      showToast("Settings saved");
    } else {
      showToast("ERROR saving: " + (resp?.error || "unknown error"));
    }
  });
});

document.getElementById("cancelBtn").addEventListener("click", () => {
  // Reload from storage
  chrome.runtime.sendMessage({ type: "GET_CONFIG" }, (cfg) => {
    populateForm(cfg);
    showToast("Changes discarded");
  });
});

// --- Logs tab ----------------------------------------------------------------

function timeAgo(ts) {
  if (!ts) return "never";
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function loadLogs() {
  chrome.runtime.sendMessage({ type: "GET_LOGS" }, (data) => {
    if (!data) return;

    // Group status
    const gsContainer = document.getElementById("groupStatusList");
    gsContainer.innerHTML = "";
    for (const group of data.groups || []) {
      const s = data.crawlState?.[group.id];
      const row = document.createElement("div");
      row.className = "group-status-row";
      if (s) {
        const status = s.newPosts > 0 ? "gs-ok" : "gs-detail";
        row.innerHTML = `
          <span class="gs-name">${group.name}</span>
          <span class="${status}">${timeAgo(s.lastCrawl)} &middot; ${s.newPosts ?? 0} new / ${s.duplicates ?? 0} dup &middot; ${s.pages ?? 0} pages</span>
        `;
      } else {
        row.innerHTML = `
          <span class="gs-name">${group.name}</span>
          <span class="gs-detail">never crawled</span>
        `;
      }
      gsContainer.appendChild(row);
    }

    // Error history
    const ehContainer = document.getElementById("errorHistoryList");
    ehContainer.innerHTML = "";
    const errors = (data.errorHistory || []).slice().reverse();
    if (!errors.length) {
      ehContainer.innerHTML = "";
      return;
    }
    for (const e of errors) {
      const div = document.createElement("div");
      div.className = "log-entry error";
      div.innerHTML = `<span class="log-time">${new Date(e.timestamp).toLocaleString()}</span><strong>${e.key}</strong>: ${e.message}`;
      ehContainer.appendChild(div);
    }

    // Crawl log
    const clContainer = document.getElementById("crawlLogList");
    clContainer.innerHTML = "";
    const logs = (data.crawlLog || []).slice().reverse();
    for (const entry of logs) {
      const div = document.createElement("div");
      div.className = "log-entry";
      // Support both old string format and new {ts, line} format
      if (typeof entry === "string") {
        div.textContent = entry;
      } else {
        div.innerHTML = `<span class="log-time">${new Date(entry.ts).toLocaleString()}</span>${entry.line}`;
      }
      clContainer.appendChild(div);
    }
  });
}

document.getElementById("clearErrorsBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_ERROR_HISTORY" }, () => {
    document.getElementById("errorHistoryList").innerHTML = "";
    showToast("Error history cleared");
  });
});

document.getElementById("clearLogsBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_LOGS" }, () => {
    document.getElementById("crawlLogList").innerHTML = "";
    showToast("Crawl logs cleared");
  });
});

// Refresh logs when switching to the tab
document.querySelector('[data-tab="logs"]').addEventListener("click", () => {
  loadLogs();
});

// --- Export / Import ----------------------------------------------------------

document.getElementById("exportBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "EXPORT_CONFIG" }, (cfg) => {
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fb-lead-scraper-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Config exported");
  });
});

document.getElementById("importBtn").addEventListener("click", () => {
  document.getElementById("importFile").click();
});

document.getElementById("importFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const cfg = JSON.parse(reader.result);
      if (!cfg.groups || !cfg.crawl || !cfg.webhook) {
        showToast("Invalid config file - missing required sections");
        return;
      }
      chrome.runtime.sendMessage({ type: "IMPORT_CONFIG", config: cfg }, (resp) => {
        if (resp?.ok) {
          populateForm(cfg);
          config = cfg;
          showToast("Config imported");
        }
      });
    } catch (err) {
      showToast("Invalid JSON file");
    }
  };
  reader.readAsText(file);
  e.target.value = ""; // allow re-import of same file
});

// --- Initial load ------------------------------------------------------------

chrome.runtime.sendMessage({ type: "GET_CONFIG" }, (cfg) => {
  populateForm(cfg);
});
