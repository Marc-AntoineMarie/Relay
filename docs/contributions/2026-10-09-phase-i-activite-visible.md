# 2026-10-09 — Phase I : activité visible en direct

- **Statut** : en attente de validation par l'utilisateur
- **Commits** : `b55140f` · docs

## Demande

« Il est difficile de savoir quand le modèle bosse : il faudrait une animation visuelle dans la
pipeline et dans la décision du routeur pour voir quel modèle fait quoi exactement, liée au
journal. » (promise depuis la phase D)

## Ce qui a changé

- **Le texte des modèles arrive en direct** (par paquets de 250 ms). Avant, l'exécuteur le gardait
  jusqu'à la fin de la réponse : rien ne bougeait pendant qu'un modèle écrivait.
- **Graphe** : la tâche en cours a une bordure dégradée qui circule et un halo ; sous sa
  description, son **activité** et son chrono — ⏳ attend la 1re réponse de *modèle*, ✍ rédige…
  *n* caractères, 📄 crée *fichier*, ▶ *commande*, ✔/✗ résultat ; les flèches qui y mènent
  s'animent. À la fin : éclair vert (réussie) ou secousse (échec), puis le résumé ou l'erreur. Un
  badge **↺ n** indique les modèles essayés (survol : lesquels et pourquoi).
- **Décisions du routeur — en direct** (panneau Modèles, modes auto et manuel) : pour chaque tâche,
  la chaîne des modèles **✗ abandonné** (barré, avec la raison : quota, délai, réponse
  inutilisable, escalade…), **● en cours** (pulse) avec ce qu'il fait et depuis quand,
  **✓ réussi**, puis les **replis encore prévus** en pointillés.
- **Lien avec le journal** : « journal » sur chaque décision et « Voir le journal de cette tâche »
  dans le détail ouvrent le journal **filtré** sur la tâche ; chaque ligne du journal porte une
  pastille **#tâche** cliquable qui sélectionne la tâche dans le graphe ; les lignes de la tâche
  sélectionnée sont surlignées.
- Arrêt ou coupure : plus aucune tâche ne reste figée « en cours ».
- Animations désactivées si le système demande de réduire les animations.

## Fichiers touchés

| Fichier | Rôle |
|---|---|
| `packages/core/src/executor/index.ts` | texte du modèle streamé en direct (paquets de 250 ms) |
| `packages/web/src/store.tsx` | activité par tâche, modèles essayés (`tries`), filtre du journal partagé |
| `packages/web/src/PipelineView.tsx` | nœud animé, ligne d'activité, badge ↺, effets de fin |
| `packages/web/src/panels.tsx` | `LiveDecisions`, pastilles #tâche du journal, lien du détail |
| `packages/web/src/{App.tsx,types.ts,styles.css}` | onglet Journal mis au premier plan, animations |

## Comment tester

`pnpm desktop` → lance une demande → regarde le graphe et l'onglet **Modèles** pendant le run ;
clique « journal » sur une décision.

**Testé en réel** (convertisseur de températures, 5 tâches, 233 s, démarrage vérifié par Relay) :
captures pendant le run — « attend la 1re réponse de openai/gpt-oss-120b · 1 s », puis
« rédige… 1 296 caractères · 6 s » ; décisions avec modèle en cours et replis prévus ; journal
avec pastilles et surlignage. Run effectué sur une base de métriques temporaire, projet d'essai
supprimé.
