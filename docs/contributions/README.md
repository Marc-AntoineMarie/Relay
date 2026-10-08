# Contributions

Une fiche par contribution (une phase, une fonctionnalité, un correctif notable). Le
[CHANGELOG](../../CHANGELOG.md) résume ; ici on garde le **pourquoi**, les **fichiers
touchés**, les **décisions** et **comment tester** — de quoi comprendre un changement des
mois plus tard, ou le reprendre dans une autre session.

## Règles

- **Nom** : `AAAA-MM-JJ-sujet-court.md` (date du jour de la contribution).
- **Quand** : à chaque contribution, dans le même commit que le code (ou juste après), avec la
  mise à jour du CHANGELOG et de [`docs/HANDOFF.md`](../HANDOFF.md) si l'état du projet change.
- **Langue** : français ; identifiants et code en anglais.
- Ajouter la fiche à l'index ci-dessous (la plus récente en haut).

## Modèle

```markdown
# AAAA-MM-JJ — Titre

- **Statut** : livré | en attente de validation | abandonné
- **Commits** : `abc1234` `def5678`

## Demande
Ce qui a été demandé, avec les mots de l'utilisateur si utile.

## Ce qui a changé
Liste des changements visibles et internes.

## Fichiers touchés
Les fichiers clés et leur rôle (pas la liste exhaustive du diff).

## Décisions
Choix faits, alternatives écartées et pourquoi.

## Comment tester
Commandes et parcours manuel pour vérifier.

## Limites connues / suite
Ce qui reste à faire ou à surveiller.
```

## Index

| Date | Contribution | Statut |
|---|---|---|
| 2026-10-08 | [Phase G — terminal intégré](2026-10-08-phase-g-terminal.md) | en attente de validation |
| 2026-10-08 | [Phase F — Ollama intégré, comptes gratuits NVIDIA & co, lancements vérifiés](2026-10-08-phase-f-ollama-et-comptes.md) | validée |
| 2026-10-08 | [Phase E — projets, conversations, questions de cadrage, mémoire](2026-10-08-phase-e-projets-conversations.md) | validée |
| 2026-10-07 | [Boucle test → correction : sessions, erreurs remontées, aperçu](2026-10-07-boucle-test-correction.md) | validée |
| 2026-10-07 | [Phase D — actions réelles (fichiers, commandes, escalade)](2026-10-07-phase-d-actions-reelles.md) | validée |
| 2026-10-07 | [Phase C — Réglages, synthèse, coûts honnêtes](2026-10-07-phase-c-reglages-synthese.md) | validée |
| 2026-10-07 | [Phase B — orchestrateur multi-comptes](2026-10-07-phase-b-orchestrateur.md) | validée |
| 2026-10-06 → 07 | [Historique : du socle v0.1 à la phase A](2026-10-07-historique-avant-phase-b.md) | livré |
