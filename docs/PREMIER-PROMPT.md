# Premier prompt pour Claude Code

Copie ce prompt dans Claude Code (VS Code) ouvert sur le dossier `~/relay`.

---

Je démarre le projet Relay — un orchestrateur de pipeline agentique.

Lis CLAUDE.md, PRODUCT.md et docs/ARCHITECTURE.md pour comprendre le projet.

On commence par la v0.1 : le CLI proof of concept. L'objectif est un `npx relay "prompt"` 
qui décompose le prompt en sous-tâches, route chaque tâche au bon modèle Anthropic, 
les exécute dans l'ordre et affiche les métriques.

On code tout nous-mêmes, directement sur les SDK officiels (`@anthropic-ai/sdk`, 
`openai`). Pas d'abstraction tierce — le cœur du produit c'est l'orchestration LLM, 
on contrôle chaque ligne. Zod pour les sorties structurées. Lis docs/INSPIRATIONS.md 
pour le contexte.

Étape 1 — initialise le monorepo :
- pnpm workspace avec packages/core, packages/providers, packages/cli
- tsconfig strict partagé
- Vitest configuré
- .env.example avec ANTHROPIC_API_KEY
- .gitignore propre
- relay.config.json avec les routes par défaut (Haiku/Sonnet/Opus)
- Dépendances v0.1 : `@anthropic-ai/sdk`, `zod` (pas de `better-sqlite3` — métriques en
  mémoire en v0.1, SQLite arrive en v0.2)

Étape 2 — packages/core/src/types.ts avec tous les types de l'architecture.

Étape 3 — packages/providers/src/anthropic.ts : notre adaptateur Anthropic.
Interface `Provider` avec `complete()` en `AsyncIterable<CompletionChunk>`, 
`estimateCost()` avec les vrais prix par modèle, et `countTokens()`. 
Directement sur `@anthropic-ai/sdk`, ~200 lignes max.

Étape 4 — packages/core/src/decomposer/ : le décomposeur avec son prompt système 
(voir docs/DECOMPOSER-PROMPT.md). Un appel à Sonnet qui produit le plan en JSON.

Étape 5 — packages/core/src/router/ : lit relay.config.json et assigne modèle + 
effort à chaque tâche selon son tier.

Étape 6 — packages/core/src/executor/ : exécute les tâches dans l'ordre 
topologique. Chaque tâche reçoit le prompt original, le plan, et les résultats 
de ses dépendances. Émet des événements PipelineEvent.

Étape 7 — packages/core/src/monitor/ : EventEmitter typé pour les PipelineEvent.

Étape 8 — packages/core/src/metrics/ : calcul des métriques (coût, tokens, temps, 
économies vs baseline).

Étape 9 — packages/cli/src/index.ts : le CLI qui assemble tout. Affiche le plan, 
les tâches en cours, et le tableau de métriques à la fin.

Étape 10 — tests unitaires pour le décomposeur (avec des prompts mockés), le 
routeur, et le calcul des métriques.

Fais les étapes 1 à 3 d'abord. Commite après chaque étape.
