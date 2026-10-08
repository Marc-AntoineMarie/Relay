# 2026-10-08 — Phase H : métriques sérieuses et tableau de bord

- **Statut** : validée (« go fait I »)
- **Commits** : `46a2946` · docs

## Demande

« Il faut justifier les métriques, en faire quelque chose de plus sérieux (dans les réglages par
exemple avec un contrôle complet dessus), voir s'il est possible de logger certaines choses de nos
comptes IA respectifs. » Plus l'inspiration Paperclip (vue d'ensemble, coûts par projet,
fournisseur et modèle, alertes de budget, fil d'activité).

## Ce qui a changé

- **Registre d'usage** (`.relay/relay.db`, SQLite intégré à Node — aucun module natif) : **chaque
  appel de modèle** est enregistré, réussi ou non — plan, tâches (replis et escalades compris),
  synthèse, mémoire du projet — avec tokens, durée, temps de première réponse, issue (ok, quota,
  délai, réponse inutilisable…), compte et facturation. Chaque run aussi (projet, demande, issue,
  vérification du lancement). Avant, les essais ratés et la mémoire n'étaient pas comptés, et rien
  n'était gardé après le run.
- **Tableau de bord** (bouton en haut, inspiré de Paperclip) : période (aujourd'hui / 7 j / 30 j /
  tout) ; indicateurs **payé réellement**, **équivalent API**, **référence** (« si tout passait par
  Opus »), **économie** (dont routage), runs réussis et démarrages vérifiés, appels et échecs (dont
  quota), tokens — chacun avec « comment c'est calculé » ; **équivalent API par jour** ; **où va le
  travail** (tâches vs orchestration : planification, synthèse, mémoire) ; **comptes** (appels,
  échecs, payé, équivalent, 1re réponse médiane, **quota annoncé** par le fournisseur) ;
  **modèles** ; **projets** ; **activité récente** (clic → ouvre le projet) ; **soldes**
  OpenRouter / DeepSeek ; export CSV.
- **Réglages › Métriques** : **modèle de référence** des économies (au choix) ; **budget mensuel**
  avec seuil d'alerte (au-delà : comptes payants exclus, gratuits et abonnement seulement) ;
  **table des prix de référence** par famille, avec la date de revue et la source (catalogue Relay /
  personnalisé), **modifiable** ; export et effacement de l'historique.
- **Quotas des comptes** : les en-têtes `x-ratelimit-*` (Groq, OpenAI, NVIDIA…) sont relevés à
  chaque appel — ex. Groq : 951 / 1 000 requêtes du jour, 6 528 / 8 000 tokens/min.
- **Corrigé** : le temps de première réponse était mesuré après l'arrivée des en-têtes (≈ 0 ms) au
  lieu de depuis l'envoi — le routage par latence ne voyait donc pas les files d'attente.

## Définitions (affichées dans l'interface)

| Indicateur | Calcul |
|---|---|
| Payé réellement | Σ coût des appels des comptes **à l'usage** (gratuit et abonnement = 0 $), figé au moment de l'appel |
| Équivalent API | Σ tokens × prix public de référence **du modèle utilisé** (table des prix, modifiable) |
| Référence | Σ mêmes tokens × prix du **modèle de référence** choisi (ex. Opus) |
| Économie | Référence − payé ; **dont routage** = référence − équivalent API (gain du choix de modèles) |
| 1re réponse | temps entre l'envoi et le premier morceau de réponse (file d'attente comprise), médiane |

Limite assumée : la référence suppose les **mêmes tokens** sur un autre modèle (approximation).

## Décisions

- **`node:sqlite`** plutôt que better-sqlite3 : intégré à Node 22+ et à Electron (Node 24), aucun
  module natif à recompiler. `CLAUDE.md` mis à jour en ce sens.
- **Coûts recalculés à la lecture** (équivalent, référence) avec les prix actuels ; seul le payé est
  figé — changer un prix ou la référence corrige tout l'historique.
- Le tableau de bord est une **vue d'ensemble** (comme Paperclip), séparée de l'espace de travail ;
  le panneau Coûts reste celui du run en cours, avec les définitions et un lien.

## Fichiers touchés

| Fichier | Rôle |
|---|---|
| `packages/server/src/usage.ts` | registre SQLite, `meter()` (mesure de chaque appel), agrégats, CSV |
| `packages/server/src/index.ts` | providers mesurés, runs enregistrés, budget mensuel, référence, `/api/usage/*`, soldes |
| `packages/core/src/catalog.ts` | prix personnalisables, `priceTable()`, date de revue |
| `packages/core/src/types.ts` | `CallTag` (usage de l'appel), `RateLimitSnapshot`, chunk `quota` |
| `packages/providers/src/openai-compatible.ts` | en-têtes de quota, latence mesurée depuis l'envoi |
| `packages/web/src/Dashboard.tsx` | tableau de bord, Réglages › Métriques |
| `packages/web/src/{App,Settings,panels,components,store,api,types}.tsx?`, `styles.css` | bouton, section, panneau Coûts, état |

## Comment tester

```bash
pnpm test        # 143 tests (registre, agrégats, prix personnalisés, latence)
pnpm desktop
```

Lance un run, puis **Tableau de bord** (en haut à droite) ; Réglages › **Métriques** pour la
référence, le budget et les prix. Testé : run réel sur une base temporaire (6 appels mesurés :
plan, 3 tâches, synthèse, mémoire ; quota Groq relevé) ; captures du tableau de bord sur un
historique fictif généré dans une base temporaire (ton historique réel n'a pas été touché).

## Suite

La **comparaison avec / sans Relay** (même prompt via Claude Code seul) s'appuiera sur ce registre :
idée notée pour plus tard.
