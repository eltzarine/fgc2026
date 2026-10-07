#!/usr/bin/env node
/**
 * Construit dist/artifact.html : version mono-fichier pour un artefact claude.ai
 * (CSS et JS en ligne, sans manifeste ni service worker, que l'hébergeur n'autorise pas).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = p => readFile(join(root, p), "utf8");
const MODULES = ["js/config.js", "js/i18n.js", "js/data.js", "js/teams.js", "js/pwa.js", "js/app.js"];

const html = await read("index.html");
const title = html.match(/<title>[\s\S]*?<\/title>/)?.[0];
const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/)?.[0];
const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1];
if (!title || !fonts || !body) throw new Error("index.html : structure inattendue");
const css = await read("css/app.css");

const strip = src => src
  .replace(/^import\s[^;]+;\s*$/gm, "")
  .replace(/^export\s+(?=(async\s+)?function|const|let|class)/gm, "");
const js = (await Promise.all(MODULES.map(read))).map((src, i) => `/* ---- ${MODULES[i]} ---- */\n${strip(src)}`).join("\n");
if (/^\s*(import|export)\s/m.test(js)) throw new Error("import/export résiduel dans le bundle");
if (js.includes("</script")) throw new Error("séquence </script interdite dans le bundle");

const out = `${title}
${fonts}
<style>
${css}
</style>
${body.trim()}
<script>
(() => {
"use strict";
${js}
})();
</script>
`;
await mkdir(join(root, "dist"), { recursive: true });
await writeFile(join(root, "dist/artifact.html"), out);
console.log(`dist/artifact.html (${(out.length / 1024).toFixed(1)} Ko)`);
