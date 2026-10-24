# Indeed Job Filter (AI): Architecture

> Purpose of this file: give a developer or an AI assistant enough context to modify the extension safely.
> Keep it in sync with the code. When behavior changes, bump `manifest.json` → `version` and add an entry to `CHANGELOG.md`.
> This extension is a port of the sibling project `linkedin-job-filter`. The main loop, panel, AI calls and settings are the same;
> only the DOM layer (section 5) and some defaults differ.

## 1. What the extension does

A Chrome extension (Manifest V3) for Indeed job lists (`https://*.indeed.com/`: the home feed "Jobb för dig" and `/jobs?q=…` search results).
When the user clicks the toolbar icon, it:

1. Collects the **real, visible** job cards on the **current page only** (it never paginates).
2. Skips cards that are already disliked or already applied to.
3. **Keyword filter (no AI):** if the card's title, company or location contains a keyword from the user's list, the card is marked `🚫 keyword`.
4. **Location rule (no AI):** if the card's location is outside your commutable places and is not remote, the card is marked `📍 location`.
5. Otherwise it opens the job (clicks the card's title link, which opens the right-hand details pane), reads the pane, and asks
   the AI (Claude, OpenAI or Gemini) to score it against the resume and hard criteria.
6. The card gets a badge with the AI score: green = suitable, red = not suitable (`reject` or score below the threshold).
   Suitable jobs are also **bookmarked** (Indeed "Save job", since 1.2.0, option `bookmarkMatches`).
   **The run never clicks Indeed's dislike button.** After the run, the panel offers **"👎 Dislike rejected (N)"** (since 1.3.0):
   with a confirm click, it dislikes the jobs that run marked not suitable (`lastRejected`, `dislikeRejected()`).
7. Shows a draggable floating panel (summary; "Details ▾" for the per-job log; Stop / ↻ Run again) and a score badge on each card.

## 2. Files

| File | Runs in | Responsibility |
|---|---|---|
| `manifest.json` | – | MV3. Content script on `https://*.indeed.com/*` (top frame only). Host permissions for Indeed and the 3 AI APIs. |
| `settings.js` | background (`importScripts`) and options page | `IJF_DEFAULTS` and `ijfGetSettings()` (merges stored settings with the defaults). |
| `background.js` | service worker | Toolbar click, provider API calls, prompt, JSON parsing, retries, toolbar badge. |
| `content.js` | Indeed page | DOM scraping, main loop, opening jobs (title-link clicks only), keyword and location rules, cache, badges, panel UI. |
| `options.html` / `options.js` | options page | Settings form. Saving clears `scoreCache`. "Save & test API" button. |
| `icons/` | – | Toolbar icons. |

## 3. Message flow

```
[toolbar click] → background.js chrome.action.onClicked
    ├─ no API key or resume → opens the options page
    ├─ not an indeed.com URL → toolbar badge "?"
    └─ chrome.tabs.sendMessage(tab, {type:"IJF_TOGGLE"})   (injects content.js first if it isn't listening)

content.js IJF_TOGGLE: running & panel closed → reopen panel | running → stop | no cards → diagnostic | else run()
run(): per card (sequential UI) → chrome.runtime.sendMessage({type:"IJF_SCORE", job}) (max 5 in flight)
background scoreJob → provider → {score, decision, reason} → content applyResult → green/red badge (no click)
content → background {type:"IJF_STATE", running, progress} (toolbar badge)
```

## 4. Storage (`chrome.storage.local`, separate from the LinkedIn extension)

| Key | Shape | Notes |
|---|---|---|
| `settings` | see below | |
| `scoreCache` | `{ [jk]: {score, decision, reason, ts} }` | Cleared when settings are saved. |
| `dismissedIds` | `string[]` (last 5000) | Job keys disliked by hand or via "Dislike rejected". Never processed again. |

Page `localStorage` (Indeed origin, try/catch): `ijf-panel-pos`, `ijf-panel-expanded`.

```js
settings = {
  provider, models{anthropic,openai,gemini}, apiKeys{…},
  threshold: 55,        // 55+ keeps "[Transition]" jobs (criteria section 9)
  delaySec: 1,          // pause after opening each job (Indeed has bot protection)
  bookmarkMatches: true, // press "Save job" on suitable jobs (only if not saved yet)
  blockKeywords: "",    // comma/newline-separated, NOT trimmed (spaces matter); case-insensitive substring on title/company/location
  commuteLocations: "",  // e.g. "Berlin, Potsdam"; empty = location rule off
  commutePostalRanges: "", // e.g. "100-199, 740-764"; decisive when the location has a 5-digit postal code
  criteria: "...", resume: "..."
}
```

## 5. Indeed DOM (most fragile part, as of 2026-10)

| Thing | Selector / source | Notes |
|---|---|---|
| Card | `li` containing `a[data-jk]` (inside `div.job_seen_beacon`) | `jk` = 16 hex chars = job key. |
| **Trap cards** | hidden cards (height 0) with fake keys such as `fedcba9876543210` / `abcdef0123456789` and `href="/viewjob?jk=…"` | **Never click them**: doing so navigates away and triggers Cloudflare's "Just a moment…" bot check. `isRealCard()` filters on key format, the `FAKE_JK` list and visibility. `getCards()` and `findCard()` only return real cards. |
| Card fields | `.jobTitle`, `[data-testid="company-name"]`, `[data-testid="text-location"]` | `cardInfo(card)` → `{title, company, location}`. |
| Save (bookmark) | `button.bookmark` (aria-label "Save job Toggle"); state in `aria-pressed` ("true" = saved) | Toggle! `bookmark(card)` clicks only when not saved. Returns "saved" / "already" / "missing". |
| Dislike | `button[data-testid="dislikeicon"]` (aria-label "Inget intresse" / "Not interested") | Clicked **only** by `dislikeRejected()` after the user presses and confirms the panel button. The user's own clicks are also recorded in `dismissedIds` so those jobs are skipped later. |
| Disliked state | card text "Jobbet har dolts / Vi kommer inte att visa dig det här jobbet igen." + an "Ångra" (undo) button | `DISMISSED_TEXT`. |
| Applied state | card text line starting with "Ansökt" / "Applied" | `isApplied`. |
| Open job | `a[data-jk]`.click() → right pane `#jobsearch-ViewjobPaneWrapper`; URL gets `?vjk=<jk>` (no navigation) | Ready when `vjk === jk`, the pane title `[data-testid="vj-job-title"]` starts with the card title, and the pane text length is stable (`waitStable`). About 0.8–1.3 s per job. |
| Details text | pane `innerText` (title, company, location, "Jobbinformation", "Fullständig jobbeskrivning"…) | `cleanText` removes "Ansök på företagets webbplats" and "Rapportera jobb"; capped at 7000 chars. Company: `[data-testid="vj-company-name"]`. |
| Security check | page title or body contains "Just a moment" / "Verify you are human" | `openAndExtract` stops the whole run with a message; the user completes the check manually (the extension never touches CAPTCHAs). |

### Location rule (`locationProblem`)
Indeed location formats include "117 43 City", "Hybridarbete i City", "Distansarbete" and "City, Region".
1. Contains remote / distans / hemifrån → OK.
2. Strips "Hybridarbete i", "(…)" and "+N platser".
3. Country-only ("Sverige") → left to the AI.
4. **Optional postal-code rule:** if `commutePostalRanges` is set (e.g. "100-199") and the location has a 5-digit postal code, the first 3 digits decide.
5. Otherwise → whole-word match against `commuteLocations`; no match → not suitable.

## 6. content.js structure

Init guard (`window.__ijfAlive`) → message listener → DOM helpers (`isRealCard`, `getCards`, `cardJobId`, `findCard`,
`isDismissed`, `isApplied`, `findDismissButton`, `currentJobIdFromUrl`, `cleanText`, `waitStable`, `openAndExtract`) →
dismissed memory (`dismissedIds`, `rememberDismissed`, click listener) → card fields (`cardInfo`, `cardFields`) →
keywords (`parseBlockKeywords` + `keywordHit`; `parseKeywords` = trimmed whole-word, for locations) → `locationProblem` →
cache → `run()` (skip → keyword → location → cache → open → async score) → `diagnose` → `finish` →
badges (`badges` Map, `applyBadge` bottom-right of `.job_seen_beacon`, re-applied every 1 s) → `ui` panel module
(same as the LinkedIn version, ids prefixed `ijf-`).

## 7. background.js
Providers: Anthropic, OpenAI, Gemini and **TypeSafe (Jev)** (key routing: `vck_…` → Vercel AI Gateway `/v1/evaluate` with `boolean` instead of `noul`; `sk-or-…` → OpenRouter `/api/v1/systemone`; otherwise `api.typesafe.ai`). Jev goes through `callTypeSafe` (`POST https://api.typesafe.ai/v1/systemone`, typed questions `fit` = score with 6 levels → 0–100 and `violation` = noul → reject if ≥ 0.5).

Same as the LinkedIn version except for the URL check (`indeed.com`), message names (`IJF_*`) and the prompt wording ("Indeed job ads";
it notes that Swedish UI labels such as "Heltid" don't mean the ad itself is in Swedish).

## 8. Conventions and gotchas
- Current page only; never paginate. During a run the only clicks are on job title links (to open the details pane) and on "Save job" for suitable, not-yet-saved jobs. Dislike happens **only** through the confirmed "👎 Dislike rejected" button.
- Never click hidden or trap elements; never try to solve Cloudflare challenges.
- Saving options invalidates `scoreCache`.
- After editing: reload the extension in `chrome://extensions` and refresh the Indeed tab once.
- Test without API cost: inject `content.js` into the page with a stubbed `window.chrome` (fake `IJF_SCORE` responses) and `dryRun: true`.

## Criteria
The default hard criteria are empty. A commented example and a writing guide are at the top of `settings.js`, and the options page shows an example placeholder.
