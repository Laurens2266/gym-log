/* ---------- State ---------- */
const STORAGE_KEY = "gymlog_state_v1";
const DAY_CODE_BY_WEEKDAY = { 1: "Ma", 3: "Wo", 5: "Vr" };
const DAY_LABEL = { Ma: "Maandag", Wo: "Woensdag", Vr: "Vrijdag" };

function uid(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 9);
}

function defaultState() {
  return {
    library: {
      strength: [
        { id: "ex_bench", name: "Bench Press (Dumbbell)", unit: "reps" },
        { id: "ex_row", name: "Seated Cable Row", unit: "reps" },
        { id: "ex_incline", name: "Incline Dumbbell Press", unit: "reps" },
        { id: "ex_curl", name: "Bicep Curl", unit: "reps" },
        { id: "ex_shoulder", name: "Dumbbell Shoulder Press", unit: "reps" },
        { id: "ex_lat", name: "Lat Pulldown", unit: "reps" },
        { id: "ex_dbbench", name: "Dumbbell Bench Press", unit: "reps" },
        { id: "ex_tricep", name: "Tricep Pushdown", unit: "reps" }
      ],
      core: [
        { id: "core_plank", name: "Plank", unit: "seconds" },
        { id: "core_legraise", name: "Leg Raises", unit: "reps" },
        { id: "core_bicycle", name: "Bicycle Crunch", unit: "reps" },
        { id: "core_mountain", name: "Mountain Climbers", unit: "reps" },
        { id: "core_hollow", name: "Hollow Hold", unit: "seconds" },
        { id: "core_russian", name: "Russian Twists", unit: "reps" }
      ]
    },
    schedule: {
      Ma: [
        { exerciseId: "ex_bench", target: "4x8-10" },
        { exerciseId: "ex_row", target: "3x10-12" },
        { exerciseId: "ex_incline", target: "3x8-10" },
        { exerciseId: "ex_curl", target: "3x10-12" }
      ],
      Wo: [
        { exerciseId: "ex_shoulder", target: "3x8-10" },
        { exerciseId: "ex_lat", target: "3x10-12" },
        { exerciseId: "ex_dbbench", target: "3x8-10" },
        { exerciseId: "ex_tricep", target: "3x10-12" }
      ],
      Vr: [
        { exerciseId: "ex_bench", target: "4x8" },
        { exerciseId: "ex_incline", target: "3x10" },
        { exerciseId: "ex_lat", target: "3x10" },
        { exerciseId: "ex_curl", target: "3x12" }
      ]
    },
    logs: {},
    coreSelectionByDate: {}
  };
}

let state = loadState();
let currentView = "today";
let currentDate = todayISO();
let activeSchemaDay = "Ma";

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const def = defaultState();
    return {
      library: parsed.library || def.library,
      schedule: parsed.schedule || def.schedule,
      logs: parsed.logs || {},
      coreSelectionByDate: parsed.coreSelectionByDate || {}
    };
  } catch (e) {
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  scheduleDropboxSync();
}

/* ---------- Date helpers ---------- */
function todayISO() {
  return isoFromDate(new Date());
}
function isoFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function dateFromISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function shiftDate(iso, days) {
  const d = dateFromISO(iso);
  d.setDate(d.getDate() + days);
  return isoFromDate(d);
}
function dayCodeForISO(iso) {
  const wd = dateFromISO(iso).getDay();
  return DAY_CODE_BY_WEEKDAY[wd] || null;
}
function formatDateNL(iso) {
  const d = dateFromISO(iso);
  return d.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long" });
}

/* ---------- Exercise lookup ---------- */
function findExercise(id) {
  return (
    state.library.strength.find((e) => e.id === id) ||
    state.library.core.find((e) => e.id === id) ||
    null
  );
}
function parseTarget(target) {
  const m = /^(\d+)\s*x\s*([\d–\-]+)/i.exec(target || "");
  if (!m) return { sets: 3, repsLabel: target || "" };
  return { sets: parseInt(m[1], 10), repsLabel: m[2] };
}

/* ---------- Log access ---------- */
function getDayLog(iso, create) {
  if (!state.logs[iso]) {
    if (!create) return null;
    state.logs[iso] = { strength: {}, core: {} };
  }
  return state.logs[iso];
}
function getSets(iso, group, exerciseId) {
  const day = getDayLog(iso, false);
  if (!day || !day[group] || !day[group][exerciseId]) return [];
  return day[group][exerciseId];
}
function setSets(iso, group, exerciseId, sets) {
  const day = getDayLog(iso, true);
  if (!day[group]) day[group] = {};
  day[group][exerciseId] = sets;
  saveState();
}

/* history max weight for PR detection, excludes given iso */
function historicalMaxWeight(group, exerciseId, excludeIso) {
  let max = 0;
  for (const iso in state.logs) {
    if (iso === excludeIso) continue;
    const sets = (state.logs[iso][group] || {})[exerciseId] || [];
    for (const s of sets) {
      if (s.weight > max) max = s.weight;
    }
  }
  return max;
}

/* =========================================================
   DROPBOX SYNC
   PKCE OAuth (no client secret) against the app's own Dropbox
   "App folder". Auto-uploads a debounced YAML snapshot after
   every local change, and pulls+merges once on startup so a
   second device (or a wiped Safari) catches up automatically.
   ========================================================= */
const DBX_CLIENT_ID = "c22rza6ronv2ixj";
const DBX_REDIRECT_URI = "https://laurens2266.github.io/gym-log/";
const DBX_FILE_PATH = "/gymlog.yaml";
const DBX_LS = {
  refresh: "gymlog_dbx_refresh_token",
  access: "gymlog_dbx_access_token",
  expiry: "gymlog_dbx_access_expiry",
  lastSync: "gymlog_dbx_last_sync"
};
const DBX_SS = { verifier: "gymlog_dbx_verifier", state: "gymlog_dbx_state" };

let dbxSyncStatus = "idle"; // idle | syncing | synced | error
let dbxSyncTimer = null;

function dbxIsConnected() {
  return !!localStorage.getItem(DBX_LS.refresh);
}

function dbxB64Url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function dbxRandomString(len) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return dbxB64Url(arr.buffer);
}
async function dbxSha256(str) {
  return await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
}

async function dbxConnect() {
  const verifier = dbxRandomString(64);
  const oauthState = dbxRandomString(16);
  sessionStorage.setItem(DBX_SS.verifier, verifier);
  sessionStorage.setItem(DBX_SS.state, oauthState);
  const challenge = dbxB64Url(await dbxSha256(verifier));
  const url = new URL("https://www.dropbox.com/oauth2/authorize");
  url.searchParams.set("client_id", DBX_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", DBX_REDIRECT_URI);
  url.searchParams.set("token_access_type", "offline");
  url.searchParams.set("state", oauthState);
  window.location.href = url.toString();
}

function dbxDisconnect() {
  localStorage.removeItem(DBX_LS.refresh);
  localStorage.removeItem(DBX_LS.access);
  localStorage.removeItem(DBX_LS.expiry);
  localStorage.removeItem(DBX_LS.lastSync);
  dbxSyncStatus = "idle";
  toast("Losgekoppeld van Dropbox");
  render();
}

async function dbxHandleRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return;
  const returnedState = params.get("state");
  window.history.replaceState({}, "", window.location.pathname);

  const expectedState = sessionStorage.getItem(DBX_SS.state);
  const verifier = sessionStorage.getItem(DBX_SS.verifier);
  sessionStorage.removeItem(DBX_SS.state);
  sessionStorage.removeItem(DBX_SS.verifier);
  if (!verifier || returnedState !== expectedState) {
    toast("Dropbox-koppeling mislukt");
    return;
  }
  try {
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: DBX_CLIENT_ID,
        redirect_uri: DBX_REDIRECT_URI,
        code_verifier: verifier
      })
    });
    if (!res.ok) throw new Error("token exchange failed");
    const data = await res.json();
    localStorage.setItem(DBX_LS.refresh, data.refresh_token);
    localStorage.setItem(DBX_LS.access, data.access_token);
    localStorage.setItem(DBX_LS.expiry, String(Date.now() + data.expires_in * 1000 - 60000));
    toast("Verbonden met Dropbox");
    await dbxPullAndMerge();
    await doDropboxSync(false);
  } catch (e) {
    toast("Dropbox-koppeling mislukt");
  }
}

async function dbxGetAccessToken() {
  const refresh = localStorage.getItem(DBX_LS.refresh);
  if (!refresh) return null;
  const expiry = parseInt(localStorage.getItem(DBX_LS.expiry) || "0", 10);
  if (Date.now() < expiry) return localStorage.getItem(DBX_LS.access);
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: DBX_CLIENT_ID
    })
  });
  if (!res.ok) return null;
  const data = await res.json();
  localStorage.setItem(DBX_LS.access, data.access_token);
  localStorage.setItem(DBX_LS.expiry, String(Date.now() + data.expires_in * 1000 - 60000));
  return data.access_token;
}

async function dbxUpload(yamlStr) {
  const token = await dbxGetAccessToken();
  if (!token) return false;
  const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path: DBX_FILE_PATH, mode: "overwrite", mute: true })
    },
    body: yamlStr
  });
  return res.ok;
}

async function dbxDownload() {
  const token = await dbxGetAccessToken();
  if (!token) return null;
  const res = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Dropbox-API-Arg": JSON.stringify({ path: DBX_FILE_PATH })
    }
  });
  if (!res.ok) return null; // e.g. 409 not_found on first-ever sync
  return await res.text();
}

function scheduleDropboxSync() {
  if (!dbxIsConnected()) return;
  clearTimeout(dbxSyncTimer);
  dbxSyncTimer = setTimeout(() => doDropboxSync(false), 1500);
}

async function doDropboxSync(manual) {
  if (!dbxIsConnected() || typeof jsyaml === "undefined") return;
  clearTimeout(dbxSyncTimer);
  dbxSyncStatus = "syncing";
  updateDropboxStatusUI();
  try {
    const yamlStr = jsyaml.dump(buildExportObject());
    const ok = await dbxUpload(yamlStr);
    dbxSyncStatus = ok ? "synced" : "error";
    if (ok) localStorage.setItem(DBX_LS.lastSync, String(Date.now()));
    if (manual) toast(ok ? "Gesynchroniseerd met Dropbox" : "Synchroniseren mislukt");
  } catch (e) {
    dbxSyncStatus = "error";
    if (manual) toast("Synchroniseren mislukt (geen internet?)");
  }
  updateDropboxStatusUI();
}

/* additive merge: remote fills gaps, local always wins on conflict
   so a partially-synced day never gets clobbered mid-edit */
function mergeRemoteIntoLocal(remoteObj) {
  if (!remoteObj) return;
  ["strength", "core"].forEach((group) => {
    const remoteList = (remoteObj.library && remoteObj.library[group]) || [];
    const localList = state.library[group];
    const localIds = new Set(localList.map((e) => e.id));
    remoteList.forEach((e) => { if (!localIds.has(e.id)) localList.push(e); });
  });
  if (remoteObj.schema) {
    Object.keys(remoteObj.schema).forEach((day) => {
      if (!state.schedule[day] || state.schedule[day].length === 0) {
        state.schedule[day] = remoteObj.schema[day];
      }
    });
  }
  if (remoteObj.workouts) {
    Object.entries(remoteObj.workouts).forEach(([iso, entry]) => {
      if (state.logs[iso]) return;
      applyWorkoutDay(iso, entry);
    });
  }
  saveState();
}

async function dbxPullAndMerge() {
  try {
    const yamlStr = await dbxDownload();
    if (!yamlStr || typeof jsyaml === "undefined") return;
    const parsed = jsyaml.load(yamlStr);
    mergeRemoteIntoLocal(parsed);
  } catch (e) {
    /* offline or first-ever sync: nothing to merge, ignore */
  }
}

function updateDropboxStatusUI() {
  const card = document.getElementById("dbx-status-card");
  if (card) renderDropboxCard(card);
  const dot = document.getElementById("dbx-dot");
  if (dot) dot.className = "dbx-dot " + (dbxIsConnected() ? "dbx-" + dbxSyncStatus : "dbx-off");
}

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

/* ---------- Rendering dispatch ---------- */
function render() {
  document.getElementById("today-label").textContent = new Date().toLocaleDateString("nl-NL", {
    weekday: "short", day: "numeric", month: "short"
  });
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === currentView);
  });
  updateDropboxStatusUI();
  const root = document.getElementById("view-root");
  root.innerHTML = "";
  if (currentView === "today") root.appendChild(renderToday());
  else if (currentView === "schema") root.appendChild(renderSchema());
  else if (currentView === "stats") root.appendChild(renderStats());
  else if (currentView === "data") root.appendChild(renderData());
}

document.getElementById("tabbar").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  currentView = btn.dataset.view;
  render();
});

/* =========================================================
   TODAY VIEW
   ========================================================= */
function renderToday() {
  const wrap = document.createElement("div");

  const nav = document.createElement("div");
  nav.className = "date-nav";
  nav.innerHTML = `
    <button id="date-prev">‹</button>
    <input type="date" id="date-input" value="${currentDate}" />
    <button id="date-next">›</button>
  `;
  wrap.appendChild(nav);
  nav.querySelector("#date-prev").onclick = () => { currentDate = shiftDate(currentDate, -1); render(); };
  nav.querySelector("#date-next").onclick = () => { currentDate = shiftDate(currentDate, 1); render(); };
  nav.querySelector("#date-input").onchange = (e) => { currentDate = e.target.value; render(); };

  const dayCode = dayCodeForISO(currentDate);
  const label = document.createElement("div");
  label.className = "small-note";
  label.style.marginBottom = "16px";
  label.textContent = dayCode
    ? `${formatDateNL(currentDate)} — schema ${DAY_LABEL[dayCode]}`
    : `${formatDateNL(currentDate)} — geen sportschool schema vandaag`;
  wrap.appendChild(label);

  if (dayCode) {
    const secLabel = document.createElement("div");
    secLabel.className = "section-label";
    secLabel.textContent = "Sportschool";
    wrap.appendChild(secLabel);

    const list = state.schedule[dayCode] || [];
    if (list.length === 0) {
      wrap.appendChild(emptyState("Nog geen oefeningen voor deze dag. Voeg ze toe via Schema."));
    }
    list.forEach((entry) => {
      const ex = findExercise(entry.exerciseId);
      if (!ex) return;
      wrap.appendChild(renderExerciseCard("strength", ex, entry.target));
    });
  }

  const coreLabel = document.createElement("div");
  coreLabel.className = "section-label";
  coreLabel.textContent = "Buikspier kwartier";
  wrap.appendChild(coreLabel);
  wrap.appendChild(renderCoreSection());

  return wrap;
}

function renderExerciseCard(group, ex, target) {
  const card = document.createElement("div");
  card.className = "card";
  const { sets: targetSets, repsLabel } = parseTarget(target || (ex.unit === "seconds" ? "2x12" : "3x10-12"));
  const existing = getSets(currentDate, group, ex.id);
  const rowCount = Math.max(existing.length, targetSets);
  const maxBefore = historicalMaxWeight(group, ex.id, currentDate);

  card.innerHTML = `
    <div class="card-title-row">
      <h3 class="card-title">${ex.name}</h3>
      ${target ? `<span class="card-target">${target}</span>` : ""}
    </div>
    <div class="set-labels">
      <span></span><span>${ex.unit === "seconds" ? "Seconden" : "Reps"}</span><span>Kg</span><span></span>
    </div>
    <div class="set-rows"></div>
    <div class="btn-row">
      <button class="btn btn-sm add-set-btn">+ Set</button>
    </div>
  `;

  const rowsWrap = card.querySelector(".set-rows");

  function buildRows() {
    rowsWrap.innerHTML = "";
    const sets = getSets(currentDate, group, ex.id);
    const n = Math.max(sets.length, targetSets);
    let anyPR = false;
    for (let i = 0; i < n; i++) {
      const s = sets[i] || { amount: "", weight: "" };
      const row = document.createElement("div");
      row.className = "set-row";
      row.innerHTML = `
        <span class="set-idx">${i + 1}</span>
        <input class="set-input amount-input" type="number" inputmode="decimal" placeholder="${repsLabel || ""}" value="${s.amount === "" || s.amount == null ? "" : s.amount}" />
        <input class="set-input weight-input" type="number" inputmode="decimal" step="0.5" placeholder="kg" value="${s.weight === "" || s.weight == null ? "" : s.weight}" />
        <button class="set-remove" title="Verwijder set">✕</button>
      `;
      const amountInput = row.querySelector(".amount-input");
      const weightInput = row.querySelector(".weight-input");

      if (s.weight && s.weight > maxBefore) { weightInput.classList.add("pr"); anyPR = true; }

      function commit() {
        const currentSets = getSets(currentDate, group, ex.id);
        while (currentSets.length < n) currentSets.push({ amount: "", weight: "" });
        currentSets[i] = {
          amount: amountInput.value === "" ? "" : parseFloat(amountInput.value),
          weight: weightInput.value === "" ? "" : parseFloat(weightInput.value)
        };
        setSets(currentDate, group, ex.id, currentSets);
        const w = parseFloat(weightInput.value);
        const isPR = !isNaN(w) && w > 0 && w > maxBefore;
        weightInput.classList.toggle("pr", isPR);
        updatePRBadge(card);
      }
      amountInput.oninput = commit;
      weightInput.oninput = commit;

      row.querySelector(".set-remove").onclick = () => {
        const currentSets = getSets(currentDate, group, ex.id);
        currentSets.splice(i, 1);
        setSets(currentDate, group, ex.id, currentSets);
        buildRows();
      };

      rowsWrap.appendChild(row);
    }
    updatePRBadge(card);
  }

  card.querySelector(".add-set-btn").onclick = () => {
    const currentSets = getSets(currentDate, group, ex.id);
    currentSets.push({ amount: "", weight: "" });
    setSets(currentDate, group, ex.id, currentSets);
    buildRows();
  };

  buildRows();
  return card;
}

function updatePRBadge(card) {
  const hasPR = !!card.querySelector(".weight-input.pr");
  let badge = card.querySelector(".pr-badge");
  if (hasPR && !badge) {
    badge = document.createElement("span");
    badge.className = "pr-badge";
    badge.textContent = "PR";
    card.querySelector(".card-title-row").appendChild(badge);
  } else if (!hasPR && badge) {
    badge.remove();
  }
}

function renderCoreSection() {
  const wrap = document.createElement("div");
  const selected = state.coreSelectionByDate[currentDate] || [];

  const chipRow = document.createElement("div");
  chipRow.className = "btn-row";
  chipRow.style.marginBottom = "14px";
  state.library.core.forEach((ex) => {
    const chip = document.createElement("button");
    chip.className = "btn btn-sm" + (selected.includes(ex.id) ? " chip-active" : "");
    chip.textContent = ex.name;
    chip.onclick = () => {
      const cur = state.coreSelectionByDate[currentDate] || [];
      const idx = cur.indexOf(ex.id);
      if (idx >= 0) cur.splice(idx, 1);
      else cur.push(ex.id);
      state.coreSelectionByDate[currentDate] = cur;
      saveState();
      render();
    };
    chipRow.appendChild(chip);
  });
  wrap.appendChild(chipRow);

  if (selected.length === 0) {
    wrap.appendChild(emptyState("Kies hierboven welke oefeningen je vandaag doet."));
  } else {
    selected.forEach((id) => {
      const ex = findExercise(id);
      if (!ex) return;
      wrap.appendChild(renderExerciseCard("core", ex, "2x12"));
    });
  }
  return wrap;
}

function emptyState(text) {
  const d = document.createElement("div");
  d.className = "empty-state";
  d.textContent = text;
  return d;
}

/* =========================================================
   SCHEMA VIEW
   ========================================================= */
function renderSchema() {
  const wrap = document.createElement("div");

  const picker = document.createElement("div");
  picker.className = "day-picker";
  ["Ma", "Wo", "Vr"].forEach((code) => {
    const b = document.createElement("button");
    b.textContent = DAY_LABEL[code];
    b.className = code === activeSchemaDay ? "active" : "";
    b.onclick = () => { activeSchemaDay = code; render(); };
    picker.appendChild(b);
  });
  wrap.appendChild(picker);

  const card = document.createElement("div");
  card.className = "card";
  const list = state.schedule[activeSchemaDay];

  if (list.length === 0) {
    card.appendChild(emptyState("Nog geen oefeningen op deze dag."));
  }
  list.forEach((entry, idx) => {
    const ex = findExercise(entry.exerciseId);
    if (!ex) return;
    const row = document.createElement("div");
    row.className = "exercise-edit-row";
    row.innerHTML = `
      <div class="drag-handle">⠿</div>
      <div class="exercise-edit-name">
        ${ex.name}<br/>
        <input class="target-input" value="${entry.target}" />
      </div>
      <button class="btn btn-sm move-up" ${idx === 0 ? "disabled" : ""}>↑</button>
      <button class="btn btn-sm move-down" ${idx === list.length - 1 ? "disabled" : ""}>↓</button>
      <button class="btn btn-sm btn-danger remove-ex">✕</button>
    `;
    row.querySelector(".target-input").onchange = (e) => {
      entry.target = e.target.value;
      saveState();
    };
    row.querySelector(".move-up").onclick = () => {
      [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
      saveState(); render();
    };
    row.querySelector(".move-down").onclick = () => {
      [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
      saveState(); render();
    };
    row.querySelector(".remove-ex").onclick = () => {
      list.splice(idx, 1);
      saveState(); render();
    };
    card.appendChild(row);
  });
  wrap.appendChild(card);

  const addCard = document.createElement("div");
  addCard.className = "card";
  addCard.innerHTML = `
    <div class="card-title-row"><h3 class="card-title">Oefening toevoegen</h3></div>
    <label class="field-label">Kies bestaande oefening</label>
    <div class="field-row">
      <select id="existing-ex-select">
        <option value="">— kies —</option>
        ${state.library.strength.map((e) => `<option value="${e.id}">${e.name}</option>`).join("")}
      </select>
    </div>
    <label class="field-label">Target (bijv. 3x10-12)</label>
    <div class="field-row">
      <input id="existing-target" placeholder="3x10-12" />
      <button class="btn btn-accent" id="add-existing-btn">Toevoegen</button>
    </div>
    <label class="field-label" style="margin-top:10px;">Of maak nieuwe oefening</label>
    <div class="field-row">
      <input id="new-ex-name" placeholder="Naam oefening" />
    </div>
    <div class="field-row">
      <input id="new-ex-target" placeholder="Target 3x10-12" />
      <button class="btn btn-accent" id="add-new-btn">Aanmaken</button>
    </div>
  `;
  addCard.querySelector("#add-existing-btn").onclick = () => {
    const id = addCard.querySelector("#existing-ex-select").value;
    const target = addCard.querySelector("#existing-target").value.trim() || "3x10-12";
    if (!id) { toast("Kies eerst een oefening"); return; }
    state.schedule[activeSchemaDay].push({ exerciseId: id, target });
    saveState(); render();
    toast("Toegevoegd");
  };
  addCard.querySelector("#add-new-btn").onclick = () => {
    const name = addCard.querySelector("#new-ex-name").value.trim();
    const target = addCard.querySelector("#new-ex-target").value.trim() || "3x10-12";
    if (!name) { toast("Vul een naam in"); return; }
    const id = uid("ex");
    state.library.strength.push({ id, name, unit: "reps" });
    state.schedule[activeSchemaDay].push({ exerciseId: id, target });
    saveState(); render();
    toast("Oefening aangemaakt en toegevoegd");
  };
  wrap.appendChild(addCard);

  const coreCard = document.createElement("div");
  coreCard.className = "card";
  coreCard.innerHTML = `<div class="card-title-row"><h3 class="card-title">Buikspier bibliotheek</h3></div>`;
  state.library.core.forEach((ex, idx) => {
    const row = document.createElement("div");
    row.className = "exercise-edit-row";
    row.innerHTML = `
      <div class="exercise-edit-name">${ex.name} <span class="exercise-edit-target">(${ex.unit === "seconds" ? "sec" : "reps"})</span></div>
      <button class="btn btn-sm btn-danger remove-core">✕</button>
    `;
    row.querySelector(".remove-core").onclick = () => {
      state.library.core.splice(idx, 1);
      saveState(); render();
    };
    coreCard.appendChild(row);
  });
  const addCoreRow = document.createElement("div");
  addCoreRow.className = "field-row";
  addCoreRow.style.marginTop = "10px";
  addCoreRow.innerHTML = `
    <input id="new-core-name" placeholder="Naam oefening" />
    <select id="new-core-unit">
      <option value="reps">reps</option>
      <option value="seconds">seconden</option>
    </select>
    <button class="btn btn-accent" id="add-core-btn">+</button>
  `;
  addCoreRow.querySelector("#add-core-btn").onclick = () => {
    const name = addCoreRow.querySelector("#new-core-name").value.trim();
    const unit = addCoreRow.querySelector("#new-core-unit").value;
    if (!name) { toast("Vul een naam in"); return; }
    state.library.core.push({ id: uid("core"), name, unit });
    saveState(); render();
  };
  coreCard.appendChild(addCoreRow);
  wrap.appendChild(coreCard);

  return wrap;
}

/* =========================================================
   STATS VIEW
   ========================================================= */
let chartInstance = null;
let volumeChartInstance = null;

function allExercisesWithLogs() {
  const ids = new Set();
  for (const iso in state.logs) {
    const day = state.logs[iso];
    Object.keys(day.strength || {}).forEach((id) => ids.add(id));
    Object.keys(day.core || {}).forEach((id) => ids.add(id));
  }
  return [...ids].map((id) => findExercise(id)).filter(Boolean);
}

function renderStats() {
  const wrap = document.createElement("div");

  if (typeof Chart === "undefined") {
    wrap.appendChild(emptyState("Grafieken konden niet laden (geen internetverbinding). Log je sets gewoon door, dit werkt weer zodra je online bent."));
  }

  const exercises = allExercisesWithLogs();
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<div class="card-title-row"><h3 class="card-title">Progressie per oefening</h3></div>`;
  if (exercises.length === 0) {
    card.appendChild(emptyState("Nog geen data gelogd."));
  } else {
    const select = document.createElement("select");
    select.className = "stat-select";
    exercises.forEach((ex) => {
      const opt = document.createElement("option");
      opt.value = ex.id; opt.textContent = ex.name;
      select.appendChild(opt);
    });
    card.appendChild(select);
    const chartWrap = document.createElement("div");
    chartWrap.className = "chart-wrap";
    const canvas = document.createElement("canvas");
    chartWrap.appendChild(canvas);
    card.appendChild(chartWrap);

    function drawExerciseChart(exId) {
      if (typeof Chart === "undefined") return;
      const points = [];
      Object.keys(state.logs).sort().forEach((iso) => {
        const sets = (state.logs[iso].strength || {})[exId] || (state.logs[iso].core || {})[exId] || [];
        const weights = sets.map((s) => s.weight).filter((w) => typeof w === "number" && !isNaN(w));
        const amounts = sets.map((s) => s.amount).filter((a) => typeof a === "number" && !isNaN(a));
        if (weights.length && Math.max(...weights) > 0) points.push({ x: iso, y: Math.max(...weights), label: "kg" });
        else if (amounts.length) points.push({ x: iso, y: Math.max(...amounts), label: "reps/sec" });
      });
      if (chartInstance) chartInstance.destroy();
      chartInstance = new Chart(canvas, {
        type: "line",
        data: {
          labels: points.map((p) => p.x),
          datasets: [{
            label: points[0]?.label === "kg" ? "Max gewicht (kg)" : "Max reps/sec",
            data: points.map((p) => p.y),
            borderColor: "#FF6B35",
            backgroundColor: "#FF6B3533",
            tension: 0.25,
            pointRadius: 3,
            fill: true
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: {
            x: { ticks: { color: "#9A9CA6" }, grid: { color: "#33363F" } },
            y: { ticks: { color: "#9A9CA6" }, grid: { color: "#33363F" } }
          },
          plugins: { legend: { labels: { color: "#ECEAE4" } } }
        }
      });
    }
    select.onchange = () => drawExerciseChart(select.value);
    drawExerciseChart(exercises[0].id);
  }
  wrap.appendChild(card);

  const volCard = document.createElement("div");
  volCard.className = "card";
  volCard.innerHTML = `<div class="card-title-row"><h3 class="card-title">Totaal volume per workout</h3></div>`;
  const volChartWrap = document.createElement("div");
  volChartWrap.className = "chart-wrap";
  const volCanvas = document.createElement("canvas");
  volChartWrap.appendChild(volCanvas);
  volCard.appendChild(volChartWrap);

  if (typeof Chart !== "undefined") {
    const isos = Object.keys(state.logs).sort();
    const volumes = isos.map((iso) => {
      let total = 0;
      const day = state.logs[iso];
      ["strength", "core"].forEach((group) => {
        Object.values(day[group] || {}).forEach((sets) => {
          sets.forEach((s) => {
            if (typeof s.amount === "number" && typeof s.weight === "number" && s.weight > 0) {
              total += s.amount * s.weight;
            }
          });
        });
      });
      return total;
    });
    if (volumeChartInstance) volumeChartInstance.destroy();
    volumeChartInstance = new Chart(volCanvas, {
      type: "bar",
      data: {
        labels: isos,
        datasets: [{ label: "Volume (kg × reps)", data: volumes, backgroundColor: "#2DD4BF" }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: "#9A9CA6" }, grid: { color: "#33363F" } },
          y: { ticks: { color: "#9A9CA6" }, grid: { color: "#33363F" } }
        },
        plugins: { legend: { labels: { color: "#ECEAE4" } } }
      }
    });
  }
  wrap.appendChild(volCard);

  const lastCard = document.createElement("div");
  lastCard.className = "card";
  lastCard.innerHTML = `<div class="card-title-row"><h3 class="card-title">Laatste keer per oefening</h3></div>`;
  const allEx = [...state.library.strength, ...state.library.core];
  const rows = allEx.map((ex) => {
    let lastIso = null;
    Object.keys(state.logs).sort().forEach((iso) => {
      const sets = (state.logs[iso].strength || {})[ex.id] || (state.logs[iso].core || {})[ex.id];
      if (sets && sets.length) lastIso = iso;
    });
    if (!lastIso) return null;
    const sets = (state.logs[lastIso].strength || {})[ex.id] || (state.logs[lastIso].core || {})[ex.id];
    const summary = sets
      .filter((s) => s.amount !== "" && s.amount != null)
      .map((s) => (s.weight ? `${s.amount}x${s.weight}kg` : `${s.amount}`))
      .join(", ");
    return { name: ex.name, lastIso, summary };
  }).filter(Boolean);

  if (rows.length === 0) {
    lastCard.appendChild(emptyState("Nog geen data gelogd."));
  } else {
    const table = document.createElement("table");
    table.className = "last-table";
    table.innerHTML = `
      <thead><tr><th>Oefening</th><th>Laatst</th><th>Sets</th></tr></thead>
      <tbody>
        ${rows.map((r) => `<tr><td>${r.name}</td><td>${r.lastIso}</td><td>${r.summary}</td></tr>`).join("")}
      </tbody>
    `;
    lastCard.appendChild(table);
  }
  wrap.appendChild(lastCard);

  return wrap;
}

/* =========================================================
   DATA VIEW (export / import YAML)
   ========================================================= */
function buildExportObject() {
  const workouts = {};
  Object.keys(state.logs).sort().forEach((iso) => {
    const day = state.logs[iso];
    const dayCode = dayCodeForISO(iso);
    const entry = {};
    if (dayCode) entry.dag = DAY_LABEL[dayCode];

    const oefeningen = {};
    Object.entries(day.strength || {}).forEach(([exId, sets]) => {
      const ex = findExercise(exId);
      if (!ex) return;
      const setsObj = {};
      sets.forEach((s, i) => {
        if (s.amount === "" || s.amount == null) return;
        setsObj[`Rep ${i + 1}`] = ex.unit === "seconds"
          ? `${s.amount} sec`
          : `${s.amount} x ${s.weight || 0} kg`;
      });
      if (Object.keys(setsObj).length) oefeningen[ex.name] = setsObj;
    });
    if (Object.keys(oefeningen).length) entry.oefeningen = oefeningen;

    const buik = {};
    Object.entries(day.core || {}).forEach(([exId, sets]) => {
      const ex = findExercise(exId);
      if (!ex) return;
      const setsObj = {};
      sets.forEach((s, i) => {
        if (s.amount === "" || s.amount == null) return;
        setsObj[`Rep ${i + 1}`] = ex.unit === "seconds"
          ? `${s.amount} sec`
          : `${s.amount} x ${s.weight || 0} kg`;
      });
      if (Object.keys(setsObj).length) buik[ex.name] = setsObj;
    });
    if (Object.keys(buik).length) entry.buikspier_kwartier = buik;

    if (Object.keys(entry).length) workouts[iso] = entry;
  });

  return {
    workouts,
    schema: state.schedule,
    library: state.library
  };
}

function renderData() {
  const wrap = document.createElement("div");

  const dbxCard = document.createElement("div");
  dbxCard.className = "card";
  dbxCard.id = "dbx-status-card";
  wrap.appendChild(dbxCard);
  renderDropboxCard(dbxCard);

  const resetCard = document.createElement("div");
  resetCard.className = "card";
  resetCard.innerHTML = `
    <div class="card-title-row"><h3 class="card-title">Reset</h3></div>
    <p class="small-note">Verwijdert alle lokale data op dit toestel. Je Dropbox-back-up blijft staan.</p>
    <button class="btn btn-danger" id="reset-btn">Alles wissen</button>
  `;
  resetCard.querySelector("#reset-btn").onclick = () => {
    if (!confirm("Weet je zeker dat je alles wilt wissen? Dit kan niet ongedaan gemaakt worden.")) return;
    localStorage.removeItem(STORAGE_KEY);
    state = defaultState();
    toast("Gewist");
    render();
  };
  wrap.appendChild(resetCard);

  return wrap;
}

function renderDropboxCard(card) {
  if (!dbxIsConnected()) {
    card.innerHTML = `
      <div class="card-title-row"><h3 class="card-title">Dropbox</h3></div>
      <p class="small-note">Verbind met Dropbox zodat je logboek automatisch op de achtergrond wordt bewaard, ook als je Safari-data ooit wist.</p>
      <div class="btn-row">
        <button class="btn btn-accent" id="dbx-connect-btn">Verbind met Dropbox</button>
      </div>
    `;
    card.querySelector("#dbx-connect-btn").onclick = () => dbxConnect();
    return;
  }

  const statusLabel = {
    idle: "Verbonden",
    syncing: "Bezig met synchroniseren…",
    synced: "Alles gesynchroniseerd",
    error: "Synchroniseren mislukt, probeert opnieuw bij volgende wijziging"
  }[dbxSyncStatus] || "Verbonden";
  const lastSyncRaw = localStorage.getItem(DBX_LS.lastSync);
  const lastSyncLabel = lastSyncRaw
    ? ` · laatst gelukt ${new Date(parseInt(lastSyncRaw, 10)).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}`
    : "";

  card.innerHTML = `
    <div class="card-title-row">
      <h3 class="card-title">Dropbox</h3>
      <span class="dbx-dot dbx-${dbxSyncStatus}"></span>
    </div>
    <p class="small-note">${statusLabel}${lastSyncLabel}</p>
    <div class="btn-row">
      <button class="btn" id="dbx-sync-now-btn">Nu synchroniseren</button>
      <button class="btn btn-danger" id="dbx-disconnect-btn">Loskoppelen</button>
    </div>
  `;
  card.querySelector("#dbx-sync-now-btn").onclick = () => doDropboxSync(true);
  card.querySelector("#dbx-disconnect-btn").onclick = () => {
    if (!confirm("Dropbox loskoppelen? Lokale data blijft staan, alleen de automatische back-up stopt.")) return;
    dbxDisconnect();
  };
}

function parseSetString(v) {
  const secMatch = /^([\d.]+)\s*sec$/i.exec(v);
  if (secMatch) return { amount: parseFloat(secMatch[1]), weight: 0 };
  const m = /^([\d.]+)\s*x\s*([\d.]+)/i.exec(v);
  if (m) return { amount: parseFloat(m[1]), weight: parseFloat(m[2]) };
  return { amount: "", weight: "" };
}

/* applies one exported day-entry (as produced by buildExportObject) onto state.logs */
function applyWorkoutDay(iso, entry) {
  const day = getDayLog(iso, true);
  if (entry.oefeningen) {
    Object.entries(entry.oefeningen).forEach(([name, sets]) => {
      const ex = [...state.library.strength, ...state.library.core].find((e) => e.name === name);
      if (!ex) return;
      day.strength[ex.id] = Object.values(sets).map(parseSetString);
    });
  }
  if (entry.buikspier_kwartier) {
    Object.entries(entry.buikspier_kwartier).forEach(([name, sets]) => {
      const ex = [...state.library.strength, ...state.library.core].find((e) => e.name === name);
      if (!ex) return;
      day.core[ex.id] = Object.values(sets).map(parseSetString);
      const sel = state.coreSelectionByDate[iso] || [];
      if (!sel.includes(ex.id)) sel.push(ex.id);
      state.coreSelectionByDate[iso] = sel;
    });
  }
}

/* ---------- init ---------- */
render();
initDropboxSync();

async function initDropboxSync() {
  if (new URLSearchParams(window.location.search).has("code")) {
    await dbxHandleRedirect();
    render();
  } else if (dbxIsConnected()) {
    await dbxPullAndMerge();
    render();
  }
}
