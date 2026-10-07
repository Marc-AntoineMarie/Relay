# 2026-10-08 — Phase E : projets, conversations, questions de cadrage, mémoire

- **Statut** : validée (l'utilisateur est passé à la phase F)
- **Commits** : `00a16fb` (moteur) · `d4c362c` (serveur + desktop) · `51ba955` (interface) · docs

## Demande

« Que le dossier ait un nom simple à chaque fois, que je puisse choisir le nom, l'emplacement
aussi (facultatif). Une sorte de conversation comme avec toi, avec des historiques pour les
retrouver plus tard, se souvenir, avoir une continuité : pour l'instant Relay marche pour des
tâches simples, pas pour des projets complexes. Si l'orchestrateur a des questions de
contexte, qu'il les pose : je fais volontairement des prompts imprécis pour tester la
solidité. Le système de mémoire : peut-on s'inspirer de Claude Code ? »

Le reste de la demande (terminal intégré, Ollama, métriques sérieuses) est planifié en
phases F, G, H (voir HANDOFF).

## Ce qui a changé

- **Projets** : un projet = un dossier au **nom simple** proposé d'après la demande
  (« Crée-moi une calculatrice… » → `calculatrice`, `-2` si pris), **modifiable**, à
  l'**emplacement** de ton choix (facultatif ; sélecteur de dossier natif dans l'app). On peut
  aussi **ouvrir un dossier existant** comme projet. Les projets hors de la racine des runs
  sont inscrits dans `.relay/projects.json` : seuls les projets connus sont accessibles à l'API.
- **Conversation** (nouveau panneau principal, à gauche) : fil de messages par projet —
  demandes, questions, réponses, résultats (tâches avec modèle, fichiers, coût, compte rendu),
  corrections. **Historique** des projets avec recherche ; le dernier projet est rouvert au
  démarrage. Une suite (« ajoute un score ») continue le même projet : tâches `n.x`, graphe et
  journal prolongés. Pendant un run, une carte montre **qui travaille sur quoi** (tâche,
  compte, modèle, dernière action).
- **Questions de cadrage** : si la demande est trop floue *et* qu'une réponse changerait le
  résultat, le planificateur pose 1 à 3 questions avec réponses proposées (cliquables, ou
  « autre… ») au lieu de planifier ; « Décide pour moi » lui laisse le choix. Sinon il planifie
  et affiche ses **hypothèses**. Options limitées à ce qui est réalisable sur la machine.
  Désactivable (Réglages › Général).
- **Mémoire, inspirée de Claude Code** :
  - `RELAY.md` à la racine du projet (comme `CLAUDE.md`) : objectif, structure, commandes,
    décisions et contraintes (dont les outils absents), historique, à faire. Réécrite après
    chaque tour par un petit modèle (niveau quick, contexte long), **modifiable** depuis la
    Conversation ; relue par le planificateur et les agents à chaque tour ;
  - **mémoire globale** (tes préférences) dans Réglages › Général, transmise à tous les projets ;
  - **conversation récente** condensée et session technique ajoutées au contexte (budgets bornés).
- Disposition v6 : Conversation à gauche, Pipeline au centre, détails (Tâche, Fichiers, Aperçu,
  Résultat, Modèles) à droite, Journal / Exécution / Coûts en bas.

## Fichiers touchés

| Fichier | Rôle |
|---|---|
| `packages/core/src/decomposer/` | `questions`, `assumptions`, `allowQuestions`, règle 5 réécrite (cadrage) |
| `packages/core/src/memory/index.ts` | `updateProjectMemory`, gabarit de `RELAY.md`, bornage |
| `packages/core/src/types.ts` | `PlanQuestion`, `Pipeline.analysis/assumptions/questions` |
| `packages/server/src/projects.ts` | noms (`suggestName`, `slugify`, `uniqueDir`), index des projets, import, conversation, mémoire |
| `packages/server/src/index.ts` | création du projet, messages de la conversation, questions, mise à jour de `RELAY.md`, `/api/projects/*`, aperçu par dossier encodé |
| `packages/desktop/{main,preload}.cjs` | sélecteur de dossier natif (`window.relayDesktop.pickFolder`) |
| `packages/web/src/conversation.tsx` | panneau Conversation : projets, fil, questions, résultats, activité, saisie, éditeur de mémoire |
| `packages/web/src/{store,api,types,App,Settings,panels,workspace-panels}.tsx?`, `styles.css` | état des projets, réglages, disposition v6 |

## Décisions

- **Fichiers JSON dans le projet** (`.relay/conversation.json`, `session.json`) plutôt que
  SQLite : le projet emporte son historique (copiable, lisible) ; SQLite viendra avec
  l'historique des métriques (phase H, v0.2).
- **`RELAY.md` visible à la racine**, comme `CLAUDE.md` : l'utilisateur le lit et le corrige.
- **Questions plutôt que tâche « clarify »** : le run s'arrête proprement, la réponse devient un
  message de la conversation, le planificateur ne repose pas de question après une réponse.
- **Skills** (recettes réutilisables façon Claude Code) : reportés ; la mémoire de projet et la
  mémoire globale couvrent d'abord la continuité.

## Comment tester

```bash
pnpm test        # 118 tests
pnpm desktop
```

« ＋ Nouveau » → écris « fais-moi un jeu » (le nom proposé s'affiche, modifiable) → réponds aux
questions → résultat dans le fil → « ajoute un score » → *Mémoire* pour voir `RELAY.md` →
l'historique (▾ à côté du nom) pour retrouver un projet.

**Testé en réel** (Gemini + Groq gratuits) : « fais-moi un jeu » → 3 questions (type,
interface, complexité) → 6 tâches, 34 s, 0 $ → suite « ajoute un compteur de score » (tour 2)
→ suite « écran d'accueil » (tour 3, 4 tâches `3.x`, 193 s) ; `RELAY.md` à jour après chaque tour.

## Limites connues

- Une question peut encore proposer un choix discutable ; « autre… » permet de répondre librement.
- Les anciens runs (`20261007-…`) apparaissent dans l'historique avec leur nom daté.
- La mise à jour de `RELAY.md` ajoute un appel court par tour (compté dans le journal, pas
  encore dans les métriques : phase H).
