# Changelog

Toutes les modifications notables du projet sont consignées ici.

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/), versions en
[SemVer](https://semver.org/lang/fr/). **Ce fichier est mis à jour à chaque changement**,
en même temps que le commit correspondant (un bloc par commit, le plus récent en haut).

## [Non publié] — v0.1.0 en cours

Proof of concept CLI : un prompt → décomposition → routing → exécution → métriques.
Multi-backend : API Anthropic, Claude Code (abonnement), et tous les backends compatibles
OpenAI (Gemini, Groq, OpenRouter, DeepSeek, Ollama…). Exécution séquentielle.

### (ce commit) — feat: provider compatible OpenAI + backends gratuits de test

- **`providers/openai-compatible.ts`** : `OpenAICompatibleProvider`, un seul adaptateur
  pour tout backend exposant l'API Chat Completions (Gemini, Groq, OpenRouter, DeepSeek,
  Qwen, Ollama, OpenAI). `baseURL` + `apiKey` + `billing` configurables ; mapping des
  paramètres en fonction pure testable (`buildChatParams`), structured outputs via
  `json_object` (portable) ou `json_schema` strict.
- **Décomposeur portable** : le schéma JSON est aussi inscrit dans le prompt → les
  backends sans structured outputs natifs produisent quand même la bonne structure.
- **CLI** : presets `--provider gemini|groq|openrouter|deepseek|ollama` + `--model <id>`
  (force un modèle unique, requis hors Claude). Messages d'erreur guidés (clé/`--model`).
- **`.env.example`** : clés des backends gratuits documentées.
- **But** : tester **gratuitement**, sans consommer le quota Claude Code.
- **Tests** : `buildChatParams` (5). Total : 48 tests verts.

### `ced1fcb` + (ce commit) — feat: provider Claude Code + métriques multi-backend

- **`providers/claude-code.ts`** : `ClaudeCodeProvider` pilote le binaire `claude` en
  `-p` (abonnement, sans clé API). Modèle par tâche via `--model`, JSON du décomposeur
  via `--json-schema`, progression via `--output-format stream-json`. Parsing stream-json
  en fonction pure testable (`interpretStreamJsonLine`). Sûr par défaut
  (`permissionMode: "none"`, `--restricted`).
- **Métriques multi-backend** : `Provider.billing` (`per-token` | `subscription` | `free`) ;
  `TaskMetrics` passe de `cost` à `referenceCost` (tarif API, échelle commune) +
  `billedCost` (réel, 0 sur abonnement) ; `PipelineMetrics` → `totalBilledCost` +
  `totalReferenceCost`. Permet de **prouver l'économie même sans facturation en $**.
- **CLI** : option `--provider anthropic|claude-code` + fabrique de provider ; affiche le
  backend, le coût payé **et** le coût équivalent API.
- **Tests** : parseur stream-json + métadonnées provider (8).

### `dd3a3a3` — feat: config, moniteur et CLI de bout en bout (étapes 7 et 9)

- **`core/config.ts`** : chargement de `relay.config.json`, substitution des `${ENV}`
  (clés API jamais en clair), validation Zod (`parseConfig`, `loadConfig`, `ConfigError`).
- **`core/monitor/`** : `Monitor`, un `EventEmitter` typé (`onAny`, `on(type)`, `pipe`)
  pour les consommateurs qui préfèrent les callbacks au flux `AsyncGenerator`.
- **`cli/`** : commande `relay "prompt"` complète — charge `.env`, vérifie la clé API,
  décompose, exécute, affiche le plan puis les métriques ; messages d'erreur clairs.
- **Tests** : config (5), moniteur (4) ; smoke tests CLI (version/aide/clé manquante).

### `d514534` — feat(core): exécuteur + calcul des métriques (étapes 6 et 8)

- **`core/executor/`** : parcours topologique du DAG, chaînage des résultats entre
  tâches, événements typés (`AsyncGenerator<PipelineEvent>`), gestion d'échec.
  Point d'injection `runTask` prévu pour le futur **worker agentique** (fichiers + shell).
- **`core/metrics/`** : `computePipelineMetrics` (coûts, tokens, durée, baseline, économies).
- **Tests** : exécuteur + métriques (8), provider mocké, sans réseau.

### `a41688f` — feat(core): routeur piloté par registre + escalade (étape 5)

- **`core/registry.ts`** : registre central des modèles (prix, capacités) — source unique
  partagée par le routeur et les providers.
- **`core/router/`** : `assign()` par tier, `escalate()` (« effort d'abord puis modèle »),
  `validate()` des modèles de route.
- **`providers/anthropic`** : pointe désormais sur le registre central (fin de la
  duplication `MODELS`).
- **Tests** : routeur + registre (10).

### `4245fb2` — feat(core): décomposeur avec structured outputs (étape 4)

- **`core/decomposer/`** : schéma Zod du plan, `decompose()` via **structured outputs**
  (JSON garanti conforme), validation (JSON, schéma, dépendances inexistantes, cycles),
  prompt système + constructeur de prompt worker.
- **`core/types`** : `CompletionRequest.format` (`StructuredFormat`) pour la sortie structurée.
- **`providers/anthropic`** : câblage de `output_config.format` (fusion avec `effort`).
- **Tests** : décomposeur (7), provider mocké.

### `4ec51ac` — docs: stratégie multi-fournisseurs (clés API, zéro marge)

- **`docs/PROVIDERS.md`** : appel direct par clé utilisateur, registre de modèles,
  politique de routage « compétent + moins cher », abonnements non routables, temps réel.
- Mises à jour de `CLAUDE.md`, `ARCHITECTURE.md`, `PRODUCT.md`.

### `12a0871` — feat(providers): adaptateur Anthropic sur le SDK officiel (étape 3)

- **`providers/anthropic.ts`** : `complete()` en streaming (`AsyncIterable<CompletionChunk>`),
  `estimateCost()` (prix réels), `countTokens()` ; gestion par modèle de l'`effort` et du
  thinking adaptatif (Haiku exclu), split system/messages.
- **Tests** : coût et catalogue (6), sans réseau.

### `20b1d4e` — feat(core): types partagés du pipeline (étape 2)

- **`core/types.ts`** : `Pipeline`, `Task`, `TaskIO`, `Provider`, `CompletionRequest/Chunk`,
  `PipelineEvent`, `TaskMetrics`, `PipelineMetrics`, `RelayConfig`. `effort` optionnel
  (Haiku), type de tâche `clarify`, `CompletionChunk` en union discriminée.

### `413e235` — chore(repo): monorepo pnpm + corrections doc (étape 1)

- Monorepo pnpm (`core`, `providers`, `cli`), tsconfig strict + project references, Vitest.
- `.env.example`, `.gitignore`, `relay.config.json`.
- Corrections doc vérifiées contre l'API : IDs de modèles, `effort` non envoyé pour Haiku,
  structured outputs pour le décomposeur, SQLite repoussé en v0.2, worker = agent exécutant.

---

### Environnement

- Node ≥ 22, pnpm 9. Stack datée 2026 : zod 4, TypeScript 7, vitest 5,
  `@anthropic-ai/sdk` 0.131.
