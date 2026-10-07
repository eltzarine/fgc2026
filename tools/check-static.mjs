#!/usr/bin/env node
/**
 * Vérifications statiques sans dépendance (lancées en CI) :
 * CSP et absence de code en ligne, fichiers du précache et icônes présents,
 * JSON valides, syntaxe des scripts.
 */
import { readFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = p => readFile(join(root, p), "utf8");
const exists = p => access(join(root, p)).then(() => true, () => false);
const errors = [];
const check = (ok, msg) => { if (!ok) errors.push(msg); };

const html = await read("index.html");
check(/^<!doctype html>/i.test(html), "index.html : doctype manquant");
check(/<html lang="(fr|en)">/.test(html), "index.html : attribut lang manquant");
const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] || "";
for (const d of ["default-src 'none'", "script-src 'self'", "base-uri 'none'", "form-action 'none'", "require-trusted-types-for 'script'"]) check(csp.includes(d), `CSP : « ${d} » manquant`);
check(!/'unsafe-(inline|eval)'/.test(csp), "CSP : unsafe-inline / unsafe-eval interdits");
check(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "index.html : script en ligne interdit");
check(!/\son[a-z]+\s*=/i.test(html), "index.html : attribut on* interdit");
check(!/\sstyle\s*=/i.test(html), "index.html : attribut style interdit");
for (const m of html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) check(/rel="noopener noreferrer"/.test(m[0]), `lien externe sans noopener noreferrer : ${m[0].slice(0, 80)}`);

const sw = await read("sw.js");
check(/const VERSION = "fgc2026-v\d+"/.test(sw), "sw.js : VERSION introuvable");
for (const f of [...sw.matchAll(/^\s+"([^"]+)",?$/gm)].map(m => m[1])) if (f !== "./") check(await exists(f), `précache : ${f} introuvable`);

const manifest = JSON.parse(await read("manifest.webmanifest"));
for (const k of ["name", "short_name", "start_url", "scope", "display", "icons"]) check(manifest[k], `manifeste : ${k} manquant`);
for (const i of manifest.icons || []) check(await exists(i.src), `icône introuvable : ${i.src}`);
JSON.parse(await read("data.json"));
for (const js of ["js/app.js", "js/config.js", "js/data.js", "js/i18n.js", "js/pwa.js", "sw.js", "scripts/scrape.mjs"]) {
  try { execFileSync(process.execPath, ["--check", join(root, js)], { stdio: "pipe" }); } catch (e) { errors.push(`syntaxe ${js} : ${String(e.stderr).split("\n")[0]}`); }
  const src = await read(js);
  check(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\s*\(/.test(src), `${js} : API d'injection HTML/code interdite`);
}

if (errors.length) { console.error(`✗ ${errors.length} problème(s) :\n- ${errors.join("\n- ")}`); process.exit(1); }
console.log("✓ vérifications statiques OK");
