/**
 * FGC 2026 Incheon — application principale.
 * Rendu 100 % DOM (textContent / createElement) : aucune donnée n'est injectée en HTML.
 */
import { DAYS, FIELD_IDS, DATA_URL, DATA_REFRESH_MS, BROADCAST_SHEET, YT_ID, KST_TZ, replayOffset } from "./config.js";
import { I18N, TZ_LIST } from "./i18n.js";
import { validateData } from "./data.js";
import { TEAMS, TEAM_CODES } from "./teams.js";
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
/* Cache des noms normalisés : isMine() est appelé pour ~340 matchs × 6 équipes à chaque rendu. */
const normCache = new Map();
const normC = s => { let v = normCache.get(s); if (v === undefined) { v = norm(s); if (normCache.size > 2000) normCache.clear(); normCache.set(s, v); } return v; };

/* ---------- Stockage local (valeurs toujours revalidées) ---------- */
/** Attributs des liens qui ouvrent un autre site. */
const EXTERNAL = Object.freeze({ target: "_blank", rel: "noopener noreferrer" });
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)");

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
  team: (store.get("fgc-team") || "France").slice(0, 60),   /* revalidé contre la liste au démarrage */
  view: "live",
  data: validateData(null),
  feed: location.protocol === "file:" ? "off" : "pending",
  checkedAt: /** @type {Date|null} */ (null),
  playerId: "",
  /** Rediffusion demandée par « Revoir » : position (s) et numéro du match, sinon null. */
  replay: /** @type {{ at: number, n: string }|null} */ (null)
};
S.prevTz = S.tz === KST_TZ ? "Europe/Paris" : S.tz;
/** @param {string} k */
const t = k => (I18N[S.lang][k] ?? I18N.fr[k] ?? k);
const locale = () => (S.lang === "fr" ? "fr-FR" : "en-GB");
const tzName = z => I18N[S.lang].tzNames[z] || `${t("tzLocal")} (${z.split("/").pop().replace(/_/g, " ")})`;

/* ---------- Temps ---------- */
const fmtCache = new Map();
function fmtTime(d, tz) {
  const k = S.lang + tz;
  if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }));
  return fmtCache.get(k).format(d);
}
const ymdCache = new Map();
/** Date AAAA-MM-JJ dans un fuseau (formateurs mis en cache). */
function ymd(d, tz) {
  if (!ymdCache.has(tz)) ymdCache.set(tz, new Intl.DateTimeFormat("en-CA", { timeZone: tz }));
  return ymdCache.get(tz).format(d);
}
const numCache = new Map();
/** Nombre au format de la langue (443,33 / 443.33) ; « – » si absent. */
function num(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return "–";
  if (!numCache.has(S.lang)) numCache.set(S.lang, new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }));
  return numCache.get(S.lang).format(Number(v));
}
const ordinalRules = { en: new Intl.PluralRules("en-GB", { type: "ordinal" }) };
const EN_SUFFIX = { one: "st", two: "nd", few: "rd", other: "th" };
/** Rang ordinal : 1er, 2e… / 1st, 2nd… */
const ordinal = n => (S.lang === "fr" ? (n === 1 ? "1er" : `${n}e`) : `${n}${EN_SUFFIX[ordinalRules.en.select(n)]}`);
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
const shortOf = d => (d.ceremony ? t("openShort") : `${t("dayShort")}${d.n}`);
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
  $("clkKstBtn").setAttribute("aria-pressed", String(S.tz === KST_TZ));
  $("tzShort").textContent = tzName(S.tz);
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
  const now = new Date();
  const wd = new Intl.DateTimeFormat(locale(), { weekday: "long", timeZone: KST_TZ });
  $("cal").replaceChildren(...DAYS.map(d => {
    const dt = new Date(`${d.date}T12:00:00+09:00`), sel = S.day === d.key;
    return h("button", { type: "button", class: "day", role: "tab", id: `tab-${d.key}`, "aria-selected": String(sel), "aria-controls": "dayPanel", tabindex: sel ? "0" : "-1", "data-k": d.key },
      pill(dayState(d, now)),
      h("span", { class: "d", text: Number(d.date.slice(8)) }),
      h("span", { class: "w", text: wd.format(dt) }),
      h("span", { class: "t", text: `${dayLabel(d)} · ${daySub(d)}` }),
      h("span", { class: "s", text: shortOf(d) }));
  }));
  $("dayPanel").setAttribute("aria-labelledby", `tab-${S.day}`);
}

const matchesFor = d => S.data.matches.filter(m => (m.day ? m.day === d.date : !d.ceremony));
/** Nom complet d'une équipe à partir de son code officiel (FRA → France). */
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const nameOf = x => (has(S.data.teams, x) ? S.data.teams[x] : has(TEAM_CODES, x) ? TEAM_CODES[x] : x);
/** L'équipe (code ou nom) est-elle l'équipe suivie ? */
const isFollowed = x => { const k = normC(S.team); return !!k && normC(nameOf(x)) === k; };
const isMine = m => m.red.some(isFollowed) || m.blue.some(isFollowed);
const rankingOf = x => { const k = normC(nameOf(x)); return S.data.rankings.find(r => normC(nameOf(r.team)) === k); };
/** Libellé court d'un terrain : « Général » ou « T3 ». */
const fieldShort = f => (f === "g" ? t("general") : `T${f.slice(1)}`);

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
      h("small", { text: f === "g" ? t("stream") : t("field") }), fieldShort(f))));
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
  const rp = d.ceremony ? null : S.replay;
  const url = `https://www.youtube.com/watch?v=${id}${rp ? `&t=${rp.at}` : ""}`;
  const title = `${dayLabel(d)} · ${label}${rp ? ` · ${fill(t("replayOf"), { n: rp.n })}` : ""}`;
  $("ytLink").setAttribute("href", url);
  $("nowWatching").textContent = title;
  if (CAN_EMBED) {
    const key = rp ? `${id}@${rp.at}` : id;
    if (S.playerId === key) { $("player").querySelector("iframe")?.setAttribute("title", title); return; }
    S.playerId = key;
    $("player").replaceChildren(h("iframe", {
      src: `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1&modestbranding=1${rp ? `&start=${rp.at}&autoplay=1` : ""}`,
      title, loading: rp ? "eager" : "lazy", referrerpolicy: "strict-origin-when-cross-origin",
      allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", allowfullscreen: true,
      sandbox: "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
    }));
  } else {
    const st = dayState(d);
    const p = st === "live" ? pill("live", t("onAir")) : st === "done" ? pill("done", t("replay")) : pill("today", st === "pause" ? t("pause") : t("soon"));
    $("player").replaceChildren(h("div", { class: "gate" }, p, h("h3", { text: title }),
      h("a", { class: "btn", href: url, ...EXTERNAL }, PLAY_SVG(), ` ${t("watchYt")}`),
      h("p", { text: t("gateNote") })));
  }
}

/** Codes pays d'une alliance : chacun est un bouton qui ouvre la fiche du pays. */
function teamsNode(arr) {
  const f = document.createDocumentFragment();
  arr.forEach((x, i) => {
    if (i) f.append(" · ");
    f.append(h("button", { type: "button", class: `cc${isFollowed(x) ? " me" : ""}`, "data-team": x, "aria-expanded": "false",
      "aria-controls": "teamTip", "aria-label": fill(t("tipOpen"), { team: nameOf(x) }), text: x }));
  });
  return f;
}

function renderMatches() {
  /* Fiche pays ouverte : rouverte sur le même code après le rendu (données relues). */
  const open = tipAnchor && { team: tipAnchor.dataset.team, n: tipAnchor.closest(".match")?.getAttribute("data-n") };
  closeTeamTip();
  renderMatchList();
  const again = open && [...document.querySelectorAll("#matches .match")].find(m => m.getAttribute("data-n") === open.n)
    ?.querySelector(`.cc[data-team="${CSS.escape(open.team || "")}"]`);
  if (again) openTeamTip(/** @type {HTMLElement} */ (again));
}

function renderMatchList() {
  const d = dayOf(S.day);
  if (d.ceremony) {
    $("matchCount").textContent = "";
    $("matches").replaceChildren(h("div", { class: "empty" },
      h("strong", { text: t("ceremonyTitle") }),
      h("span", {}, fillNodes(t("ceremonyBody"), { s: tzButton(timeNode(d.date, "18:30")), e: tzButton(timeNode(d.date, "20:30")), tz: tzName(S.tz) })),
      h("a", { href: BROADCAST_SHEET, ...EXTERNAL, text: t("schedSheet") })));
    return;
  }
  const list = matchesFor(d).filter(isMine).sort((a, b) => (a.day || "").localeCompare(b.day || "") || (a.kst || "99").localeCompare(b.kst || "99") || String(a.n || "").localeCompare(String(b.n || ""), undefined, { numeric: true }));
  $("matchCount").textContent = list.length ? fill(t("nMatches"), { n: list.length }) : "";
  if (!list.length) {
    const any = matchesFor(d).length > 0;
    $("matches").replaceChildren(h("div", { class: "empty" }, h("strong", { text: fill(t(any ? "noMine" : "noSched"), { team: S.team }) }), any ? t("noMineBody") : t("noSchedBody")));
    return;
  }
  $("matches").replaceChildren(...list.map(m => h("div", { class: `match${isMine(m) ? " mine" : ""}`, "data-n": m.n || null },
    h("span", { class: "n", text: m.n ? `#${m.n}` : "" }),
    h("span", { class: "h" }, m.kst ? tzButton(timeNode(m.day || d.date, m.kst)) : (m.time || "–"),
      m.field ? h("span", { text: fieldShort(m.field) }) : null),
    h("span", { class: "teams" },
      h("span", { class: "rd", "aria-label": t("red") }, teamsNode(m.red)),
      h("span", { class: "bl", "aria-label": t("blue") }, teamsNode(m.blue))),
    h("span", { class: "sc" }, h("strong", { text: m.sr !== null && m.sb !== null ? `${m.sr} – ${m.sb}` : "–" }),
      watchNode(d, m)))));
}

/** Match joué → lien « Revoir » au bon moment de la rediffusion ; sinon « Voir » ouvre le terrain en direct. */
function watchNode(d, m) {
  const id = m.field && d.streams[m.field];
  if (!id) return null;
  const at = m.sr !== null && m.sb !== null ? replayOffset(d, m.field, m.kst) : null;
  if (at !== null && YT_ID.test(id))
    return h("button", { type: "button", class: "linkbtn", "data-watch": m.field, "data-at": at, "data-n": m.n || "",
      "aria-label": fill(t("rewatchAria"), { n: m.n || "" }), text: t("rewatch") });
  return h("button", { type: "button", class: "linkbtn", "data-watch": m.field, text: t("see") });
}

/* ---------- Fiche pays (bulle légère sous un code pays) ---------- */
let tipAnchor = /** @type {HTMLElement|null} */ (null);
function closeTeamTip() {
  const tip = document.getElementById("teamTip");
  if (tip) tip.hidden = true;
  tipAnchor?.setAttribute("aria-expanded", "false");
  tipAnchor = null;
}
/** @param {HTMLElement} btn */
function openTeamTip(btn) {
  if (tipAnchor === btn) { closeTeamTip(); return; }
  closeTeamTip();
  const code = btn.dataset.team || "", r = rankingOf(code), total = S.data.rankings.length;
  const tip = $("teamTip");
  tip.setAttribute("aria-label", nameOf(code));
  tip.replaceChildren(
    h("p", { class: "tip-name" }, h("span", { text: nameOf(code) }), h("span", { class: "tip-code", text: code })),
    r?.rank != null
      ? h("div", { class: "tip-row" },
          h("p", { class: "tip-rank" }, ordinal(r.rank), h("small", { text: ` / ${total}` })),
          h("p", { class: "tip-kv" }, h("b", { text: num(r.score) }), h("span", { text: t("colScoreLong") })),
          h("p", { class: "tip-kv" }, h("b", { text: num(r.high) }), h("span", { text: t("tipHigh") })))
      : h("p", { class: "tip-foot", text: t("tipNone") }),
    r?.played != null ? h("p", { class: "tip-foot", text: fill(t("tipPlayed"), { n: r.played }) }) : null);
  tip.hidden = false;
  tipAnchor = btn;
  btn.setAttribute("aria-expanded", "true");
  /* Sous le code, dans la largeur de l'écran ; la pointe vise le code. */
  const b = btn.getBoundingClientRect(), w = tip.offsetWidth, vw = document.documentElement.clientWidth, gap = 12;
  const left = Math.min(Math.max(gap, b.left + b.width / 2 - 22), Math.max(gap, vw - w - gap));
  tip.style.setProperty("--tip-x", `${Math.round(left + scrollX)}px`);
  tip.style.setProperty("--tip-y", `${Math.round(b.bottom + scrollY + 8)}px`);
  tip.style.setProperty("--tip-arrow", `${Math.round(Math.max(10, Math.min(w - 20, b.left + b.width / 2 - left - 6)))}px`);
}

/** Liste déroulante : équipes officielles + noms vus dans les résultats, triés, sans doublon. */
let teamOptionsKey = "";
function teamNames() {
  const byKey = new Map(TEAMS.map(n => [normC(n), n]));
  for (const n of [...S.data.rankings.map(r => r.team), ...S.data.matches.flatMap(m => [...m.red, ...m.blue])].map(nameOf)) {
    const k = normC(n);
    if (k && !byKey.has(k)) byKey.set(k, n);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, S.lang, { sensitivity: "base" }));
}
function renderTeamOptions() {
  const names = teamNames();
  const key = `${S.lang}|${names.join("|")}`;
  const sel = /** @type {HTMLSelectElement} */ ($("team"));
  if (key !== teamOptionsKey) {
    teamOptionsKey = key;
    sel.replaceChildren(...names.map(n => h("option", { value: n, text: n })));
  }
  const want = normC(S.team), match = names.find(n => normC(n) === want);
  if (!match) S.team = names.find(n => n === "France") || names[0];
  else S.team = match;
  sel.value = S.team;
}

function renderResults() {
  renderTeamOptions();
  const r = S.data.rankings, me = rankingOf(S.team);
  $("sRank").textContent = num(me?.rank);
  $("sScore").textContent = num(me?.score);
  $("sPlayed").textContent = num(me?.played);
  $("updated").textContent = S.data.updated ? fill(t("updated"), { t: fmtTime(new Date(S.data.updated), S.tz) }) : "";
  if (!r.length) { $("rankWrap").replaceChildren(h("div", { class: "empty" }, h("strong", { text: t("noRank") }), t("noRankBody"))); return; }
  $("rankWrap").replaceChildren(h("div", { class: "tablebox", tabindex: "0", role: "region", "aria-label": t("rankCaption") },
    h("table", {},
      h("caption", { class: "sr-only", text: t("rankCaption") }),
      h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "#" }), h("th", { scope: "col", text: t("colTeam") }),
        h("th", { scope: "col", class: "r", text: t("colScore") }), h("th", { scope: "col", class: "r", text: t("colMax") }), h("th", { scope: "col", class: "r", text: t("colPlayed") }))),
      h("tbody", {}, ...r.map(x => h("tr", { class: isFollowed(x.team) ? "mine" : null },
        h("td", { text: num(x.rank) }), h("td", { text: nameOf(x.team) }), h("td", { class: "r", text: num(x.score) }), h("td", { class: "r", text: num(x.high) }), h("td", { class: "r", text: num(x.played) })))))));
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
  const live = DAYS.find(d => dayState(d, now) === "live");
  if (live) { $("cdLabel").textContent = t("onAir"); $("cdShort").textContent = "●"; $("cd").textContent = dayLabel(live); return; }
  const next = DAYS.flatMap(d => d.sessions.filter(x => !x.pause).map(x => ({ d, at: kst(d.date, x.s) }))).find(o => o.at > now);
  if (!next) { $("cdLabel").textContent = t("competition"); $("cdShort").textContent = ""; $("cd").textContent = t("over"); return; }
  const ms = next.at.getTime() - now.getTime(), hh = Math.floor(ms / 3.6e6), mm = Math.floor((ms % 3.6e6) / 6e4);
  $("cdLabel").textContent = `${dayLabel(next.d)} ${t("nextIn")}`;
  $("cdShort").textContent = `${shortOf(next.d)} →`;
  $("cd").textContent = `${hh} h ${String(mm).padStart(2, "0")}`;
}

function renderAll() { renderStatic(); renderTeamOptions(); renderCal(); renderDay(); renderResults(); renderRulesTimes(); renderStatus(); tick(); scheduleKey = scheduleKeyAt(new Date()); }

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
let lastDataText = "", loading = false;
async function loadData() {
  if (loading || S.feed === "off" || document.visibilityState === "hidden") return;
  loading = true;
  try {
    const r = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" }, signal: timeoutSignal(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (!(r.headers.get("content-type") || "").includes("json")) throw new Error("type");
    const text = await r.text();
    if (text.length > 2_000_000) throw new Error("trop gros");
    S.checkedAt = new Date();
    S.feed = navigator.onLine === false ? "nonet" : "ok";
    /* Contenu identique à la dernière lecture : ni analyse ni nouveau rendu. */
    if (text !== lastDataText) {
      lastDataText = text;
      S.data = validateData(JSON.parse(text));
      renderDay(); renderResults();
    }
  } catch {
    if (navigator.onLine === false) S.feed = "nonet";
    else S.feed = IN_ARTIFACT && !S.checkedAt ? "off" : "err";
  } finally { loading = false; }
  renderStatus();
}

/* ---------- Actions ---------- */
function setDay(k, focus = false) {
  if (!dayOf(k)) return;
  S.day = k; S.replay = null;
  if (S.view === "live" && location.hash !== `#${k}`) history.replaceState(null, "", `#${k}`);
  renderCal(); renderDay();
  if (focus) /** @type {HTMLElement|null} */ (document.getElementById(`tab-${k}`))?.focus();
}
/** Change de terrain ; `replay` lance la rediffusion d'un match à sa position, sinon le direct. */
function setField(f, replay = null) { if (!FIELD_IDS.includes(f)) return; S.field = f; S.replay = replay; store.set("fgc-field", f); renderDay(); }
function setTz(z) { if (!validTz(z)) return; S.tz = z; if (z !== KST_TZ) S.prevTz = z; store.set("fgc-tz", z); renderAll(); }
const toggleTz = () => setTz(S.tz === KST_TZ ? S.prevTz : KST_TZ);
function setLang(l) { if (l !== "fr" && l !== "en") return; S.lang = l; store.set("fgc-lang", l); renderAll(); }
function setView(v) {
  S.view = v === "rules" ? "rules" : "live";
  const rules = S.view === "rules";
  $("viewLive").hidden = rules; $("viewRules").hidden = !rules;
  $("vLive").setAttribute("aria-pressed", String(!rules)); $("vRules").setAttribute("aria-pressed", String(rules));
  history.replaceState(null, "", `#${rules ? "regles" : S.day}`);
}

function bindEvents() {
  document.addEventListener("click", e => {
    const target = /** @type {HTMLElement} */ (e.target);
    const el = /** @type {HTMLElement|null} */ (target.closest("button"));
    if (el?.dataset.team) return openTeamTip(el);
    if (!target.closest("#teamTip")) closeTeamTip();
    if (!el) return;
    if (el.classList.contains("tzb") || el.id === "clkKstBtn") return toggleTz();
    if (el.dataset.lang) return setLang(el.dataset.lang);
    if (el.id === "vLive") return setView("live");
    if (el.id === "vRules") return setView("rules");
    if (el.classList.contains("day") && el.dataset.k) { if (S.view !== "live") setView("live"); return setDay(el.dataset.k); }
    if (el.classList.contains("field") && el.dataset.f) return setField(el.dataset.f);
    if (el.dataset.watch) {
      const at = Number(el.dataset.at);
      setField(el.dataset.watch, el.dataset.at && Number.isFinite(at) && at >= 0 ? { at: Math.floor(at), n: el.dataset.n || "" } : null); $("player").scrollIntoView({ behavior: REDUCED_MOTION.matches ? "auto" : "smooth", block: "center" }); }
  });
  /* Flèches gauche/droite dans les onglets de jours (motif ARIA tabs) */
  $("cal").addEventListener("keydown", e => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const from = /** @type {HTMLElement} */ (e.target).closest(".day")?.getAttribute("data-k") || S.day;
    const i = DAYS.findIndex(d => d.key === from);
    const j = e.key === "Home" ? 0 : e.key === "End" ? DAYS.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + DAYS.length) % DAYS.length;
    if (S.view !== "live") setView("live");
    setDay(DAYS[j].key, true);
  });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || !tipAnchor) return;
    const back = tipAnchor; closeTeamTip(); back.focus();
  });
  window.addEventListener("resize", closeTeamTip, { passive: true });
  $("tzSelect").addEventListener("change", e => setTz(/** @type {HTMLSelectElement} */ (e.target).value));
  $("team").addEventListener("change", e => {
    S.team = /** @type {HTMLSelectElement} */ (e.target).value;
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
  let timer = 0;
  const done = () => { clearTimeout(timer); el.remove(); };
  el.addEventListener("animationend", e => { if (e.target === el) done(); });
  timer = window.setTimeout(done, 3000);
}

/* ---------- Barre collante : version resserrée pendant le défilement ----------
   La hauteur perdue en mode resserré est rendue en marge basse (--dock-comp) :
   la hauteur totale ne change pas, donc le contenu ne saute pas et la page
   garde la même longueur. La barre ne se resserre qu'une fois sortie de l'écran
   la zone qu'elle libère (pas de bande vide), avec un écart aller/retour contre
   le clignotement et un court fondu enchaîné. */
function initDock() {
  const dock = $("dock"), root = document.documentElement;
  let compact = false, raf = 0, roRaf = 0, anchorRaf = 0, morphTimer = 0, lost = 0, padTop = 0, toggledAt = 0;
  /* Hauteurs de la barre et des onglets, publiées pour les éléments collés dessous (onglets, classement). */
  const views = document.querySelector(".views");
  const pubH = () => {
    root.style.setProperty("--dock-h", `${Math.round(dock.getBoundingClientRect().height)}px`);
    if (views) root.style.setProperty("--views-h", `${Math.round(views.getBoundingClientRect().height)}px`);
  };
  const setComp = () => { dock.style.setProperty("--dock-comp", compact ? `${lost}px` : "0px"); pubH(); };
  /* Pendant la bascule, l'ancrage de défilement du navigateur verrait la barre
     changer de taille et décalerait la page : on le coupe le temps d'une image. */
  const noAnchor = () => {
    root.style.overflowAnchor = "none";
    cancelAnimationFrame(anchorRaf);
    anchorRaf = requestAnimationFrame(() => { anchorRaf = requestAnimationFrame(() => { root.style.overflowAnchor = ""; }); });
  };
  /* Mesure les deux hauteurs dans la même image (rien n'est affiché entre-temps). */
  const measure = () => {
    noAnchor();
    dock.style.transition = "none";   /* l'aller-retour de classe ne doit rien animer */
    dock.classList.remove("compact");
    const full = dock.getBoundingClientRect().height;
    dock.classList.add("compact");
    const small = dock.getBoundingClientRect().height;
    dock.classList.toggle("compact", compact);
    lost = Math.max(0, full - small);
    padTop = parseFloat(getComputedStyle(/** @type {HTMLElement} */ (dock.parentElement)).paddingTop) || 0;
    setComp();
    void dock.offsetWidth;
    dock.style.transition = "";
  };
  const morph = () => {
    if (REDUCED_MOTION.matches) return;
    dock.classList.remove("morph");
    void dock.offsetWidth;            /* relance l'animation */
    dock.classList.add("morph");
    clearTimeout(morphTimer);
    morphTimer = window.setTimeout(() => dock.classList.remove("morph"), 260);
  };
  const update = () => {
    raf = 0;
    const y = window.scrollY || root.scrollTop || 0, on = Math.max(96, lost + padTop);
    const next = compact ? y > on : y > on + 40;
    if (next === compact) return;
    noAnchor();
    compact = next; toggledAt = performance.now();
    dock.classList.toggle("compact", compact);
    setComp();
    morph();
  };
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { measure(); update(); }); }, { passive: true });
  /* Le contenu de la barre change de taille (langue, jours, bouton d'installation,
     statut) : on remesure, sauf juste après une bascule (taille déjà connue). */
  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(() => {
      if (performance.now() - toggledAt < 300 || roRaf) return;
      roRaf = requestAnimationFrame(() => { roRaf = 0; measure(); });
    });
    ro.observe($("cal"));
    ro.observe(/** @type {HTMLElement} */ (dock.firstElementChild));
  }
  measure(); update();
}

/* ---------- Démarrage ---------- */
function start() {
  initSplash();
  const hsh = location.hash.slice(1), now = new Date();
  S.day = dayOf(hsh)?.key
    || DAYS.find(d => ["live", "pause", "today"].includes(dayState(d, now)))?.key
    || DAYS.find(d => dayState(d, now) === "soon")?.key
    || DAYS[DAYS.length - 1].key;
  bindEvents();
  renderAll();
  initDock();
  setView(hsh === "regles" ? "rules" : "live");
  loadData();
  scheduleMinute();
  startPolling();
  initPwa(t);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
