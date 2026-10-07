# 2026-10-07 — Phase D : actions réelles (fichiers, commandes, vérification, escalade)

- **Statut** : validée (l'utilisateur est passé à la suite le 2026-10-08)
- **Commits** : `b8e2163` (moteur) · `5232b1f` (moteur, robustesse après tests réels) ·
  `2110bda` (serveur) · `fc9e205` (interface) · docs

## Demande

« Est-ce que c'est possible de faire en sorte que les actions soient vraiment écrites ? Si je
demande *fais-moi une calculatrice en Python*, je veux pouvoir la voir et la tester. » Plus,
suite à la discussion QUOI / COMMENT : **contrats partagés** dans le plan et champ **`spec`**
optionnel par tâche. Le worker doit être « un agent exécutant capable de planifier, générer et
appliquer ».

## Ce qui a changé

- **Dossier de travail par run** : `~/relay-workspaces/AAAAMMJJ-HHMMSS-sujet/` (réglable),
  jamais réutilisé. Tous les chemins sont confinés (pas d'absolu, pas de `..`, pas de sortie
  par lien symbolique).
- **Agent exécutant** (`agenticRunTask`) : le modèle agit par un **protocole texte**
  (`===FILE: chemin===` … `===END===`, `===RUN: commande===`, `===READ: chemin===`) ; Relay
  écrit, lit, lance, renvoie les sorties ; le modèle corrige. Jusqu'à 4 tours par tâche.
  Protocole texte plutôt qu'appel d'outils natif : marche avec **tous** les fournisseurs
  (Gemini, Groq, Claude Code…) et groupe plusieurs fichiers par réponse (moins de tokens).
- **Commandes** : trois politiques — *Prudent* (chaque commande attend « Autoriser » dans un
  bandeau, refus au bout de 5 min), *Sûr* (défaut : outils de développement seulement),
  *Libre* (tout sauf la liste noire). Dans tous les modes : liste noire (sudo, `rm -rf /`,
  `curl | sh`, `git push`, ssh…), dossier du run comme cwd, **clés API retirées de
  l'environnement**, 60 s max, processus tué avec ses enfants, sortie bornée.
- **Vérification + escalade** : si des commandes échouent encore à la fin d'une tâche, elle est
  reprise **une fois** par un modèle du niveau supérieur (`TaskRouting.escalate`), avec la
  tentative précédente en contexte. Coûts et tokens des deux tentatives cumulés.
- **Événements en direct** : `file:write`, `command:start`, `command:done`, `task:escalate`
  (streamés pendant la tâche, pas à la fin) ; journal catégorie « Actions ».
- **Planificateur** : `contracts` (fichiers, signatures, commande de test) et `spec` par tâche ;
  règles 8 à 11 (actions réelles, point d'entrée exécutable si l'utilisateur veut lancer,
  langue de la demande) ; il reçoit les **outils installés** (python3, pytest ?, node…).
- **Synthèse** adaptée : avec un dossier, elle ne recopie plus le code mais explique
  arborescence, commandes pour lancer/tester, état des vérifications.
- **Interface** : panneau **Fichiers** (arbre + contenu numéroté, mise à jour en direct, runs
  précédents, « Ouvrir le dossier », « VS Code ») ; panneau **Exécution** (commandes des agents
  avec sortie, et les tiennes : *Exécuter* avec entrée clavier optionnelle, *Lancer (fenêtre)*
  pour une app graphique, reprise des commandes réussies des agents) ; bandeau de validation
  (mode Prudent) ; Tâche : fichiers écrits, commandes, escalade ; Réglages › Général : mode
  agent, dossier des runs, politique des commandes (explication honnête). Disposition v4.
- **Robustesse** (trouvée en testant pour de vrai) :
  - analyse ligne à ligne des blocs FILE (des blocs vides consécutifs étaient fusionnés) ;
    bloc sans `===END===` → non écrit et signalé ;
  - tâche qui décrit son travail sans écrire de fichier → relancée une fois ;
  - réponse vide (tout en réflexion) ou appel d'outil inventé (gpt-oss sur Groq :
    « model called a tool ») → nouveau type d'erreur `invalid_output` → repli ;
  - quotas par minute : si tous les modèles sont saturés et qu'un fournisseur annonce un délai
    court (« try again in 17 s », ≤ 30 s), Relay patiente puis réessaie ; la pénalité de santé
    suit le délai annoncé ; jusqu'à 5 modèles essayés par tâche (au lieu de 3).

## Fichiers touchés

| Fichier | Rôle |
|---|---|
| `packages/core/src/workspace/workspace.ts` | `Workspace` : confinement, écriture, lecture, liste, aperçu pour prompt |
| `packages/core/src/workspace/protocol.ts` | protocole d'action, `parseActions`, `condense` |
| `packages/core/src/workspace/commands.ts` | politiques, liste noire, `runCommand`, `launchCommand`, environnement sans secrets |
| `packages/core/src/agent/index.ts` | `agenticRunTask` : boucle agent, relances, validations |
| `packages/core/src/executor/index.ts` | `emit` + `streamWhile` (événements en direct), escalade, patience, réponses vides, synthèse avec dossier, contrats/spec dans le prompt |
| `packages/core/src/decomposer/` | `contracts`, `spec`, règles 6 et 8 à 11 |
| `packages/core/src/router/auto.ts`, `health.ts` | `escalate`, `candidateKey`, fenêtre de santé = délai annoncé |
| `packages/core/src/errors.ts` | `invalid_output`, `retryDelayMs` |
| `packages/core/src/types.ts` | `Task.spec`, `Pipeline.contracts/workspace`, événements fichiers/commandes |
| `packages/providers/src/{openai-compatible,anthropic}.ts` | classement des erreurs hors HTTP |
| `packages/server/src/workspace.ts` | dossiers de run, confinement, outils installés, ouverture dossier / VS Code |
| `packages/server/src/index.ts` | réglages `agentic`/`workspaceRoot`/`commandPolicy`, validations, `/api/approve`, `/api/workspace/{runs,files,file,run,open}` |
| `packages/web/src/workspace-panels.tsx` | Fichiers, Exécution, bandeau de validation |
| `packages/web/src/{store,api,types,App,Settings,components,panels}.tsx?` | état, événements, réglages, détail de tâche, journal « Actions » |

## Décisions

- **Protocole texte** et pas d'outils natifs : universel, groupé, et les modèles gratuits
  testés (Gemini lite, gpt-oss) le suivent bien.
- **Mode Sûr par défaut**, avec une explication honnête : un interpréteur peut tout faire ;
  le contrôle total, c'est Prudent. Le confinement protège les **écritures de fichiers** de
  l'agent, pas ce qu'exécute un programme qu'il a écrit.
- **Une seule escalade** par tâche : borne le coût ; au-delà, le résultat est gardé avec ⚠.
- **Les commandes de l'utilisateur** (panneau Exécution) passent la liste noire mais pas le
  filtre Sûr : c'est lui qui tape.
- Le dossier est créé **avant** la planification pour que le planificateur connaisse le
  contexte (dossier neuf, outils installés).

## Comment tester

```bash
pnpm test        # 105 tests (dont 16 phase D : confinement, protocole, politiques, agent, escalade, patience)
pnpm desktop
```

Dans l'app : « Crée une calculatrice en Python avec ses tests. Je veux pouvoir la lancer et la
tester. » → panneau **Fichiers** (les fichiers apparaissent pendant le run), **Exécution**
(les tests lancés par l'agent), puis lance toi-même `python3 run_calc.py divide 10 4` (le nom
du point d'entrée dépend du plan). Réglages › Général : passe en *Prudent* pour valider chaque
commande.

**Testé en réel** (Gemini + Groq gratuits, 4 runs) : dernier run 7/7 tâches en 42 s, 0 $,
5 tests unittest verts, CLI fonctionnelle ; repli `invalid_output` observé et réussi.

## Limites connues

- Pas de parallélisme entre tâches (v0.2) ; pas d'isolation forte (conteneur) des commandes.
- Paliers gratuits très serrés en 2026 : Gemini `flash-latest` ≈ 20 requêtes/jour,
  Groq `gpt-oss-120b` 8 000 tokens/minute → un run agentique en consomme une bonne part.
- Une app graphique lancée par un agent bloquerait jusqu'au délai (60 s) : le protocole le lui
  interdit ; c'est l'utilisateur qui la lance (*Lancer (fenêtre)*).
