import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTables, extract, merge, dayFrom, timeFrom, fieldFrom, text, run } from "../../scripts/scrape.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "../fixtures/results.html");

test("text() retire balises et scripts, décode les entités", () => {
  assert.equal(text("a<br>b&#39;c<script>alert(1)</script>"), "a\nb'c");
  assert.equal(text("&#x110000;x"), "x");
});

test("helpers de date, heure et terrain", () => {
  assert.equal(dayFrom("Thursday 8 Oct"), "2026-10-08");
  assert.equal(dayFrom("Oct 10"), "2026-10-10");
  assert.equal(dayFrom("Fri"), "2026-10-09");
  assert.equal(dayFrom("Day 1"), "2026-10-08");
  assert.equal(dayFrom("12 Oct"), null);
  assert.equal(timeFrom("2:15 PM"), "14:15");
  assert.equal(timeFrom("12:05 am"), "00:05");
  assert.equal(timeFrom("99:99"), null);
  assert.equal(fieldFrom("Field 3"), "t3");
  assert.equal(fieldFrom("Main field"), "g");
  assert.equal(fieldFrom("Field 9"), null);
});

test("extraction complète de la page d'exemple", async () => {
  const html = await readFile(fixture, "utf8");
  assert.equal(parseTables(html).length, 4);
  const { rankings, matches } = extract([html]);
  assert.equal(rankings.length, 3);
  assert.deepEqual(rankings[1], { rank: 2, team: "France", score: 198, high: 240, climb: 70, played: 4 });
  assert.equal(rankings[2].team, "<img src=x onerror=alert(1)>", "texte brut, jamais interprété");
  assert.equal(matches.length, 4);
  const q1 = matches.find(m => m.n === "Q1");
  assert.deepEqual(q1, { n: "Q1", day: "2026-10-08", kst: "11:05", time: "11:05", field: "t2", red: ["France", "Kenya", "Côte d'Ivoire"], blue: ["Japan", "Brazil", "Chile"], sr: 120, sb: 95 });
  const q2 = matches.find(m => m.n === "Q2");
  assert.equal(q2.kst, "14:15");
  assert.equal(q2.field, "t5");
  const q3 = matches.find(m => m.n === "Q3");
  assert.equal(q3.kst, null);
  assert.equal(q3.field, null);
  assert.deepEqual(q3.red, ["A"], "le contenu <script> est supprimé");
  const m40 = matches.find(m => m.n === "40");
  assert.equal(m40.day, "2026-10-09");
  assert.equal(m40.kst, "09:20");
  assert.equal(m40.field, "g");
  assert.deepEqual([m40.sr, m40.sb], [88, 101]);
});

test("merge : une source vide ne remplace jamais des données publiées", () => {
  const prev = { updated: "2026-10-08T02:00:00Z", rankings: [{ rank: 1, team: "France" }], matches: [{ n: "1", day: "2026-10-08", red: ["A"], blue: ["B"] }] };
  const r = merge(prev, { rankings: [], matches: [] });
  assert.equal(r.rankings.length, 1);
  assert.equal(r.matches.length, 1);
});

test("merge : un match sans date garde la date déjà connue", () => {
  const prev = { matches: [{ n: "7", day: "2026-10-09", red: ["A"], blue: ["B"] }] };
  const r = merge(prev, { rankings: [], matches: [{ n: "7", day: null, kst: "10:00", time: null, field: "t1", red: ["A"], blue: ["B"], sr: 1, sb: 2 }] });
  assert.equal(r.matches[0].day, "2026-10-09");
  assert.equal(r.matches[0].sr, 1);
});

test("run() écrit un data.json valide puis ne réécrit pas sans changement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fgc-"));
  const out = join(dir, "data.json");
  try {
    await writeFile(out, JSON.stringify({ updated: null, rankings: [], matches: [] }));
    const first = await run({ out, file: fixture });
    assert.equal(first.changed, true);
    const saved = JSON.parse(await readFile(out, "utf8"));
    assert.equal(saved.rankings.length, 3);
    assert.equal(saved.matches.length, 4);
    assert.ok(!Number.isNaN(Date.parse(saved.updated)));
    const second = await run({ out, file: fixture });
    assert.equal(second.changed, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------- Données Next.js (format réel de results.first.global) ---------- */
import { nextData, fromNextData, kstOf } from "../../scripts/scrape.mjs";
const nextFixture = join(here, "../fixtures/next.html");

test("kstOf convertit en heure de Corée", () => {
  assert.deepEqual(kstOf("2026-10-08T11:15:00.900+09:00"), { day: "2026-10-08", kst: "11:15" });
  assert.deepEqual(kstOf("2026-10-09T00:30:00Z"), { day: "2026-10-09", kst: "09:30" });
  assert.deepEqual(kstOf("pas une date"), { day: null, kst: null });
});

test("nextData lit le bloc __NEXT_DATA__ et ignore un JSON invalide", async () => {
  const html = await readFile(nextFixture, "utf8");
  assert.ok(Array.isArray(nextData(html).matches));
  assert.equal(nextData('<script id="__NEXT_DATA__">{oops</script>'), null);
  assert.equal(nextData("<p>rien</p>"), null);
});

test("extract privilégie __NEXT_DATA__ : matchs, playoffs et classement", async () => {
  const { rankings, matches } = extract([await readFile(nextFixture, "utf8")]);
  assert.equal(matches.length, 3, "le match sans participants valides est ignoré");
  assert.deepEqual(matches[0], { n: "1", day: "2026-10-08", kst: "11:15", time: null, field: "t1", red: ["SLE", "ARU", "FRA"], blue: ["ANG", "SRB", "NOR"], sr: 152, sb: 131 });
  assert.equal(matches[1].field, null, "terrain hors 1–5 refusé");
  assert.equal(matches[1].sr, null, "pas de score tant que le match n'est pas joué");
  assert.equal(matches[1].red[0], "<img src=x onerror=alert(1)>", "texte brut, jamais interprété");
  assert.equal(matches[2].n, "P4");
  assert.equal(matches[2].red.length, 4);
  assert.deepEqual(rankings[0], { rank: 1, team: "FRA", score: 198.5, high: 240, climb: 70, played: 4 });
  assert.equal(rankings[1].team, "JPN");
  assert.equal(rankings[1].rank, 2);
});

test("run() sur le format Next.js écrit les codes pays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fgc-"));
  const out = join(dir, "data.json");
  try {
    const r = await run({ out, file: nextFixture });
    assert.equal(r.changed, true);
    const saved = JSON.parse(await readFile(out, "utf8"));
    assert.equal(saved.teams.FRA, "France");
    assert.equal(saved.matches.length, 3);
    assert.equal(saved.rankings[0].team, "FRA");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
