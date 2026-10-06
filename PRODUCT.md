# Relay — Vision produit

## Le problème

Les outils d'IA actuels envoient tout au même modèle, au même effort. Créer un
fichier vide, concevoir une architecture complexe, écrire des tests — tout passe par
le même tuyau. C'est cher, c'est lent, et c'est du gâchis.

Les développeurs qui veulent optimiser doivent aujourd'hui jongler manuellement entre
les modèles, configurer des subagents, écrire des règles. Personne ne le fait vraiment
parce que c'est trop de friction.

## La solution

Relay prend un seul prompt et fait le travail d'un tech lead :
1. **Décompose** la demande en sous-tâches concrètes
2. **Route** chaque sous-tâche au modèle le plus adapté (puissant pour l'archi,
   léger pour le scaffolding)
3. **Chaîne** les résultats automatiquement d'une tâche à la suivante
4. **Vérifie** chaque résultat et escalade si nécessaire
5. **Mesure** tout : coût, temps, qualité, économies réelles

L'utilisateur voit tout en temps réel — comme Claude Code mais avec le routing en plus.

## Principes

- **Un prompt, zéro friction** — donner sa demande et laisser Relay orchestrer.
- **Transparent** — voir en temps réel qui fait quoi, combien ça coûte, pourquoi.
- **Configurable** — routes, modèles, seuils, tout est modifiable.
- **Mesurable** — métriques claires, analyse automatique des gains et des pertes.
- **Multi-plateforme** — bureau, web, mobile, même expérience partout.
- **Multi-modèles, zéro marge** — tous fournisseurs via leurs **API natives** et les
  **clés de l'utilisateur** ; appels directs, pas de marge d'agrégateur, pas
  d'abonnement grand public routé (non supporté). Voir [docs/PROVIDERS.md](docs/PROVIDERS.md).
- **Honnête** — afficher les économies réelles, pas des simulations optimistes.

## Public cible

Développeurs et équipes qui utilisent des assistants IA au quotidien et veulent
réduire leurs coûts sans perdre en qualité. Pas besoin d'être expert en IA — Relay
doit être aussi simple à utiliser que Claude Code.

## Différenciation

| Existant | Limite | Relay |
|---|---|---|
| Claude Code / Codex | Un modèle, switch manuel | Routing automatique par tâche |
| Morphy | Multi-agents manuels | Pipeline automatique avec chaînage |
| LiteLLM Auto Router | Routing API, pas de décomposition | Décomposition + routing + chaînage |
| OpenRouter Auto | Boîte noire, pas de vérification | Transparent, vérifie, escalade |

## Roadmap

### v0.1.0 — Proof of concept (CLI)

Le strict minimum pour prouver que le concept marche.

- Décomposeur : prompt → plan de tâches structuré (JSON)
- Routeur : 3 tiers (quick/build/deep) configurables dans `relay.config.json`
- Exécuteur : séquentiel, chaînage des résultats entre tâches
- Un provider : Anthropic (Haiku, Sonnet, Opus)
- Métriques : coût, tokens, temps par tâche + total + baseline comparison
- Sortie CLI : résultat final + tableau récapitulatif
- Tests unitaires sur chaque composant

### v0.2.0 — Multi-providers + parallélisme

- Providers : OpenAI, Ollama (local, gratuit), Google Gemini (palier gratuit) — appels
  directs, clés de l'utilisateur, zéro marge (voir [docs/PROVIDERS.md](docs/PROVIDERS.md))
- Exécution parallèle des tâches indépendantes dans le DAG
- Escalade automatique : effort d'abord, modèle ensuite
- Vérificateur intégré (tests, types, lint)
- Historique des pipelines (SQLite)
- Configuration par projet (`.relay/config.json` dans le repo)

### v0.3.0 — Dashboard web

- Visualisation temps réel du pipeline (DAG animé)
- Dashboard métriques : coûts, économies, tendances
- Configuration des routes via UI
- Historique des pipelines avec replay
- Analyse automatique : où on gagne, où on perd, recommandations

### v0.4.0 — App desktop

- Electron, multi-OS
- System tray, notifications
- Raccourcis globaux
- Intégration avec les éditeurs (VS Code, JetBrains)

### v0.5.0 — Mobile

- PWA d'abord (installable, notifications push)
- React Native si la PWA ne suffit pas

### v1.0.0 — Stable

- Toutes plateformes matures
- API publique pour intégrations
- Templates de décomposition partageables
- Documentation complète
- Tests de charge, benchmarks reproductibles

## Métriques à suivre

À afficher à l'utilisateur en temps réel et en historique :

- **Coût par pipeline** et par tâche
- **Coût baseline** (si tout avait tourné sur le modèle le plus fort)
- **Économies réelles** (en % et en $)
- **Taux de succès** par tier et par modèle
- **Taux d'escalade** (combien de tâches ont dû monter en tier)
- **Faux positifs** (tâches passées qui auraient dû échouer)
- **Temps total** vs temps baseline
- **p90 du coût** par type de tâche (pour détecter les outliers)

## Licence

À décider. Options : AGPL (open-core comme Cobblestone), MIT, ou propriétaire.
