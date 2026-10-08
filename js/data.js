/**
 * Validation stricte de data.json (partagée par la page et le collecteur).
 * Toute donnée externe passe ici : types vérifiés, longueurs bornées,
 * valeurs hors liste rejetées. Rien n'est jamais interprété comme du HTML.
 */

/** @typedef {{ rank: number|null, team: string, score: number|null, high: number|null, climb: number|null, played: number|null }} Ranking */
/** @typedef {{ n: string|null, day: string|null, kst: string|null, time: string|null, field: string|null, red: string[], blue: string[], sr: number|null, sb: number|null }} Match */
/** @typedef {{ updated: string|null, source?: string, rankings: Ranking[], matches: Match[], teams: Record<string,string> }} Data */

export const LIMITS = Object.freeze({ rankings: 300, matches: 3000, teamsPerSide: 4, team: 60, n: 12, time: 40 });
const FIELDS = new Set(["g", "t1", "t2", "t3", "t4", "t5"]);
const DATES = new Set(["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"]);
const LEGACY_DAYS = Object.freeze({ jour1: "2026-10-08", jour2: "2026-10-09", jour3: "2026-10-10" });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Chaîne nettoyée (caractères de contrôle retirés, longueur bornée) ou null.
 * @param {unknown} v @param {number} [max] @returns {string|null}
 */
export function cleanStr(v, max = LIMITS.team) {
  if (typeof v !== "string" && typeof v !== "number") return null;
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return s || null;
}
/** Nombre fini raisonnable ou null. */
export function cleanNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) && Math.abs(n) < 1e6 ? Math.round(n * 100) / 100 : null;
}
const cleanTeams = v => (Array.isArray(v) ? v : []).slice(0, LIMITS.teamsPerSide).map(x => cleanStr(x)).filter(Boolean);

/** @returns {Ranking|null} */
export function cleanRanking(r) {
  if (!r || typeof r !== "object") return null;
  const team = cleanStr(r.team);
  if (!team) return null;
  return { rank: cleanNum(r.rank), team, score: cleanNum(r.score), high: cleanNum(r.high), climb: cleanNum(r.climb), played: cleanNum(r.played) };
}

/** @returns {Match|null} */
export function cleanMatch(m) {
  if (!m || typeof m !== "object") return null;
  const red = cleanTeams(m.red), blue = cleanTeams(m.blue);
  if (!red.length && !blue.length) return null;
  const day = typeof m.day === "string" && DATES.has(m.day) ? m.day : null;
  const kst = typeof m.kst === "string" && HHMM.test(m.kst) ? m.kst : null;
  const field = typeof m.field === "string" && FIELDS.has(m.field) ? m.field : null;
  return { n: cleanStr(m.n, LIMITS.n), day, kst, time: cleanStr(m.time, LIMITS.time), field, red, blue, sr: cleanNum(m.sr), sb: cleanNum(m.sb) };
}

/**
 * Classement du premier au dernier : rang croissant, équipes sans rang à la fin.
 * À rang égal (ou sans rang) : meilleur score, puis ordre alphabétique.
 * @param {Ranking[]} list @returns {Ranking[]}
 */
export function sortRankings(list) {
  const key = v => (v === null ? Infinity : v);
  return [...list].sort((a, b) => key(a.rank) - key(b.rank)
    || (b.score ?? -Infinity) - (a.score ?? -Infinity)
    || a.team.localeCompare(b.team));
}

/** Valide un objet data.json quelconque. Ne lève jamais d'exception. @returns {Data} */
export function validateData(j) {
  /** @type {Data} */
  const out = { updated: null, rankings: [], matches: [], teams: {} };
  if (!j || typeof j !== "object" || Array.isArray(j)) return out;
  /* Codes pays officiels (FRA…) → noms complets */
  if (j.teams && typeof j.teams === "object" && !Array.isArray(j.teams)) {
    for (const [k, v] of Object.entries(j.teams).slice(0, LIMITS.rankings)) {
      const code = cleanStr(k, 8), name = cleanStr(v);
      if (code && name && /^[A-Z0-9]{2,8}$/.test(code)) out.teams[code] = name;
    }
  }
  if (typeof j.updated === "string" && !Number.isNaN(Date.parse(j.updated))) out.updated = new Date(j.updated).toISOString();
  if (Array.isArray(j.rankings)) out.rankings = sortRankings(j.rankings.slice(0, LIMITS.rankings).map(cleanRanking).filter(Boolean));
  let raw = [];
  if (Array.isArray(j.matches)) raw = j.matches;
  else if (j.matches && typeof j.matches === "object") {           // ancien format { jour1: [...] }
    for (const [k, arr] of Object.entries(j.matches)) {
      if (LEGACY_DAYS[k] && Array.isArray(arr)) raw.push(...arr.map(m => ({ ...m, day: m?.day ?? LEGACY_DAYS[k] })));
    }
  }
  out.matches = raw.slice(0, LIMITS.matches).map(cleanMatch).filter(Boolean);
  return out;
}
