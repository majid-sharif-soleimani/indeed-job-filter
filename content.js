(() => {
  // Guard against double injection. After the extension is reloaded, the old copy of
  // this script stays on the page but is disconnected; let the new copy take over.
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  if (window.__ijfAlive && window.__ijfAlive()) return;
  window.__ijfAlive = alive;
  document.getElementById("ijf-panel")?.remove(); // panel left by a disconnected old copy

  let running = false;
  let stopRequested = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "IJF_TOGGLE") {
      if (running && !ui.visible()) {
        ui.show(); // panel was closed: just bring it back, keep running
        ui.status("Running…");
      } else if (running) {
        stopRequested = true;
        ui.status("Stopping after the current job…");
      } else if (!getCards().length) {
        diagnose();
      } else {
        run().catch((e) => {
          ui.status("Error: " + e.message);
          finish();
        });
      }
      sendResponse({ ok: true });
    }
  });

  // ================= DOM helpers (Indeed, as of 2026-10) =================
  //   card:      <li> containing a[data-jk="<jobKey>"] (inside div.job_seen_beacon)
  //   card info: .jobTitle, [data-testid="company-name"], [data-testid="text-location"]
  //   dislike:   button[data-testid="dislikeicon"] (aria-label "Inget intresse" / "Not interested")
  //   details:   #jobsearch-ViewjobPaneWrapper; [data-testid="vj-job-title"], [data-testid="vj-company-name"];
  //              selected job key in the URL as ?vjk=<jobKey>
  //   disliked:  the card text becomes "Jobbet har dolts / Vi kommer inte att visa dig det här jobbet igen."
  const IJF_DEFAULT_COMMUTE = ""; // no default places: set them on the options page

  // Indeed hides "trap" cards on the page (height 0, fake keys like fedcba9876543210, href /viewjob?jk=…).
  // Clicking one triggers Cloudflare's bot check, so only real, visible cards are used.
  const FAKE_JK = /^(0123456789abcdef|fedcba9876543210|abcdef0123456789|0{16}|f{16})$/i;
  function isRealCard(card) {
    const jk = cardJobId(card);
    if (!jk || FAKE_JK.test(jk) || !/^[0-9a-f]{16}$/i.test(jk)) return false;
    if (!card.getClientRects().length || card.offsetHeight < 20) return false;
    const st = getComputedStyle(card);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  }

  function getCards() {
    const cards = [...document.querySelectorAll("a[data-jk]")]
      .map((a) => a.closest("li") || a.closest(".job_seen_beacon"))
      .filter(Boolean);
    return [...new Set(cards)].filter(isRealCard);
  }

  function cardJobId(card) {
    return card.querySelector("a[data-jk]")?.getAttribute("data-jk") || null;
  }

  function findCard(jobId) {
    for (const a of document.querySelectorAll(`a[data-jk="${jobId}"]`)) {
      const c = a.closest("li") || a.closest(".job_seen_beacon");
      if (c && isRealCard(c)) return c;
    }
    return null;
  }

  const DISMISSED_TEXT =
    /jobbet har dolts|vi kommer inte att visa dig det här jobbet|this job has been hidden|job hidden|won[’']?t show you this job/i;

  function isDismissed(card, jobId) {
    if (dismissedIds.has(jobId)) return true;
    return DISMISSED_TEXT.test(card.innerText || "");
  }

  function isApplied(card) {
    return /(^|\n)\s*(Ansökt|Applied)\b/i.test(card.innerText || "");
  }

  function findDismissButton(card) {
    return (
      card.querySelector('button[data-testid="dislikeicon"]') ||
      [...card.querySelectorAll("button")].find((b) =>
        /inget intresse|not interested/i.test(b.getAttribute("aria-label") || "")
      ) ||
      null
    );
  }

  // Bookmark ("Save job Toggle"). It is a toggle, so only click when it is not already saved
  // (aria-pressed="true" means saved); otherwise we would un-save the job.
  function findSaveButton(card) {
    return (
      card.querySelector("button.bookmark") ||
      [...card.querySelectorAll("button")].find((b) => /save job|spara jobb/i.test(b.getAttribute("aria-label") || "")) ||
      null
    );
  }
  function isSaved(btn) {
    return btn.getAttribute("aria-pressed") === "true";
  }
  // returns "saved" | "already" | "missing"
  async function bookmark(card) {
    const btn = findSaveButton(card);
    if (!btn) return "missing";
    if (isSaved(btn)) return "already";
    btn.click();
    await sleep(500);
    return "saved";
  }

  // Remember disliked jobs (by us or by hand), so they are never checked again
  let dismissedIds = new Set();
  chrome.storage.local.get("dismissedIds").then(({ dismissedIds: d }) => {
    for (const id of d || []) dismissedIds.add(id);
  });
  function rememberDismissed(jobId) {
    if (!jobId || dismissedIds.has(jobId)) return;
    dismissedIds.add(jobId);
    chrome.storage.local.set({ dismissedIds: [...dismissedIds].slice(-5000) }).catch(() => {});
  }
  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target.closest?.('button[data-testid="dislikeicon"]');
      if (!btn) return;
      const card = btn.closest("li") || btn.closest(".job_seen_beacon");
      const id = card && cardJobId(card);
      if (id) rememberDismissed(id);
    },
    true
  );

  function currentJobIdFromUrl() {
    return new URL(location.href).searchParams.get("vjk");
  }

  const NOISE = [
    /ansök på företagets webbplats/gi,
    /ansök nu/gi,
    /rapportera jobb/gi,
    /apply on company site/gi,
    /report job/gi
  ];
  function cleanText(t) {
    let out = t;
    for (const r of NOISE) out = out.replace(r, "");
    return out.replace(/\n{3,}/g, "\n\n").trim();
  }

  // Wait until the element's text is non-trivial and stopped changing
  async function waitStable(getEl, minLen, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    while (Date.now() < deadline) {
      await sleep(250);
      const el = getEl();
      const len = el ? el.innerText.length : 0;
      if (len >= minLen && len === last) return el;
      last = len;
    }
    return getEl();
  }

  // Click the card, wait for its details, return the job data to score
  async function openAndExtract(card, jobId) {
    card.scrollIntoView({ block: "center" });
    await sleep(300);
    const info = cardInfo(card);
    (card.querySelector("a[data-jk]") || card).click();

    const PANE = "#jobsearch-ViewjobPaneWrapper, .jobsearch-RightPane, #jobsearch-ViewJobPane";
    const paneTitle = () =>
      (document.querySelector('[data-testid="vj-job-title"], [data-testid="jobsearch-JobInfoHeader-title"]')?.innerText || "")
        .replace(/\s*-\s*job post$/i, "")
        .trim();
    // ready = URL points to this job, the pane shows this job's title, and its text stopped changing
    const pane = await waitStable(
      () =>
        currentJobIdFromUrl() === jobId && (!info.title || paneTitle().startsWith(info.title.slice(0, 20)))
          ? document.querySelector(PANE)
          : null,
      300,
      12000
    );
    if (/just a moment|verify you are human|cloudflare/i.test(document.title + " " + (document.body?.innerText || "").slice(0, 300))) {
      stopRequested = true;
      throw new Error("Indeed showed a security check. Stopped; please complete it yourself, then press Run again.");
    }
    if (!pane || pane.innerText.length < 300) throw new Error("Job details did not load");

    return {
      title: paneTitle() || info.title,
      company: (document.querySelector('[data-testid="vj-company-name"], [data-testid="inlineHeader-companyName"]')?.innerText || info.company).trim(),
      cardText: [info.title, info.company, info.location].filter(Boolean).join(" | "),
      detailText: cleanText(pane.innerText).slice(0, 7000)
    };
  }

  // ================= Card fields (keyword filter + location rule) =================
  function cardInfo(card) {
    const t = (sel) => (card.querySelector(sel)?.innerText || "").replace(/\s+/g, " ").trim();
    return {
      title: t(".jobTitle, h2, h3"),
      company: t('[data-testid="company-name"], .companyName'),
      location: t('[data-testid="text-location"], .companyLocation')
    };
  }

  function cardFields(card) {
    const i = cardInfo(card);
    return [i.title, i.company, i.location].filter(Boolean);
  }

  function parseKeywords(str) {
    return String(str || "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .map((k) => ({
        k,
        // whole-word match, case-insensitive
        re: new RegExp(`(^|[^\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[^\\p{L}\\p{N}]|$)`, "iu")
      }));
  }

  // Auto-dislike keywords: NOT trimmed, spaces are significant (" AI " ≠ "AI").
  // Case-insensitive substring match. Each field is padded with one space on both sides,
  // so " Intern " also matches at the very start/end of a title.
  function parseBlockKeywords(str) {
    return String(str || "")
      .split(/[,\n]/)
      .filter((k) => k.trim() !== "")
      .map((k) => ({ k, low: k.toLowerCase() }));
  }

  function keywordHit(card, keywords) {
    if (!keywords.length) return null;
    for (const field of cardFields(card)) {
      const hay = (" " + field + " ").toLowerCase();
      for (const { k, low } of keywords) if (hay.includes(low)) return { keyword: k, field };
    }
    return null;
  }

  // ================= Location rule =================
  // A job must be in a commutable place (settings.commuteLocations) or be remote.
  // Returns null if OK / unknown, or the location text if the job should be disliked.
  // Indeed formats, e.g. "117 43 City", "Hybridarbete i City", "Distansarbete", "City, Region".
  const COUNTRY_ONLY = /^(sweden|sverige|europe|european union|emea|nordics?|scandinavia|worldwide)$/i;
  const REMOTE = /\bremote\b|distans|hemifrån|på distans/i;
  function locationProblem(card, places, postalRanges = []) {
    if (!places.length && !postalRanges.length) return null; // rule disabled
    const loc = cardInfo(card).location;
    if (!loc) return null;
    if (REMOTE.test(loc)) return null;
    const place = loc
      .replace(/\(.*?\)/g, "")
      .replace(/^(hybridarbete|hybrid|tillfälligt distansarbete)\s+i\s+/i, "")
      .replace(/\+\d+.*$/, "") // "+2 platser"
      .trim();
    if (!place) return null;
    const parts = place.split(",").map((x) => x.trim());
    if (parts.every((x) => COUNTRY_ONLY.test(x))) return null; // too vague: let the AI decide
    // Optional postal-code rule (settings.commutePostalRanges, e.g. "100-199, 740-764"):
    // a 5-digit code like "117 43" is decisive, so city districts don't need to be listed.
    const pc = place.match(/\b(\d{3})\s?\d{2}\b/);
    if (pc && postalRanges.length) {
      const n = +pc[1];
      return postalRanges.some(([lo, hi]) => n >= lo && n <= hi) ? null : loc;
    }
    if (places.some(({ re }) => re.test(place))) return null;
    return loc;
  }

  // ================= Dislike rejected (manual, from the panel button) =================
  // Jobs marked "not suitable" in the last run: jobId -> title. Nothing is disliked automatically;
  // the user presses "👎 Dislike rejected" in the panel after the run (with a confirm click).
  const lastRejected = new Map();
  let disliking = false;

  async function dislikeRejected() {
    if (running || disliking || !lastRejected.size) return;
    disliking = true;
    ui.setRunning(false);
    let done = 0, missing = 0;
    for (const [jobId, title] of [...lastRejected]) {
      const card = findCard(jobId);
      if (!card) { missing++; continue; }
      if (isDismissed(card, jobId)) { lastRejected.delete(jobId); continue; } // already disliked
      const btn = findDismissButton(card);
      if (!btn) { missing++; continue; }
      card.scrollIntoView({ block: "center" });
      btn.click();
      rememberDismissed(jobId);
      lastRejected.delete(jobId);
      done++;
      ui.status(`Disliking… ${done}`);
      ui.log(`👎 disliked · ${title}`, "", "bad");
      await sleep(600); // gentle pace (bot protection)
    }
    disliking = false;
    ui.status(`Disliked ${done} job(s)` + (missing ? ` · ${missing} not found on the page` : "") + ".");
    ui.setRunning(false);
  }

  // ================= Cache (avoid paying twice for the same job) =================
  async function getCache() {
    const { scoreCache } = await chrome.storage.local.get("scoreCache");
    return scoreCache || {};
  }
  async function putCache(jobId, result) {
    const c = await getCache();
    c[jobId] = { ...result, ts: Date.now() };
    await chrome.storage.local.set({ scoreCache: c });
  }

  // ================= Main loop =================
  async function run() {
    const { settings } = await chrome.storage.local.get("settings");
    const threshold = settings?.threshold ?? 60;
    const delayMs = (settings?.delaySec ?? 1) * 1000;
    const dryRun = !!settings?.dryRun;
    const MAX_PARALLEL = 5; // AI requests in flight at once

    running = true;
    stopRequested = false;
    ui.show();
    ui.setRunning(true);
    ui.reset();
    ui.status("Running…");

    const processed = new Set();
    lastRejected.clear();
    const stats = { match: 0, saved: 0, dismissed: 0, keyword: 0, location: 0, skipped: 0, errors: 0 };
    const doBookmark = settings?.bookmarkMatches ?? true;
    const keywords = parseBlockKeywords(settings?.blockKeywords);
    const places = parseKeywords(settings?.commuteLocations ?? IJF_DEFAULT_COMMUTE);
    const postalRanges = String(settings?.commutePostalRanges || "")
      .split(",")
      .map((r) => r.trim().split("-").map((x) => parseInt(x, 10)))
      .filter(([lo]) => !isNaN(lo))
      .map(([lo, hi]) => [lo, isNaN(hi) ? lo : hi]);
    const cache = await getCache();
    const inFlight = new Set();
    let opened = 0;
    let total = 0;

    const refreshStatus = (extra = "") =>
      ui.status(`Opened ${opened}/${total} · scoring ${inFlight.size}${extra ? " · " + extra : ""}`);

    // Apply a score to a card: badge it (green = fits, red = not suitable) and bookmark the suitable ones.
    // Indeed's dislike button is never clicked.
    async function applyResult(jobId, title, result) {
      const fit = result.decision === "match" && result.score >= threshold;
      const card = findCard(jobId);
      if (card) badge(card, result, fit, jobId);
      if (fit) {
        stats.match++;
        let note = "";
        if (doBookmark && card) {
          const r = await bookmark(card);
          if (r === "saved") stats.saved++;
          note = r === "saved" ? " · 🔖 saved" : r === "already" ? " · 🔖 already saved" : " · no save button";
        }
        ui.log(`✅ ${result.score} · ${title}${note}`, result.reason, "ok");
      } else {
        // Mark only: the extension never presses Indeed's dislike button
        stats.dismissed++;
        lastRejected.set(jobId, title);
        ui.log(`❌ ${result.score} · ${title}`, result.reason, "bad");
      }
      ui.stats(stats, dryRun);
    }

    function handleError(jobId, e) {
      stats.errors++;
      ui.log(`⚠️ error · job ${jobId}`, e.message, "warn");
      if (/HTTP 40[13]/.test(e.message)) {
        ui.status("API key rejected. Check the extension options.");
        stopRequested = true;
      }
      ui.stats(stats, dryRun);
    }

    // Opening jobs is sequential (it's one UI), but scoring runs in the background
    // in parallel, so we don't wait for the AI before opening the next job.
    for (let pass = 0; pass < 3 && !stopRequested; pass++) {
      const ids = [...new Set(getCards().map(cardJobId))].filter((id) => id && !processed.has(id));
      if (!ids.length) break;
      total += ids.length;

      for (const jobId of ids) {
        if (stopRequested) break;
        processed.add(jobId);
        opened++;
        chrome.runtime.sendMessage({ type: "IJF_STATE", running: true, progress: String(opened) });

        const card = findCard(jobId);
        if (!card) continue;
        if (isDismissed(card, jobId) || isApplied(card)) {
          stats.skipped++;
          ui.stats(stats, dryRun);
          continue;
        }

        // Keyword list: mark right away, no AI call
        const hit = keywordHit(card, keywords);
        if (hit) {
          const title = cardFields(card)[0] || jobId;
          badge(card, { score: 0, label: "🚫 keyword", reason: `Keyword "${hit.keyword}" in "${hit.field}"` }, false, jobId);
          stats.keyword++;
          lastRejected.set(jobId, title);
          ui.log(`🚫 keyword "${hit.keyword}" · ${title}`, hit.field, "bad");
          ui.stats(stats, dryRun);
          continue;
        }

        // Location rule: not in your commutable places and not remote -> mark, no AI call
        const badLoc = locationProblem(card, places, postalRanges);
        if (badLoc) {
          const title = cardFields(card)[0] || jobId;
          badge(card, { score: 0, label: "📍 location", reason: `Not commutable and not remote: ${badLoc}` }, false, jobId);
          stats.location++;
          lastRejected.set(jobId, title);
          ui.log(`📍 not commutable/remote · ${title}`, badLoc, "bad");
          ui.stats(stats, dryRun);
          continue;
        }

        if (cache[jobId]) {
          await applyResult(jobId, (card.innerText || "").split("\n")[0], cache[jobId]);
          continue;
        }

        while (inFlight.size >= MAX_PARALLEL && !stopRequested) await Promise.race(inFlight);
        if (stopRequested) break;

        let job;
        try {
          refreshStatus("opening job…");
          job = await openAndExtract(card, jobId);
        } catch (e) {
          handleError(jobId, e);
          continue;
        }

        const p = chrome.runtime
          .sendMessage({ type: "IJF_SCORE", job })
          .then(async (resp) => {
            if (!resp?.ok) throw new Error(resp?.error || "No response from background");
            await putCache(jobId, resp.result);
            await applyResult(jobId, job.title, resp.result);
          })
          .catch((e) => handleError(jobId, e))
          .finally(() => {
            inFlight.delete(p);
            refreshStatus();
          });
        inFlight.add(p);
        refreshStatus();
        if (delayMs) await sleep(delayMs);
      }
    }

    refreshStatus("waiting for last scores…");
    await Promise.all(inFlight);
    ui.status(stopRequested ? "Stopped." : `Done for this page (${opened} jobs).`);
    ui.stats(stats, dryRun);
    finish();
  }

  function diagnose() {
    const info = {
      url: location.href,
      jkLinks: document.querySelectorAll("a[data-jk]").length,
      beacons: document.querySelectorAll(".job_seen_beacon").length,
      dislikeBtns: document.querySelectorAll('button[data-testid="dislikeicon"]').length,
      detailsPane: !!document.querySelector("#jobsearch-ViewjobPaneWrapper"),
      sampleButtons: [...document.querySelectorAll("button[aria-label]")].map((b) => b.getAttribute("aria-label")).slice(0, 25)
    };
    console.log("[IJF] diagnostic", info);
    ui.show();
    ui.reset();
    ui.status("No job cards found. Diagnostic (please send this to Claude):");
    ui.log("Diagnostic", JSON.stringify(info), "warn");
  }

  function finish() {
    running = false;
    stopRequested = false;
    ui.setRunning(false);
    chrome.runtime.sendMessage({ type: "IJF_STATE", running: false });
  }

  // Badges: Indeed may re-render cards, so we remember scores and re-apply badges continuously.
  const badges = new Map(); // jobId -> {score, reason, fit}

  function badge(_card, result, fit, jobId) {
    if (!jobId) return;
    badges.set(jobId, { score: result.score, label: result.label, reason: result.reason, fit });
    applyBadge(jobId);
  }

  function applyBadge(jobId) {
    const info = badges.get(jobId);
    const t = info && findCard(jobId);
    if (!t) return;
    const host = t.querySelector(".job_seen_beacon") || t;
    const existing = host.querySelector(":scope > .ijf-badge");
    const text = info.label || `AI ${info.score}`;
    if (existing && existing.textContent === text) return;
    existing?.remove();
    const b = document.createElement("div");
    b.className = "ijf-badge";
    b.textContent = text;
    b.title = info.reason || "";
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    Object.assign(b.style, {
      position: "absolute",
      right: "16px", // bottom-right corner, below the save / dislike icons
      bottom: "12px",
      zIndex: 5,
      padding: "2px 8px",
      borderRadius: "10px",
      font: "600 12px system-ui, sans-serif",
      color: "#fff",
      background: info.fit ? "#1e8e3e" : "#c5221f",
      pointerEvents: "auto",
      cursor: "help"
    });
    host.appendChild(b);
  }

  setInterval(() => {
    for (const id of badges.keys()) applyBadge(id);
  }, 1000);

  // ================= Floating panel =================
  const ui = (() => {
    let root, statusEl, statsEl, logEl;
    function build() {
      root = document.createElement("div");
      root.id = "ijf-panel";
      root.innerHTML = `
        <div data-r="handle" title="Drag to move" style="display:flex;align-items:center;gap:8px;margin:-10px -12px 6px;padding:8px 12px;cursor:move;user-select:none;background:#f3f6f8;border-radius:10px 10px 0 0;border-bottom:1px solid #e0e0e0">
          <strong style="flex:1">⠿ Indeed AI Filter</strong>
          <button data-a="details" style="cursor:pointer" title="Show/hide per-job report">Details ▾</button>
          <button data-a="rerun" style="cursor:pointer;display:none" title="Run again on the jobs now on this page">↻ Run again</button>
          <button data-a="stop" style="cursor:pointer">Stop</button>
          <button data-a="close" style="cursor:pointer">✕</button>
        </div>
        <div data-r="status" style="margin-bottom:4px"></div>
        <button data-a="dislike" style="display:none;cursor:pointer;margin:2px 0 6px;padding:3px 10px;border:1px solid #c5221f;color:#c5221f;background:#fff;border-radius:6px" title="Press Indeed's dislike on the jobs marked not suitable in the last run"></button>
        <div data-r="stats" style="margin-bottom:6px;color:#555"></div>
        <div data-r="log" style="display:none;max-height:420px;overflow:auto;border-top:1px solid #ddd;padding-top:4px"></div>`;
      Object.assign(root.style, {
        position: "fixed",
        left: "16px",
        bottom: "16px",
        width: "340px",
        zIndex: 2147483647,
        background: "#fff",
        color: "#222",
        border: "1px solid #ccc",
        borderRadius: "10px",
        boxShadow: "0 6px 24px rgba(0,0,0,.18)",
        padding: "10px 12px",
        font: "13px/1.4 system-ui, sans-serif"
      });
      statusEl = root.querySelector('[data-r="status"]');
      statsEl = root.querySelector('[data-r="stats"]');
      logEl = root.querySelector('[data-r="log"]');
      // Collapsed = summary only; expanded = wider panel with the per-job report
      const detailsBtn = root.querySelector('[data-a="details"]');
      const setExpanded = (on) => {
        logEl.style.display = on ? "block" : "none";
        root.style.width = on ? "480px" : "340px";
        detailsBtn.textContent = on ? "Details ▴" : "Details ▾";
        try { localStorage.setItem("ijf-panel-expanded", on ? "1" : "0"); } catch {}
        // keep the panel on screen after it grows
        const r = root.getBoundingClientRect();
        if (r.right > window.innerWidth) root.style.left = Math.max(0, window.innerWidth - r.width - 8) + "px";
        if (r.bottom > window.innerHeight && root.style.top) root.style.top = Math.max(0, window.innerHeight - r.height - 8) + "px";
      };
      let expanded = false;
      try { expanded = localStorage.getItem("ijf-panel-expanded") === "1"; } catch {}
      detailsBtn.onclick = () => setExpanded((expanded = !expanded));
      root.querySelector('[data-a="rerun"]').onclick = () => {
        if (running || disliking) return;
        if (!getCards().length) return status("No job cards found on this page.");
        run().catch((e) => {
          status("Error: " + e.message);
          finish();
        });
      };
      // Two-step confirm (no browser dialogs)
      const dislikeBtn = root.querySelector('[data-a="dislike"]');
      let armed = 0;
      dislikeBtn.onclick = () => {
        if (running || disliking) return;
        if (Date.now() - armed > 4000) {
          armed = Date.now();
          dislikeBtn.textContent = `Click again to dislike ${lastRejected.size} job(s)`;
          setTimeout(() => setRunning(running), 4000);
          return;
        }
        armed = 0;
        dislikeRejected();
      };
      root.querySelector('[data-a="stop"]').onclick = () => {
        if (running) {
          stopRequested = true;
          status("Stopping after the current job…");
        }
      };
      root.querySelector('[data-a="close"]').onclick = () => {
        root.remove();
        root = null;
      };
      document.body.appendChild(root);
      if (typeof history !== "undefined") for (const h of history) render(...h);
      makeDraggable(root, root.querySelector('[data-r="handle"]'));
      setExpanded(expanded);
    }

    // Drag the panel by its header; remember the position across page loads
    function makeDraggable(panel, handle) {
      const KEY = "ijf-panel-pos";
      const place = (x, y) => {
        x = Math.max(0, Math.min(x, window.innerWidth - panel.offsetWidth));
        y = Math.max(0, Math.min(y, window.innerHeight - 40));
        Object.assign(panel.style, { left: x + "px", top: y + "px", bottom: "auto", right: "auto" });
      };
      try {
        const pos = JSON.parse(localStorage.getItem(KEY) || "null");
        if (pos) place(pos.x, pos.y);
      } catch {}
      handle.addEventListener("pointerdown", (e) => {
        if (e.target.closest("button")) return;
        e.preventDefault();
        const r = panel.getBoundingClientRect();
        const dx = e.clientX - r.left;
        const dy = e.clientY - r.top;
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => place(ev.clientX - dx, ev.clientY - dy);
        const up = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          try {
            const r2 = panel.getBoundingClientRect();
            localStorage.setItem(KEY, JSON.stringify({ x: r2.left, y: r2.top }));
          } catch {}
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
      });
    }

    function show() {
      if (!root || !document.body.contains(root)) build();
      setRunning(running);
    }
    // While running show Stop; when idle show Run again
    function setRunning(on) {
      if (!root) return;
      root.querySelector('[data-a="rerun"]').style.display = on ? "none" : "";
      const d = root.querySelector('[data-a="dislike"]');
      const n = lastRejected.size;
      d.style.display = !on && !disliking && n ? "" : "none";
      d.textContent = `👎 Dislike rejected (${n})`;
      root.querySelector('[data-a="stop"]').style.display = on ? "" : "none";
    }
    function visible() {
      return !!root && document.body.contains(root);
    }
    function reset() {
      history.length = 0;
      logEl.innerHTML = "";
      statsEl.textContent = "";
    }
    function status(t) {
      if (statusEl) statusEl.textContent = t;
    }
    function stats(s, dry) {
      if (statsEl)
        statsEl.textContent = `Match: ${s.match} (🔖 saved now: ${s.saved || 0}) · Not suitable (AI): ${s.dismissed} · by keyword: ${s.keyword || 0} · by location: ${s.location || 0} · Skipped (disliked/applied): ${s.skipped} · Errors: ${s.errors}`;
    }
    const history = [];
    function log(head, detail, kind) {
      history.push([head, detail, kind]);
      if (history.length > 200) history.shift();
      render(head, detail, kind);
    }
    function render(head, detail, kind) {
      if (!logEl) return;
      const d = document.createElement("div");
      d.style.margin = "4px 0";
      d.style.color = kind === "ok" ? "#1e8e3e" : kind === "bad" ? "#c5221f" : "#b06000";
      d.innerHTML = `<div style="font-weight:600"></div><div style="color:#555;font-size:12px"></div>`;
      d.children[0].textContent = head;
      d.children[1].textContent = detail || "";
      logEl.prepend(d);
    }
    return { show, visible, setRunning, reset, status, stats, log };
  })();
})();
