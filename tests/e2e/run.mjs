#!/usr/bin/env node
/**
 * Tests de bout en bout (Playwright + Chromium).
 * Usage : node tests/e2e/run.mjs
 *   PLAYWRIGHT_MODULE=/chemin/vers/playwright/index.mjs pour un Playwright installé ailleurs.
 * Le site est copié dans un dossier temporaire avec un data.json d'essai, puis servi en local.
 * Les hôtes externes (polices, YouTube) sont simulés : aucun accès réseau réel.
 */
import assert from "node:assert/strict";
import { cp, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../../tools/serve.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

/* ---------- préparation ---------- */
const site = await mkdtemp(join(tmpdir(), "fgc-e2e-"));
await cp(root, site, { recursive: true, filter: src => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) });
await cp(join(root, "tests/fixtures/data.e2e.json"), join(site, "data.json"));
const artifactHtml = await readFile(join(root, "dist/artifact.html"), "utf8");
await writeFile(join(site, "artifact.html"), `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>\n${artifactHtml}\n</body></html>`);
const server = await startServer(site, 0);
const addr = server.address();
const BASE = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}/`;
const browser = await chromium.launch();

/* ---------- mini-lanceur ---------- */
const results = [];
async function newCtx(opts = {}) {
  const ctx = await browser.newContext({ locale: "fr-FR", timezoneId: "Europe/Paris", viewport: { width: 1280, height: 900 }, serviceWorkers: "block", ...opts });
  await ctx.route(/https:\/\/fonts\.googleapis\.com\/.*/, r => r.fulfill({ status: 200, contentType: "text/css", headers: { "access-control-allow-origin": "*" }, body: "/* polices simulées */" }));
  await ctx.route(/https:\/\/fonts\.gstatic\.com\/.*/, r => r.fulfill({ status: 404, body: "" }));
  await ctx.route(/https:\/\/www\.youtube-nocookie\.com\/.*/, r => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>yt</title>" }));
  return ctx;
}
/** Ouvre une page et collecte erreurs JS, erreurs console et violations CSP. */
async function open(ctx, path = "") {
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(`pageerror: ${e.message}`));
  page.on("console", m => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("dialog", d => { errors.push(`dialog: ${d.message()}`); d.dismiss(); });
  await page.goto(BASE + path, { waitUntil: "load" });
  await page.waitForSelector("#cal .day", { state: "attached" });
  return { page, errors };
}
async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log(`  ✓ ${name}`); }
  catch (e) { results.push({ name, ok: false, ms: Date.now() - t0, err: e }); console.log(`  ✗ ${name}\n    ${String(e?.message || e).split("\n").slice(0, 6).join("\n    ")}`); }
}
const text = (page, sel) => page.locator(sel).first().innerText();

/* ---------- contraste WCAG ---------- */
function contrastFn() {
  /* exécuté dans la page */
  const parse = c => { const n = (c.match(/[\d.]+/g) || []).map(Number); return c.startsWith("color(") ? [n[0] * 255, n[1] * 255, n[2] * 255, n[3]] : n; };
  const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = el => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c.length >= 3 && (c[3] === undefined || c[3] > 0.5)) return c; } return parse(getComputedStyle(document.body).backgroundColor); };
  return sel => [...document.querySelectorAll(sel)].filter(el => el.offsetParent && el.textContent.trim()).map(el => {
    const fg = parse(getComputedStyle(el).color), bg = bgOf(el);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return { sel, text: el.textContent.trim().slice(0, 30), ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 };
  });
}

console.log(`\nE2E sur ${BASE}\n`);

/* 1 */ await test("chargement sans erreur JS, console ni violation CSP", async () => {
  const ctx = await newCtx(); const { page, errors } = await open(ctx, "#jour1");
  assert.equal(await page.title(), "FGC 2026 Incheon");
  assert.equal(await text(page, "h1"), "Incheon 2026");
  await page.waitForTimeout(300);
  assert.deepEqual(errors, []);
  await ctx.close();
});

/* 2 */ await test("statique : CSP stricte, aucun script en ligne, liens externes protégés", async () => {
  const html = await readFile(join(root, "index.html"), "utf8");
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self';/);
  assert.match(html, /require-trusted-types-for 'script'; trusted-types fgc-sw/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, "script en ligne interdit");
  assert.doesNotMatch(html, /\son[a-z]+=/i, "attribut on* interdit");
  assert.doesNotMatch(html, /\sstyle=/i, "attribut style interdit");
  const ctx = await newCtx(); const { page } = await open(ctx, "#jour1");
  const bad = await page.$$eval("a[target=_blank]", as => as.filter(a => !/noopener/.test(a.rel) || !/noreferrer/.test(a.rel)).map(a => a.href));
  assert.deepEqual(bad, []);
  await ctx.close();
});

/* 3 */ await test("langue : FR par défaut, bascule EN complète et mémorisée", async () => {
  const ctx = await newCtx(); const { page, errors } = await open(ctx, "#jour1");
  assert.equal(await text(page, "#vLive"), "Direct & calendrier");
  assert.equal(await page.getAttribute("html", "lang"), "fr");
  await page.click("#lnEn");
  assert.equal(await text(page, "#vLive"), "Live & calendar");
  assert.equal(await page.getAttribute("html", "lang"), "en");
  assert.equal(await page.getAttribute("#lnEn", "aria-pressed"), "true");
  assert.match(await text(page, "#dayTitle"), /^Day 1 · Qualifications$/);
  await page.click("#vRules");
  assert.ok(await page.locator('[data-only="en"]').first().isVisible());
  assert.ok(!(await page.locator('[data-only="fr"]').first().isVisible()));
  await page.reload(); await page.waitForSelector("#cal .day", { state: "attached" });
  assert.equal(await text(page, "#vLive"), "Live & calendar");
  assert.deepEqual(errors, []);
  await ctx.close();
});

/* 4 */ await test("langue : navigateur anglais → EN par défaut", async () => {
  const ctx = await newCtx({ locale: "en-US" }); const { page } = await open(ctx, "#jour1");
  assert.equal(await page.getAttribute("html", "lang"), "en");
  await ctx.close();
});

/* 5 */ await test("calendrier : onglets, hash et navigation clavier", async () => {
  const ctx = await newCtx(); const { page, errors } = await open(ctx, "#jour2");
  assert.equal(await text(page, "#dayTitle"), "Jour 2 · Qualifications");
  assert.equal(await page.locator('#cal [aria-selected="true"]').count(), 1);
  await page.click('#cal [data-k="jour3"]');
  assert.equal(await text(page, "#dayTitle"), "Jour 3 · Playoffs & finale");
  assert.equal(new URL(page.url()).hash, "#jour3");
  await page.focus("#tab-jour3"); await page.keyboard.press("ArrowRight");
  assert.equal(await text(page, "#dayTitle"), "Cérémonie d'ouverture");
  assert.match(await text(page, "#tab-ouverture"), /ouverture · cérémonie/i);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "tab-ouverture");
  await page.keyboard.press("End");
  assert.equal(new URL(page.url()).hash, "#jour3");
  assert.deepEqual(errors, []);
  await ctx.close();
});

/* 6 */ await test("fuseaux : Paris ⇄ Corée au clic, autre fuseau avec décalage de date", async () => {
  const ctx = await newCtx(); const { page, errors } = await open(ctx, "#jour1");
  const first = () => text(page, "#timeline li:first-child .tzb");
  assert.equal(await first(), "04:00–06:00");
  await page.click("#timeline li:first-child .tzb");
  assert.equal(await first(), "11:00–13:00");
  assert.equal(await page.getAttribute("#clkKstBtn", "aria-pressed"), "true");
  await page.click("#clkKstBtn");
  assert.equal(await first(), "04:00–06:00");
  await page.selectOption("#tzSelect", "America/New_York");
  assert.equal((await first()).replace(/\s+/g, " "), "22:00−1 j–00:00");
  await page.reload(); await page.waitForSelector("#cal .day");
  assert.equal(await page.inputValue("#tzSelect"), "America/New_York", "fuseau mémorisé");
  assert.deepEqual(errors, []);
  await ctx.close();
});

/* 7 */ await test("terrains : lecteur YouTube no-cookie, sandbox, pas de rechargement inutile", async () => {
  const ctx = await newCtx(); const { page, errors } = await open(ctx, "#jour1");
  await page.click('#fields [data-f="t3"]');
  const src = await page.getAttribute("#player iframe", "src");
  assert.ok(src.startsWith("https://www.youtube-nocookie.com/embed/-jA1YanHcB8"), src);
  assert.match(await page.getAttribute("#player iframe", "sandbox"), /allow-scripts/);
  assert.equal(await page.getAttribute('#fields [data-f="t3"]', "aria-pressed"), "true");
  await page.evaluate(() => { document.querySelector("#player iframe").dataset.mark = "1"; });
  await page.click("#lnEn"); await page.click("#timeline li:first-child .tzb");
  assert.equal(await page.getAttribute("#player iframe", "data-mark"), "1", "iframe conservée");
  assert.equal(await page.getAttribute("#ytLink", "href"), "https://www.youtube.com/watch?v=-jA1YanHcB8");
  assert.deepEqual(errors, []);
  await ctx.close();
});

/* 8 */ await test("données : validation, rendu en texte (XSS neutralisé), équipe suivie", async () => {
  const ctx = await newCtx(); const { page, errors } = await open(ctx, "#jour1");
  await page.waitForSelector("#matches .match");
  /* Seuls les matchs de l'équipe suivie (France par défaut) sont listés */
  assert.equal(await page.locator("#matches .match").count(), 1, "seul Q1 concerne la France le 8");
  assert.equal(await page.locator("#matches .match.mine").count(), 1);
  assert.equal(await text(page, "#matches .match .n"), "#Q1");
  assert.equal(await page.locator('#fields [data-f="t2"].mine').count(), 1);
  assert.equal(await text(page, "#sRank"), "2");
  assert.equal(await page.locator("#rankWrap tr.mine").count(), 1);
  assert.equal(await page.locator("#matches img, #matches svg[onload], #rankWrap img").count(), 0);
  assert.match(await text(page, "#rankWrap"), /<img src=x onerror="window.__xss=1">/);
  await page.locator("#matches .match.mine .linkbtn").click();
  assert.equal(await page.getAttribute('#fields [data-f="t2"]', "aria-pressed"), "true");
  assert.ok((await page.getAttribute("#player iframe", "src")).includes("jJ5DHNJrpc4"));
  assert.match(await text(page, "#matches .match.mine .h"), /^04:05/);
  assert.match(await text(page, "#status"), /Données auto/);
  /* Équipe d'un match piégé : le nom s'affiche en texte, rien n'est exécuté */
  await page.selectOption("#team", "Chad");
  assert.equal(await page.locator("#matches .match").count(), 1);
  assert.match(await text(page, "#matches"), /<svg onload="window.__xss=2">/);
  assert.equal(await page.locator("#matches svg[onload]").count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  /* Match sans heure valide ni terrain valide : pas de bouton Voir */
  await page.selectOption("#team", "Laos");
  assert.equal(await text(page, "#matches .match .n"), "#Q3");
  assert.equal(await page.locator("#matches .match .linkbtn").count(), 0, "terrain invalide → pas de bouton Voir");
  await page.click('#cal [data-k="jour2"]');
  assert.equal(await page.locator("#matches .match").count(), 1);
  /* Équipe sans match ce jour-là : message dédié */
  await page.selectOption("#team", "Japan");
  assert.match(await text(page, "#matches"), /Pas de match pour Japan/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

/* 9 */ await test("équipe suivie : liste déroulante complète, triée, mémorisée", async () => {
  const ctx = await newCtx(); const { page } = await open(ctx, "#jour1");
  await page.waitForSelector("#rankWrap table");
  assert.equal(await page.inputValue("#team"), "France", "France par défaut");
  const opts = await page.$$eval("#team option", os => os.map(o => o.value));
  assert.ok(opts.length >= 207, `${opts.length} équipes`);
  assert.ok(opts.includes("Korea (Republic of)") && opts.includes("Hope (Refugees)"));
  assert.deepEqual(opts, [...opts].sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" })), "liste triée");
  assert.equal(new Set(opts.map(o => o.toLowerCase())).size, opts.length, "sans doublon");
  assert.ok(opts.includes("<svg onload=\"window.__xss=2\">"), "nom inconnu issu des résultats ajouté (en texte)");
  assert.equal(await page.locator("#team option img, #team svg").count(), 0);
  await page.selectOption("#team", "Kenya");
  assert.equal(await text(page, "#sRank"), "1");
  assert.equal(await page.locator("#matches .match.mine").count(), 1);
  await page.reload(); await page.waitForSelector("#rankWrap table");
  assert.equal(await page.inputValue("#team"), "Kenya", "choix mémorisé");
  const box = await page.$eval("#team", el => ({ font: parseFloat(getComputedStyle(el).fontSize), h: el.getBoundingClientRect().height }));
  assert.ok(box.font >= 16 && box.h >= 40, "lisible et tactile");
  await ctx.close();
});

/* 10 */ await test("règles : onglet, calculateur conforme à l'exemple du manuel", async () => {
  const ctx = await newCtx(); const { page, errors } = await open(ctx, "#jour1");
  await page.click("#vRules");
  assert.equal(new URL(page.url()).hash, "#regles");
  assert.ok(await page.isVisible("#viewRules")); assert.ok(!(await page.isVisible("#viewLive")));
  assert.equal(await text(page, "#cTotal"), "178");
  await page.fill("#cBalls", "100"); await page.fill("#cExt", "0"); await page.uncheck("#cKnock");
  assert.equal(await text(page, "#cTotal"), "160");
  await page.fill("#cBalls", "-50"); assert.equal(await text(page, "#cTotal"), "0");
  await page.fill("#cBalls", "99999"); assert.equal(await text(page, "#cTotal"), "800");
  assert.match(await text(page, ".rtime"), /^07:00–09:00 \(Paris\)$/);
  await page.goto(BASE + "#regles"); await page.waitForSelector("#cal .day", { state: "attached" });
  assert.ok(await page.isVisible("#viewRules"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

/* 11 */ await test("robustesse : stockage local et hash piégés", async () => {
  const ctx = await newCtx();
  await ctx.addInitScript(() => {
    localStorage.setItem("fgc-tz", "Evil/<script>");
    localStorage.setItem("fgc-lang", "xx");
    localStorage.setItem("fgc-field", "zzz");
    localStorage.setItem("fgc-team", "x".repeat(5000));
  });
  const { page, errors } = await open(ctx, "#%3Cimg%20src=x%20onerror=alert(1)%3E");
  assert.ok(["Europe/Paris"].includes(await page.inputValue("#tzSelect")));
  assert.equal(await page.inputValue("#team"), "France", "valeur inconnue → France");
  assert.equal(await page.locator('#fields [aria-pressed="true"]').count() <= 1, true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

/* 12 */ await test("accessibilité : noms accessibles, libellés, identifiants uniques, onglets", async () => {
  const ctx = await newCtx(); const { page } = await open(ctx, "#jour1");
  await page.waitForSelector("#matches .match");
  for (const view of ["#vLive", "#vRules"]) {
    await page.click(view);
    const issues = await page.evaluate(() => {
      const out = [];
      const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      document.querySelectorAll("button, a[href]").forEach(el => { if (vis(el) && !(el.textContent.trim() || el.getAttribute("aria-label") || el.getAttribute("title"))) out.push(`sans nom: ${el.outerHTML.slice(0, 80)}`); });
      document.querySelectorAll("input, select, textarea").forEach(el => { if (!(el.labels?.length || el.getAttribute("aria-label"))) out.push(`sans libellé: #${el.id}`); });
      const ids = [...document.querySelectorAll("[id]")].map(e => e.id); const dup = ids.filter((x, i) => ids.indexOf(x) !== i); if (dup.length) out.push(`ids en double: ${dup}`);
      document.querySelectorAll("img").forEach(el => { if (!el.hasAttribute("alt")) out.push("img sans alt"); });
      document.querySelectorAll("[aria-labelledby]").forEach(el => el.getAttribute("aria-labelledby").split(" ").forEach(id => { if (!document.getElementById(id)) out.push(`aria-labelledby cassé: ${id}`); }));
      if (!document.querySelector("main")) out.push("pas de <main>");
      if (document.querySelectorAll("h1").length !== 1) out.push("un seul h1 attendu");
      if (!document.documentElement.lang) out.push("lang manquant");
      return out;
    });
    assert.deepEqual(issues, [], `vue ${view}`);
  }
  await ctx.close();
});

/* 13 */ await test("contraste WCAG AA (≥ 4,5:1) en clair et en sombre", async () => {
  for (const scheme of ["light", "dark"]) {
    const ctx = await newCtx({ colorScheme: scheme }); const { page } = await open(ctx, "#jour1");
    await page.waitForSelector("#matches .match");
    const sels = ["body", ".brand p", ".note", ".src", ".eyebrow", ".day .w", ".day .t", ".day[aria-selected=true] .t", ".field small", ".field[aria-pressed=true]", ".timeline .tk", ".match .rd", ".match .bl", ".match .h", ".pill", ".stat span", "th", ".status", ".view", ".clock > span"];
    const fn = await page.evaluateHandle(`(${contrastFn.toString()})()`);
    let rows = await page.evaluate(([f, s]) => s.flatMap(x => f(x)), [fn, sels]);
    await page.click("#vRules");
    rows = rows.concat(await page.evaluate(([f, s]) => s.flatMap(x => f(x)), [fn, [".lead", ".z span", ".z b", ".flow li > span", ".lex dt", ".big b", ".big span", ".num", ".facts span", "table.pts td.who", ".btn"]]));
    const bad = rows.filter(r => r.ratio < 4.5);
    assert.deepEqual(bad, [], `thème ${scheme}`);
    await ctx.close();
  }
});

/* 14 */ await test("mobile 375 px : aucun défilement horizontal", async () => {
  const ctx = await newCtx({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true }); const { page } = await open(ctx, "#jour1");
  await page.waitForSelector("#matches .match");
  for (const view of ["#vLive", "#vRules"]) {
    await page.click(view);
    const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(sw <= cw, `${view} : ${sw} > ${cw}`);
  }
  await page.click("#vLive");
  const layout = await page.evaluate(() => ({
    overflow: [...document.querySelectorAll("#cal .day *, .view, .clock *, .field, .timeline li *")].filter(el => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow === "visible" && el.clientWidth > 0).map(el => el.className + ":" + el.textContent.trim().slice(0, 20)),
    tabsOneLine: new Set([...document.querySelectorAll(".view")].map(el => el.offsetTop)).size === 1
  }));
  assert.deepEqual(layout.overflow, [], "aucun texte qui déborde de sa case");
  assert.ok(layout.tabsOneLine, "onglets sur une seule ligne");
  await ctx.close();
});

/* 15 */ await test("PWA : manifeste valide et icônes conformes", async () => {
  const ctx = await newCtx(); const { page } = await open(ctx, "");
  const href = await page.getAttribute('link[rel="manifest"]', "href");
  const res = await page.request.get(BASE + href);
  assert.equal(res.status(), 200);
  const m = await res.json();
  for (const k of ["name", "short_name", "start_url", "scope", "display", "icons", "theme_color", "background_color"]) assert.ok(m[k], `manifest.${k}`);
  assert.equal(m.display, "standalone");
  assert.ok(m.icons.some(i => i.purpose === "maskable"));
  for (const icon of m.icons) {
    const r = await page.request.get(BASE + icon.src); assert.equal(r.status(), 200, icon.src);
    const buf = await r.body(); const w = buf.readUInt32BE(16), hgt = buf.readUInt32BE(20);
    assert.equal(`${w}x${hgt}`, icon.sizes, icon.src);
  }
  const sw = await readFile(join(root, "sw.js"), "utf8");
  for (const f of sw.match(/^\s+"([^"]+)",?$/gm).map(s => s.trim().replace(/[",]/g, ""))) {
    const r = await page.request.get(BASE + (f === "./" ? "" : f)); assert.equal(r.status(), 200, `précache : ${f}`);
  }
  await ctx.close();
});

/* 16 */ await test("PWA : service worker actif, app utilisable hors ligne avec données en cache", async () => {
  const ctx = await newCtx({ serviceWorkers: "allow" }); const { page, errors } = await open(ctx, "#jour1");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); await page.waitForSelector("#matches .match");
  assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true, "page contrôlée");
  await ctx.setOffline(true);
  await page.reload(); await page.waitForSelector("#cal .day");
  assert.equal(await text(page, "h1"), "Incheon 2026");
  await page.waitForSelector("#matches .match");
  assert.equal(await page.locator("#matches .match").count(), 1, "données servies depuis le cache");
  await page.click("#vRules");
  assert.equal(await text(page, "#cTotal"), "178");
  await ctx.setOffline(false);
  const real = errors.filter(e => !/ERR_INTERNET_DISCONNECTED|Failed to load resource|net::ERR_FAILED/.test(e));
  assert.deepEqual(real, []);
  await ctx.close();
});

/* 17 */ await test("PWA : bannière de mise à jour quand une nouvelle version est déployée", async () => {
  const ctx = await newCtx({ serviceWorkers: "allow" }); const { page } = await open(ctx, "#jour1");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); await page.waitForSelector("#cal .day");
  const swPath = join(site, "sw.js"); const orig = await readFile(swPath, "utf8");
  await writeFile(swPath, orig.replace(/fgc2026-v\d+/, "fgc2026-v999"));
  try {
    await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
    await page.waitForSelector("#updateBanner:not([hidden])", { timeout: 10000 });
    await Promise.all([page.waitForEvent("load", { timeout: 10000 }), page.click("#updateBtn")]);
    await page.waitForSelector("#cal .day");
    assert.ok(await page.evaluate(async () => (await caches.keys()).every(k => k.startsWith("fgc2026-v999"))), "anciens caches supprimés");
  } finally { await writeFile(swPath, orig); }
  await ctx.close();
});

/* 18 */ await test("version artefact : mono-fichier, sans service worker, fonctionnelle", async () => {
  assert.doesNotMatch(artifactHtml, /<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i);
  assert.doesNotMatch(artifactHtml, /<link[^>]*rel="manifest"/);
  const ctx = await newCtx({ serviceWorkers: "allow" }); const { page, errors } = await open(ctx, "artifact.html#jour1");
  assert.equal(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())), false);
  await page.waitForSelector("#matches .match");
  await page.click("#lnEn");
  assert.equal(await text(page, "#vRules"), "How the game works");
  await page.click('#fields [data-f="t4"]');
  assert.ok((await page.getAttribute("#player iframe", "src")).includes("C7MIYhOdYS4"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

/* 19 */ await test("splashscreen : animé à l'ouverture, ne bloque pas, se retire seul ; copyright", async () => {
  const ctx = await newCtx(); const { page, errors } = await open(ctx, "#jour1");
  assert.ok(await page.isVisible("#splash"), "visible à l'ouverture");
  assert.equal(await page.getAttribute("#splash", "aria-hidden"), "true");
  assert.match(await text(page, "#splash"), /FGC 2026[\s\S]*© XVI 2026/);
  const anim = await page.$eval(".sp-ball", el => getComputedStyle(el).animationName);
  assert.equal(anim, "sp-roll", "balle animée");
  const t0 = Date.now();
  await page.click("#lnEn", { timeout: 500 });            /* cliquable pendant le splash */
  assert.equal(await page.getAttribute("html", "lang"), "en");
  await page.waitForSelector("#splash", { state: "detached", timeout: 3500 });
  const ms = Date.now() - t0;
  assert.ok(ms < 3200, `retiré en ${ms} ms`);
  assert.match(await text(page, "footer"), /© XVI 2026/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

/* 20 */ await test("splashscreen : mouvement réduit respecté (pas d'animation, court)", async () => {
  const ctx = await newCtx({ reducedMotion: "reduce" }); const { page } = await open(ctx, "#jour1");
  assert.equal(await page.$eval(".sp-ball", el => getComputedStyle(el).animationName), "none");
  const t0 = Date.now();
  await page.waitForSelector("#splash", { state: "detached", timeout: 3500 });
  assert.ok(Date.now() - t0 < 1500, "retiré rapidement");
  await ctx.close();
});

/* 21 */ await test("mobile iPhone : sélecteur de fuseau lisible, pleine largeur, sans zoom iOS", async () => {
  const ctx = await newCtx({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const { page } = await open(ctx, "#jour1");
  const box = await page.$eval("#tzSelect", el => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, right: r.right, font: parseFloat(getComputedStyle(el).fontSize) }; });
  assert.ok(box.font >= 16, `police ${box.font}px (< 16 px déclenche le zoom iOS)`);
  assert.ok(box.w >= 200, `largeur ${box.w}px`);
  assert.ok(box.h >= 40, `hauteur ${box.h}px (cible tactile)`);
  assert.ok(box.right <= 375, "dans l'écran");
  const labelLines = await page.$eval('label[for="tzSelect"]', el => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || "18")));
  assert.ok(labelLines <= 1, "libellé sur une ligne");
  await page.selectOption("#tzSelect", "Asia/Seoul");
  assert.equal(await text(page, "#timeline li:first-child .tzb"), "11:00–13:00");
  await ctx.close();
});

/* 22 */ await test("statut : aucune valeur « null » quand data.json n'a pas encore de date", async () => {
  const ctx = await newCtx();
  await ctx.route(/\/data\.json/, r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ updated: null, rankings: [], matches: [] }) }));
  const { page, errors } = await open(ctx, "#jour1");
  await page.waitForFunction(() => /Données auto/.test(document.getElementById("status").textContent));
  const all = await page.evaluate(() => document.body.innerText);
  assert.doesNotMatch(all, /\bnull\b|\bundefined\b|NaN/);
  assert.match(await text(page, "#matches"), /Aucun match ce jour-là/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

/* 22b */ await test("codes pays : nom complet, équipe suivie reconnue par son code", async () => {
  const ctx = await newCtx();
  const body = { updated: "2026-10-08T03:30:00Z", teams: { FRA: "France", KEN: "Kenya", "x y": "<b>" },
    rankings: [{ rank: 1, team: "FRA", score: 10, high: 12, climb: 2, played: 1 }],
    matches: [{ n: "8", day: "2026-10-08", kst: "11:31", field: "t4", red: ["TPE", "YEM", "FRA"], blue: ["CHN", "KEN", "BRA"], sr: 50, sb: 40 }] };
  await ctx.route(/\/data\.json/, r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
  const { page, errors } = await open(ctx, "#jour1");
  await page.waitForSelector("#matches .match.mine");
  assert.equal(await page.getAttribute("#matches .match b abbr", "title"), "France");
  assert.equal(await text(page, "#matches .match b"), "FRA");
  assert.equal(await page.getAttribute('#matches abbr[title="Kenya"]', "title"), "Kenya");
  assert.equal(await text(page, "#sRank"), "1");
  assert.match(await text(page, "#rankWrap"), /France/);
  assert.equal(await page.locator('#fields [data-f="t4"].mine').count(), 1);
  const opts = await page.$$eval("#team option", os => os.map(o => o.value));
  assert.ok(!opts.includes("FRA") && !opts.includes("TPE"), "les codes ne s'ajoutent pas comme pays");
  assert.deepEqual(errors, []);
  await ctx.close();
});

/* 22c */ await test("barre collante : reste visible et se resserre au défilement", async () => {
  const ctx = await newCtx({ viewport: { width: 390, height: 844 } }); const { page, errors } = await open(ctx, "#jour1");
  const h0 = await page.$eval("#dock", el => el.getBoundingClientRect().height);
  await page.mouse.wheel(0, 900); await page.waitForTimeout(400);
  const r = await page.$eval("#dock", el => ({ top: Math.round(el.getBoundingClientRect().top), h: el.getBoundingClientRect().height, c: el.classList.contains("compact") }));
  assert.ok(r.c, "classe compact");
  assert.equal(r.top, 0, "collée en haut");
  assert.ok(r.h < 100 && r.h < h0 / 2, `hauteur resserrée : ${r.h} (au lieu de ${h0})`);
  assert.equal(await page.isVisible("#lnEn"), true);
  assert.equal(await page.isVisible("#clkMain"), true);
  assert.equal(await page.isVisible('#cal [data-k="jour2"]'), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "aucun débordement");
  await page.click('#vRules'); await page.click('#cal [data-k="jour2"]');
  assert.equal(await page.isVisible("#viewLive"), true, "un jour ramène au direct");
  await page.mouse.wheel(0, -5000); await page.waitForTimeout(400);
  assert.equal(await page.$eval("#dock", el => el.classList.contains("compact")), false, "taille normale en haut de page");
  assert.deepEqual(errors, []);
  await ctx.close();
});

/* 22d */ await test("barre collante : bascule sans saut du contenu ni recul de la page", async () => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const ctx = await newCtx({ viewport }); const { page, errors } = await open(ctx, "#jour1");
    const probe = () => page.evaluate(() => ({ y: Math.round(scrollY), top: Math.round(document.querySelector("header").getBoundingClientRect().top + scrollY), c: document.getElementById("dock").classList.contains("compact"), h: document.documentElement.scrollHeight }));
    const start = await probe(); let seen = false;
    for (let y = 40; y <= 700; y += 40) {
      await page.evaluate(v => scrollTo(0, v), y); await page.waitForTimeout(60);
      const r = await probe(); seen ||= r.c;
      assert.equal(r.y, y, `position conservée à ${y} px (${viewport.width} px)`);
      assert.equal(r.top, start.top, `contenu immobile à ${y} px (${viewport.width} px)`);
      assert.equal(r.h, start.h, "longueur de page inchangée");
    }
    assert.ok(seen, "la barre s'est resserrée");
    /* pas de bande vide : quand la barre est resserrée, le contenu touche son bord inférieur ou est déjà passé dessous */
    for (let y = 700; y >= 0; y -= 20) {
      await page.evaluate(v => scrollTo(0, v), y); await page.waitForTimeout(40);
      const gap = await page.evaluate(() => { const d = document.getElementById("dock"); if (!d.classList.contains("compact")) return 0; return Math.round(document.querySelector(".brand").getBoundingClientRect().top - d.getBoundingClientRect().bottom); });
      assert.ok(gap <= 24, `bande vide de ${gap} px à ${y} px (${viewport.width} px)`);
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

/* 23 */ await test("horloge : rafraîchissement à la minute sans perdre le focus clavier", async () => {
  const ctx = await newCtx();
  await ctx.clock.install({ time: new Date("2026-10-08T01:58:30Z") });      /* 10:58:30 KST, 2 min avant les matchs */
  const { page, errors } = await open(ctx, "#jour1");
  await page.focus("#tab-jour2"); await page.keyboard.press("ArrowLeft");   /* focus sur l'onglet jour 1 */
  assert.equal(await page.evaluate(() => document.activeElement?.id), "tab-jour1");
  await page.clock.runFor(60_000);                                           /* minute sans changement d'état */
  assert.equal(await page.evaluate(() => document.activeElement?.id), "tab-jour1");
  await page.clock.runFor(120_000);                                          /* 11:00 KST : début des matchs */
  assert.match(await text(page, "#timeline li:first-child"), /maintenant/i, "session en cours marquée");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "tab-jour1", "focus conservé après reconstruction");
  assert.match(await text(page, "#cdLabel"), /En direct/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

/* 24 */ await test("économie : aucune relecture des données en arrière-plan, reprise au retour", async () => {
  const ctx = await newCtx();
  await ctx.clock.install({ time: new Date("2026-10-08T03:00:00Z") });
  const { page } = await open(ctx, "#jour1");
  await page.waitForSelector("#matches .match");
  let calls = 0; page.on("request", r => { if (r.url().includes("data.json")) calls++; });
  const setVis = v => page.evaluate(state => { Object.defineProperty(document, "visibilityState", { value: state, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); }, v);
  await setVis("hidden");
  await page.clock.runFor(10 * 60_000);
  assert.equal(calls, 0, "pas de requête en arrière-plan");
  await setVis("visible");
  await page.waitForTimeout(300);
  assert.equal(calls, 1, "relecture immédiate au retour");
  await page.clock.runFor(120_000 + 1000);
  await page.waitForTimeout(300);
  assert.equal(calls, 2, "relecture périodique reprise");
  await ctx.close();
});

/* 25 */ await test("vérifications statiques du dépôt", async () => {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, [join(root, "tools/check-static.mjs")], { encoding: "utf8" });
  assert.match(out, /OK/);
});

/* ---------- bilan ---------- */
await browser.close(); server.close(); await rm(site, { recursive: true, force: true });
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} tests réussis${failed.length ? ` — ${failed.length} en échec` : ""}.\n`);
await writeFile(join(root, "tests/e2e/last-report.json"), JSON.stringify({ date: new Date().toISOString(), total: results.length, passed: results.length - failed.length, results: results.map(({ name, ok, ms, err }) => ({ name, ok, ms, error: err ? String(err.message || err) : undefined })) }, null, 1));
process.exitCode = failed.length ? 1 : 0;
