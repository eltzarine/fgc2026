/**
 * PWA : enregistrement du service worker, bannière de mise à jour, bouton d'installation.
 * Inactif si la page n'a pas de manifeste (version artefact) ou hors contexte sécurisé.
 */
/** @param {(key: string) => string} t traduction dans la langue affichée */
export function initPwa(t) {
  const hasManifest = !!document.querySelector('link[rel="manifest"]');
  if (!hasManifest || !("serviceWorker" in navigator) || !window.isSecureContext) return;

  const banner = document.getElementById("updateBanner");
  const updateBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("updateBtn"));
  const installBtn = document.getElementById("installBtn");
  /** @type {ServiceWorker|null} */
  let waiting = null;
  /** @type {ServiceWorkerRegistration|null} */
  let registration = null;
  let clicked = false, reloading = false, lastCheck = 0;

  const reload = () => { if (reloading) return; reloading = true; location.reload(); };
  const offerUpdate = (/** @type {ServiceWorker} */ sw) => {
    waiting = sw;
    if (banner && banner.hidden) { banner.hidden = false; document.documentElement.classList.add("has-update"); }
  };
  /** Suit un service worker en cours d'installation jusqu'à ce qu'il attende son tour. */
  const track = (/** @type {ServiceWorker|null} */ sw) => {
    if (!sw) return;
    const done = () => { if (sw.state === "installed" && navigator.serviceWorker.controller) offerUpdate(sw); };
    done();
    sw.addEventListener("statechange", done);
  };
  /** Cherche une nouvelle version (au plus une fois par minute). */
  const check = () => {
    if (!registration || !navigator.onLine || Date.now() - lastCheck < 60_000) return;
    lastCheck = Date.now();
    registration.update().catch(() => {});
  };

  /* Trusted Types : seule l'URL « sw.js » peut être enregistrée comme script. */
  /** @type {any} */
  const tt = /** @type {any} */ (window).trustedTypes;
  const swUrl = tt
    ? tt.createPolicy("fgc-sw", { createScriptURL: u => { if (u !== "sw.js") throw new TypeError(`URL refusée : ${u}`); return u; } }).createScriptURL("sw.js")
    : "sw.js";

  navigator.serviceWorker.register(swUrl, { scope: "./", updateViaCache: "none" }).then(reg => {
    registration = reg;
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    track(reg.installing);
    reg.addEventListener("updatefound", () => track(reg.installing));
    lastCheck = Date.now();
    setInterval(check, 10 * 60_000);
  }).catch(() => { /* PWA indisponible : la page fonctionne quand même */ });

  /* Retour sur l'app (onglet réactivé, téléphone déverrouillé, réseau revenu) : vérification immédiate. */
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
  window.addEventListener("online", check);
  window.addEventListener("pageshow", e => { if (e.persisted) check(); });

  updateBtn?.addEventListener("click", () => {
    if (clicked) return;
    clicked = true;
    updateBtn.setAttribute("aria-busy", "true");
    updateBtn.textContent = t("updating");
    /* La nouvelle version a déjà pris la main (depuis un autre onglet) : simple rechargement. */
    if (!waiting || waiting.state !== "installed") { reload(); return; }
    waiting.postMessage({ type: "SKIP_WAITING" });
    /* Filet de sécurité : rechargement même si le changement de version ne se signale pas. */
    setTimeout(reload, 4000);
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (clicked) reload(); });

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
