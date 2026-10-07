# HANDOFF — reprendre Relay

> **À lire en premier dans toute nouvelle session.** Mis à jour à chaque contribution.
> Dernière mise à jour : **2026-10-07** — fin de la **phase C**, en attente de validation.

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
| B | routage auto multi-comptes, besoins, stratégies, plafonds, journal | ✅ validé |
| **C** | écran **Réglages** (comptes, test/suppression de clés, catalogue, routage, budget), synthèse finale, coûts d'orchestration | ✅ codé, **en attente de validation** |
| D | **actions réelles** : dossier de travail, écriture de fichiers, commandes, panneaux Fichiers + Exécution, vérification + escalade ; **contrats partagés** dans le plan + champ `spec` par tâche | à faire |

**Prochaine action** : attendre la validation de la phase C, puis phase D (validation +
commit à la fin).

**Testé en réel** : Gemini et Groq paliers gratuits (modes auto et manuel, tâches mélangées
entre les deux comptes, synthèse). L'utilisateur a ajouté sa clé Groq le 2026-10-07.
**Jamais testé en réel** : DeepSeek, OpenRouter, Ollama, Anthropic API, Claude Code via Relay →
le rappeler à l'utilisateur, il a demandé qu'on s'en souvienne.

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

Clés : `.env` à la racine (jamais commité) ; `GEMINI_API_KEY` et `GROQ_API_KEY` sont
renseignées chez l'utilisateur. Réglages : `.relay/settings.json` (jamais commité). Claude Code
est connecté (abonnement) mais **à ne pas utiliser pour les tests** (désactivé par défaut en auto).

## Carte du code

| Package | Rôle | Fichiers clés |
|---|---|---|
| `core` | moteur | `types.ts` (contrat), `catalog.ts` (profils modèles), `decomposer/` (plan + besoins), `router/index.ts` (manuel), `router/auto.ts` (AutoRouter, TaskRouting), `router/health.ts`, `executor/` (routage par candidats, repli, journal), `errors.ts`, `metrics/`, `config.ts` |
| `providers` | adaptateurs LLM | `anthropic.ts`, `claude-code.ts` (spawn `claude -p`), `openai-compatible.ts` (Gemini/Groq/…, repli, `reasoning_effort`), `factory.ts` (presets, `createProvider`, `autoPoolModels`, filtrage, suggestions) |
| `server` | API locale | `src/index.ts` : `/api/state`, `/api/models`, `/api/pool`, `/api/settings` (GET/PUT → `.relay/settings.json`), `/api/keys` (+ `/test`, `/delete`), `/api/run` (SSE, modes auto/manuel, synthèse, budget) |
| `web` | UI React + Vite | `App.tsx` (dockview, disposition v3, bouton Réglages), `store.tsx` (état partagé, réglages côté moteur), `panels.tsx` (Demande, Modèles, Pipeline, Tâche, Résultat, Coûts, Journal), `Settings.tsx` (Comptes et clés, Modèles, Routage, Général), `components.tsx`, `PipelineView.tsx` (graphe zoomable) |
| `desktop` | Electron | `main.cjs` : démarre le serveur en interne (port 47474, sinon libre) et ouvre la fenêtre |
| `cli` | ligne de commande | `src/index.ts` (`--provider`, `--model`) |

## Flux d'une exécution (mode auto)

1. L'UI envoie `POST /api/run {mode:"auto", strategy, policies}` ; le serveur complète avec
   les réglages (`.relay/settings.json` : budget, synthèse…).
2. Le serveur construit le **pool** : comptes prêts → modèles détectés (cache 10 min) →
   sélection éprouvée par compte (`autoPoolModels`) ± modèles retirés/ajoutés par
   l'utilisateur → plafonds appliqués.
3. Le **planificateur** est choisi par le même `AutoRouter` (niveau build, deep en Qualité),
   avec repli ; le décomposeur renvoie un plan (tâches, niveaux, besoins).
4. Pour chaque tâche, l'exécuteur prend les candidats classés : premier choix, puis replis
   (éventuellement chez un autre compte) ; la santé est mise à jour.
5. **Synthèse** (si activée) : un modèle build à long contexte assemble le livrable final.
   Plan et synthèse sont comptés dans les coûts (« dont orchestration »).
6. Tout est streamé en SSE : `task:route`, `task:start`, `task:done`, `log`,
   `pipeline:synthesis`, `pipeline:done`…

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
- **Groq gratuit (catalogue 2026)** : les Llama 3 ont été retirés ; modèles utiles
  `openai/gpt-oss-120b` (build) et `openai/gpt-oss-20b` (quick). Petite limite de tokens par
  minute → les grosses requêtes (synthèse) renvoient 413 « too_large » → repli sur Gemini.
- Les catalogues des fournisseurs changent souvent : préférer des **familles** dans
  `core/catalog.ts` plutôt que des noms figés ; vérifier avec `GET /api/pool` (champ `available`).
- Disposition dockview mémorisée sous `relay.layout.v3` : **incrémenter la clé** si la liste
  des panneaux change.
- Un run réel a une fois dépassé le délai sans cause reproductible (fournisseur lent) ; les
  timeouts (60 s par requête, 3 candidats max) bornent la durée par tâche.

## Où trouver quoi

- Vision et roadmap SemVer : [`PRODUCT.md`](../PRODUCT.md)
- Architecture : [`ARCHITECTURE.md`](ARCHITECTURE.md) · fournisseurs : [`PROVIDERS.md`](PROVIDERS.md)
- Prompt du décomposeur : [`DECOMPOSER-PROMPT.md`](DECOMPOSER-PROMPT.md)
- Historique résumé : [`CHANGELOG.md`](../CHANGELOG.md) · détaillé : [`contributions/`](contributions/README.md)
