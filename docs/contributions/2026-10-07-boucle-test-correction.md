# 2026-10-07 — Boucle test → correction : sessions, erreurs remontées, aperçu

- **Statut** : en attente de validation (complément de la phase D)
- **Commits** : voir CHANGELOG (moteur, serveur, interface, docs)

## Demande

En testant la calculatrice générée (`python3 calculator.py` → `ModuleNotFoundError: tkinter`) :
« Je m'en fous que la calculatrice ne fonctionne pas, il faut que Relay fonctionne : trouver
une solution pour avoir du contexte, une session, pour que les modèles puissent corriger
l'erreur ; que je puisse tester direct vite fait et que les erreurs soient remontées direct
dans Relay, au pipeline. »

## Ce qui a changé

- **Session par dossier** (`<run>/.relay/session.json`) : chaque tour (demande, suite,
  correction) est enregistré (tâches, contrats, compte rendu, erreur). Une suite ou une
  correction transmet ce contexte au planificateur et aux agents ; les contrats sont repris ;
  les tâches du tour n sont numérotées `n.1, n.2…`. Règle 12 du planificateur : une suite ne
  planifie que ce qui change (1 à 3 tâches).
- **Suite dans le même dossier** : après un run, la Demande affiche « ↪ Suite dans … » ; le
  bouton devient *Continuer* (« le bouton = ne fait rien », « ajoute un historique ») ;
  *nouveau projet* repart d'un dossier neuf. Le graphe et le journal s'allongent au lieu
  d'être effacés.
- **Erreurs remontées au pipeline** : une commande lancée depuis Exécution qui échoue, une app
  (*Lancer (fenêtre)*) qui plante au démarrage **ou plus tard** (sortie suivie jusqu'à sa
  fermeture, exceptions détectées même si la fenêtre reste ouverte), une erreur JavaScript de
  l'Aperçu → **nœud rouge « erreur »** dans le graphe + entrée du journal + détail affiché.
- **Corriger avec Relay** (détail de l'erreur, ligne de commande, Aperçu) : correction directe
  sans re-planification — une tâche d'agent (niveau build, besoin code) avec l'erreur, une
  précision facultative et l'historique ; elle corrige, revérifie, escalade si besoin.
  Consignes : **interdit de masquer l'erreur** (faux module, try/except qui avale…), changer
  d'approche si un outil manque, finir par la commande pour lancer.
- **Aperçu** (nouvel onglet) : les pages `.html` du dossier s'affichent dans Relay (iframe
  isolée, sans accès à l'API), rechargées quand un agent modifie un fichier ; erreurs
  JavaScript et ressources introuvables remontées. Fichiers : *Aperçu dans Relay*, *Ouvrir
  dans le navigateur*.
- **Environnement** : détection de `tkinter`, `pytest` et de la commande `python` ; les absents
  sont indiqués aux agents (« ABSENTS : tkinter… ») ; interface graphique demandée sans
  tkinter → page HTML autonome. Les agents vérifient que le programme principal démarre
  (au moins son import).
- **Protocole** : `===RUN: …` accepté sans `===` final ; lignes de protocole retirées des
  comptes rendus.
- **Sécurité** : l'API locale répondait `Access-Control-Allow-Origin: *` — n'importe quel site
  ouvert dans le navigateur pouvait l'appeler (et, depuis la phase D, lancer des commandes).
  Désormais : plus d'en-têtes CORS, requêtes d'une autre origine refusées (403), hôte limité
  à localhost / 127.0.0.1 (protection DNS rebinding).

## Fichiers touchés

| Fichier | Rôle |
|---|---|
| `packages/server/src/session.ts` | session (tours, contexte), correction directe, numérotation par tour |
| `packages/server/src/index.ts` | `workspace`/`fix` dans `/api/run`, enregistrement des tours, apps suivies (`/api/workspace/launches`, `/stop`), aperçu `/ws/…` avec remontée d'erreurs, contrôle d'origine |
| `packages/server/src/workspace.ts` | détection tkinter / pytest / python, `describeEnvironment` |
| `packages/core/src/workspace/commands.ts` | `launchCommand` : journal de sortie, `onExit` |
| `packages/core/src/workspace/protocol.ts` | RUN tolérant, comptes rendus nettoyés, vérification du point d'entrée |
| `packages/core/src/decomposer/system-prompt.ts` | règles 10 (vérifier le point d'entrée) et 12 (suites) |
| `packages/web/src/store.tsx` | session, nœuds d'erreur, `fixError`, suivi des apps, aperçu |
| `packages/web/src/workspace-panels.tsx` | `ErrorDetail`, `PreviewPanel`, boutons Corriger / Fermer l'app |
| `packages/web/src/{App,panels,PipelineView,types,api}.tsx?`, `styles.css` | onglet Aperçu (disposition v5), chip de session, badge erreur |

## Comment tester

```bash
pnpm test      # 110 tests
pnpm desktop
```

1. Fais un run, puis dans **Exécution** lance le programme (*Exécuter* ou *Lancer (fenêtre)*).
2. En cas d'erreur : nœud rouge dans le graphe, détail ouvert → *Corriger avec Relay*.
3. Relance la même commande ; ou écris une suite dans la Demande (*Continuer*).
4. Page web : Fichiers › *Aperçu dans Relay*.

**Testé en réel** (Gemini + Groq gratuits), sur une copie du run tkinter : erreur remontée,
correction en 8 s par gpt-oss-120b (repli depuis Gemini saturé) → vrai mode ligne de commande
quand tkinter manque, tests verts, relance sans erreur. Un premier essai avait « corrigé » en
simulant tkinter (programme muet) : d'où la règle « interdit de masquer l'erreur ».

## Limites

- Une erreur obtenue **hors de Relay** (ton terminal) ne remonte pas toute seule : colle-la
  dans la Demande (*Continuer*), le planificateur a le contexte du dossier.
- *Lancer (fenêtre)* n'envoie pas d'entrée clavier : pour un programme en ligne de commande,
  utiliser *Exécuter* avec « entrée ».
- Les scripts `type="module"` en fichiers séparés ne se chargent pas dans l'Aperçu isolé
  (pages autonomes recommandées, c'est ce que demande le planificateur).
