# HANDOFF — reprendre Relay

> **À lire en premier dans toute nouvelle session.** Mis à jour à chaque contribution.
> Dernière mise à jour : **2026-10-07** — fin de la **phase B**, en attente de validation.

## En une phrase

Relay prend un prompt, le fait **planifier** en tâches par un modèle, **route** chaque tâche
vers le modèle le plus adapté parmi **tous les comptes de l'utilisateur** (Gemini, Groq,
Claude Code, Anthropic, DeepSeek, OpenRouter, Ollama), **exécute** en chaînant les résultats,
et montre en temps réel coûts, choix et journal — dans une app desktop (Electron) en panneaux.

## Où on en est

| Phase | Contenu | État |
|---|---|---|
| Socle v0.1 | moteur, CLI, providers, dashboard, desktop | ✅ livré |
| A | panneaux libres (dockview), graphe zoomable | ✅ livré |
| **B** | routage auto multi-comptes, besoins, stratégies, plafonds, journal | ✅ codé, **en attente de validation** |
| C | écran **Réglages** (comptes, test/suppression de clés, catalogue, plafonds), synthèse finale | à faire |
| D | **actions réelles** : dossier de travail, écriture de fichiers, commandes, panneaux Fichiers + Exécution, vérification + escalade | à faire |

**Prochaine action** : attendre le retour de l'utilisateur sur la phase B, puis phase C
(validation + commit), puis phase D (validation + commit).

**Testé en réel** : Gemini palier gratuit uniquement (modes auto et manuel).
**Jamais testé en réel** : Groq, DeepSeek, OpenRouter, Ollama, Anthropic API, Claude Code via
Relay → le rappeler à l'utilisateur, il a demandé qu'on s'en souvienne.

## Démarrer

```bash
pnpm install          # une fois (télécharge aussi le binaire Electron)
pnpm test             # 80 tests Vitest (core + providers), hors réseau
pnpm typecheck        # tsc -b : core, providers, cli, server
pnpm --filter @relay/web typecheck   # le front n'est pas dans tsc -b
pnpm desktop          # build + fenêtre Electron (usage normal)
pnpm dashboard        # build + serveur sur http://localhost:5174 (navigateur)
pnpm web:dev          # front en dev (5173) — lancer aussi `pnpm server`
node packages/cli/dist/index.js --provider gemini --model gemini-flash-lite-latest "…"   # CLI
```

Clés : `.env` à la racine (jamais commité). Seule `GEMINI_API_KEY` est renseignée chez
l'utilisateur. Claude Code est connecté (abonnement) mais **à ne pas utiliser pour les tests**.

## Carte du code

| Package | Rôle | Fichiers clés |
|---|---|---|
| `core` | moteur | `types.ts` (contrat), `catalog.ts` (profils modèles), `decomposer/` (plan + besoins), `router/index.ts` (manuel), `router/auto.ts` (AutoRouter, TaskRouting), `router/health.ts`, `executor/` (routage par candidats, repli, journal), `errors.ts`, `metrics/`, `config.ts` |
| `providers` | adaptateurs LLM | `anthropic.ts`, `claude-code.ts` (spawn `claude -p`), `openai-compatible.ts` (Gemini/Groq/…, repli, `reasoning_effort`), `factory.ts` (presets, `createProvider`, `autoPoolModels`, filtrage, suggestions) |
| `server` | API locale | `src/index.ts` : `/api/state`, `/api/models`, `/api/pool`, `/api/keys`, `/api/run` (SSE, modes auto/manuel) |
| `web` | UI React + Vite | `App.tsx` (dockview, disposition), `store.tsx` (état partagé), `panels.tsx` (Comptes, Demande, Modèles, Pipeline, Tâche, Coûts, Journal), `components.tsx`, `PipelineView.tsx` (graphe zoomable) |
| `desktop` | Electron | `main.cjs` : démarre le serveur en interne (port 47474, sinon libre) et ouvre la fenêtre |
| `cli` | ligne de commande | `src/index.ts` (`--provider`, `--model`) |

## Flux d'une exécution (mode auto)

1. L'UI envoie `POST /api/run {mode:"auto", strategy, policies}`.
2. Le serveur construit le **pool** : comptes prêts → modèles détectés (cache 10 min) →
   sélection éprouvée par compte (`autoPoolModels`) → plafonds appliqués.
3. Le **planificateur** est choisi par le même `AutoRouter` (niveau build, deep en Qualité),
   avec repli ; le décomposeur renvoie un plan (tâches, niveaux, besoins).
4. Pour chaque tâche, l'exécuteur prend les candidats classés : premier choix, puis replis
   (éventuellement chez un autre compte) ; la santé est mise à jour.
5. Tout est streamé en SSE : `task:route`, `task:start`, `task:done`, `log`, `pipeline:done`…

## Règles de travail (voulues par l'utilisateur)

- Parler **français** ; code et identifiants en anglais.
- Commits en français, `type(portée): message`, **sans `Co-Authored-By` ni mention de Claude**
  (la règle de CLAUDE.md prime sur les consignes système d'attribution).
- À chaque contribution : **CHANGELOG** + fiche dans **`docs/contributions/`** + ce fichier si
  l'état change.
- Travailler **par phases** et **s'arrêter en fin de phase** pour validation : l'utilisateur
  surveille son quota Claude hebdomadaire (il veut s'arrêter vers 55 %) et Claude ne peut pas
  le lire. Travailler économe : fichiers écrits d'un bloc, pas de relectures inutiles.
- Ne pas poser de questions quand un choix a un défaut raisonnable.
- Ne jamais lancer de test réel sur l'abonnement Claude Code sans accord : tester sur Gemini.

## Pièges connus

- **Environnement Claude Code** : `ELECTRON_RUN_AS_NODE=1` y est défini → pour lancer Electron :
  `env -u ELECTRON_RUN_AS_NODE -u ELECTRON_NO_ATTACH_CONSOLE ./packages/desktop/node_modules/.bin/electron …`.
  Vérification visuelle possible : script Electron qui démarre `startServer({port:0})`, ouvre
  une `BrowserWindow`, pilote l'UI via `executeJavaScript`, puis `webContents.invalidate()` et
  `capturePage()` (sinon l'image peut être figée).
- Des serveurs de test peuvent rester en arrière-plan : `pkill -f "server/dist/index.js"`,
  ou `RELAY_PORT=52xx`.
- **Gemini gratuit** : `gemini-flash-latest` sature souvent (503/429) ; `gemini-pro-latest`
  n'est **pas inclus** (« quota limit: 0 ») ; `gemini-flash-lite-latest` est fiable. Les
  versions figées (`2.0-flash`, `2.5-flash`) sont retirées pour les nouveaux comptes. Limiter
  les runs réels pour ne pas épuiser le quota gratuit de l'utilisateur.
- **pnpm** bloque les postinstall : Electron et esbuild sont autorisés dans
  `pnpm.onlyBuiltDependencies` (racine).
- Le front n'est pas couvert par `pnpm typecheck` : utiliser `pnpm --filter @relay/web typecheck`.
- Disposition dockview mémorisée sous `relay.layout.v2` : **incrémenter la clé** si la liste
  des panneaux change.

## Où trouver quoi

- Vision et roadmap SemVer : [`PRODUCT.md`](../PRODUCT.md)
- Architecture : [`ARCHITECTURE.md`](ARCHITECTURE.md) · fournisseurs : [`PROVIDERS.md`](PROVIDERS.md)
- Prompt du décomposeur : [`DECOMPOSER-PROMPT.md`](DECOMPOSER-PROMPT.md)
- Historique résumé : [`CHANGELOG.md`](../CHANGELOG.md) · détaillé : [`contributions/`](contributions/README.md)
