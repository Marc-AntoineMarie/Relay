# Changelog

Toutes les modifications notables de Relay, regroupées par étape, la plus récente en haut.
Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/), versions en
[SemVer](https://semver.org/lang/fr/).

- **Ce fichier est mis à jour à chaque changement**, dans le même commit.
- Le **détail** de chaque contribution (pourquoi, fichiers, comment tester, décisions) est
  dans [`docs/contributions/`](docs/contributions/README.md).
- Pour reprendre le projet dans une nouvelle session : [`docs/HANDOFF.md`](docs/HANDOFF.md).

## [Non publié] — 0.1.0 en cours

### Phase E — projets, conversations, questions, mémoire · 2026-10-08 · *en attente de validation*

Commits `00a16fb` `d4c362c` `51ba955` + docs · détail :
[contribution](docs/contributions/2026-10-08-phase-e-projets-conversations.md)

#### Ajouté

- **Projets** au nom simple (proposé d'après la demande, modifiable), à l'emplacement de ton
  choix (facultatif, sélecteur natif), ou dossier existant ouvert comme projet.
- **Conversation** par projet, panneau principal : demandes, questions, résultats, corrections ;
  **historique** des projets avec recherche ; suites dans le même projet ; activité en direct
  (tâche, compte, modèle, dernière action).
- **Questions de cadrage** quand la demande est trop floue (réponses proposées, « autre… »,
  « Décide pour moi ») ; sinon **hypothèses** affichées. Désactivable.
- **Mémoire** inspirée de Claude Code : `RELAY.md` par projet (tenu à jour après chaque tour,
  modifiable), **mémoire globale** de tes préférences, conversation récente dans le contexte.
- API : `GET /api/projects`, `GET /api/projects/detail`, `PUT /api/projects/memory`,
  `POST /api/projects/import` ; événements `questions`, `memory`.

#### Modifié

- Disposition v6 : Conversation à gauche, Pipeline au centre, détails à droite.
- La règle « clarify » du planificateur est remplacée par les questions de cadrage.

### Phase D — actions réelles · 2026-10-07 · validée

Commits `b8e2163` `5232b1f` `2110bda` `fc9e205` + docs · détail :
[contribution](docs/contributions/2026-10-07-phase-d-actions-reelles.md)

#### Ajouté

- **Agent exécutant** : chaque tâche écrit de **vrais fichiers** dans un dossier neuf par run
  (`~/relay-workspaces/…`, réglable) et **lance des commandes** (tests, exécution) ; il lit
  les sorties et corrige (jusqu'à 4 tours). Protocole texte `===FILE===` / `===RUN===` /
  `===READ===`, compatible avec tous les fournisseurs.
- **Commandes encadrées** : politiques *Prudent* (validation de chaque commande), *Sûr*
  (défaut, outils de dev), *Libre* ; liste noire dans tous les modes, clés API retirées de
  l'environnement, 60 s max.
- **Vérification + escalade** : si les vérifications échouent encore, la tâche est reprise une
  fois par un modèle du niveau supérieur.
- **Contrats partagés** (fichiers, signatures, commande de test) et **`spec`** par tâche dans
  le plan ; point d'entrée exécutable quand l'utilisateur veut lancer le résultat ; le
  planificateur connaît les outils installés.
- Panneaux **Fichiers** (arbre + contenu en direct, runs précédents, ouvrir le dossier ou VS
  Code) et **Exécution** (sorties des commandes, tes propres commandes avec entrée clavier,
  lancement d'app graphique) ; bandeau de validation ; Réglages › Général : mode agent,
  dossier, politique.
- API : `POST /api/approve`, `GET /api/workspace/{runs,files,file}`,
  `POST /api/workspace/{run,open}` ; événements `file:write`, `command:start|done`,
  `task:escalate`, `workspace`, `approval:request|done`.

#### Modifié

- La synthèse décrit le dossier (arborescence, commandes, état des tests) au lieu de recopier
  le code.
- Robustesse face aux vrais modèles : réponse vide ou appel d'outil inventé → erreur
  `invalid_output` → repli ; tâche qui ne fait que décrire → relancée ; blocs de fichiers
  coupés ignorés ; **patience** sur les limites par minute (« réessaie dans 17 s ») ; jusqu'à 5
  modèles essayés par tâche.
- Disposition par défaut v4 (onglets Fichiers et Exécution).

#### Ajouté ensuite — boucle test → correction ([contribution](docs/contributions/2026-10-07-boucle-test-correction.md))

- **Session par dossier** (`.relay/session.json`) : une suite (*Continuer*) ou une correction
  repart du dossier, des contrats et de l'historique du projet ; graphe et journal s'allongent.
- **Erreurs remontées au pipeline** : commande en échec, app qui plante (au démarrage ou plus
  tard, sortie suivie jusqu'à sa fermeture), erreur JavaScript de l'Aperçu → nœud rouge
  « erreur » + journal → **Corriger avec Relay** (une tâche d'agent, sans re-planification,
  interdit de masquer l'erreur).
- Onglet **Aperçu** : pages HTML du dossier dans Relay (iframe isolée), rechargées après
  correction. Disposition v5.
- Détection de `tkinter`, `pytest`, `python` ; absents signalés aux agents ; interface
  graphique sans tkinter → page HTML. Les agents vérifient que le programme principal démarre.

#### Sécurité

- L'API locale n'envoie plus `Access-Control-Allow-Origin: *` et refuse les requêtes d'une
  autre origine ou d'un hôte non local : un site web ouvert dans le navigateur ne peut plus
  piloter Relay (ni lancer de commandes).

### Phase C — Réglages, synthèse finale, coûts honnêtes · 2026-10-07 · validée

Commits `a18eca1` `c5f24d7` `224952a` + docs · détail :
[contribution](docs/contributions/2026-10-07-phase-c-reglages-synthese.md)

#### Ajouté

- **Écran ⚙ Réglages** : *Comptes et clés* (enregistrer, **tester** sans rien consommer,
  supprimer, clé masquée `…KlvA`), *Modèles* (catalogue complet de chaque compte, ajout ou
  retrait du pool automatique), *Routage* (mode et stratégie par défaut, **budget par run**,
  synthèse, plafonds par compte), *Général*. Enregistrés côté moteur dans
  `.relay/settings.json` (ignoré par git).
- **Étape de synthèse** : à la fin du run, un modèle assemble tous les résultats en **un
  livrable unique** (code final de chaque fichier + mode d'emploi), affiché dans le nouveau
  panneau **Résultat** (copie en un clic, activé automatiquement).
- **Budget par run** : une fois atteint, le routeur n'utilise plus que le gratuit et
  l'abonnement.
- Erreur **« requête trop volumineuse »** (HTTP 413, limite de tokens par minute des paliers
  gratuits) : la tâche passe à un modèle à plus grand contexte au lieu d'échouer.
- API : `GET|PUT /api/settings`, `POST /api/keys/test`, `POST /api/keys/delete`.

#### Modifié

- **Coûts honnêtes** : la planification (relances comprises) et la synthèse sont comptées dans
  les totaux et la baseline, affichées à part (« dont orchestration ») ; avant, le plan
  n'était pas compté.
- Espace de travail réorganisé : la gestion des clés passe dans les Réglages, le choix du
  compte du mode manuel est dans le panneau Modèles ; disposition par défaut v3.
- Le graphe se recadre quand son panneau change de taille (sauf après un zoom manuel).
- La raison affichée pour une tâche suit le modèle réellement tenté (premier choix ou repli).
- **Groq** : catalogue 2026 (les Llama 3 ont été retirés) → `gpt-oss-20b` / `gpt-oss-120b` ;
  familles GPT-OSS, Kimi, Llama 4 et Qwen ajoutées ; modèles vocaux filtrés.

### Phase B — orchestrateur multi-comptes · 2026-10-07 · validée

Commits `c32d07b` `6d3bf98` `f0093ac` + docs · détail :
[contribution](docs/contributions/2026-10-07-phase-b-orchestrateur.md)

#### Ajouté

- **Mode automatique** (par défaut) : pour le plan puis pour chaque tâche, le routeur choisit
  le compte et le modèle parmi **tous les comptes connectés** ; mode **manuel** conservé.
- **Stratégies** Économie / Équilibré / Qualité (pondération coût, qualité, vitesse,
  sur-dimensionnement, coût virtuel de l'abonnement).
- **Besoins par tâche** (`code`, `reasoning`, `long_context`, `web`, `fast`) attribués par le
  planificateur, en plus des 3 niveaux quick / build / deep.
- **Catalogue de modèles** (`core/catalog.ts`) : niveau, besoins couverts, prix de référence,
  vitesse et qualité par famille (Claude, Gemini, Llama, DeepSeek, Qwen, Sonar).
- **Plafonds par compte** : activé ou non, niveaux autorisés, nombre max d'appels par run.
  Par défaut **Claude Code est désactivé** en auto (quota préservé), l'API Anthropic est
  réservée au « deep ».
- **Santé des modèles** : un modèle saturé / à court de quota est évité quelques minutes, un
  modèle retiré ou non inclus dans l'offre est écarté une heure.
- **Repli entre fournisseurs** : si un modèle échoue, la tâche passe au candidat suivant,
  éventuellement chez un autre compte ; la raison de chaque choix est affichée.
- **Journal lisible** (panneau « Journal ») : une ligne par action (plan, routage, requête,
  réponse, repli, erreur), détail brut dépliable, filtres, recherche, vue brute, export JSONL.
- API serveur : `GET /api/pool`, `POST /api/run` avec `mode: "auto"`.

#### Modifié

- L'exécuteur route via `TaskRouting` (manuel ou automatique) ; le coût « équivalent API » est
  calculé via le catalogue pour tous les backends (plus seulement Claude).
- Un modèle de niveau inférieur n'est utilisé qu'en **dernier recours**, signalé, quand aucun
  modèle du bon niveau ne répond (au lieu d'échouer).

#### Corrigé

- « quota limit: 0 » (modèle non inclus dans le palier gratuit, ex. Gemini Pro) est traité
  comme modèle indisponible, et plus comme un quota temporaire.

### Phase A — espace de travail en panneaux libres · `934801c`

- Six panneaux indépendants (dockview) : déplacer, empiler, redimensionner, agrandir ;
  disposition mémorisée, bouton « Disposition par défaut ».
- Graphe zoomable : molette, glisser le fond pour se déplacer, « Ajuster ».

### Fiabilisation : modèles, erreurs, front · `d0a73ff` `885179e` `57b07b2` `1c4f4f5` `25efea7` `2014df7` `8f35ca1`

- Décomposeur robuste : extraction JSON tolérante, troncature détectée, relances de réparation.
- Erreurs normalisées (`ProviderRequestError`, `describeError`) : titre, détail, conseil.
- Un modèle par tier pour chaque backend, repli automatique, effort → `reasoning_effort`,
  filtrage des modèles non-chat, détection des modèles disponibles avec la clé.
- Front : sélecteur par tier, carte d'erreur avec actions, chrono, bouton Arrêter, détail
  par tâche ; timeout 60 s sur les backends compatibles OpenAI.

### App desktop Electron · `90a09c8` `b18d2c1`

- Fenêtre native : le serveur démarre dans le processus Electron (plus de port à gérer).
- Chemins (UI, `.env`, config) résolus depuis la racine du dépôt quel que soit le dossier courant.

### Dashboard web + serveur local · `e5981e9` `ce907ee` `280c049` `1de43e5`

- Serveur local (`/api/state`, `/api/keys`, `/api/run` en SSE), clés écrites dans `.env`.
- Dashboard React + Vite sombre : backends, DAG, métriques.
- Écoute IPv4 + IPv6, gestion du port occupé, reconnexion automatique de l'UI.

### Multi-backend · `ced1fcb` `3acf9af` `0c9728e`

- Métriques comparables entre backends : `billedCost` (payé) et `referenceCost` (équivalent API).
- Provider **Claude Code** (abonnement, sans clé API) et provider **compatible OpenAI**
  (Gemini, Groq, OpenRouter, DeepSeek, Ollama…).

### Socle v0.1 (étapes 1 → 10) · `413e235` → `dd3a3a3`, `1d55ea6`, `4ec51ac`

- Monorepo pnpm (core, providers, cli), types partagés, adaptateur Anthropic, décomposeur
  (structured outputs), routeur + escalade, exécuteur, métriques, moniteur, config, CLI.
- Documentation multi-fournisseurs (`docs/PROVIDERS.md`) et premier CHANGELOG.

---

### Environnement

Node ≥ 22, pnpm 9. Stack datée 2026 : zod 4, TypeScript 7, vitest 5, React 19, Vite 8,
Electron 44, `@anthropic-ai/sdk` 0.131, `openai` 7.30, `dockview-react` 8.4.
