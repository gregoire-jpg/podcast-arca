# Podcast Arca — Briefing Claude

Site **admin + ressources** pour le projet podcast "Arca". Sert d'admin central pour plusieurs sous-projets (épisodes, glossaire, dictionnaire, documentation, citations du jour).

**GitHub** : `gregoire-jpg/podcast-arca` (public)
**Site public WordPress** : https://arca-revue.com (séparé, pas dans ce repo)
**Admin Netlify** : https://gregoire-jpg.github.io/podcast-arca/admin/

## Stack technique

- **Vanilla HTML/CSS/JS** — pas de framework. Multi-pages classique.
- **Build** : `node build-rss.js` (génère le flux RSS depuis `episodes.json`)
- **Déploiement** : Netlify (config dans `netlify.toml`)
- **Embed depuis arca-revue.com** : plusieurs pages avec CSP `frame-ancestors` autorisant l'iframe (cf. `netlify.toml`)
- **Style global** : navy + or

## Architecture racine (fichiers principaux)

```
podcast-arca/
├── index.html                       ← page racine
├── admin/                           ← admin web (login, dashboard, panels)
│   ├── index.html                   ← entrée admin
│   └── citations-app/               ← build Flutter copié depuis citations_du_jour
├── n1-sommaire.html à n8-sommaire.html  ← sommaires par numéro de revue
├── embed.html, docs-embed.html      ← iframes destinées à arca-revue.com
├── docs.html                        ← documentation
├── glossaire.html, glossaire.json
├── dictionnaire.html, dictionnaire.json
├── etiquette.html
├── commande.html, commande-merci.html  ← tunnel de commande (Stripe ?)
├── episodes.json, documents.json, dictionnaire.json, glossaire.json
├── build-rss.js                     ← génère rss.xml
├── images/
├── netlify/functions/               ← Netlify Functions (forms, mr-label, submission-created, etc.)
└── netlify.toml
```

## Onglets admin (`admin/index.html`)

- **Podcasts** (gestion épisodes / playlists)
- **Documentation** (gestion `docs.html`)
- **Glossaire** (gestion `glossaire.html`)
- **Dictionnaire** (gestion `dictionnaire.html`)
- **Citations du Jour** ← héberge l'admin de l'app mobile Flutter (sous-onglets : Citations · Auteurs · Inscrits · Statistiques · Aperçu) — **éditer ici, pas dans `citations_du_jour/admin/`**

## Données

- `episodes.json` : liste des épisodes (alimente RSS + l'admin)
- `documents.json` : docs téléchargeables
- `glossaire.json`, `dictionnaire.json` : références accessibles via CORS depuis arca-revue.com
- `config.json` : config globale (clés publiques, URLs, etc.)

## Variables d'environnement Netlify

(Côté Functions, non accessibles côté browser)

- `STRIPE_SECRET_KEY` (LIVE — utilisé pour le tunnel commande)
- `ORDER_EMAIL_TO` (destinataire emails commande, ex: `gregoire@taiga.be,antoine@arca-librairie.com`)
- Autres à compléter au fil des besoins

## Commandes courantes

```powershell
# Build RSS
node build-rss.js

# Serveur local pour dev
npx serve .

# Préparer une nouvelle livraison de l'admin Citations
# (depuis le repo citations_du_jour — voir agent livrer-citations)
```

## Garde-fous

- **CSP `frame-ancestors`** : à conserver pour chaque page embedée dans arca-revue.com. Ne pas casser cette intégration.
- **JSON publics** : `episodes.json`, `documents.json`, `glossaire.json`, `dictionnaire.json` doivent rester accessibles avec `Access-Control-Allow-Origin: *` (déjà dans `netlify.toml`).
- **Cache HTML** : `no-cache, no-store, must-revalidate` (les pages HTML ne sont jamais cachées par Netlify). Conserver cette politique pour pouvoir publier rapidement.
- **admin/citations-app/** : ne pas éditer à la main — c'est un build Flutter qui doit être régénéré depuis `citations_du_jour` via l'agent `livrer-citations`.
- **Stripe LIVE** : la clé est en env var Netlify, jamais dans le code source.

## Liens

- **WordPress arca-revue.com** : front public, séparé de ce repo (pas accessible Claude).
- **citations_du_jour** : repo source de l'admin Citations (l'admin déployé ici est un build).

## Auto-commit/push

Préférence permanente : auto-commit + push (Netlify redéploie automatiquement).
