#!/usr/bin/env node
/**
 * FGC 2026 — collecteur de résultats (Node 20+, sans dépendance).
 * Lit results.first.global. Le site (Next.js) embarque toutes ses données dans le bloc
 * JSON <script id="__NEXT_DATA__"> de la page d'accueil : matchs de classement, playoffs,
 * finales et classement. Si ce bloc disparaît, repli sur la lecture des tableaux HTML.
 * Écrit data.json, validé par le même schéma que la page (js/data.js).
 *
 * Usage : node scripts/scrape.mjs [--out data.json] [--file page.html]
 *   --file : analyser un fichier HTML local (tests) au lieu du site.
 */
import { readFile, writeFile, rename } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { validateData } from "../js/data.js";
import { TEAM_CODES } from "../js/teams.js";

export const BASE = "https://results.first.global/";
const ALLOWED_HOST = new URL(BASE).hostname;
const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 20_000;
const MAX_PAGES = 8;
const EVENT_DAYS = { 7: "2026-10-07", 8: "2026-10-08", 9: "2026-10-09", 10: "2026-10-10" };
const WEEKDAYS = { wed: 7, mer: 7, thu: 8, jeu: 8, fri: 9, ven: 9, sat: 10, sam: 10 };

/* ---------- HTML → texte / tableaux ---------- */
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—" };
export const decode = s => s.replace(/&(#x?[0-9a-f]{1,6}|\w{2,8});/gi, (m, e) => {
  if (e[0] !== "#") return ENT[e.toLowerCase()] ?? m;
  const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return Number.isInteger(cp) && cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : " ";
});
export const text = html => decode(String(html)
    .replace(/<(script|style|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]*>/g, " "))
  .split("\n").map(l => l.replace(/[ \t\r\f\v]+/g, " ").trim()).filter(Boolean).join("\n");

export function parseTables(html) {
  const out = [];
  const re = /<table[\s\S]*?<\/table>/gi;
  let m;
  while ((m = re.exec(html))) {
    const before = html.slice(Math.max(0, m.index - 1500), m.index);
    const heads = [...before.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)];
    const heading = heads.length ? text(heads[heads.length - 1][1]) : "";
    const rows = [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)]
      .map(r => [...r[0].matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(c => ({ th: c[1].toLowerCase() === "h", v: text(c[2]) })));
    if (!rows.length) continue;
    const hi = rows.findIndex(r => r.length && r.every(c => c.th));
    const headers = (hi >= 0 ? rows[hi] : rows[0]).map(c => c.v.toLowerCase());
    const body = rows.slice((hi >= 0 ? hi : 0) + 1).filter(r => r.length && !r.every(c => c.th)).map(r => r.map(c => c.v));
    out.push({ heading, headers, rows: body });
  }
  return out;
}

/* ---------- mapping ---------- */
const col = (hs, re, not) => hs.findIndex(x => re.test(x) && !(not && not.test(x)));
const cols = (hs, re, not) => hs.map((x, i) => (re.test(x) && !(not && not.test(x)) ? i : -1)).filter(i => i >= 0);
const num = v => { const m = String(v ?? "").replace(",", ".").match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
export const teamsOf = v => String(v || "").split(/\n|,|;| \/ | & /).map(s => s.trim()).filter(s => s && !/^[-–—]$/.test(s));

export function dayFrom(str) {
  const s = String(str || "").toLowerCase();
  const pick = n => EVENT_DAYS[Number(n)] || null;
  let m;
  if ((m = s.match(/2026-10-(\d{2})/))) return pick(m[1]);
  if ((m = s.match(/\b(\d{1,2})\s*(?:oct|octobre|october)\b/))) return pick(m[1]);
  if ((m = s.match(/\b(?:oct|october|octobre)\.?\s*(\d{1,2})\b/))) return pick(m[1]);
  if ((m = s.match(/\b(\d{1,2})\/10(?:\/2026)?\b/))) return pick(m[1]);
  if ((m = s.match(/\b(wed|thu|fri|sat|mer|jeu|ven|sam)/))) return pick(WEEKDAYS[m[1]]);
  if ((m = s.match(/\b(?:day|jour)\s*([123])\b/))) return pick(7 + Number(m[1]));
  return null;
}
/** Heure locale de l'événement (KST) au format HH:MM, ou null. */
export function timeFrom(str) {
  const m = String(str || "").match(/\b(\d{1,2})[:h](\d{2})\s*(am|pm)?/i);
  if (!m) return null;
  let hr = Number(m[1]);
  const ap = (m[3] || "").toLowerCase();
  if (ap === "pm" && hr < 12) hr += 12;
  if (ap === "am" && hr === 12) hr = 0;
  if (hr > 23 || Number(m[2]) > 59) return null;
  return `${String(hr).padStart(2, "0")}:${m[2]}`;
}
export function fieldFrom(str) {
  const s = String(str || "").toLowerCase();
  if (!s) return null;
  const m = s.match(/(\d+)/);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 5) return `t${m[1]}`;
  if (/main|center|centre|arena|principal/.test(s)) return "g";
  return null;
}

export function mapRankings(tb) {
  const hs = tb.headers, iT = col(hs, /team|country|nation|équipe|pays/);
  if (iT < 0 || col(hs, /rank/) < 0) return null;
  const iR = col(hs, /^(rank|#|pos)/, /score/), iS = col(hs, /ranking score|^score|avg|average/), iH = col(hs, /highest|high/), iC = col(hs, /climb/), iP = col(hs, /played|matches|^mp$/);
  return tb.rows.map((r, k) => ({
    rank: iR >= 0 ? num(r[iR]) : k + 1, team: r[iT], score: iS >= 0 ? num(r[iS]) : null,
    high: iH >= 0 ? num(r[iH]) : null, climb: iC >= 0 ? num(r[iC]) : null, played: iP >= 0 ? num(r[iP]) : null
  })).filter(x => x.team);
}

export function mapMatches(tb) {
  const hs = tb.headers;
  const red = cols(hs, /red|rouge/, /score|pts|points/), blue = cols(hs, /blue|bleu/, /score|pts|points/);
  const iN = col(hs, /^(match|#|no\.?|n°|num)/, /time|score/);
  if (!(red.length && blue.length)) return null;
  const iTime = col(hs, /time|start|sched|heure/), iDate = col(hs, /date|day|jour/), iF = col(hs, /field|court|terrain/);
  const iRS = col(hs, /(red|rouge).*(score|pts|points)|(score|pts|points).*(red|rouge)/);
  const iBS = col(hs, /(blue|bleu).*(score|pts|points)|(score|pts|points).*(blue|bleu)/);
  const iSc = col(hs, /score|result|résultat/, /red|blue|rouge|bleu/);
  const tableDay = dayFrom(tb.heading);
  return tb.rows.map(r => {
    let sr = iRS >= 0 ? num(r[iRS]) : null, sb = iBS >= 0 ? num(r[iBS]) : null;
    if ((sr === null || sb === null) && iSc >= 0) {
      const m = String(r[iSc] || "").match(/(\d+)\s*[-–:]\s*(\d+)/);
      if (m) { sr = Number(m[1]); sb = Number(m[2]); }
    }
    const timeCell = iTime >= 0 ? r[iTime] : "", dateCell = iDate >= 0 ? r[iDate] : "";
    return {
      n: iN >= 0 ? (String(r[iN]).match(/[A-Z]?\d+/i) || [r[iN]])[0] : null,
      day: dayFrom(dateCell) || dayFrom(timeCell) || tableDay,
      kst: timeFrom(timeCell) || timeFrom(dateCell),
      time: timeCell || dateCell || null,
      field: fieldFrom(iF >= 0 ? r[iF] : ""),
      red: red.flatMap(i => teamsOf(r[i])), blue: blue.flatMap(i => teamsOf(r[i])), sr, sb
    };
  }).filter(m => m.red.length || m.blue.length);
}

/* ---------- données Next.js (__NEXT_DATA__) ---------- */
const NEXT_RE = /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;
/** Objet `props.pageProps.data` du bloc __NEXT_DATA__, ou null. */
export function nextData(html) {
  const m = NEXT_RE.exec(String(html));
  if (!m) return null;
  try {
    const d = JSON.parse(m[1])?.props?.pageProps?.data;
    return d && typeof d === "object" && !Array.isArray(d) ? d : null;
  } catch { return null; }
}
/** Valeur du premier champ présent (noms comparés sans casse). */
function pick(o, names) {
  if (!o || typeof o !== "object") return null;
  const keys = Object.keys(o);
  for (const n of names) {
    const k = keys.find(x => x.toLowerCase() === n.toLowerCase());
    if (k !== undefined && o[k] !== null && o[k] !== "") return o[k];
  }
  return null;
}
const teamCode = p => {
  const v = pick(p, ["country", "countryCode", "team", "teamName", "name"]);
  return v && typeof v === "object" ? teamCode(v) : v;
};
/** Date et heure de Corée (UTC+9, sans heure d'été) d'un horodatage ISO. */
export function kstOf(iso) {
  const ms = Date.parse(String(iso || ""));
  if (!Number.isFinite(ms)) return { day: null, kst: null };
  const k = new Date(ms + 9 * 3600e3).toISOString();
  return { day: k.slice(0, 10), kst: k.slice(11, 16) };
}
/** Convertit les données Next.js au format de data.json. */
export function fromNextData(d) {
  const matches = [];
  for (const [key, prefix] of [["matches", ""], ["round_robin", "P"], ["finals", "F"]]) {
    for (const m of Array.isArray(d[key]) ? d[key] : []) {
      if (!m || typeof m !== "object" || !Array.isArray(m.participants)) continue;
      const ps = m.participants.filter(p => p && typeof p === "object" && Number.isFinite(p.station)).sort((a, b) => a.station - b.station);
      const red = ps.filter(p => p.station >= 10 && p.station < 20).map(teamCode).filter(Boolean);
      const blue = ps.filter(p => p.station >= 20 && p.station < 30).map(teamCode).filter(Boolean);
      const num = String(m.name || "").match(/(\d+)\s*$/)?.[1] ?? m.id;
      const field = Number(m.field);
      const { day, kst } = kstOf(m.scheduledTime);
      const played = m.played === true || m.played === 1;
      matches.push({
        n: num === undefined || num === null ? null : `${prefix}${num}`, day, kst, time: null,
        field: Number.isInteger(field) && field >= 1 && field <= 5 ? `t${field}` : null,
        red, blue, sr: played ? m.redScore : null, sb: played ? m.blueScore : null
      });
    }
  }
  const rankings = (Array.isArray(d.rankings) ? d.rankings : []).map((r, i) => ({
    rank: pick(r, ["rank", "ranking", "position"]) ?? i + 1,
    team: teamCode(r),
    score: pick(r, ["rankingScore", "ranking_score", "rankingPoints", "score", "average"]),
    high: pick(r, ["highestPoints", "highest_points", "highestScore", "highScore", "high"]),
    climb: pick(r, ["climbPoints", "climb_points", "climb"]),
    played: pick(r, ["played", "matchesPlayed", "matches_played"])
  })).filter(x => x.team);
  return { rankings, matches };
}

/** Extrait classement et matchs d'une liste de pages HTML. */
export function extract(pages) {
  for (const p of pages) {
    const d = nextData(p);
    if (d) return fromNextData(d);
  }
  let rankings = [];
  const matches = [];
  for (const tb of pages.flatMap(parseTables)) {
    const rk = mapRankings(tb);
    if (rk) { if (rk.length > rankings.length) rankings = rk; continue; }
    const mt = mapMatches(tb);
    if (mt) matches.push(...mt);
  }
  const key = m => `${m.day || ""}|${m.n || ""}|${m.red.join("+")}|${m.blue.join("+")}`;
  return { rankings, matches: [...new Map(matches.map(m => [key(m), m])).values()] };
}

/** Fusionne avec l'existant : ne remplace jamais des données publiées par du vide. */
export function merge(prev, found) {
  const p = validateData(prev);
  const prevDay = new Map(p.matches.filter(m => m.n).map(m => [`${m.n}|${m.red.join("+")}`, m.day]));
  const matches = found.matches.map(m => ({ ...m, day: m.day || prevDay.get(`${m.n}|${m.red.join("+")}`) || null }));
  const next = validateData({ updated: p.updated, rankings: found.rankings, matches });
  return {
    rankings: next.rankings.length ? next.rankings : p.rankings,
    matches: next.matches.length ? next.matches : p.matches,
    prev: p
  };
}

/* ---------- réseau ---------- */
async function get(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.hostname !== ALLOWED_HOST) throw new Error(`URL refusée : ${url}`);
  const r = await fetch(u, { headers: { "user-agent": "fgc2026-viewer/1.0 (+github-actions)", accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (new URL(r.url).hostname !== ALLOWED_HOST) throw new Error(`redirection hors domaine : ${r.url}`);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  if (Number(r.headers.get("content-length") || 0) > MAX_BYTES) throw new Error("réponse trop grosse");
  const body = await r.text();
  if (body.length > MAX_BYTES) throw new Error("réponse trop grosse");
  return body;
}

async function collect(file) {
  if (file) return [await readFile(file, "utf8")];
  const home = await get(BASE);
  if (nextData(home)) return [home];          // tout est dans la page d'accueil
  const pages = [home], seen = new Set([BASE]);
  for (const m of home.matchAll(/<a\b[^>]*\bhref="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    let u;
    try { u = new URL(decode(m[1]), BASE); } catch { continue; }
    if (u.hostname !== ALLOWED_HOST || u.protocol !== "https:" || seen.has(u.href)) continue;
    if (!/match|rank|result|schedule|standing/i.test(`${u.pathname} ${text(m[2])}`)) continue;
    seen.add(u.href);
    if (seen.size > MAX_PAGES) break;
    try { pages.push(await get(u.href)); } catch (e) { console.warn("ignorée :", e.message); }
  }
  return pages;
}

export async function run({ out = "data.json", file } = {}) {
  let prev = null;
  try { prev = JSON.parse(await readFile(out, "utf8")); } catch { /* premier passage */ }
  let pages;
  try { pages = await collect(file); } catch (e) { console.warn("Source injoignable :", e.message); return { changed: false }; }
  const { rankings, matches, prev: p } = merge(prev, extract(pages));
  const changed = JSON.stringify(rankings) !== JSON.stringify(p.rankings) || JSON.stringify(matches) !== JSON.stringify(p.matches);
  if (!changed) { console.log("Aucun changement."); return { changed: false }; }
  const data = { updated: new Date().toISOString(), source: BASE, teams: TEAM_CODES, rankings, matches };
  const tmp = `${out}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 1)}\n`, { mode: 0o644 });
  await rename(tmp, out);
  console.log(`data.json mis à jour : ${rankings.length} équipes classées, ${matches.length} matchs.`);
  return { changed: true, data };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2), arg = k => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
  run({ out: arg("out") || "data.json", file: arg("file") }).catch(e => { console.error(e); process.exitCode = 1; });
}
