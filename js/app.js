/**
 * FGC 2026 Incheon — application principale.
 * Rendu 100 % DOM (textContent / createElement) : aucune donnée n'est injectée en HTML.
 */
import { DAYS, FIELD_IDS, DATA_URL, DATA_REFRESH_MS, BROADCAST_SHEET, YT_ID, KST_TZ } from "./config.js";
import { I18N, TZ_LIST } from "./i18n.js";
import { validateData } from "./data.js";
import { initPwa } from "./pwa.js";

/* ---------- Outils DOM ---------- */
const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
/**
 * Crée un élément. `text` → textContent, `class` → className, le reste → setAttribute.
 * @param {string} tag @param {Record<string, unknown>} [props] @param {...(Node|string|number|null|undefined|false)} kids
 */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "text") el.textContent = String(v);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
/** Remplace les {clés} d'un gabarit par des nœuds ou du texte (jamais de HTML). */
function fillNodes(tpl, map) {
  const frag = document.createDocumentFragment();
  tpl.split(/(\{\w+\})/).forEach(part => {
    const m = part.match(/^\{(\w+)\}$/);
    if (m && m[1] in map) { const v = map[m[1]]; frag.append(v instanceof Node ? v : String(v)); }
    else if (part) frag.append(part);
  });
  return frag;
}
const fill = (tpl, map) => tpl.replace(/\{(\w+)\}/g, (_, k) => (k in map ? String(map[k]) : ""));
const norm = s => String(s || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/* ---------- Stockage local (valeurs toujours revalidées) ---------- */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } }
};

/* ---------- Environnement ---------- */
const IN_ARTIFACT = /(^|\.)(claude\.ai|claudeusercontent\.com|anthropic\.com)$/.test(location.hostname);
const CAN_EMBED = !IN_ARTIFACT;
const LOCAL_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Paris"; } catch { return "Europe/Paris"; } })();
const tzList = TZ_LIST.includes(LOCAL_TZ) ? [...TZ_LIST] : [TZ_LIST[0], TZ_LIST[1], LOCAL_TZ, ...TZ_LIST.slice(2)];
const validTz = z => typeof z === "string" && tzList.includes(z);

/* ---------- État unique ---------- */
const storedLang = store.get("fgc-lang");
const storedTz = store.get("fgc-tz");
const storedField = store.get("fgc-field");
const S = {
  lang: storedLang === "fr" || storedLang === "en" ? storedLang : ((navigator.language || "fr").toLowerCase().startsWith("fr") ? "fr" : "en"),
  tz: validTz(storedTz) ? storedTz : (validTz(LOCAL_TZ) ? LOCAL_TZ : "Europe/Paris"),
  prevTz: "Europe/Paris",
  day: DAYS[1].key,
  field: FIELD_IDS.includes(storedField || "") ? /** @type {string} */ (storedField) : "g",
  team: (store.get("fgc-team") || "France").slice(0, 60),
  view: "live",
  data: validateData(null),
  feed: location.protocol === "file:" ? "off" : "pending",
  checkedAt: /** @type {Date|null} */ (null),
  playerId: ""
};
S.prevTz = S.tz === KST_TZ ? "Europe/Paris" : S.tz;
/** @param {string} k */
const t = k => (I18N[S.lang][k] ?? I18N.fr[k] ?? k);
const tzName = z => I18N[S.lang].tzNames[z] || `${t("tzLocal")} (${z.split("/").pop().replace(/_/g, " ")})`;

/* ---------- Temps ---------- */
const fmtCache = new Map();
function fmtTime(d, tz) {
  const k = S.lang + tz;
  if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat(S.lang === "fr" ? "fr-FR" : "en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }));
  return fmtCache.get(k).format(d);
}
const ymdCache = new Map();
/** Date AAAA-MM-JJ dans un fuseau (formateurs mis en cache). */
function ymd(d, tz) {
  if (!ymdCache.has(tz)) ymdCache.set(tz, new Intl.DateTimeFormat("en-CA", { timeZone: tz }));
  return ymdCache.get(tz).format(d);
}
const kst = (date, hhmm) => new Date(`${date}T${hhmm}:00+09:00`);
/** Heure KST affichée dans le fuseau choisi, avec « ±1 j » si la date change. */
function timeNode(date, hhmm) {
  const d = kst(date, hhmm);
  const diff = Math.round((Date.parse(ymd(d, S.tz)) - Date.parse(date)) / 864e5);
  const frag = document.createDocumentFragment();
  frag.append(fmtTime(d, S.tz));
  if (diff) frag.append(h("sup", { text: `${diff > 0 ? "+" : "−"}${Math.abs(diff)} ${t("dayShift")}` }));
  return frag;
}
const tzButton = (...kids) => h("button", { type: "button", class: "tzb", title: t("tzToggle") }, ...kids);
const spanNode = (date, a, b) => { const f = document.createDocumentFragment(); f.append(timeNode(date, a), "–", timeNode(date, b)); return f; };

/* ---------- Calendrier ---------- */
const dayOf = k => DAYS.find(d => d.key === k);
const dayLabel = d => (d.ceremony ? t("opening") : `${t("day")} ${d.n}`);
const daySub = d => (d.ceremony ? t("ceremonyShort") : t(d.sub));
const curSession = (d, now) => d.sessions.find(x => now >= kst(d.date, x.s) && now < kst(d.date, x.e));
function dayState(d, now = new Date()) {
  const cs = curSession(d, now);
  if (cs) return cs.pause ? "pause" : "live";
  if (now < kst(d.date, d.sessions[0].s)) return ymd(now, KST_TZ) === d.date ? "today" : "soon";
  return "done";
}
function pill(state, label) {
  const cls = { live: "pill dot", pause: "pill soon", today: "pill soon", done: "pill done" }[state];
  return cls ? h("span", { class: cls, text: label ?? t(state) }) : null;
}

/* ---------- Rendu ---------- */
function renderStatic() {
  document.documentElement.lang = S.lang;
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(/** @type {HTMLElement} */ (el).dataset.i18n || ""); });
  $("lnFr").setAttribute("aria-pressed", String(S.lang === "fr"));
  $("lnEn").setAttribute("aria-pressed", String(S.lang === "en"));
  $("cal").setAttribute("aria-label", t("days"));
  $("fields").setAttribute("aria-label", t("fieldsLabel"));
  $("clkKstBtn").setAttribute("title", t("tzToggle"));
  const sel = /** @type {HTMLSelectElement} */ ($("tzSelect"));
  sel.replaceChildren(...tzList.map(z => h("option", { value: z, text: tzName(z) })));
  sel.value = S.tz;
  const zones = [["0", "zNone"], ["0.05", "zO0"], ["0.10", "zO1"], ["0.20", "zO2"], ["0.30", "zO3"]];
  ["cR1", "cR2", "cR3"].forEach((id, i) => {
    const s = /** @type {HTMLSelectElement} */ ($(id)), v = s.value || ["0.10", "0.20", "0.30"][i];
    s.replaceChildren(...zones.map(([val, k]) => h("option", { value: val, text: t(k) })));
    s.value = v;
  });
  const coop = /** @type {HTMLSelectElement} */ ($("cCoop")), cv = coop.value || "0";
  coop.replaceChildren(...[["0", t("lt4")], ["10", "4"], ["25", "5"], ["40", "6"]].map(([v, l]) => h("option", { value: v, text: l })));
  coop.value = cv;
  calc();
}

function renderCal() {
  const now = new Date(), loc = S.lang === "fr" ? "fr-FR" : "en-GB";
  const wd = new Intl.DateTimeFormat(loc, { weekday: "long", timeZone: KST_TZ });
  $("cal").replaceChildren(...DAYS.map(d => {
    const dt = new Date(`${d.date}T12:00:00+09:00`), sel = S.day === d.key;
    return h("button", { type: "button", class: "day", role: "tab", id: `tab-${d.key}`, "aria-selected": String(sel), "aria-controls": "dayPanel", tabindex: sel ? "0" : "-1", "data-k": d.key },
      pill(dayState(d, now)),
      h("span", { class: "d", text: Number(d.date.slice(8)) }),
      h("span", { class: "w", text: wd.format(dt) }),
      h("span", { class: "t", text: `${dayLabel(d)} · ${daySub(d)}` }));
  }));
  $("dayPanel").setAttribute("aria-labelledby", `tab-${S.day}`);
}

const matchesFor = d => S.data.matches.filter(m => (m.day ? m.day === d.date : !d.ceremony));
const isMine = m => { const k = norm(S.team); return !!k && [...m.red, ...m.blue].some(x => norm(x) === k); };

function renderDay() {
  const d = dayOf(S.day), now = new Date(), cs = curSession(d, now);
  $("dayTitle").textContent = d.ceremony ? t("ceremony") : `${dayLabel(d)} · ${t(d.sub)}`;
  $("dayPlace").textContent = d.ceremony ? t("place") : "";
  $("timeline").replaceChildren(...d.sessions.map(x => {
    const cls = [x.pause && "pause", cs === x && "now", now >= kst(d.date, x.e) && "past"].filter(Boolean).join(" ");
    return h("li", { class: cls || null },
      tzButton(spanNode(d.date, x.s, x.e)),
      h("span", { class: "tt" }, t(x.t), cs === x && !x.pause ? pill("live", t("now")) : null),
      h("span", { class: "tk", text: S.tz === KST_TZ ? "" : `${x.s}–${x.e} KST` }));
  }));
  if (d.ceremony) {
    $("fields").replaceChildren(h("div", { class: "field wide", "aria-current": "true" }, h("small", { text: t("mainStream") }), t("ceremony")));
  } else {
    const mine = new Set(matchesFor(d).filter(isMine).map(m => m.field));
    $("fields").replaceChildren(...FIELD_IDS.map(f => h("button", { type: "button", class: `field${mine.has(f) ? " mine" : ""}`, "aria-pressed": String(S.field === f), "data-f": f },
      h("small", { text: f === "g" ? t("stream") : t("field") }), f === "g" ? t("general") : `T${f.slice(1)}`)));
  }
  renderPlayer();
  renderMatches();
}

const PLAY_SVG = () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", "M4 2.5v11l9-5.5z"); svg.append(p);
  return svg;
};

function renderPlayer() {
  const d = dayOf(S.day), fid = d.ceremony ? "g" : S.field, id = d.streams[fid];
  if (!YT_ID.test(id || "")) return;
  const label = d.ceremony ? t("ceremony") : fid === "g" ? t("generalStream") : `${t("field")} ${fid.slice(1)}`;
  const url = `https://www.youtube.com/watch?v=${id}`;
  $("ytLink").setAttribute("href", url);
  $("nowWatching").textContent = `${dayLabel(d)} · ${label}`;
  if (CAN_EMBED) {
    if (S.playerId === id) { $("player").querySelector("iframe")?.setAttribute("title", `${dayLabel(d)} · ${label}`); return; }
    S.playerId = id;
    $("player").replaceChildren(h("iframe", {
      src: `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1&modestbranding=1`,
      title: `${dayLabel(d)} · ${label}`, loading: "lazy", referrerpolicy: "strict-origin-when-cross-origin",
      allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", allowfullscreen: true,
      sandbox: "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
    }));
  } else {
    const st = dayState(d);
    const p = st === "live" ? pill("live", t("onAir")) : st === "done" ? pill("done", t("replay")) : pill("today", st === "pause" ? t("pause") : t("soon"));
    $("player").replaceChildren(h("div", { class: "gate" }, p, h("h3", { text: `${dayLabel(d)} · ${label}` }),
      h("a", { class: "btn", href: url, target: "_blank", rel: "noopener noreferrer" }, PLAY_SVG(), ` ${t("watchYt")}`),
      h("p", { text: t("gateNote") })));
  }
}

function renderMatches() {
  const d = dayOf(S.day);
  if (d.ceremony) {
    $("matchCount").textContent = "";
    $("matches").replaceChildren(h("div", { class: "empty" },
      h("strong", { text: t("ceremonyTitle") }),
      h("span", {}, fillNodes(t("ceremonyBody"), { s: tzButton(timeNode(d.date, "18:30")), e: tzButton(timeNode(d.date, "20:30")), tz: tzName(S.tz) })),
      h("a", { href: BROADCAST_SHEET, target: "_blank", rel: "noopener noreferrer", text: t("schedSheet") })));
    return;
  }
  const list = matchesFor(d).slice().sort((a, b) => (a.day || "").localeCompare(b.day || "") || (a.kst || "99").localeCompare(b.kst || "99") || String(a.n || "").localeCompare(String(b.n || ""), undefined, { numeric: true }));
  $("matchCount").textContent = list.length ? fill(t("nMatches"), { n: list.length }) : "";
  if (!list.length) { $("matches").replaceChildren(h("div", { class: "empty" }, h("strong", { text: t("noSched") }), t("noSchedBody"))); return; }
  const team = norm(S.team);
  const teamsNode = arr => { const f = document.createDocumentFragment(); arr.forEach((x, i) => { if (i) f.append(", "); f.append(norm(x) === team ? h("b", { text: x }) : x); }); return f; };
  $("matches").replaceChildren(...list.map(m => h("div", { class: `match${isMine(m) ? " mine" : ""}` },
    h("span", { class: "n", text: m.n ? `#${m.n}` : "" }),
    h("span", { class: "h" }, m.kst ? tzButton(timeNode(m.day || d.date, m.kst)) : (m.time || "–"),
      m.field ? h("span", { text: m.field === "g" ? t("general") : `T${m.field.slice(1)}` }) : null),
    h("span", { class: "teams" },
      h("span", { class: "rd", "aria-label": t("red") }, teamsNode(m.red)),
      h("span", { class: "bl", "aria-label": t("blue") }, teamsNode(m.blue))),
    h("span", { class: "sc" }, h("strong", { text: m.sr !== null && m.sb !== null ? `${m.sr} – ${m.sb}` : "–" }),
      m.field && d.streams[m.field] ? h("button", { type: "button", class: "linkbtn", "data-watch": m.field, text: t("see") }) : null))));
}

function renderResults() {
  const r = S.data.rankings, k = norm(S.team), me = r.find(x => norm(x.team) === k);
  $("sRank").textContent = me?.rank != null ? String(me.rank) : "–";
  $("sScore").textContent = me?.score != null ? String(me.score) : "–";
  $("sPlayed").textContent = me?.played != null ? String(me.played) : "–";
  $("updated").textContent = S.data.updated ? fill(t("updated"), { t: fmtTime(new Date(S.data.updated), S.tz) }) : "";
  $("teamList").replaceChildren(...r.map(x => h("option", { value: x.team })));
  if (!r.length) { $("rankWrap").replaceChildren(h("div", { class: "empty" }, h("strong", { text: t("noRank") }), t("noRankBody"))); return; }
  const cell = v => (v === null || v === undefined ? "–" : String(v));
  $("rankWrap").replaceChildren(h("div", { class: "tablebox", tabindex: "0", role: "region", "aria-label": t("rankCaption") },
    h("table", {},
      h("caption", { class: "sr-only", text: t("rankCaption") }),
      h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "#" }), h("th", { scope: "col", text: t("colTeam") }),
        h("th", { scope: "col", class: "r", text: t("colScore") }), h("th", { scope: "col", class: "r", text: t("colMax") }), h("th", { scope: "col", class: "r", text: t("colPlayed") }))),
      h("tbody", {}, ...r.map(x => h("tr", { class: norm(x.team) === k ? "mine" : null },
        h("td", { text: cell(x.rank) }), h("td", { text: x.team }), h("td", { class: "r", text: cell(x.score) }), h("td", { class: "r", text: cell(x.high) }), h("td", { class: "r", text: cell(x.played) })))))));
}

function renderStatus() {
  const el = $("status");
  if (S.feed === "ok" && S.checkedAt) {
    const parts = [h("span", { class: "ok", "aria-hidden": "true", text: "● " }), fill(t("stAuto"), { t: fmtTime(S.checkedAt, S.tz) })];
    if (S.data.updated) parts.push(h("br"), fill(t("stAutoUpd"), { t: fmtTime(new Date(S.data.updated), S.tz) }));
    el.replaceChildren(...parts);
  } else if (S.feed === "nonet") el.textContent = t("stNoNet");
  else if (S.feed === "err") el.textContent = t("stErr");
  else if (S.feed === "off") el.textContent = t("stOffline");
  else el.textContent = "";
}

function renderRulesTimes() {
  document.querySelectorAll(".rtime").forEach(el => {
    const ds = /** @type {HTMLElement} */ (el).dataset;
    el.replaceChildren(tzButton(spanNode(ds.d, ds.s, ds.e)), ` (${tzName(S.tz)})`);
  });
}

function tick() {
  const now = new Date();
  $("clkMain").textContent = fmtTime(now, S.tz);
  $("clkKst").textContent = fmtTime(now, KST_TZ);
  $("clkKstBtn").setAttribute("aria-pressed", String(S.tz === KST_TZ));
  const live = DAYS.find(d => dayState(d, now) === "live");
  if (live) { $("cdLabel").textContent = t("onAir"); $("cd").textContent = dayLabel(live); return; }
  const next = DAYS.flatMap(d => d.sessions.filter(x => !x.pause).map(x => ({ d, at: kst(d.date, x.s) }))).find(o => o.at > now);
  if (!next) { $("cdLabel").textContent = t("competition"); $("cd").textContent = t("over"); return; }
  const ms = next.at.getTime() - now.getTime(), hh = Math.floor(ms / 3.6e6), mm = Math.floor((ms % 3.6e6) / 6e4);
  $("cdLabel").textContent = `${dayLabel(next.d)} ${t("nextIn")}`;
  $("cd").textContent = `${hh} h ${String(mm).padStart(2, "0")}`;
}

function renderAll() { renderStatic(); renderCal(); renderDay(); renderResults(); renderRulesTimes(); renderStatus(); tick(); scheduleKey = scheduleKeyAt(new Date()); }

/* ---------- Horloge : rafraîchit à chaque minute, et ne reconstruit le calendrier
   que si l'état du programme change (le focus clavier est ainsi conservé) ---------- */
let scheduleKey = "";
const scheduleKeyAt = now => `${ymd(now, KST_TZ)}|${DAYS.map(d => `${dayState(d, now)}${d.sessions.indexOf(curSession(d, now))}`).join("|")}`;
/** Exécute un rendu en rendant ensuite le focus à l'élément équivalent (même id ou même data-*). */
function keepFocus(render) {
  const a = /** @type {HTMLElement|null} */ (document.activeElement);
  const sel = a && a !== document.body ? (a.id ? `#${CSS.escape(a.id)}` : a.dataset.f ? `[data-f="${CSS.escape(a.dataset.f)}"]` : a.dataset.k ? `[data-k="${CSS.escape(a.dataset.k)}"]` : "") : "";
  render();
  if (sel && !document.activeElement?.matches(sel)) /** @type {HTMLElement|null} */ (document.querySelector(sel))?.focus({ preventScroll: true });
}
function onMinute() {
  tick();
  const k = scheduleKeyAt(new Date());
  if (k !== scheduleKey) { scheduleKey = k; keepFocus(() => { renderCal(); renderDay(); }); }
}
let minuteTimer = 0;
function scheduleMinute() {
  clearTimeout(minuteTimer);
  minuteTimer = window.setTimeout(() => { onMinute(); scheduleMinute(); }, 60_000 - (Date.now() % 60_000) + 50);
}
let pollTimer = 0;
function startPolling() { clearInterval(pollTimer); pollTimer = window.setInterval(loadData, DATA_REFRESH_MS); }

/* ---------- Calculateur ---------- */
function calc() {
  const val = id => /** @type {HTMLInputElement} */ ($(id)).value;
  const int = x => Math.min(500, Math.max(0, Math.floor(Number(x) || 0)));
  const b = int(val("cBalls")), x = int(val("cExt"));
  const mult = ["cR1", "cR2", "cR3"].reduce((s, id) => s + (Number(val(id)) || 0), 0);
  const u = Math.ceil(Math.round(b * (1 + mult) * 1000) / 1000);
  const c = 25 * (Number(val("cCarry")) || 0);
  const k = (/** @type {HTMLInputElement} */ ($("cKnock")).checked ? 10 : 0) + (Number(val("cCoop")) || 0);
  $("cTotal").textContent = String(u + c + x + k);
  $("cDetail").textContent = fill(t("calcDetail"), { b, m: (1 + mult).toFixed(2).replace(".", t("decimal")), u, c, x, k });
}

/* ---------- Données automatiques ---------- */
/** Signal d'annulation après `ms` millisecondes (repli pour les navigateurs anciens). */
function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}
async function loadData() {
  if (S.feed === "off" || document.visibilityState === "hidden") return;
  try {
    const r = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" }, signal: timeoutSignal(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (!(r.headers.get("content-type") || "").includes("json")) throw new Error("type");
    const text = await r.text();
    if (text.length > 2_000_000) throw new Error("trop gros");
    const next = validateData(JSON.parse(text));
    const changed = JSON.stringify(next) !== JSON.stringify(S.data);
    S.data = next; S.checkedAt = new Date();
    S.feed = navigator.onLine === false ? "nonet" : "ok";
    if (changed) { renderDay(); renderResults(); }
  } catch {
    if (navigator.onLine === false) S.feed = "nonet";
    else S.feed = IN_ARTIFACT && !S.checkedAt ? "off" : "err";
  }
  renderStatus();
}

/* ---------- Actions ---------- */
function setDay(k, focus = false) {
  if (!dayOf(k)) return;
  S.day = k;
  if (S.view === "live" && location.hash !== `#${k}`) history.replaceState(null, "", `#${k}`);
  renderCal(); renderDay();
  if (focus) /** @type {HTMLElement|null} */ (document.getElementById(`tab-${k}`))?.focus();
}
function setField(f) { if (!FIELD_IDS.includes(f)) return; S.field = f; store.set("fgc-field", f); renderDay(); }
function setTz(z) { if (!validTz(z)) return; S.tz = z; if (z !== KST_TZ) S.prevTz = z; store.set("fgc-tz", z); renderAll(); }
const toggleTz = () => setTz(S.tz === KST_TZ ? S.prevTz : KST_TZ);
function setLang(l) { if (l !== "fr" && l !== "en") return; S.lang = l; store.set("fgc-lang", l); fmtCache.clear(); renderAll(); }
function setView(v) {
  S.view = v === "rules" ? "rules" : "live";
  const rules = S.view === "rules";
  $("viewLive").hidden = rules; $("viewRules").hidden = !rules;
  $("vLive").setAttribute("aria-pressed", String(!rules)); $("vRules").setAttribute("aria-pressed", String(rules));
  history.replaceState(null, "", `#${rules ? "regles" : S.day}`);
}

function bindEvents() {
  document.addEventListener("click", e => {
    const el = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest("button"));
    if (!el) return;
    if (el.classList.contains("tzb") || el.id === "clkKstBtn") return toggleTz();
    if (el.dataset.lang) return setLang(el.dataset.lang);
    if (el.id === "vLive") return setView("live");
    if (el.id === "vRules") return setView("rules");
    if (el.classList.contains("day") && el.dataset.k) return setDay(el.dataset.k);
    if (el.classList.contains("field") && el.dataset.f) return setField(el.dataset.f);
    if (el.dataset.watch) { setField(el.dataset.watch); $("player").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" }); }
  });
  /* Flèches gauche/droite dans les onglets de jours (motif ARIA tabs) */
  $("cal").addEventListener("keydown", e => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const from = /** @type {HTMLElement} */ (e.target).closest(".day")?.getAttribute("data-k") || S.day;
    const i = DAYS.findIndex(d => d.key === from);
    const j = e.key === "Home" ? 0 : e.key === "End" ? DAYS.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + DAYS.length) % DAYS.length;
    setDay(DAYS[j].key, true);
  });
  $("tzSelect").addEventListener("change", e => setTz(/** @type {HTMLSelectElement} */ (e.target).value));
  $("team").addEventListener("input", e => {
    S.team = /** @type {HTMLInputElement} */ (e.target).value.slice(0, 60);
    store.set("fgc-team", S.team); renderDay(); renderResults();
  });
  $("calcForm").addEventListener("input", calc);
  $("calcForm").addEventListener("submit", e => e.preventDefault());
  window.addEventListener("hashchange", () => {
    const hsh = location.hash.slice(1);
    if (hsh === "regles") setView("rules");
    else if (dayOf(hsh)) { setView("live"); setDay(hsh); }
  });
  window.addEventListener("online", loadData);
  /* En arrière-plan : ni relecture des données ni horloge ; reprise immédiate au retour. */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { onMinute(); scheduleMinute(); loadData(); startPolling(); }
    else { clearInterval(pollTimer); clearTimeout(minuteTimer); }
  });
  window.addEventListener("offline", () => { S.feed = "nonet"; renderStatus(); });
}

/* ---------- Splashscreen ---------- */
/** Retire l'écran d'ouverture du DOM à la fin de son animation (sécurité : 3 s max). */
function initSplash() {
  const el = document.getElementById("splash");
  if (!el) return;
  const done = () => { el.classList.add("is-gone"); el.remove(); };
  el.addEventListener("animationend", e => { if (e.target === el) done(); });
  setTimeout(done, 3000);
}

/* ---------- Démarrage ---------- */
function start() {
  initSplash();
  /** @type {HTMLInputElement} */ ($("team")).value = S.team;
  const hsh = location.hash.slice(1), now = new Date();
  S.day = dayOf(hsh)?.key
    || DAYS.find(d => ["live", "pause", "today"].includes(dayState(d, now)))?.key
    || DAYS.find(d => dayState(d, now) === "soon")?.key
    || DAYS[DAYS.length - 1].key;
  bindEvents();
  renderAll();
  setView(hsh === "regles" ? "rules" : "live");
  loadData();
  scheduleMinute();
  startPolling();
  initPwa();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
