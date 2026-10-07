# 2026-10-06 → 07 — Historique : du socle v0.1 à la phase A

- **Statut** : livré
- **Commits** : `413e235` → `934801c` (voir le CHANGELOG pour le découpage)

Fiche de rattrapage : elle résume tout ce qui a été construit avant la mise en place du
dossier `docs/contributions/`.

## Ce qui a été construit, dans l'ordre

1. **Revue de la doc initiale** et corrections vérifiées contre l'API Anthropic : IDs de
   modèles sans suffixe de date, pas d'`effort` pour Haiku 4.5, structured outputs pour le
   décomposeur (le `tool_choice` forcé est refusé par les modèles récents).
2. **Socle v0.1** (étapes 1 → 10 de `docs/PREMIER-PROMPT.md`) : monorepo, types, adaptateur
   Anthropic, décomposeur, routeur, exécuteur, métriques, moniteur, config, CLI.
3. **Stratégie multi-fournisseurs** (`docs/PROVIDERS.md`) : appels directs avec les clés de
   l'utilisateur, zéro marge ; les abonnements grand public ne sont pas routables par API.
4. **Multi-backend** : provider Claude Code (pilote le binaire `claude` sur abonnement),
   provider compatible OpenAI (Gemini, Groq, OpenRouter, DeepSeek, Ollama) ; métriques
   « payé » vs « équivalent API ».
5. **Dashboard web + serveur local**, puis **app desktop Electron** (demandée par
   l'utilisateur après des problèmes de connexion au serveur web).
6. **Fiabilisation** après le premier run réel : décomposeur robuste, erreurs normalisées,
   modèles par tier, repli, détection des modèles, timeout.
7. **Phase A** : panneaux libres (dockview), graphe zoomable.

## Décisions marquantes

- **Pas de framework d'agents ni d'abstraction tierce** pour les LLM : SDK officiels uniquement.
- **Claude Code plutôt que l'API pour l'abonnement** : l'abonnement n'est utilisable que via
  le harnais officiel ; extraire le jeton OAuth pour l'API brute est refusé (CGU).
- **Tests gratuits** sur Gemini pour préserver le quota Claude de l'utilisateur.
- **Electron** charge une URL `127.0.0.1` qu'il contrôle, le serveur tourne dans son processus.

## Leçons apprises (problèmes réels rencontrés)

- `gemini-2.0-flash` / `2.5-flash` sont retirés pour les nouveaux comptes → alias `*-latest`.
- Les paliers gratuits saturent souvent (503) et `gemini-pro-latest` n'est pas inclus dans le
  gratuit (« quota limit: 0 »).
- Sans timeout, une requête vers un backend saturé pendait 10 minutes.
- `localhost` résolu en IPv6 alors que le serveur écoutait en IPv4 → « site inaccessible ».
- pnpm bloque le postinstall d'Electron → `pnpm.onlyBuiltDependencies`.
- Lancé depuis `packages/desktop`, le serveur cherchait l'UI au mauvais endroit → chemins
  résolus depuis l'emplacement du fichier serveur.
