# 2026-10-07 — Phase B : orchestrateur multi-comptes

- **Statut** : validée par l'utilisateur (2026-10-07)
- **Commits** : `c32d07b` (moteur) · `6d3bf98` (serveur) · `f0093ac` (interface) · docs

## Demande

« Un orchestrateur qui distribue à un petit modèle pour établir les tâches, puis redistribue
aux modèles disponibles sur l'app avec les comptes de l'utilisateur (Gemini, Claude, Groq…) en
fonction de l'optimisation coût / efficacité », avec choix **automatique** des modèles selon la
demande et une **option manuelle**. Proposition retenue : garder 3 niveaux et ajouter des
**étiquettes de besoin**. Avoir un **journal** lisible de ce que fait chaque modèle.

## Ce qui a changé

- **Mode automatique** (défaut) : le routeur classe tous les modèles de tous les comptes prêts,
  pour le plan puis pour chaque tâche. Le mode **manuel** (un compte, un modèle par niveau)
  reste disponible.
- **Besoins par tâche** : `code`, `reasoning`, `long_context`, `web`, `fast`, attribués par le
  planificateur (règle 7 du prompt système).
- **Stratégies** : Économie, Équilibré, Qualité — mêmes critères, pondérations différentes.
- **Plafonds par compte** : activé, niveaux autorisés, appels max par run. Défauts : Claude
  Code désactivé (quota de travail de l'utilisateur préservé), API Anthropic réservée au deep.
- **Santé des modèles** partagée entre les runs ; **repli entre fournisseurs**.
- **Journal** : chaque action est une ligne lisible, le détail brut (prompt, réponse) se déplie.
- **Coût équivalent API** calculé pour tous les backends via le catalogue.

## Fichiers touchés

| Fichier | Rôle |
|---|---|
| `packages/core/src/catalog.ts` | Profils de modèles par famille (niveau, besoins, prix de référence, vitesse, qualité) |
| `packages/core/src/router/auto.ts` | `AutoRouter` (classement + raisons), `TaskRouting`, `autoRouting`, `manualRouting` |
| `packages/core/src/router/health.ts` | `HealthTracker` : échecs récents pondérés puis oubliés |
| `packages/core/src/executor/index.ts` | Routage par candidats, repli entre fournisseurs, événements `task:route` et `log` |
| `packages/core/src/decomposer/*` | Champ `needs`, journal des tentatives (`onLog`) |
| `packages/core/src/errors.ts` | `quota limit: 0` ⇒ `model_not_found` |
| `packages/providers/src/factory.ts` | `autoPoolModels`, option `fallbacks: false` en mode auto |
| `packages/server/src/index.ts` | `/api/pool`, `runAuto` (planificateur routé), `runManual`, cache de détection, plafonds par défaut |
| `packages/web/src/panels.tsx` | Panneau Modèles (auto/manuel, stratégie, comptes, décisions), panneau Journal |
| `packages/web/src/store.tsx` | Mode, stratégie, plafonds, pool, journal (mémorisés localement) |

## Décisions

- **3 niveaux + besoins plutôt que plus de niveaux** : plus de niveaux = plus d'erreurs de
  classement par le planificateur ; les besoins capturent ce qui manquait (spécialité).
- **Score transparent plutôt que modèle de routage appris** : un score lisible (et sa raison)
  dès maintenant ; l'apprentissage depuis l'historique viendra quand les métriques seront
  persistées.
- **Niveau inférieur en dernier recours** plutôt qu'interdit : avec un seul compte gratuit
  (Gemini sans Pro), une tâche deep échouait sinon. Le choix est signalé dans la raison.
- **Replis internes désactivés en auto** : le routeur garde la main pour ne jamais descendre
  de niveau sans le dire.
- **Planificateur routé** (build, deep en stratégie Qualité) avec 3 essais.
- **Prix de référence approximatifs** hors Anthropic : ils servent à comparer, pas à facturer.

## Comment tester

```bash
pnpm test        # 80 tests (dont tests/auto-routing.test.ts)
pnpm desktop     # fenêtre Relay
```

1. Panneau **Modèles** : mode *Automatique*, stratégie *Équilibré* ; Claude Code décoché.
2. Demande : « Crée une calculatrice en Python avec ses tests » → **Lancer**.
3. Vérifier : graphe (compte · modèle par nœud), fiche Tâche (« Pourquoi », replis prévus),
   Journal (filtres, détail dépliable, export).

Résultats de référence (Gemini gratuit, 2026-10-07) : 4 à 5 tâches, ~11–15 s, payé $0,
−97,9 % par rapport au tout-Opus ; replis observés flash → pro (non inclus) → flash-lite.

## Limites connues / suite

- Seul **Gemini** a été testé en réel ; Groq, DeepSeek, OpenRouter, Claude Code en auto restent
  à valider.
- Les tâches produisent encore du **texte** (phase D : fichiers et commandes réels).
- Pas encore d'écran **Réglages** ni de test de clé (phase C).
- Santé et plafonds en mémoire / navigateur ; pas d'historique persistant (SQLite v0.2).
