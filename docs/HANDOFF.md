# HANDOFF — reprendre Relay

> **À lire en premier dans toute nouvelle session.** Mis à jour à chaque contribution.
> Dernière mise à jour : **2026-10-07** — fin de la **phase D**, en attente de validation.

## En une phrase

Relay prend un prompt, le fait **planifier** en tâches par un modèle, **route** chaque tâche
vers le modèle le plus adapté parmi **tous les comptes de l'utilisateur** (Gemini, Groq,
Claude Code, Anthropic, DeepSeek, OpenRouter, Ollama), **exécute** en chaînant les résultats,
et montre en temps réel coûts, choix et journal — dans une app desktop (Electron) en panneaux.
Depuis la phase D, chaque tâche est un **agent exécutant** : il écrit de vrais fichiers dans un
dossier par run, lance des commandes (tests) et corrige ; l'utilisateur voit et teste le résultat.

## Où on en est

| Phase | Contenu | État |
|---|---|---|
| Socle v0.1 | moteur, CLI, providers, dashboard, desktop | ✅ livré |
| A | panneaux libres (dockview), graphe zoomable | ✅ livré |
| B | routage auto multi-comptes, besoins, stratégies, plafonds, journal | ✅ validé |
| C | écran **Réglages** (comptes, test/suppression de clés, catalogue, routage, budget), synthèse finale, coûts d'orchestration | ✅ validé |
| **D** | **actions réelles** : dossier de travail, fichiers, commandes (Prudent/Sûr/Libre), panneaux Fichiers + Exécution, vérification + escalade ; **contrats partagés** + `spec` par tâche | ✅ codé et testé en réel, **en attente de validation** |
| E (prochaine) | **activité visible** : animation dans le graphe (quel modèle travaille sur quoi, en direct), décisions du routeur animées, liées au journal | demandée par l'utilisateur, **après validation de D** |

**Prochaine action** : attendre la validation de la phase D, puis la phase « activité
visible » (l'utilisateur trouve difficile de savoir quand un modèle travaille).

**Testé en réel** : Gemini et Groq paliers gratuits (modes auto et manuel, tâches mélangées
entre les deux comptes, synthèse ; phase D : calculatrice Python écrite, testée par l'agent,
CLI lançable, 7/7 tâches en 42 s, 0 $). L'utilisateur a ajouté sa clé Groq le 2026-10-07.
**Jamais testé en réel** : DeepSeek, OpenRouter, Ollama, Anthropic API, Claude Code via Relay →
le rappeler à l'utilisateur, il a demandé qu'on s'en souvienne.

## Démarrer

```bash
pnpm install          # une fois (télécharge aussi le binaire Electron)
pnpm test             # 105 tests Vitest (core, providers, server), hors réseau
pnpm typecheck        # tsc -b : core, providers, cli, server
pnpm --filter @relay/web typecheck   # le front n'est pas dans tsc -b
pnpm desktop          # build + fenêtre Electron (usage normal)
pnpm dashboard        # build + serveur sur http://localhost:5174 (navigateur)
pnpm web:dev          # front en dev (5173) — lancer aussi `pnpm server`
node packages/cli/dist/index.js --provider gemini --model gemini-flash-lite-latest "…"   # CLI
```

Clés : `.env` à la racine (jamais commité) ; `GEMINI_API_KEY` et `GROQ_API_KEY` sont
renseignées chez l'utilisateur. Réglages : `.relay/settings.json` (jamais commité). Dossiers
des runs : `~/relay-workspaces/AAAAMMJJ-HHMMSS-sujet/` (réglable, hors dépôt). Claude Code
est connecté (abonnement) mais **à ne pas utiliser pour les tests** (désactivé par défaut en auto).

## Carte du code

| Package | Rôle | Fichiers clés |
|---|---|---|
| `core` | moteur | `types.ts` (contrat), `catalog.ts` (profils modèles), `decomposer/` (plan, besoins, contrats, spec), `router/index.ts` (manuel), `router/auto.ts` (AutoRouter, TaskRouting, escalade), `router/health.ts`, `executor/` (candidats, repli, patience, escalade, événements en direct via `emit`/`streamWhile`, synthèse), `agent/` (`agenticRunTask` : boucle agent), `workspace/` (`Workspace` confiné, protocole `===FILE===`, politiques et exécution des commandes), `errors.ts`, `metrics/`, `config.ts` |
| `providers` | adaptateurs LLM | `anthropic.ts`, `claude-code.ts` (spawn `claude -p`), `openai-compatible.ts` (Gemini/Groq/…, repli, `reasoning_effort`), `factory.ts` (presets, `createProvider`, `autoPoolModels`, filtrage, suggestions) |
| `server` | API locale | `src/index.ts` : `/api/state`, `/api/models`, `/api/pool`, `/api/settings` (GET/PUT → `.relay/settings.json`), `/api/keys` (+ `/test`, `/delete`), `/api/run` (SSE, modes auto/manuel, synthèse, budget, dossier de travail, validations), `/api/approve`, `/api/workspace/{runs,files,file,run,open}` ; `src/workspace.ts` (dossiers de run, confinement, outils installés, ouvrir dossier/VS Code) |
| `web` | UI React + Vite | `App.tsx` (dockview, disposition **v4**, bouton Réglages, bandeau de validation), `store.tsx` (état partagé, réglages côté moteur, fichiers/commandes/validations), `panels.tsx` (Demande, Modèles, Pipeline, Tâche, Résultat, Coûts, Journal), `workspace-panels.tsx` (Fichiers, Exécution, validations), `Settings.tsx` (Comptes et clés, Modèles, Routage, Général), `components.tsx`, `PipelineView.tsx` (graphe zoomable) |
| `desktop` | Electron | `main.cjs` : démarre le serveur en interne (port 47474, sinon libre) et ouvre la fenêtre |
| `cli` | ligne de commande | `src/index.ts` (`--provider`, `--model`) |

## Flux d'une exécution (mode auto)

1. L'UI envoie `POST /api/run {mode:"auto", strategy, policies}` ; le serveur complète avec
   les réglages (`.relay/settings.json` : budget, synthèse…).
2. Le serveur construit le **pool** : comptes prêts → modèles détectés (cache 10 min) →
   sélection éprouvée par compte (`autoPoolModels`) ± modèles retirés/ajoutés par
   l'utilisateur → plafonds appliqués.
3. Mode agent (défaut) : le serveur crée le **dossier du run**, détecte les outils installés
   (python3, pytest, node…) et annonce `workspace` à l'UI.
4. Le **planificateur** est choisi par le même `AutoRouter` (niveau build, deep en Qualité),
   avec repli ; il reçoit dossier + outils ; le plan contient tâches, niveaux, besoins,
   **contrats** et `spec`.
5. Pour chaque tâche, l'exécuteur prend les candidats classés (5 max) : premier choix, puis
   replis (éventuellement chez un autre compte), pause si tout est saturé avec un délai court.
   L'**agent** écrit les fichiers, lance les commandes (politique Prudent/Sûr/Libre), corrige
   (4 tours max) ; si les vérifications échouent encore → **escalade** une fois au niveau
   supérieur.
6. **Synthèse** (si activée) : avec un dossier, compte rendu (arborescence, commandes, état des
   tests) ; sinon livrable complet. Plan et synthèse comptés dans les coûts.
7. Tout est streamé en SSE, en direct : `task:route`, `task:start`, `file:write`,
   `command:start|done`, `approval:request|done`, `task:escalate`, `task:done`, `log`,
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
- Des serveurs de test peuvent rester en arrière-plan : `pkill -f "^node packages/server/dist/index.js"`
  (le `^` évite de tuer le shell qui lance la commande), ou `RELAY_PORT=52xx`.
- Dans les scripts de capture Electron, les **onglets dockview** s'activent au `pointerdown`
  (un simple `click()` ne change pas d'onglet).
- **Gemini gratuit** : `gemini-flash-latest` sature souvent (503/429) et n'a qu'environ
  **20 requêtes/jour** ; `gemini-pro-latest` n'est **pas inclus** (« quota limit: 0 ») ;
  `gemini-flash-lite-latest` est fiable. Les
  versions figées (`2.0-flash`, `2.5-flash`) sont retirées pour les nouveaux comptes. Limiter
  les runs réels pour ne pas épuiser le quota gratuit de l'utilisateur.
- **pnpm** bloque les postinstall : Electron et esbuild sont autorisés dans
  `pnpm.onlyBuiltDependencies` (racine).
- Le front n'est pas couvert par `pnpm typecheck` : utiliser `pnpm --filter @relay/web typecheck`.
- **Groq gratuit (catalogue 2026)** : les Llama 3 ont été retirés ; modèles utiles
  `openai/gpt-oss-120b` (build) et `openai/gpt-oss-20b` (quick). **8 000 tokens/minute** →
  429 « try again in 17 s » (Relay patiente) ou 413 « too_large » (repli). Les gpt-oss
  inventent parfois un appel d'outil (« model called a tool ») ou répondent vide → erreur
  `invalid_output` → repli automatique.
- Les catalogues des fournisseurs changent souvent : préférer des **familles** dans
  `core/catalog.ts` plutôt que des noms figés ; vérifier avec `GET /api/pool` (champ `available`).
- Disposition dockview mémorisée sous `relay.layout.v4` : **incrémenter la clé** si la liste
  des panneaux change.
- **Phase D, sécurité** : le confinement protège les écritures de l'agent ; une commande
  autorisée (python…) peut tout faire → le mode *Sûr* évite les erreurs, pas un code
  malveillant ; *Prudent* = contrôle total. Les commandes ne reçoivent jamais les clés API.
- Un run réel a une fois dépassé le délai sans cause reproductible (fournisseur lent) ; les
  timeouts (60 s par requête et par commande, 5 candidats max, 4 tours d'agent, 1 escalade)
  bornent la durée par tâche.

## Où trouver quoi

- Vision et roadmap SemVer : [`PRODUCT.md`](../PRODUCT.md)
- Architecture : [`ARCHITECTURE.md`](ARCHITECTURE.md) · fournisseurs : [`PROVIDERS.md`](PROVIDERS.md)
- Prompt du décomposeur : [`DECOMPOSER-PROMPT.md`](DECOMPOSER-PROMPT.md)
- Historique résumé : [`CHANGELOG.md`](../CHANGELOG.md) · détaillé : [`contributions/`](contributions/README.md)
