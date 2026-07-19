/* ---------- State ---------- */
const STORAGE_KEY = "gymlog_state_v1";
const DAY_CODE_BY_WEEKDAY = { 0: "Zo", 1: "Ma", 2: "Di", 3: "Wo", 4: "Do", 5: "Vr", 6: "Za" };
const DAY_ORDER = ["Ma", "Di", "Wo", "Do", "Vr", "Za", "Zo"];
const DAY_LABEL = {
  Ma: "Maandag", Di: "Dinsdag", Wo: "Woensdag", Do: "Donderdag",
  Vr: "Vrijdag", Za: "Zaterdag", Zo: "Zondag"
};

function uid(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 9);
}

function defaultState() {
  return {
    library: [],
    schedule: {},
    logs: {},
    /* last-modified timestamps, keyed per exercise id / schedule day / log
       date. Used to resolve sync conflicts (newest wins) instead of the
       old "local always wins if present" rule. Missing entries default to
       0 (unknown/old) wherever they're read, so pre-existing data from
       before this existed never spuriously loses to a genuine remote edit. */
    meta: { library: {}, scheduleDays: {}, logDays: {} }
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
    return migrateLegacyState({
      library: parsed.library || def.library,
      schedule: parsed.schedule || def.schedule,
      logs: parsed.logs || {},
      meta: parsed.meta || def.meta
    });
  } catch (e) {
    return defaultState();
  }
}

function touchLibraryMeta(id) { state.meta.library[id] = Date.now(); }
function touchScheduleMeta(day) { state.meta.scheduleDays[day] = Date.now(); }
function touchLogMeta(iso) { state.meta.logDays[iso] = Date.now(); }

/* older saves had a separate "buikspier" concept: library.{strength,core}
   and logs[iso].{strength,core}. Fold everything into one flat exercise
   list / flat per-day log so no history gets silently dropped. */
function migrateLegacyState(s) {
  if (s.library && !Array.isArray(s.library)) {
    const merged = [...(s.library.strength || [])];
    const ids = new Set(merged.map((e) => e.id));
    (s.library.core || []).forEach((e) => { if (!ids.has(e.id)) merged.push(e); });
    s.library = merged;
  }
  Object.keys(s.logs).forEach((iso) => {
    const day = s.logs[iso];
    if (day && (day.strength || day.core)) {
      s.logs[iso] = { ...(day.strength || {}), ...(day.core || {}) };
    }
  });
  return s;
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
  const ex = state.library.find((e) => e.id === id);
  return ex && !ex.deleted ? ex : null;
}
/* library entries, excluding tombstoned (soft-deleted/merged-away) ones —
   use this for anything UI-facing; use state.library directly only when
   the raw array (including tombstones) needs to round-trip through sync. */
function activeLibrary() {
  return state.library.filter((e) => !e.deleted);
}
function scheduleFor(dayCode) {
  if (!state.schedule[dayCode]) state.schedule[dayCode] = [];
  return state.schedule[dayCode];
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
    state.logs[iso] = {};
  }
  return state.logs[iso];
}
function getSets(iso, exerciseId) {
  const day = getDayLog(iso, false);
  if (!day || !day[exerciseId]) return [];
  return day[exerciseId];
}
function setSets(iso, exerciseId, sets) {
  const day = getDayLog(iso, true);
  day[exerciseId] = sets;
  touchLogMeta(iso);
  saveState();
}

/* history max weight for PR detection, excludes given iso */
function historicalMaxWeight(exerciseId, excludeIso) {
  let max = 0;
  for (const iso in state.logs) {
    if (iso === excludeIso) continue;
    const sets = state.logs[iso][exerciseId] || [];
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
    /* pull+merge first so a second device's changes (that this tab hasn't
       seen since it was loaded) get absorbed before we push — otherwise
       our upload would silently overwrite them. */
    await dbxPullAndMerge();
    clearTimeout(dbxSyncTimer); // the pull's own saveState() may have re-armed the debounce timer
    const yamlStr = jsyaml.dump(buildExportObject());
    const ok = await dbxUpload(yamlStr);
    dbxSyncStatus = ok ? "synced" : "error";
    if (ok) localStorage.setItem(DBX_LS.lastSync, String(Date.now()));
    if (manual) { toast(ok ? "Gesynchroniseerd met Dropbox" : "Synchroniseren mislukt"); render(); }
  } catch (e) {
    dbxSyncStatus = "error";
    if (manual) toast("Synchroniseren mislukt (geen internet?)");
  }
  updateDropboxStatusUI();
}

/* last-write-wins merge: each library entry / schedule day / log date has
   its own meta timestamp, and whichever side (local vs remote) touched it
   more recently wins outright for that whole unit. Missing timestamps
   default to 0 (unknown/old), so pre-existing data never spuriously loses
   to a "genuine" remote edit, but a real rename/merge/delete made on any
   device reliably reaches every other device instead of being silently
   reverted by whichever device happens to sync next. */
function mergeRemoteIntoLocal(remoteObj) {
  if (!remoteObj) return;
  const remoteMeta = remoteObj.meta || { library: {}, scheduleDays: {}, logDays: {} };

  const remoteLibrary = Array.isArray(remoteObj.library)
    ? remoteObj.library
    : [...((remoteObj.library && remoteObj.library.strength) || []), ...((remoteObj.library && remoteObj.library.core) || [])];
  const localIds = new Set(state.library.map((e) => e.id));
  remoteLibrary.forEach((remoteEx) => {
    const remoteTs = remoteMeta.library[remoteEx.id] || 0;
    const localTs = state.meta.library[remoteEx.id] || 0;
    if (!localIds.has(remoteEx.id)) {
      state.library.push({ ...remoteEx });
      state.meta.library[remoteEx.id] = remoteTs;
      localIds.add(remoteEx.id);
    } else if (remoteTs > localTs) {
      const idx = state.library.findIndex((e) => e.id === remoteEx.id);
      state.library[idx] = { ...remoteEx };
      state.meta.library[remoteEx.id] = remoteTs;
    }
  });

  if (remoteObj.schema) {
    Object.keys(remoteObj.schema).forEach((day) => {
      const remoteTs = remoteMeta.scheduleDays[day] || 0;
      const localTs = state.meta.scheduleDays[day] || 0;
      if (!state.schedule[day] || remoteTs > localTs) {
        state.schedule[day] = remoteObj.schema[day];
        state.meta.scheduleDays[day] = remoteTs;
      }
    });
  }

  if (remoteObj.workouts) {
    Object.entries(remoteObj.workouts).forEach(([iso, entry]) => {
      const remoteTs = remoteMeta.logDays[iso] || 0;
      const localTs = state.meta.logDays[iso] || 0;
      if (!state.logs[iso] || remoteTs > localTs) {
        state.logs[iso] = {};
        applyWorkoutDay(iso, entry);
        state.meta.logDays[iso] = remoteTs;
      }
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
  label.textContent = `${formatDateNL(currentDate)} — schema ${DAY_LABEL[dayCode]}`;
  wrap.appendChild(label);

  const list = state.schedule[dayCode] || [];
  const scheduledIds = new Set(list.map((entry) => entry.exerciseId));
  const loggedDay = getDayLog(currentDate, false) || {};
  const extraIds = Object.keys(loggedDay).filter(
    (id) => !scheduledIds.has(id) && loggedDay[id] && loggedDay[id].length
  );

  if (list.length === 0 && extraIds.length === 0) {
    wrap.appendChild(emptyState("Nog geen oefeningen voor deze dag. Voeg ze toe via Schema."));
  }
  list.forEach((entry) => {
    const ex = findExercise(entry.exerciseId);
    if (!ex) return;
    wrap.appendChild(renderExerciseCard(ex, entry.target));
  });
  extraIds.forEach((id) => {
    const ex = findExercise(id);
    if (!ex) return;
    wrap.appendChild(renderExerciseCard(ex, null));
  });

  return wrap;
}

function renderExerciseCard(ex, target) {
  const card = document.createElement("div");
  card.className = "card";
  const { sets: targetSets, repsLabel } = parseTarget(target || (ex.unit === "seconds" ? "2x12" : "3x10-12"));
  const existing = getSets(currentDate, ex.id);
  const rowCount = Math.max(existing.length, targetSets);
  const maxBefore = historicalMaxWeight(ex.id, currentDate);

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
    const sets = getSets(currentDate, ex.id);
    const day = getDayLog(currentDate, false);
    const initialized = !!(day && day[ex.id]);
    const n = initialized ? sets.length : targetSets;
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
        const currentSets = getSets(currentDate, ex.id);
        while (currentSets.length < n) currentSets.push({ amount: "", weight: "" });
        currentSets[i] = {
          amount: amountInput.value === "" ? "" : parseFloat(amountInput.value),
          weight: weightInput.value === "" ? "" : parseFloat(weightInput.value)
        };
        setSets(currentDate, ex.id, currentSets);
        const w = parseFloat(weightInput.value);
        const isPR = !isNaN(w) && w > 0 && w > maxBefore;
        weightInput.classList.toggle("pr", isPR);
        updatePRBadge(card);
      }
      amountInput.oninput = commit;
      weightInput.oninput = commit;

      row.querySelector(".set-remove").onclick = () => {
        const currentSets = getSets(currentDate, ex.id);
        while (currentSets.length < n) currentSets.push({ amount: "", weight: "" });
        currentSets.splice(i, 1);
        setSets(currentDate, ex.id, currentSets);
        buildRows();
      };

      rowsWrap.appendChild(row);
    }
    updatePRBadge(card);
  }

  card.querySelector(".add-set-btn").onclick = () => {
    const currentSets = getSets(currentDate, ex.id);
    const day = getDayLog(currentDate, false);
    const initialized = !!(day && day[ex.id]);
    const n = initialized ? currentSets.length : targetSets;
    while (currentSets.length < n) currentSets.push({ amount: "", weight: "" });
    currentSets.push({ amount: "", weight: "" });
    setSets(currentDate, ex.id, currentSets);
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

function emptyState(text) {
  const d = document.createElement("div");
  d.className = "empty-state";
  d.textContent = text;
  return d;
}

/* renaming only touches the library entry's name — schedule and logs
   reference exercises by id, so history and schema stay linked automatically. */
function renameExercise(id, newName) {
  const ex = findExercise(id);
  if (!ex) return;
  const trimmed = newName.trim();
  if (!trimmed || trimmed === ex.name) return;
  ex.name = trimmed;
  touchLibraryMeta(id);
  saveState();
  render();
  toast("Oefening hernoemd");
}

/* removes an exercise from the library entirely, and from every day's
   schedule. Only allowed when it has zero logged history — an exercise
   with history should be merged into another one (mergeExercises) instead,
   never deleted, so historical data can never be silently orphaned.
   Marked as a tombstone (deleted: true) rather than physically removed,
   so the deletion itself can sync to other devices instead of a stale
   device silently resurrecting it on its next push. */
function deleteExerciseFromLibrary(id) {
  const ex = findExercise(id);
  if (!ex) return;
  const loggedDays = Object.keys(state.logs).filter((iso) => (state.logs[iso][id] || []).length);
  if (loggedDays.length) {
    toast(`"${ex.name}" heeft gelogde data op ${loggedDays.length} dag(en) — voeg 'm samen met een andere oefening in plaats van verwijderen`);
    return;
  }
  if (!confirm(`"${ex.name}" definitief verwijderen?`)) return;
  ex.deleted = true;
  touchLibraryMeta(id);
  Object.keys(state.schedule).forEach((day) => {
    const before = state.schedule[day].length;
    state.schedule[day] = state.schedule[day].filter((entry) => entry.exerciseId !== id);
    if (state.schedule[day].length !== before) touchScheduleMeta(day);
  });
  saveState();
  render();
  toast("Oefening verwijderd");
}

/* merges sourceId into targetId: moves all logged sets (per date, appended
   after any sets already on targetId that day so nothing is lost), repoints
   schedule entries to targetId (dropping the source entry instead if that
   day already has targetId, to avoid a duplicate card), then tombstones
   sourceId in the library (see deleteExerciseFromLibrary for why). */
function mergeExercises(sourceId, targetId) {
  const source = findExercise(sourceId);
  const target = findExercise(targetId);
  if (!source || !target || sourceId === targetId) return;

  Object.entries(state.logs).forEach(([iso, day]) => {
    if (!day[sourceId]) return;
    day[targetId] = (day[targetId] || []).concat(day[sourceId]);
    delete day[sourceId];
    touchLogMeta(iso);
  });

  Object.keys(state.schedule).forEach((dayCode) => {
    const list = state.schedule[dayCode];
    const hasTargetAlready = list.some((entry) => entry.exerciseId === targetId);
    const touchesSource = list.some((entry) => entry.exerciseId === sourceId);
    state.schedule[dayCode] = list.reduce((acc, entry) => {
      if (entry.exerciseId === sourceId) {
        if (!hasTargetAlready) acc.push({ ...entry, exerciseId: targetId });
      } else {
        acc.push(entry);
      }
      return acc;
    }, []);
    if (touchesSource) touchScheduleMeta(dayCode);
  });

  source.deleted = true;
  touchLibraryMeta(sourceId);
  saveState();
  render();
  toast(`Samengevoegd met "${target.name}"`);
}

function closeModal() {
  const overlay = document.querySelector(".modal-overlay");
  if (overlay) overlay.remove();
}

function openMergeModal(ex) {
  const others = activeLibrary().filter((e) => e.id !== ex.id);

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `
    <h3 class="modal-title">Samenvoegen met…</h3>
    <p class="small-note">Kies met welke oefening je "${ex.name}" wilt samenvoegen. Gelogde data wordt overgezet, "${ex.name}" verdwijnt daarna uit je lijst.</p>
    <div class="modal-list"></div>
    <button class="btn btn-block modal-cancel">Annuleren</button>
  `;

  const list = modal.querySelector(".modal-list");
  if (others.length === 0) {
    list.appendChild(emptyState("Geen andere oefeningen om mee samen te voegen."));
  } else {
    others.forEach((target) => {
      const b = document.createElement("button");
      b.className = "btn btn-block modal-option";
      b.textContent = target.name;
      b.onclick = () => {
        if (!confirm(`"${ex.name}" samenvoegen met "${target.name}"? Alle gelogde data van "${ex.name}" wordt overgezet naar "${target.name}", en "${ex.name}" verdwijnt daarna uit je lijst.`)) return;
        closeModal();
        mergeExercises(ex.id, target.id);
      };
      list.appendChild(b);
    });
  }

  modal.querySelector(".modal-cancel").onclick = () => closeModal();
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

/* =========================================================
   SCHEMA VIEW
   ========================================================= */
function renderSchema() {
  const wrap = document.createElement("div");

  const picker = document.createElement("div");
  picker.className = "day-picker";
  DAY_ORDER.forEach((code) => {
    const b = document.createElement("button");
    b.textContent = code;
    b.title = DAY_LABEL[code];
    b.className = code === activeSchemaDay ? "active" : "";
    b.onclick = () => { activeSchemaDay = code; render(); };
    picker.appendChild(b);
  });
  wrap.appendChild(picker);

  const card = document.createElement("div");
  card.className = "card";
  const list = state.schedule[activeSchemaDay] || [];

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
      touchScheduleMeta(activeSchemaDay);
      saveState();
    };
    row.querySelector(".move-up").onclick = () => {
      [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
      touchScheduleMeta(activeSchemaDay);
      saveState(); render();
    };
    row.querySelector(".move-down").onclick = () => {
      [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
      touchScheduleMeta(activeSchemaDay);
      saveState(); render();
    };
    row.querySelector(".remove-ex").onclick = () => {
      list.splice(idx, 1);
      touchScheduleMeta(activeSchemaDay);
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
        ${activeLibrary().map((e) => `<option value="${e.id}">${e.name}</option>`).join("")}
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
    scheduleFor(activeSchemaDay).push({ exerciseId: id, target });
    touchScheduleMeta(activeSchemaDay);
    saveState(); render();
    toast("Toegevoegd");
  };
  addCard.querySelector("#add-new-btn").onclick = () => {
    const name = addCard.querySelector("#new-ex-name").value.trim();
    const target = addCard.querySelector("#new-ex-target").value.trim() || "3x10-12";
    if (!name) { toast("Vul een naam in"); return; }
    const id = uid("ex");
    state.library.push({ id, name, unit: "reps" });
    touchLibraryMeta(id);
    scheduleFor(activeSchemaDay).push({ exerciseId: id, target });
    touchScheduleMeta(activeSchemaDay);
    saveState(); render();
    toast("Oefening aangemaakt en toegevoegd");
  };
  wrap.appendChild(addCard);

  const libraryCard = document.createElement("div");
  libraryCard.className = "card";
  libraryCard.innerHTML = `<div class="card-title-row"><h3 class="card-title">Alle oefeningen</h3></div>`;
  const libraryList = activeLibrary();
  if (libraryList.length === 0) {
    libraryCard.appendChild(emptyState("Nog geen oefeningen."));
  } else {
    libraryList.forEach((ex) => {
      const row = document.createElement("div");
      row.className = "exercise-edit-row";
      row.innerHTML = `
        <div class="exercise-edit-name">
          <input class="rename-input" value="${ex.name}" />
        </div>
        <button class="btn btn-sm merge-btn" title="Samenvoegen met andere oefening">Samenvoegen</button>
        <button class="btn btn-sm btn-danger delete-lib-ex" title="Oefening definitief verwijderen">🗑</button>
      `;
      row.querySelector(".rename-input").onchange = (e) => renameExercise(ex.id, e.target.value);
      row.querySelector(".merge-btn").onclick = () => openMergeModal(ex);
      row.querySelector(".delete-lib-ex").onclick = () => deleteExerciseFromLibrary(ex.id);
      libraryCard.appendChild(row);
    });
  }
  wrap.appendChild(libraryCard);

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
    Object.keys(state.logs[iso]).forEach((id) => ids.add(id));
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
        const sets = state.logs[iso][exId] || [];
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
      Object.values(state.logs[iso]).forEach((sets) => {
        sets.forEach((s) => {
          if (typeof s.amount === "number" && typeof s.weight === "number" && s.weight > 0) {
            total += s.amount * s.weight;
          }
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
  const rows = activeLibrary().map((ex) => {
    let lastIso = null;
    Object.keys(state.logs).sort().forEach((iso) => {
      const sets = state.logs[iso][ex.id];
      if (sets && sets.length) lastIso = iso;
    });
    if (!lastIso) return null;
    const sets = state.logs[lastIso][ex.id];
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
    Object.entries(day).forEach(([exId, sets]) => {
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

    if (Object.keys(entry).length) workouts[iso] = entry;
  });

  return {
    workouts,
    schema: state.schedule,
    library: state.library,
    meta: state.meta
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

/* looks up an exercise by name, auto-creating it if the library doesn't
   have it yet (instead of silently dropping the logged sets) */
function findOrCreateExerciseByName(name, rawValues) {
  let ex = state.library.find((e) => e.name === name && !e.deleted);
  if (ex) return ex;
  const looksLikeSeconds = rawValues.length > 0 && rawValues.every((v) => /^[\d.]+\s*sec$/i.test(String(v).trim()));
  ex = { id: uid("ex"), name, unit: looksLikeSeconds ? "seconds" : "reps" };
  state.library.push(ex);
  touchLibraryMeta(ex.id);
  return ex;
}

/* applies one exported day-entry (as produced by buildExportObject) onto state.logs.
   "buikspier_kwartier" is the old separate-abs-section key from before that feature
   was removed; still understood here so older Dropbox backups keep working. */
function applyWorkoutDay(iso, entry) {
  const day = getDayLog(iso, true);
  [entry.oefeningen, entry.buikspier_kwartier].filter(Boolean).forEach((section) => {
    Object.entries(section).forEach(([name, sets]) => {
      const rawValues = Object.values(sets);
      const ex = findOrCreateExerciseByName(name, rawValues);
      day[ex.id] = rawValues.map(parseSetString);
    });
  });
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
