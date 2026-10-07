#!/usr/bin/env node
/**
 * Petit serveur statique local (tests et prévisualisation). Usage : node tools/serve.mjs [dossier] [port]
 * Sert uniquement des fichiers sous le dossier racine, sans liste de répertoires.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8"
};

export function startServer(dir = ".", port = 0) {
  const root = resolve(dir);
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url || "/", "http://x").pathname);
      let file = normalize(join(root, path));
      if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, "index.html");
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] || "application/octet-stream",
        "x-content-type-options": "nosniff",
        "cache-control": "no-cache"
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
    }
  });
  return new Promise(ok => server.listen(port, "127.0.0.1", () => ok(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = await startServer(process.argv[2] || ".", Number(process.argv[3] || 8080));
  const a = s.address();
  console.log(`http://localhost:${typeof a === "object" && a ? a.port : ""}/`);
}
