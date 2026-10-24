const $ = (id) => document.getElementById(id);
let state;

function showProvider() {
  const p = $("provider").value;
  $("model").value = state.models[p] || "";
  $("apiKey").value = state.apiKeys[p] || "";
}

function collect() {
  const p = $("provider").value;
  state.provider = p;
  state.models[p] = $("model").value.trim();
  state.apiKeys[p] = $("apiKey").value.trim();
  state.threshold = Math.max(0, Math.min(100, parseInt($("threshold").value, 10) || 0));
  state.delaySec = Math.max(0, parseFloat($("delaySec").value) || 0);
  state.bookmarkMatches = $("bookmarkMatches").checked;
  state.blockKeywords = $("blockKeywords").value;
  state.commuteLocations = $("commuteLocations").value;
  state.commutePostalRanges = $("commutePostalRanges").value.trim();
  state.criteria = $("criteria").value;
  state.resume = $("resume").value;
}

async function save() {
  collect();
  // Resume/criteria may have changed, so old scores are no longer valid
  await chrome.storage.local.set({ settings: state, scoreCache: {} });
  msg("Saved ✔");
}

function msg(t, color = "#1e8e3e") {
  $("msg").textContent = t;
  $("msg").style.color = color;
}

(async () => {
  await ijfRunMigration().catch(() => {}); // make sure the criteria are up to date
  state = await ijfGetSettings();
  $("provider").value = state.provider;
  showProvider();
  $("threshold").value = state.threshold;
  $("delaySec").value = state.delaySec;
  $("bookmarkMatches").checked = state.bookmarkMatches ?? true;
  $("blockKeywords").value = state.blockKeywords || "";
  $("commuteLocations").value = state.commuteLocations ?? "";
  $("commutePostalRanges").value = state.commutePostalRanges || "";
  $("criteria").value = state.criteria;
  $("resume").value = state.resume;
  prevProvider = state.provider;
})();

// remember the model/key typed for the previous provider before switching
let prevProvider;
$("provider").addEventListener("change", () => {
  if (prevProvider) {
    state.models[prevProvider] = $("model").value.trim();
    state.apiKeys[prevProvider] = $("apiKey").value.trim();
  }
  prevProvider = $("provider").value;
  showProvider();
});

$("resumeFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (f) $("resume").value = await f.text();
});

$("save").addEventListener("click", save);

$("test").addEventListener("click", async () => {
  await save();
  msg("Testing…", "#555");
  const resp = await chrome.runtime.sendMessage({
    type: "IJF_SCORE",
    job: {
      title: "Senior Backend Developer",
      company: "Test AB",
      cardText: "Example City (Hybrid)",
      detailText: "About the job: We build backend APIs with PostgreSQL on AWS. English is our working language."
    }
  });
  if (resp?.ok) msg(`API works ✔  Test job scored ${resp.result.score} (${resp.result.decision}): ${resp.result.reason}`);
  else msg("Failed: " + (resp?.error || "no response"), "#c5221f");
});
