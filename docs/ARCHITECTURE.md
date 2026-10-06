# Architecture technique

## Vue d'ensemble

```
Utilisateur
    │ prompt
    ▼
┌──────────────────────────────────────────────────┐
│                    Interface                      │
│            CLI · Web · Desktop · Mobile            │
├──────────────────────────────────────────────────┤
│                    Moniteur                        │
│     Événements typés, streamés en temps réel       │
├──────────────────────────────────────────────────┤
│                  Orchestrateur                     │
│   Décomposeur → Routeur → Exécuteur → Vérificateur │
├──────────────────────────────────────────────────┤
│                  Fournisseurs                      │
│       Anthropic · OpenAI · Ollama · OpenRouter      │
├──────────────────────────────────────────────────┤
│                   Métriques                        │
│            SQLite · Analytics · Logs                │
└──────────────────────────────────────────────────┘
```

## Flux d'exécution

```
Prompt ──▶ Décomposeur ──▶ Pipeline (DAG)
               │              │
               │         ┌────┴────┐
               │         ▼         ▼
               │     Tâche A    Tâche B    (indépendantes → parallèles)
               │         │         │
               │         └────┬────┘
               │              ▼
               │          Tâche C          (dépend de A et B)
               │              │
               │              ▼
               │          Tâche D          (tests)
               │              │
               ▼              ▼
           Routeur ──▶  Modèle assigné par tâche
                              │
                              ▼
                         Exécuteur
                              │
                         ┌────┴────┐
                         ▼         ▼
                       PASS      FAIL
                         │         │
                         ▼         ▼
                    Métriques   Escalade (effort++ puis modèle++)
                    + résultat      │
                                    └──▶ retry 1x ──▶ Métriques
```

## Types centraux

```typescript
// === Pipeline ===

interface Pipeline {
  id: string
  prompt: string
  context: ProjectContext
  tasks: Task[]
  status: 'pending' | 'running' | 'done' | 'failed'
  metrics?: PipelineMetrics
  created: Date
  finished?: Date
}

interface ProjectContext {
  cwd: string
  files?: string[]          // fichiers pertinents détectés ou fournis
  stack?: string[]           // langages, frameworks détectés
  conventions?: string       // extrait du CLAUDE.md ou équivalent
}

// === Tâche ===

type TaskType =
  | 'scaffold'       // créer des fichiers/dossiers
  | 'architecture'   // concevoir, planifier
  | 'implement'      // écrire le code
  | 'test'           // écrire les tests
  | 'verify'         // exécuter tests/lint/types
  | 'review'         // relire le résultat
  | 'format'         // formatter, renommer
  | 'document'       // écrire la doc

type RouteTier = 'quick' | 'build' | 'deep'

interface Task {
  id: string
  type: TaskType
  description: string
  tier: RouteTier
  dependsOn: string[]       // IDs des tâches prérequises
  input: TaskIO
  output?: TaskIO
  status: 'pending' | 'running' | 'done' | 'failed' | 'escalated'
  assignedModel?: string
  assignedEffort?: Effort
  attempts: TaskAttempt[]
}

interface TaskIO {
  summary: string            // résumé lisible
  files?: string[]           // fichiers créés ou modifiés
  data?: Record<string, unknown>
}

interface TaskAttempt {
  model: string
  effort: Effort
  success: boolean
  metrics: TaskMetrics
  result?: string
  error?: string
}

// === Routage ===

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

interface RouteConfig {
  quick:    ModelAssignment
  build:    ModelAssignment
  deep:     ModelAssignment
  escalate: ModelAssignment
}

interface ModelAssignment {
  provider: string
  model: string
  effort: Effort
  maxRetries?: number
}

// === Fournisseur ===

interface Provider {
  name: string
  models(): Promise<ModelInfo[]>
  complete(request: CompletionRequest): AsyncIterable<CompletionChunk>
  estimateCost(model: string, inputTokens: number, outputTokens: number): number
  countTokens(request: CompletionRequest): Promise<number>
}

interface CompletionRequest {
  model: string
  effort?: Effort
  system: string
  messages: Message[]
  tools?: ToolDefinition[]
  maxTokens?: number
}

interface CompletionChunk {
  type: 'text' | 'tool_use' | 'usage'
  text?: string
  toolUse?: { name: string; input: unknown }
  usage?: { inputTokens: number; outputTokens: number; thinkingTokens?: number }
}

// === Événements ===

type PipelineEvent =
  | { type: 'pipeline:start'; pipeline: Pipeline }
  | { type: 'pipeline:plan'; pipeline: Pipeline; tasks: Task[] }
  | { type: 'task:start'; taskId: string; model: string; effort: Effort }
  | { type: 'task:chunk'; taskId: string; text: string }
  | { type: 'task:done'; taskId: string; result: TaskIO; metrics: TaskMetrics }
  | { type: 'task:failed'; taskId: string; error: string; metrics: TaskMetrics }
  | { type: 'task:escalate'; taskId: string; from: ModelAssignment; to: ModelAssignment; reason: string }
  | { type: 'pipeline:done'; pipeline: Pipeline; metrics: PipelineMetrics }
  | { type: 'pipeline:failed'; pipeline: Pipeline; error: string }

// === Métriques ===

interface TaskMetrics {
  taskId: string
  model: string
  provider: string
  effort: Effort
  tier: RouteTier
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
  cost: number
  durationMs: number
  success: boolean
  escalated: boolean
}

interface PipelineMetrics {
  pipelineId: string
  totalCost: number
  totalTokens: number
  totalDurationMs: number
  taskCount: number
  successCount: number
  escalationCount: number
  baselineCost: number   // coût si tout avait tourné sur deep
  savings: number        // pourcentage d'économie
  costPerTask: TaskMetrics[]
}
```

## Composants détaillés

### 1. Décomposeur (`core/src/decomposer/`)

Le cerveau du système. Prend un prompt + contexte projet et produit un pipeline.

**Implémentation :** un appel LLM (Sonnet, effort medium) avec un prompt système
structuré qui :
- Analyse la demande et identifie les sous-tâches
- Assigne un type et un tier à chaque tâche
- Définit les dépendances (quel résultat alimente quelle tâche)
- Produit du JSON structuré

Le prompt du décomposeur est le cœur du produit. Il doit être :
- **Stable** : produire des plans cohérents pour des demandes similaires
- **Granulaire sans excès** : 3-8 tâches par pipeline, pas 20
- **Conscient du contexte** : adapter le plan aux fichiers existants, au stack

Voir `core/src/decomposer/system-prompt.ts` pour le prompt complet.

**Escalade du décomposeur lui-même :** si le prompt est ambigu, le décomposeur
peut produire une tâche `clarify` qui demande des précisions à l'utilisateur
avant de continuer.

### 2. Routeur (`core/src/router/`)

Lit la configuration des routes et assigne modèle + effort à chaque tâche.

**Configuration :** fichier `relay.config.json` à la racine du projet ou
`~/.relay/config.json` en global.

```json
{
  "routes": {
    "quick":    { "provider": "anthropic", "model": "claude-haiku-4-5" },
    "build":    { "provider": "anthropic", "model": "claude-sonnet-5-5", "effort": "medium" },
    "deep":     { "provider": "anthropic", "model": "claude-opus-5-5", "effort": "high" },
    "escalate": { "provider": "anthropic", "model": "claude-fable-5-1", "effort": "high" }
  },
  "providers": {
    "anthropic": { "apiKey": "${ANTHROPIC_API_KEY}" },
    "openai":    { "apiKey": "${OPENAI_API_KEY}" },
    "ollama":    { "baseUrl": "http://localhost:11434" }
  },
  "escalation": {
    "maxRetries": 1,
    "effortFirst": true
  },
  "decomposer": {
    "provider": "anthropic",
    "model": "claude-sonnet-5",
    "effort": "medium"
  }
}
```

### 3. Exécuteur (`core/src/executor/`)

Parcourt le DAG en ordre topologique. Pour chaque tâche :
1. Attend que toutes les dépendances soient terminées
2. Rassemble leurs sorties comme entrée
3. Construit le prompt de la tâche (description + contexte + entrées)
4. Appelle le provider via le modèle assigné
5. Émet des événements à chaque étape

**v0.1 :** exécution séquentielle (ordre topologique simple).
**v0.2 :** exécution parallèle (`Promise.all` sur les tâches sans dépendances
mutuelles).

### 4. Vérificateur (`core/src/verifier/`)

Après chaque tâche (ou à la fin du pipeline selon la config), exécute des
vérifications adaptées au type de tâche :

| Type | Vérifications |
|---|---|
| `implement` | Tests unitaires, typecheck |
| `test` | Les tests passent |
| `scaffold` | Les fichiers existent |
| `format` | Lint, prettier |

Sur FAIL : escalade selon la stratégie configurée (effort d'abord, modèle ensuite).

### 5. Moniteur (`core/src/monitor/`)

`EventEmitter` typé qui diffuse les `PipelineEvent` à tous les consommateurs :
- CLI : affichage en direct dans le terminal
- Web : WebSocket vers le dashboard
- Métriques : enregistrement en base
- Logs : fichier JSON rotatif

### 6. MetricsStore (`core/src/metrics/`)

SQLite locale. Tables principales :
- `pipelines` : un row par pipeline exécuté
- `tasks` : un row par tâche (avec le pipeline_id)
- `attempts` : un row par tentative (avec le task_id)

Requêtes pré-faites :
- Coût moyen par tier sur les 7/30/90 derniers jours
- Taux d'escalade par type de tâche
- Économies cumulées vs baseline
- Modèles les plus/moins efficaces par type

## Structure du monorepo

```
relay/
├── packages/
│   ├── core/
│   │   ├── src/
│   │   │   ├── decomposer/
│   │   │   │   ├── index.ts
│   │   │   │   └── system-prompt.ts    ← le prompt du décomposeur
│   │   │   ├── router/
│   │   │   │   └── index.ts
│   │   │   ├── executor/
│   │   │   │   └── index.ts
│   │   │   ├── verifier/
│   │   │   │   └── index.ts
│   │   │   ├── monitor/
│   │   │   │   └── index.ts
│   │   │   ├── metrics/
│   │   │   │   ├── store.ts
│   │   │   │   └── queries.ts
│   │   │   ├── types.ts                ← tous les types partagés
│   │   │   └── index.ts
│   │   ├── tests/
│   │   └── package.json
│   ├── providers/
│   │   ├── src/
│   │   │   ├── anthropic.ts
│   │   │   ├── openai.ts
│   │   │   ├── ollama.ts
│   │   │   ├── openrouter.ts
│   │   │   └── index.ts
│   │   ├── tests/
│   │   └── package.json
│   ├── cli/
│   │   ├── src/
│   │   │   └── index.ts
│   │   └── package.json
│   ├── web/                            (v0.3)
│   └── desktop/                        (v0.4)
├── relay.config.json
├── CLAUDE.md
├── PRODUCT.md
├── docs/
│   └── ARCHITECTURE.md
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.json
```

## Décisions techniques

1. **pnpm** plutôt que npm : workspaces natifs, rapide, strict.
2. **SQLite** pour les métriques : zéro config, embarqué, performant pour du local.
3. **AsyncIterable** pour le streaming : composable, natif, pas de dépendance.
4. **Un prompt système par composant** (décomposeur, chaque type de tâche) :
   itérable indépendamment sans casser le reste.
5. **Config JSON avec variables d'env** (`${VAR}`) : simple, pas de nouveau format.
6. **Pas de framework agent** (LangChain, CrewAI…) : on construit les briques
   nous-mêmes pour garder le contrôle et comprendre chaque coût.
