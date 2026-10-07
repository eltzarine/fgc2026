import { test } from "node:test";
import assert from "node:assert/strict";
import { validateData, cleanStr, cleanNum, LIMITS } from "../../js/data.js";

test("entrées invalides → structure vide, sans exception", () => {
  for (const v of [null, undefined, 42, "x", [], { rankings: "no", matches: 5 }]) {
    assert.deepEqual(validateData(v), { updated: null, rankings: [], matches: [], teams: {} });
  }
});

test("cleanStr retire les caractères de contrôle et borne la longueur", () => {
  assert.equal(cleanStr("  Fr\u0000an‮ce \n"), "Fr an ce");
  assert.equal(cleanStr("x".repeat(500)).length, LIMITS.team);
  assert.equal(cleanStr({}), null);
  assert.equal(cleanStr("   "), null);
});

test("cleanNum n'accepte que des nombres finis raisonnables", () => {
  assert.equal(cleanNum("12,5"), 12.5);
  assert.equal(cleanNum(Infinity), null);
  assert.equal(cleanNum("abc"), null);
  assert.equal(cleanNum(1e9), null);
  assert.equal(cleanNum(""), null);
  assert.equal(cleanNum(0), 0);
});

test("matchs : champs hors liste rejetés, chaînes conservées en texte", () => {
  const d = validateData({
    updated: "2026-10-08T02:00:00Z",
    matches: [
      { n: "Q1", day: "2026-10-08", kst: "11:05", field: "t2", red: ["<img src=x onerror=alert(1)>"], blue: ["Japan"], sr: 1, sb: "2" },
      { n: "Q2", day: "1999-01-01", kst: "25:00", field: "javascript:alert(1)", red: ["A"], blue: [], sr: "x", sb: null },
      { n: "Q3", red: [], blue: [] },
      "garbage"
    ]
  });
  assert.equal(d.updated, "2026-10-08T02:00:00.000Z");
  assert.equal(d.matches.length, 2);
  assert.deepEqual(d.matches[0].red, ["<img src=x onerror=alert(1)>"]);
  assert.equal(d.matches[0].sb, 2);
  assert.equal(d.matches[1].day, null);
  assert.equal(d.matches[1].kst, null);
  assert.equal(d.matches[1].field, null);
  assert.equal(d.matches[1].sr, null);
});

test("ancien format { jour1: [...] } converti avec la bonne date", () => {
  const d = validateData({ matches: { jour2: [{ n: "1", red: ["A"], blue: ["B"] }], hack: [{ red: ["C"] }] } });
  assert.equal(d.matches.length, 1);
  assert.equal(d.matches[0].day, "2026-10-09");
});

test("volumes bornés", () => {
  const big = { rankings: Array.from({ length: 1000 }, (_, i) => ({ team: `T${i}` })), matches: Array.from({ length: 5000 }, () => ({ red: ["A", "B", "C", "D", "E", "F"], blue: ["X"] })) };
  const d = validateData(big);
  assert.equal(d.rankings.length, LIMITS.rankings);
  assert.equal(d.matches.length, LIMITS.matches);
  assert.equal(d.matches[0].red.length, LIMITS.teamsPerSide);
});

test("date de mise à jour invalide ignorée", () => {
  assert.equal(validateData({ updated: "pas une date" }).updated, null);
});

test("validateData garde la table des codes pays et rejette les clés invalides", () => {
  const d = validateData({ teams: { FRA: "France", "bad key": "x", JPN: 5, KEN: "" } });
  assert.deepEqual(d.teams, { FRA: "France", JPN: "5" });
  assert.deepEqual(validateData(null).teams, {});
});
