# Inspirations et briques existantes

Tout ce qui existe, ce qu'on peut en tirer, et ce qu'on construit nous-mêmes.

---

## 1. Orchestrateurs multi-agents (l'inspiration directe)

### CrewAI — Python
**Ce que c'est :** Framework pour créer des équipes d'agents IA autonomes.
Chaque agent a un rôle, un objectif et des outils. Les tâches déclarent leurs
dépendances et s'exécutent en séquentiel ou hiérarchique.

**Ce qu'on prend :**
- Le concept Agent + Task + Crew (chez nous : Worker + Task + Pipeline)
- Les Flows avec décorateurs `@start`, `@listen`, `@router` pour le routing conditionnel
- L'état typé (Pydantic) qui traverse le pipeline — chez nous TypeScript + Zod
- Les exemples concrets : écriture de livre avec chapitres en parallèle, boucles
  d'auto-évaluation, lead scoring avec humain dans la boucle

**Ce qu'on ne prend pas :**
- C'est Python, nous c'est TypeScript
- Le routing n'est pas automatique : c'est le dev qui assigne les agents manuellement
- Pas de routing par coût/modèle — tous les agents utilisent le même LLM

**Repo :** github.com/crewAIInc/crewAI

---

### AutoGen (Microsoft) — Python/.NET
**Ce que c'est :** Framework multi-agents avec chat entre agents (2 agents, groupe),
et une couche Flows événementielle. Initialement recherche Microsoft, maintenant
en maintenance (remplacé par Microsoft Agent Framework).

**Ce qu'on prend :**
- L'idée d'AgentTool : envelopper un agent comme un outil appelable par un autre agent
- L'architecture en couches : Core (messages) → AgentChat (patterns) → Extensions
- AutoGen Bench pour le benchmarking — on fera pareil pour mesurer notre routing

**Ce qu'on ne prend pas :**
- En maintenance, pas de futur
- Architecture trop complexe pour ce qu'on veut

**Repo :** github.com/microsoft/autogen

---

### Cline — TypeScript
**Ce que c'est :** Agent de code autonome dans l'IDE (VS Code, JetBrains, CLI, desktop).
SDK partagé entre toutes les interfaces. Support multi-modèles.

**Ce qu'on prend :**
- **Le mode Plan/Act** : séparer la réflexion de l'exécution, exactement notre
  Decomposer → Executor. Cline prouve que ça marche pour le code.
- **SDK unifié** pour CLI, desktop, IDE — notre `core` fait pareil
- Le système de plugins (tools enregistrés programmatiquement) et les hooks de lifecycle
- `.clinerules` = notre `relay.config.json` par projet
- **Multi-agent coordination** : un coordinateur décompose le travail en sous-tâches
  déléguées à des agents spécialistes — exactement notre modèle

**Ce qu'on ne prend pas :**
- Cline ne route pas entre modèles automatiquement
- Pas de métriques de coût intégrées

**Repo :** github.com/cline/cline — **À étudier en profondeur, le plus proche de nous**

---

## 2. Abstraction multi-fournisseurs (la couche providers)

### Vercel AI SDK — TypeScript
**Ce que c'est :** SDK TypeScript pour appeler n'importe quel LLM avec une API unifiée.
`generateText`, `streamText`, `generateObject` avec validation Zod.

**Ce qu'on prend :**
- **L'abstraction provider** : un string `'anthropic/claude-opus-5-5'` suffit pour
  changer de modèle. On peut s'en servir directement comme couche providers au lieu
  d'écrire nos propres adaptateurs.
- `generateObject` avec schéma Zod pour les sorties structurées du décomposeur
- Le streaming natif avec hooks React pour la future UI
- Déjà en TypeScript, compatible avec notre stack

**Verdict : S'INSPIRER mais ne pas utiliser.** Le cœur de Relay c'est l'orchestration
LLM — on doit contrôler chaque ligne de la couche providers. Écrire un adaptateur
sur le SDK officiel c'est ~200 lignes, et on maîtrise le costing, le streaming et
les erreurs. Mais les patterns de Vercel AI SDK (generateObject + Zod, streaming
AsyncIterable) sont bons à reprendre dans notre propre code.

**Repo :** github.com/vercel/ai

---

### LiteLLM — Python (proxy)
**Ce que c'est :** Proxy/gateway qui unifie 100+ providers LLM en format OpenAI.
Auto-router intégré, retry, fallback, load balancing, tracking de coûts.

**Ce qu'on prend :**
- Le concept d'Auto Router avec tiers et escalade — c'est ce qu'on construit
- Le tracking de coûts par provider intégré
- La gestion des retries et fallbacks

**Ce qu'on ne prend pas :**
- C'est un proxy Python, pas un SDK TypeScript
- On pourrait l'utiliser comme backend mais ça ajoute une dépendance lourde
- On préfère le Vercel AI SDK côté code

**Repo :** github.com/BerriAI/litellm

---

### LibreChat — TypeScript/React
**Ce que c'est :** Chat IA self-hosted qui unifie tous les providers dans une interface.
Switch de modèle en plein milieu d'une conversation, branching de messages.

**Ce qu'on prend :**
- Le **switch de modèle mid-conversation** — pertinent pour notre escalade
- Le branching de conversations (fork) — on pourrait forker un pipeline en échec
- L'architecture d'abstraction des endpoints
- C'est TypeScript/React, on peut regarder le code directement

**Repo :** github.com/danny-avila/LibreChat

---

## 3. Routing intelligent (le cerveau du routeur)

### RouteLLM — Python
**Ce que c'est :** Framework qui route les requêtes entre un modèle fort et un modèle
faible selon la complexité du prompt. Réduit les coûts de 85% en gardant 95% de la
qualité de GPT-4.

**Ce qu'on prend :**
- Le concept de **seuil de routing** : score de difficulté → modèle fort ou faible
- Les types de routeurs : matrix factorization (le meilleur), BERT classifier,
  semantic weighted ranking
- Le fait que c'est un drop-in replacement pour le client OpenAI — même pattern
- La calibration du seuil sur des données réelles

**Ce qu'on ne prend pas :**
- C'est du routing par prompt (1 prompt → 1 modèle), pas par sous-tâche
- Pas de décomposition
- Le playbook note que RouteLLM n'a plus de commits depuis août 2024
- Mais les algorithmes sont réutilisables conceptuellement

**Repo :** github.com/lm-sys/RouteLLM

---

### Plano (ex-Arch Gateway) — Envoy/Rust
**Ce que c'est :** Proxy IA natif construit sur Envoy. Route par nom de modèle,
alias sémantique ou préférences. Utilise un modèle de routing de 4B paramètres
(plano_orchestrator) pour la sélection d'agents.

**Ce qu'on prend :**
- L'idée de **déclarer les agents en YAML** et laisser le proxy router
- Le modèle de routing dédié (4B params) qui route à faible coût/latence
- Le tracing OpenTelemetry automatique de bout en bout
- Les guardrails comme filter chains

**Ce qu'on ne prend pas :**
- C'est un proxy réseau (Envoy), pas un orchestrateur applicatif
- Trop bas niveau pour notre cas d'usage v0.1

**Repo :** github.com/katanemo/archgw

---

## 4. Exécution durable de pipelines (le moteur d'exécution)

### Inngest — TypeScript
**Ce que c'est :** Plateforme d'orchestration de workflows durables. Les fonctions
sont découpées en steps, chaque step est automatiquement retried en cas d'échec,
et l'état persiste entre les steps.

**Ce qu'on prend :**
- **Le concept de step functions** : chaque tâche = un step durable avec retry
  automatique. Si une tâche échoue, on reprend à cette tâche, pas depuis le début.
- `waitForEvent` pour mettre en pause le pipeline en attendant une validation humaine
- Le support de fonctions longues (des mois) — utile pour les gros pipelines
- **C'est TypeScript natif** — on pourrait l'utiliser comme moteur d'exécution

**Verdict : CONSIDÉRER pour v0.2+.** Pour v0.1 on fait notre propre exécuteur simple.
Si on a besoin de durabilité (reprendre après un crash), Inngest est la meilleure
option en TypeScript.

**Repo :** github.com/inngest/inngest

---

### Temporal — Go (SDK multi-langages)
**Ce que c'est :** Plateforme d'exécution durable. Les workflows sont résilients :
retry automatique, reprise après crash, état persisté. Utilisé en production par
Uber, Netflix, Snap.

**Ce qu'on prend :**
- Le concept Workflow → Activities → Workers
- La résilience automatique sans code d'erreur explicite

**Ce qu'on ne prend pas :**
- Nécessite un serveur Temporal séparé — trop lourd pour une app locale
- Inngest fait pareil en plus léger et en TypeScript natif

**Repo :** github.com/temporalio/temporal

---

### Prefect — Python
**Ce que c'est :** Orchestrateur de workflows DAG en Python. Décorateurs `@task`
et `@flow`, dépendances implicites, retries, caching, UI de monitoring.

**Ce qu'on prend :**
- L'approche décoratrice pour définir les tâches et leurs dépendances — simple et lisible
- Le caching pour éviter de re-exécuter les tâches réussies
- L'UI de monitoring en temps réel

**Ce qu'on ne prend pas :**
- C'est Python et orienté data pipelines, pas agents IA
- Mais les concepts sont les mêmes

**Repo :** github.com/prefecthq/prefect

---

## 5. Machines à états (la logique du pipeline)

### XState — TypeScript
**Ce que c'est :** Bibliothèque de machines à états et statecharts en TypeScript.
Zéro dépendance. Gère des workflows complexes avec états parallèles, hiérarchiques,
transitions conditionnelles.

**Ce qu'on prend :**
- **Les états parallèles** pour modéliser les tâches indépendantes du DAG
- Les transitions conditionnelles (PASS → suite, FAIL → escalade)
- Le contexte typé qui traverse les transitions (= nos résultats de tâches)
- **Stately Studio** : éditeur visuel de machines à états — pourrait être la base
  de notre visualisation de pipeline
- Zéro dépendance, TypeScript natif, mature

**Verdict : CONSIDÉRER pour le moteur de pipeline.** XState pourrait modéliser
élégamment notre DAG de tâches avec ses états parallèles et ses transitions
conditionnelles. Chaque tâche = un état, chaque résultat = une transition.

**Repo :** github.com/statelyai/xstate

---

## 6. Observabilité et métriques (ce que l'utilisateur voit)

### Laminar — Rust/TypeScript
**Ce que c'est :** Plateforme d'observabilité open-source pour agents IA. Tracing
OpenTelemetry natif, compression 20x, recherche full-text sur les spans, détection
de signaux en langage naturel ("l'agent tourne en boucle").

**Ce qu'on prend :**
- La **détection de signaux en langage naturel** : décrire un comportement à tracker
  ("le pipeline escalade trop souvent sur les tests") → alerte
- Le tracing OpenTelemetry — standard ouvert, compatible avec tout
- La compression des traces pour le stockage
- Le framework d'évaluation avec UI de comparaison

**Verdict : INTÉGRER en v0.3+ pour le dashboard.** On trace en OpenTelemetry dès
v0.1 et on branche Laminar quand on aura la UI.

**Repo :** github.com/lmnr-ai/lmnr

---

### AgentOps — Python
**Ce que c'est :** SDK d'observabilité pour agents IA. Tracking automatique des
coûts, tokens, durée, erreurs. Session replays pour rejouer un workflow step by step.

**Ce qu'on prend :**
- Les **session replays** : enregistrer et rejouer un pipeline entier pour debug
- Le tracking automatique des coûts par provider
- La détection de prompt injection — utile pour la sécurité
- Les graphes d'exécution visuels

**Ce qu'on ne prend pas :**
- C'est un SaaS Python, pas un SDK TypeScript
- Mais les concepts se transposent directement dans notre MetricsStore

**Repo :** github.com/AgentOps-AI/agentops

---

## 7. Sorties structurées (la colle entre les tâches)

### PydanticAI — Python
**Ce que c'est :** SDK d'agents IA avec typage de bout en bout. Chaque agent déclare
un `output_type` (modèle Pydantic) et le framework valide automatiquement la réponse
du LLM.

**Ce qu'on prend :**
- Le pattern `output_type` → validation automatique. Chez nous : chaque tâche déclare
  son schéma de sortie (Zod) et le résultat est validé avant d'être passé à la suite.
- L'injection de dépendances via `RunContext` — propre et testable
- La composition de capabilities (tools + instructions + hooks)

**En TypeScript :** Le Vercel AI SDK fait la même chose avec `generateObject` + Zod.

**Repo :** github.com/pydantic/pydantic-ai

---

## 8. Morphy (là d'où tu viens)

**Ce que c'est :** App desktop canvas avec Claude Code intégré. Agents multi-providers
(Claude, Codex, Grok, Copilot, Ollama…), cartes HTML, orchestration via `morph-ctl.mjs`.

**Ce qu'on prend :**
- Le concept de **canvas avec cartes** — notre dashboard pourrait être un canvas
- L'orchestration multi-providers via `spawn` / `send` / `results`
- Le system de `card-generators.json` pour le refresh automatique
- Le focus mode (contextes de travail)

**Ce qu'on ajoute :**
- Le routing AUTOMATIQUE (Morphy c'est toi qui choisis quel agent)
- La décomposition du prompt en sous-tâches
- Les métriques de coût et d'économie
- La vérification et l'escalade automatiques

---

## Résumé : la stack recommandée pour Relay v0.1

| Couche | Brique | Source |
|---|---|---|
| **Providers** | Nos adaptateurs sur SDK officiels | Construire (~200 lignes/provider) |
| **Sorties structurées** | Zod + JSON parsing maison | Construire |
| **Décomposeur** | Notre prompt + `generateObject` | Construire |
| **Routeur** | Notre logique de tiers | Construire (inspiré RouteLLM) |
| **Exécuteur** | Notre DAG séquentiel | Construire (inspiré Inngest) |
| **Machine à états** | Optionnel XState | Considérer pour v0.2 |
| **Métriques** | SQLite + nos types | Construire (inspiré AgentOps) |
| **Tracing** | OpenTelemetry | Standard, intégrer tôt |
| **CLI** | Notre interface | Construire |
| **Dashboard** | React + Vite | v0.3 (inspiré Laminar) |

**Briques à NE PAS reconstruire :** la validation de schéma (Zod), le tracing
(OpenTelemetry).

**Briques à construire nous-mêmes :** les adaptateurs providers (~200 lignes chacun,
contrôle total sur le costing et le streaming), le décomposeur (c'est le produit),
le routeur (c'est la valeur), l'exécuteur (simple en v0.1), les métriques (spécifiques
à nos besoins).
