# FGC 2026 Incheon — PWA

Application web installable (PWA) pour suivre le FIRST Global Challenge 2026 : directs des 5 terrains,
calendrier dans votre fuseau horaire, règles expliquées simplement, résultats mis à jour automatiquement.
Français et anglais. Site non officiel.

## Fonctionnement

```
results.first.global ──(GitHub Action, toutes les 10 min)──▶ data.json ──(relu toutes les 2 min)──▶ PWA
```

- **Aucune dépendance** : HTML, CSS et JavaScript standard (modules ES), Node 20+ pour les scripts.
- **Hors ligne** : le service worker garde l'interface et les dernières données ; l'app s'ouvre sans réseau.
- **Mise à jour** : quand une nouvelle version est déployée, une bannière propose de recharger.
- Si la source officielle est vide ou en panne, les dernières données publiées sont conservées.

## Mise en ligne sur GitHub Pages (5 minutes)

1. Crée un dépôt public (ex. `fgc2026`) et envoie-y **tout** le contenu de ce dossier, y compris `.github/`.
2. **Settings → Pages** : « Deploy from a branch », branche `main`, dossier `/ (root)`.
   L'app sera à `https://<ton-compte>.github.io/fgc2026/`.
3. **Settings → Actions → General → Workflow permissions** : « Read and write permissions ».
4. **Actions → Mise à jour des résultats FGC 2026 → Run workflow** pour un premier essai.

Pour l'installer : ouvrir le lien sur le téléphone, puis « Ajouter à l'écran d'accueil »
(ou le bouton « Installer l'app » sur Chrome/Edge).

## Structure

| Chemin | Rôle |
|---|---|
| `index.html` | Page (HTML5, CSP stricte, aucun script en ligne) |
| `css/app.css` | Styles, thèmes clair/sombre |
| `js/config.js` | Jours, horaires officiels (heure de Corée), identifiants des directs |
| `js/i18n.js` | Textes FR / EN |
| `js/data.js` | Validation stricte de `data.json` (partagée avec le collecteur) |
| `js/app.js` | Application (rendu DOM sans `innerHTML`) |
| `js/pwa.js` | Service worker, installation, bannière de mise à jour |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA |
| `data.json` | Données (écrites par l'Action) |
| `scripts/scrape.mjs` | Collecteur de results.first.global |
| `.github/workflows/update-data.yml` | Planification du collecteur (toutes les 10 min) |
| `.github/workflows/ci.yml` | Contrôles à chaque modification : vérifications statiques, tests, types |
| `.github/dependabot.yml` | Mises à jour proposées des actions GitHub |
| `SECURITY.md` | Mesures de sécurité et signalement |
| `tests/` | Tests unitaires (node:test) et de bout en bout (Playwright) |
| `tools/` | Serveur local, construction de la version artefact |

## Sécurité

- **CSP** : `default-src 'none'`, scripts et styles uniquement depuis le site (plus Google Fonts), vidéos uniquement depuis `youtube-nocookie.com`.
- **Trusted Types** imposés : le navigateur refuse toute injection de HTML ou de script ; seule l'URL du service worker est autorisée.
- **Aucune donnée externe n'est interprétée comme du HTML** : rendu par `textContent` / `createElement`.
- **Validation** de `data.json` : types, listes autorisées (jours, terrains, heures), longueurs et volumes bornés.
- Valeurs du stockage local et de l'URL revalidées à chaque lecture.
- Lecteur YouTube en `sandbox`, liens externes en `noopener noreferrer`, politique de référent stricte.
- **Collecteur** : HTTPS sur le seul domaine officiel, délai de 20 s, taille max 3 Mo, contenu `<script>` ignoré, écriture atomique.
- **Workflow** : aucune permission par défaut sauf l'écriture du contenu, actions figées par SHA, délai de 5 min, arrêt automatique après le 11 octobre 2026.

## Développement

```bash
npm test                 # 13 tests unitaires (collecteur + validation)
npm run check            # vérification de types (tsc, si installé)
npm run serve            # http://localhost:8080/
npm run build:artifact   # dist/artifact.html (version mono-fichier)
npm run check:static     # CSP, précache, manifeste, syntaxe, API dangereuses
npm run test:e2e         # 25 tests de bout en bout (nécessite Playwright + Chromium)
```

Les tests de bout en bout couvrent : chargement sans erreur ni violation CSP, langues, calendrier et clavier,
fuseaux horaires, lecteur vidéo, données et neutralisation XSS, équipe suivie, calculateur des règles,
stockage piégé, accessibilité, contraste WCAG AA clair/sombre, mobile 375 px, manifeste et icônes,
fonctionnement hors ligne, mise à jour du service worker, version artefact, écran d'ouverture,
sélecteur de fuseau sur iPhone, focus clavier conservé, pause des requêtes en arrière-plan. Dernier rapport : `tests/e2e/last-report.json`.

Après une modification de l'interface, change `VERSION` dans `sw.js` pour que les utilisateurs reçoivent la mise à jour.

## Limite connue

Le collecteur suppose que results.first.global publie des tableaux HTML (c'est le cas du classement).
Si les matchs arrivent sous une autre forme, l'app continue avec les données connues ; il faudra adapter
`mapMatches()` dans `scripts/scrape.mjs`. `data.json` peut aussi être modifié à la main sur GitHub.
