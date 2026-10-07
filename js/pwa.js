/**
 * PWA : enregistrement du service worker, bannière de mise à jour, bouton d'installation.
 * Inactif si la page n'a pas de manifeste (version artefact) ou hors contexte sécurisé.
 */
export function initPwa() {
  const hasManifest = !!document.querySelector('link[rel="manifest"]');
  if (!hasManifest || !("serviceWorker" in navigator) || !window.isSecureContext) return;

  const banner = document.getElementById("updateBanner");
  const updateBtn = document.getElementById("updateBtn");
  const installBtn = document.getElementById("installBtn");
  let reloading = false;
  /** @type {ServiceWorker|null} */
  let waiting = null;

  const offerUpdate = sw => { waiting = sw; if (banner) banner.hidden = false; };

  /* Trusted Types : seule l'URL « sw.js » peut être enregistrée comme script. */
  /** @type {any} */
  const tt = /** @type {any} */ (window).trustedTypes;
  const swUrl = tt
    ? tt.createPolicy("fgc-sw", { createScriptURL: u => { if (u !== "sw.js") throw new TypeError(`URL refusée : ${u}`); return u; } }).createScriptURL("sw.js")
    : "sw.js";

  navigator.serviceWorker.register(swUrl, { scope: "./" }).then(reg => {
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const sw = reg.installing;
      sw?.addEventListener("statechange", () => {
        if (sw.state === "installed" && navigator.serviceWorker.controller) offerUpdate(sw);
      });
    });
    setInterval(() => reg.update().catch(() => {}), 30 * 60_000);
  }).catch(() => { /* PWA indisponible : la page fonctionne quand même */ });

  updateBtn?.addEventListener("click", () => { waiting?.postMessage({ type: "SKIP_WAITING" }); });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading || !waiting) return;
    reloading = true;
    location.reload();
  });

  /** @type {any} */
  let deferred = null;
  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    deferred = e;
    if (installBtn) installBtn.hidden = false;
  });
  installBtn?.addEventListener("click", async () => {
    if (!deferred) return;
    installBtn.hidden = true;
    deferred.prompt();
    try { await deferred.userChoice; } finally { deferred = null; }
  });
  window.addEventListener("appinstalled", () => { if (installBtn) installBtn.hidden = true; });
}
