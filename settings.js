// ---------------------------------------------------------------------------
// HARD CRITERIA (settings.criteria) — empty by default. Fill it in on the
// extension's options page. It is sent to the AI together with your resume and
// every job ad. Write it in plain English, one rule per line. Example:
//
//   HARD RULES (a job that clearly breaks any of these must be rejected, score below 40):
//   - Target roles: backend or full-stack developer, mid or senior level; tech lead is fine.
//   - Reject: junior, intern, trainee roles; non-engineering roles (sales, HR, support...).
//   - Location: <your city> or places commutable from it; elsewhere only if fully remote.
//   - Language: <language> must NOT be required; the working language should be English.
//
//   TECHNOLOGY (not a hard rule):
//   - <your main stack> is the strongest fit, but do not reject a suitable role only because
//     it uses another language or framework. Count a technology as a real gap only if the ad
//     says it is required/essential; "nice to have" is never disqualifying.
//   - Credit transferable experience (backend, distributed systems, cloud, leadership...).
//
//   SCORING:
//   - 75–100 Strong · 55–74 Transition (learnable gap) · 40–54 Weak · below 40 Gap.
//
//   REASON: start with [Strong], [Transition], [Weak] or [Gap], then the main gap in a few words.
//
// Tips: keep it short and concrete; state what must cause a rejection; put rules that can be
// checked without AI (keywords, locations) in the fields below instead.
// ---------------------------------------------------------------------------

// Shared defaults (loaded by background.js via importScripts and by options.html)
const IJF_DEFAULTS = {
  provider: "anthropic",
  models: {
    anthropic: "claude-haiku-5-5",
    openai: "gpt-5-mini",
    gemini: "gemini-2.5-flash",
    typesafe: "jev-latest" // or a pinned version such as "jev-1.13.0"
  },
  apiKeys: { anthropic: "", openai: "", gemini: "", typesafe: "" },
  threshold: 55, // minimum score to keep a job; 55 also keeps "[Transition]" jobs (see the scoring guide)
  delaySec: 1, // Indeed has bot protection; keep a small pause between jobs
  dryRun: false,
  bookmarkMatches: true, // press Indeed's "Save job" on suitable jobs (only if not saved yet)
  // Auto-dismiss / not-suitable keywords, comma separated, case-insensitive, searched in
  // the card's title, company and location (no AI call). Spaces are kept and matter:
  // "Java" also matches "JavaScript", " Java " only the word. Example: "Junior,Intern ,Embedded"
  blockKeywords: "",
  // Places you can commute to. A job located anywhere else is rejected unless it is remote
  // (no AI call). Comma separated, whole-word match. Empty = rule disabled.
  // Example: "Berlin, Potsdam, Brandenburg" or "London, Reading, Croydon"
  commuteLocations: "",
  // Optional: postal-code prefixes (first 3 digits) you can commute to, e.g. "100-199, 740-764".
  // If a location contains a 5-digit postal code ("117 43 City"), only this list decides. Empty = off.
  commutePostalRanges: "",
  resume: "", // stored only in this browser (chrome.storage.local)
  criteria: "" // see the guide above
};

async function ijfGetSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = Object.assign({}, IJF_DEFAULTS, settings || {});
  s.models = Object.assign({}, IJF_DEFAULTS.models, (settings || {}).models);
  s.apiKeys = Object.assign({}, IJF_DEFAULTS.apiKeys, (settings || {}).apiKeys);
  return s;
}

// Settings migration hook (kept for future format changes). Currently nothing to migrate.
function ijfMigrateSettings(settings) {
  return false;
}

async function ijfRunMigration() {
  const { settings } = await chrome.storage.local.get("settings");
  if (ijfMigrateSettings(settings)) await chrome.storage.local.set({ settings, scoreCache: {} });
}
