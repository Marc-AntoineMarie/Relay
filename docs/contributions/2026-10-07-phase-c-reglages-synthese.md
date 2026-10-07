# 2026-10-07 — Phase C : Réglages, synthèse finale, coûts honnêtes

- **Statut** : en attente de validation par l'utilisateur
- **Commits** : `a18eca1` (moteur) · `c5f24d7` (serveur) · `224952a` (interface) · docs

## Demande

« Réorganiser les modèles et faire une gestion des clés API, des comptes, etc. dans les
réglages » ; étape de synthèse finale prévue au plan de la phase C. Phase B validée par
l'utilisateur (« tout est parfait »).

## Ce qui a changé

- **Réglages** (overlay, bouton ⚙, Échap pour fermer), quatre sections :
  - *Comptes et clés* : enregistrer / remplacer / supprimer une clé, **tester** une clé
    enregistrée ou saisie sans l'enregistrer, fin de clé masquée ;
  - *Modèles* : tous les modèles de chat détectés par compte, avec famille, niveau, forces,
    prix de référence, badge « recommandé », case « dans le pool auto » ;
  - *Routage* : mode et stratégie par défaut, budget par run ($), synthèse on/off, plafonds par
    compte (activé, niveaux, appels max) ;
  - *Général* : réinitialiser la disposition, emplacement des fichiers.
- **Synthèse** : un modèle (niveau build, besoin « long contexte ») assemble les résultats ;
  panneau **Résultat** activé automatiquement. Un échec de synthèse ne fait pas échouer un run
  réussi.
- **Coûts d'orchestration** (plan + synthèse) comptés et affichés à part.
- **Budget** : au-delà, plus de comptes à l'usage.
- **Erreur `too_large`** + `shouldTryAnotherModel()` (repli unifié : moteur, provider, serveur).
- Espace de travail réorganisé (clés → Réglages, compte manuel → panneau Modèles).

## Fichiers touchés

| Fichier | Rôle |
|---|---|
| `packages/core/src/executor/index.ts` | `synthesize()`, coûts d'orchestration, `onCost`, raison par tentative |
| `packages/core/src/metrics/index.ts` | `overhead` (plan + synthèse) dans totaux et baseline, `overheadReferenceCost` |
| `packages/core/src/decomposer/index.ts` | usage des tokens du plan → `pipeline.planning` |
| `packages/core/src/router/auto.ts` | `budget`, `spend()`, `disabledModels` / `extraModels` |
| `packages/core/src/errors.ts` | `too_large`, `shouldTryAnotherModel` |
| `packages/core/src/catalog.ts` | familles GPT-OSS, Kimi, Llama 4, Qwen |
| `packages/server/src/index.ts` | `.relay/settings.json`, `/api/settings`, `/api/keys/test|delete`, `keyHint`, catalogue par compte |
| `packages/providers/src/factory.ts` | preset Groq 2026, filtre des modèles vocaux |
| `packages/web/src/Settings.tsx` | écran Réglages (nouveau) |
| `packages/web/src/panels.tsx` | panneau Résultat, Modèles réorganisé |
| `packages/web/src/store.tsx` | réglages côté moteur, test/suppression de clé, synthèse |
| `packages/web/src/PipelineView.tsx` | recadrage au redimensionnement |

## Décisions

- **Réglages côté moteur** (`.relay/settings.json`) plutôt que dans le navigateur : partagés
  par le desktop, le navigateur et à terme le CLI ; le navigateur ne garde que la disposition.
- **Test de clé sans coût** : liste des modèles (compatibles OpenAI), `count_tokens` (gratuit,
  Anthropic), `claude --version` (Claude Code, aucun quota).
- **Synthèse = besoin « long contexte »** : elle lit tout ; les paliers gratuits à petite
  fenêtre (Groq) renvoyaient « requête trop volumineuse ».
- **Synthèse non bloquante** : les résultats des tâches restent la source de vérité.
- **Overlay** plutôt que panneau dockview pour les Réglages : on les ouvre ponctuellement,
  ils n'ont pas à occuper l'espace de travail.

## Comment tester

```bash
pnpm test      # 86 tests (dont tests/phase-c.test.ts)
pnpm desktop
```

1. ⚙ Réglages → *Comptes et clés* → « Tester » sur Gemini et Groq (✓ N modèles accessibles).
2. *Modèles* : décocher / cocher un modèle → le panneau Modèles de l'espace de travail suit.
3. *Routage* : budget, synthèse, plafonds.
4. Lancer « Crée une calculatrice en Python avec ses tests » → onglet **Résultat** à la fin.

Référence (2026-10-07, Gemini + Groq gratuits) : 7 tâches en 51 s, synthèse en 7 s, $0 payé,
tâches réparties entre Groq (`gpt-oss-120b`, `gpt-oss-20b`) et Gemini (`flash-lite`).

## Limites connues / suite

- Les tâches produisent toujours du **texte** → phase D (fichiers et commandes réels).
- À intégrer en phase D : **contrats partagés** dans le plan (noms de fichiers, signatures)
  et champ `spec` optionnel par tâche (discussion « QUOI vs COMMENT » du 2026-10-07).
- Prix de référence hors Anthropic approximatifs ; santé et budget non persistés entre
  redémarrages.
