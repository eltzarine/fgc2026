/**
 * Configuration de l'événement. Heures en heure de Corée (KST, UTC+9),
 * d'après le planning de diffusion officiel FGC 2026.
 */

/** @typedef {{ s: string, e: string, t: string, pause: boolean }} Session */
/** @typedef {{ key: string, date: string, n?: number, sub?: string, ceremony?: boolean,
 *  streams: Record<string, string>, sessions: Session[] }} Day */

export const DATA_URL = "data.json";
export const DATA_REFRESH_MS = 120_000;
export const BROADCAST_SHEET = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQnnmQH3TA9yWFgs806rW_HTFl1uorje-2yI7A5SqlPKgwlIl2GUx0_Pd4otcgzh1v5H7TXEjUC1wzR/pubhtml?gid=74336431&single=true";
export const YT_ID = /^[A-Za-z0-9_-]{11}$/;
export const FIELD_IDS = Object.freeze(["g", "t1", "t2", "t3", "t4", "t5"]);
export const KST_TZ = "Asia/Seoul";

/** @param {[string,string,string][]} list @returns {Session[]} */
const sessions = list => list.map(([s, e, t]) => Object.freeze({ s, e, t, pause: t === "sLunch" }));

/** @type {readonly Day[]} */
export const DAYS = Object.freeze([
  { key: "ouverture", date: "2026-10-07", ceremony: true,
    streams: { g: "CUUvTeXDERo" },
    sessions: sessions([["18:30", "20:30", "sCeremony"]]) },
  { key: "jour1", date: "2026-10-08", n: 1, sub: "subQual",
    streams: { t1: "OYWoZl6scbM", t2: "jJ5DHNJrpc4", t3: "-jA1YanHcB8", t4: "C7MIYhOdYS4", t5: "rQO7Ml3pYxk", g: "2giQLSlMOgo" },
    sessions: sessions([["11:00", "13:00", "sRank"], ["13:00", "14:00", "sLunch"], ["14:00", "17:30", "sRank"]]) },
  { key: "jour2", date: "2026-10-09", n: 2, sub: "subQual",
    streams: { t1: "tkQpTnlTcu8", t2: "F_kvVyXWrZU", t3: "YNKPPyYxfJM", t4: "ZkFxxa22V5g", t5: "onEdqqlQjaQ", g: "UekLwTOuNUU" },
    sessions: sessions([["09:00", "13:00", "sRank"], ["13:00", "14:00", "sLunch"], ["14:00", "17:00", "sRank"]]) },
  { key: "jour3", date: "2026-10-10", n: 3, sub: "subFinal",
    streams: { t1: "jKX6kQnTp7g", t2: "P4tHKmWGoS0", t3: "3H32iaSLciE", t4: "u9lpqA9azkM", t5: "-zWoaHmeZ38", g: "juiOD0SCK9Q" },
    sessions: sessions([["09:00", "12:30", "sRankLast"], ["12:30", "14:00", "sLunch"], ["14:00", "16:00", "sPlayoffs"], ["16:00", "18:00", "sFinal"]]) }
].map(d => Object.freeze({ ...d, streams: Object.freeze(d.streams) })));

export const EVENT_DATES = Object.freeze(DAYS.map(d => d.date));
