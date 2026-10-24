importScripts("settings.js");

// ---------- Toolbar button ----------
chrome.action.onClicked.addListener(async (tab) => {
  const s = await ijfGetSettings();
  if (!s.apiKeys[s.provider] || !s.resume.trim()) {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (!/^https:\/\/([a-z]+\.)?indeed\.com\//.test(tab.url || "")) {
    flashBadge(tab.id, "?", "#888");
    chrome.action.setTitle({ tabId: tab.id, title: "Open an Indeed jobs page first" });
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "IJF_TOGGLE" });
  } catch {
    // Content script not present (tab was open before install) -> inject it
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "IJF_TOGGLE" });
  }
});

function flashBadge(tabId, text, color) {
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }), 3000);
}

// ---------- Migration: keep saved criteria up to date ----------
// Runs every time the service worker starts (and on install/update); it only changes something once.
ijfRunMigration().catch(() => {});
chrome.runtime.onInstalled.addListener(() => ijfRunMigration().catch(() => {}));

// ---------- Messages from content script / options ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "IJF_SCORE") {
    scoreJob(msg.job)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }
  if (msg.type === "IJF_STATE" && sender.tab) {
    const tabId = sender.tab.id;
    if (msg.running) {
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#0a66c2" });
      chrome.action.setBadgeText({ tabId, text: msg.progress || "…" });
    } else {
      chrome.action.setBadgeText({ tabId, text: "" });
    }
  }
});

// ---------- Scoring ----------
async function scoreJob(job) {
  const s = await ijfGetSettings();
  const system =
    `You screen Indeed job ads for ONE candidate. Compare the job with the candidate's hard criteria and resume.\n` +
    `Rules:\n` +
    `- If any hard criterion is clearly violated, decision must be "reject" and score <= 30.\n` +
    `- Otherwise score 0-100 by how well the candidate's experience fits the job's requirements.\n` +
    `- If the hard criteria limit the location and the job is clearly outside it and not fully remote, reject.
` +
    `- For other missing information, don't reject for that alone.\n` +
    `Reply with JSON only, no markdown: {"score": <integer 0-100>, "decision": "match" | "reject", "reason": "<max 30 words; start with [Strong], [Transition], [Weak] or [Gap]>"}\n\n` +
    `=== CANDIDATE HARD CRITERIA ===\n${s.criteria}\n\n=== CANDIDATE RESUME ===\n${s.resume}`;

  const user =
    `=== JOB AD (scraped from Indeed, may contain UI noise; Swedish UI labels like "Heltid", "Tillsvidare", "Hybridarbete" are not the ad language) ===\n` +
    `Title: ${job.title}\nCompany: ${job.company}\nCard info: ${job.cardText}\n\n${job.detailText}`;

  const parsed = await callWithRetry(async () => parseJson(await callProvider(s, system, user)));
  let score = Math.max(0, Math.min(100, parseInt(parsed.score, 10) || 0));
  const decision = String(parsed.decision || "").toLowerCase() === "match" && score >= s.threshold ? "match" : "reject";
  return { score, decision, reason: String(parsed.reason || "").slice(0, 300) };
}

async function callWithRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!e.retryable) break;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}

async function httpJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  return JSON.parse(text);
}

async function callProvider(s, system, user) {
  if (s.provider === "typesafe") return callTypeSafe(s, user);
  const key = s.apiKeys[s.provider];
  const model = s.models[s.provider];
  if (s.provider === "anthropic") {
    const data = await httpJson("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }]
      })
    });
    const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    if (!text.trim()) throw emptyError(`stop_reason=${data.stop_reason}`);
    return text;
  }
  if (s.provider === "openai") {
    const data = await httpJson("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        // reasoning models are slow; keep reasoning to the minimum
        ...(/^gpt-5/.test(model) ? { reasoning_effort: "minimal" } : /^o\d/.test(model) ? { reasoning_effort: "low" } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });
    const text = data.choices?.[0]?.message?.content || "";
    if (!text.trim()) throw emptyError(`finish_reason=${data.choices?.[0]?.finish_reason}`);
    return text;
  }
  if (s.provider === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const data = await httpJson(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0,
          // "flash" models think by default, which is slow and can eat the output; turn it off
          ...(/flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {})
        }
      })
    });
    const text = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
    if (!text.trim()) throw emptyError(`finishReason=${data.candidates?.[0]?.finishReason}`);
    return text;
  }
  throw new Error("Unknown provider " + s.provider);
}

function emptyError(detail) {
  const e = new Error("Model returned an empty answer (" + detail + ")");
  e.retryable = true;
  return e;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    const e = new Error("Model did not return JSON: " + String(text).slice(0, 200));
    e.retryable = true;
    throw e;
  }
}

// ---------- TypeSafe (Jev) ----------
// Jev is a "decision" model: it doesn't write text, it answers typed questions over a `state`.
// API: POST https://api.typesafe.ai/v1/systemone, Authorization: Bearer <key>
//   questions.fit       (score, 6 ordered levels)  -> answers.fit.score is a probability-weighted 0..5
//   questions.violation (noul = yes/no)            -> answers.violation.noul is P(yes) 0..1
// We convert this to the same {score, decision, reason} JSON the chat providers return.
const TS_FIT_LEVELS = [
  "Not a fit at all: different field or seniority",
  "Poor fit: few relevant skills",
  "Weak fit: some overlap but major gaps",
  "Moderate fit: relevant background with notable gaps",
  "Good fit: most requirements matched",
  "Excellent fit: strong match on role, stack and seniority"
];

async function callTypeSafe(s, user) {
  const state =
    `=== CANDIDATE HARD CRITERIA ===\n${s.criteria}\n\n=== CANDIDATE RESUME ===\n${s.resume}\n\n${user}`;
  // Two ways to reach Jev with the same request body:
  //   - a TypeSafe key  -> https://api.typesafe.ai/v1/systemone   (model "jev-latest" / "jev-1.13.0")
  //   - an OpenRouter key (starts with "sk-or-") -> https://openrouter.ai/api/v1/systemone
  //     (model "~typesafe/jev-latest" / "typesafe/jev-1.13")
  const key = (s.apiKeys.typesafe || "").trim();
  //   - a Vercel AI Gateway key (starts with "vck_") -> https://ai-gateway.vercel.sh/v1/evaluate
  //     (model "typesafe-ai/jev"; yes/no question type is "boolean", answer field "probability")
  const viaVercel = /^vck_/i.test(key);
  const viaOpenRouter = /^sk-or-/i.test(key);
  let model = (s.models.typesafe || "jev-latest").trim();
  if (viaOpenRouter && !model.includes("/")) {
    model = /latest/i.test(model) ? "~typesafe/jev-latest" : "typesafe/" + model.replace(/^(jev-\d+\.\d+)\.0$/i, "$1");
  }
  if (viaVercel && !model.includes("/")) model = "typesafe-ai/jev"; // Vercel's id for Jev (latest)
  if (!viaOpenRouter && !viaVercel) model = model.replace(/^~?typesafe\//i, "");
  const url = viaVercel
    ? "https://ai-gateway.vercel.sh/v1/evaluate"
    : viaOpenRouter
      ? "https://openrouter.ai/api/v1/systemone"
      : "https://api.typesafe.ai/v1/systemone";
  let data;
  try {
    data = await httpJson(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      state,
      questions: {
        fit: {
          type: "score",
          instructions:
            "How well does the candidate's resume fit this job ad (role, tech stack, seniority, requirements)?",
          criteria: TS_FIT_LEVELS
        },
        violation: {
          type: viaVercel ? "boolean" : "noul",
          instructions:
            "Does the job ad clearly violate at least one of the candidate's hard criteria " +
            "(e.g. location, required language, seniority or field)?",
          criteria: {
            true: "At least one hard criterion is clearly violated",
            false: "No hard criterion is clearly violated, or it is unclear"
          }
        }
      }
    })
  });
  } catch (e) {
    if (/HTTP 401/.test(e.message))
      e.message +=
        viaVercel
          ? " — Vercel AI Gateway rejected the key. Check it under AI Gateway → API Keys on vercel.com."
          : viaOpenRouter
          ? " — OpenRouter rejected the key. Check it at openrouter.ai/settings/keys."
          : " — TypeSafe rejected the key. Use a key from TypeSafe (docs.typesafe.ai), or an OpenRouter key (sk-or-…), which is sent to OpenRouter automatically.";
    throw e;
  }
  const fit = data.answers?.fit;
  const vio = data.answers?.violation;
  if (!fit || typeof fit.score !== "number") throw emptyError("no fit score in TypeSafe answer");
  const maxLevel = TS_FIT_LEVELS.length - 1;
  let score = Math.round((fit.score / maxLevel) * 100);
  const pViolation = typeof vio?.noul === "number" ? vio.noul : typeof vio?.probability === "number" ? vio.probability : 0;
  const violated = pViolation >= 0.5;
  if (violated) score = Math.min(score, 30);
  const level = TS_FIT_LEVELS[Math.round(fit.score)]?.split(":")[0] || "";
  const reason =
    `${level} (Jev, confidence ${Math.round((fit.confidence ?? Math.max(0, ...Object.values(fit.probabilities || { 0: 0 }))) * 100)}%)` +
    (violated ? ` · hard-criteria violation likely (${Math.round(pViolation * 100)}%)` : "");
  return JSON.stringify({ score, decision: violated ? "reject" : "match", reason });
}
