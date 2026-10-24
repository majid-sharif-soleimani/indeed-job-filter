# Changelog

All notable changes. Newest first. Versions match `manifest.json` → `version`.

## [1.5.1] - 2026-10-24
First public release.

### Features
- Toolbar button: opens every job on the current Indeed page (home feed or search results), sends the ad (plus your
  resume and hard criteria) to an AI model and **marks** each card: green = suitable, red = not suitable. It never dislikes automatically.
- AI providers: Claude (Anthropic), OpenAI, Google Gemini and **TypeSafe Jev** (TypeSafe, OpenRouter `sk-or-…` or Vercel AI Gateway `vck_…` key).
- Rules without AI: **keyword list**, **commutable locations** and optional **commutable postal-code ranges** (e.g. `100-199`).
- **Bookmark suitable jobs** with Indeed's "Save job" (toggle-safe: never un-saves).
- After a run, **👎 Dislike rejected (N)** (with a confirm click) dislikes the jobs that run marked not suitable.
- Skips Indeed's hidden **trap cards** and stops on a security check ("Just a moment…"); default pause 1 s between jobs.
- Draggable panel with summary, Details log, Stop / ↻ Run again; score cache; card badges with the reason as a tooltip.
- Hard criteria are empty by default; a commented example and a writing guide are in `settings.js`.
