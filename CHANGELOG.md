# Changelog

Toutes les modifications notables de Relay, regroupées par étape, la plus récente en haut.
Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/), versions en
[SemVer](https://semver.org/lang/fr/).

- **Ce fichier est mis à jour à chaque changement**, dans le même commit.
- Le **détail** de chaque contribution (pourquoi, fichiers, comment tester, décisions) est
  dans [`docs/contributions/`](docs/contributions/README.md).
- Pour reprendre le projet dans une nouvelle session : [`docs/HANDOFF.md`](docs/HANDOFF.md).

## [Non publié] — 0.1.0 en cours

### Phase B — orchestrateur multi-comptes · 2026-10-07 · *en attente de validation*

Commits `c32d07b` `6d3bf98` `f0093ac` + docs · détail :
[contribution](docs/contributions/2026-10-07-phase-b-orchestrateur.md)

#### Ajouté

- **Mode automatique** (par défaut) : pour le plan puis pour chaque tâche, le routeur choisit
  le compte et le modèle parmi **tous les comptes connectés** ; mode **manuel** conservé.
- **Stratégies** Économie / Équilibré / Qualité (pondération coût, qualité, vitesse,
  sur-dimensionnement, coût virtuel de l'abonnement).
- **Besoins par tâche** (`code`, `reasoning`, `long_context`, `web`, `fast`) attribués par le
  planificateur, en plus des 3 niveaux quick / build / deep.
- **Catalogue de modèles** (`core/catalog.ts`) : niveau, besoins couverts, prix de référence,
  vitesse et qualité par famille (Claude, Gemini, Llama, DeepSeek, Qwen, Sonar).
- **Plafonds par compte** : activé ou non, niveaux autorisés, nombre max d'appels par run.
  Par défaut **Claude Code est désactivé** en auto (quota préservé), l'API Anthropic est
  réservée au « deep ».
- **Santé des modèles** : un modèle saturé / à court de quota est évité quelques minutes, un
  modèle retiré ou non inclus dans l'offre est écarté une heure.
- **Repli entre fournisseurs** : si un modèle échoue, la tâche passe au candidat suivant,
  éventuellement chez un autre compte ; la raison de chaque choix est affichée.
- **Journal lisible** (panneau « Journal ») : une ligne par action (plan, routage, requête,
  réponse, repli, erreur), détail brut dépliable, filtres, recherche, vue brute, export JSONL.
- API serveur : `GET /api/pool`, `POST /api/run` avec `mode: "auto"`.

#### Modifié

- L'exécuteur route via `TaskRouting` (manuel ou automatique) ; le coût « équivalent API » est
  calculé via le catalogue pour tous les backends (plus seulement Claude).
- Un modèle de niveau inférieur n'est utilisé qu'en **dernier recours**, signalé, quand aucun
  modèle du bon niveau ne répond (au lieu d'échouer).

#### Corrigé

- « quota limit: 0 » (modèle non inclus dans le palier gratuit, ex. Gemini Pro) est traité
  comme modèle indisponible, et plus comme un quota temporaire.

### Phase A — espace de travail en panneaux libres · `934801c`

- Six panneaux indépendants (dockview) : déplacer, empiler, redimensionner, agrandir ;
  disposition mémorisée, bouton « Disposition par défaut ».
- Graphe zoomable : molette, glisser le fond pour se déplacer, « Ajuster ».

### Fiabilisation : modèles, erreurs, front · `d0a73ff` `885179e` `57b07b2` `1c4f4f5` `25efea7` `2014df7` `8f35ca1`

- Décomposeur robuste : extraction JSON tolérante, troncature détectée, relances de réparation.
- Erreurs normalisées (`ProviderRequestError`, `describeError`) : titre, détail, conseil.
- Un modèle par tier pour chaque backend, repli automatique, effort → `reasoning_effort`,
  filtrage des modèles non-chat, détection des modèles disponibles avec la clé.
- Front : sélecteur par tier, carte d'erreur avec actions, chrono, bouton Arrêter, détail
  par tâche ; timeout 60 s sur les backends compatibles OpenAI.

### App desktop Electron · `90a09c8` `b18d2c1`

- Fenêtre native : le serveur démarre dans le processus Electron (plus de port à gérer).
- Chemins (UI, `.env`, config) résolus depuis la racine du dépôt quel que soit le dossier courant.

### Dashboard web + serveur local · `e5981e9` `ce907ee` `280c049` `1de43e5`

- Serveur local (`/api/state`, `/api/keys`, `/api/run` en SSE), clés écrites dans `.env`.
- Dashboard React + Vite sombre : backends, DAG, métriques.
- Écoute IPv4 + IPv6, gestion du port occupé, reconnexion automatique de l'UI.

### Multi-backend · `ced1fcb` `3acf9af` `0c9728e`

- Métriques comparables entre backends : `billedCost` (payé) et `referenceCost` (équivalent API).
- Provider **Claude Code** (abonnement, sans clé API) et provider **compatible OpenAI**
  (Gemini, Groq, OpenRouter, DeepSeek, Ollama…).

### Socle v0.1 (étapes 1 → 10) · `413e235` → `dd3a3a3`, `1d55ea6`, `4ec51ac`

- Monorepo pnpm (core, providers, cli), types partagés, adaptateur Anthropic, décomposeur
  (structured outputs), routeur + escalade, exécuteur, métriques, moniteur, config, CLI.
- Documentation multi-fournisseurs (`docs/PROVIDERS.md`) et premier CHANGELOG.

---

### Environnement

Node ≥ 22, pnpm 9. Stack datée 2026 : zod 4, TypeScript 7, vitest 5, React 19, Vite 8,
Electron 44, `@anthropic-ai/sdk` 0.131, `openai` 7.30, `dockview-react` 8.4.
