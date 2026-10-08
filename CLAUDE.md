# Relay — orchestrateur de pipeline agentique

Un prompt → décomposition automatique → routing intelligent → exécution chaînée → métriques.
Desktop, web et mobile.

## Reprise du projet et suivi

- **Nouvelle session : lire d'abord [docs/HANDOFF.md](docs/HANDOFF.md)** — état, commandes,
  pièges connus, règles de travail, prochaine étape.
- À chaque contribution, dans le même commit : [CHANGELOG.md](CHANGELOG.md) + une fiche dans
  [docs/contributions/](docs/contributions/README.md) + `docs/HANDOFF.md` si l'état change.
- Travailler par phases et s'arrêter en fin de phase pour validation de l'utilisateur.

## Stack technique

- TypeScript strict, monorepo pnpm (`packages/`)
- `core` : moteur de pipeline — décomposeur, routeur, exécuteur, moniteur, métriques
- `providers` : adaptateurs LLM (Anthropic, OpenAI, Ollama, OpenRouter)
- `cli` : interface ligne de commande (v0.1)
- `web` : dashboard React + Vite (v0.3)
- `desktop` : Electron (v0.4)
- Tests : Vitest — chaque composant a ses tests
- Métriques : SQLite via `node:sqlite` (intégré à Node et à Electron, aucun module natif)

## Langue

- Parler à l'utilisateur en français.
- Code, identifiants et types en anglais.
- Messages de commit en français, format `type(portée): message`.

## Commits

- Petits commits cohérents.
- Aucune ligne `Co-Authored-By` ni mention de Claude.
- Tests verts avant chaque commit.

## Architecture

Voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) pour le détail complet.

### Concepts clés

- **Pipeline** : DAG de tâches généré depuis un prompt
- **Task** : unité de travail avec entrée, sortie, modèle assigné et statut
- **Decomposer** : transforme un prompt en pipeline structuré (le cerveau du système)
- **Router** : assigne modèle + effort à chaque tâche selon son tier
- **Executor** : lance les tâches dans l'ordre topologique, chaîne les résultats.
  Chaque worker est un **agent exécutant** : via une boucle d'outils (lecture/écriture
  de fichiers + shell), il peut planifier, générer **et appliquer** son travail sur le
  disque, puis vérifier (tests/lint). Ce n'est pas un simple appel `complete()`.
- **Monitor** : flux d'événements temps réel consommé par toutes les interfaces
- **MetricsStore** : coût, tokens, temps, taux de succès, économies vs baseline

### Tiers de routage

| Tier | Usage | Modèle par défaut | ID | Effort |
|---|---|---|---|---|
| `quick` | Fichiers, format, tests simples | Haiku 4.5 | `claude-haiku-4-5` | — (pas d'`effort`) |
| `build` | Features, bug fixes, code standard | Sonnet 5.5 | `claude-sonnet-5-5` | `medium` |
| `deep` | Architecture, migrations, auth, flou | Opus 5.5 | `claude-opus-5-5` | `high` |
| `escalate` | Après un échec vérifié | Fable 5.1 | `claude-fable-5-1` | `high` |

> **Pièges API (vérifiés)** : les IDs de modèles ne prennent **jamais** de suffixe de date
> (`claude-haiku-4-5`, pas `...-20251001`). Haiku 4.5 **ne supporte pas** le paramètre
> `effort` : l'adaptateur ne doit pas l'envoyer pour ce modèle. Sur Sonnet 5.5 / Opus 5.5 /
> Fable 5.1, le thinking ne se désactive pas et `budget_tokens` est rejeté : utiliser
> `thinking: {type:"adaptive"}` et piloter la profondeur via `effort`. Le `tool_choice`
> forcé est aussi rejeté sur ces modèles → le décomposeur produit son JSON via les
> **structured outputs** (`output_config.format` + schéma Zod), pas via un tool forcé.

### Fournisseurs

L'abstraction `Provider` isole le moteur des API. Priorité :
1. Anthropic (v0.1) — Haiku, Sonnet, Opus, Fable
2. OpenAI (v0.2) — gamme GPT
3. Ollama (v0.2) — modèles locaux gratuits
4. Google Gemini (v0.2–v0.3) — gamme Gemini, palier gratuit
5. Perplexity (v0.3) — Sonar
6. OpenRouter (v0.3) — tous modèles, **fallback only** (marge)

**Règle multi-fournisseurs** (détail : [docs/PROVIDERS.md](docs/PROVIDERS.md)) :
appel **direct** à chaque API native avec la **clé de l'utilisateur** → prix exact,
**zéro marge**. Pas d'agrégateur par défaut. Les **abonnements grand public**
(ChatGPT Plus, Gemini Advanced…) ne sont **pas** routables (pas d'API, contre CGU) :
« connecter un compte » = coller une clé API. Le choix de route reste **local et
quasi-gratuit** (registre + heuristique, jamais un gros appel LLM).

## Dépendances

- **Zod** : validation des sorties du décomposeur et des résultats de tâches.
- **SQLite** : métriques locales, historique des appels et des runs (`.relay/relay.db`) via
  `node:sqlite`, intégré à Node 22+ et à Electron — pas de better-sqlite3 (module natif à
  recompiler pour Electron).
- Les adaptateurs LLM (Anthropic, OpenAI, Ollama) sont écrits par nous, directement
  sur les SDK officiels (`@anthropic-ai/sdk`, `openai`). Pas de couche d'abstraction
  tierce — le cœur du produit c'est l'orchestration, on contrôle chaque ligne.
- Voir [docs/INSPIRATIONS.md](docs/INSPIRATIONS.md) pour les briques étudiées et les choix.

## Règles de code

- Construire ce qui est nécessaire maintenant ; pas de sur-ingénierie.
- Interfaces TypeScript claires entre composants ; les types sont le contrat.
- Événements du pipeline typés et streamés (`AsyncIterableIterator`).
- Clés API dans `.env` uniquement, jamais dans le code ni les tests.
- Zéro dépendance inutile au-delà de celles listées ci-dessus.

## Règles de design (quand il y aura une UI)

- L'utilisateur voit **en temps réel** chaque tâche : quel modèle, quel coût, quel résultat.
- Le DAG du pipeline est visualisé (nœuds + flèches), pas juste une liste.
- Les métriques sont toujours visibles : coût total, économies vs baseline, temps.
- Tout est configurable : routes, modèles, seuils d'escalade, providers.
- Dark mode par défaut.

## Versions

SemVer. Voir [PRODUCT.md](PRODUCT.md) pour la roadmap détaillée.
- `0.1.0` — CLI proof of concept (un provider, séquentiel)
- `0.2.0` — multi-providers, parallélisme, escalade automatique
- `0.3.0` — dashboard web
- `0.4.0` — app desktop
- `1.0.0` — stable, toutes plateformes
