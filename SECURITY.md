# Sécurité

## Signaler un problème

Ouvre une « Security advisory » privée depuis l'onglet **Security** du dépôt plutôt qu'une issue publique.

## Mesures en place

- CSP stricte : `default-src 'none'`, aucun script en ligne, `require-trusted-types-for 'script'` (aucune API d'injection HTML utilisable).
- Données externes (`data.json`) validées par un schéma strict et affichées uniquement en texte.
- Lecteur YouTube en mode sans cookies et en `sandbox`.
- Collecteur limité au domaine officiel en HTTPS, avec délai et taille maximum.
- Workflows avec permissions minimales et actions figées par SHA ; Dependabot propose les mises à jour.
