# 2026-10-08 — Phase G : terminal intégré

- **Statut** : validée (« go faire la H »)
- **Commits** : `93ea227` · docs

## Demande

« Voir s'il est possible d'intégrer un terminal directement connecté à tout dans Relay. »

## Ce qui a changé

- **Onglet Terminal** (en bas, à côté de Journal / Exécution / Coûts) : un vrai shell interactif
  (ton `$SHELL`, couleurs, programmes interactifs, redimensionnement) ouvert dans le **dossier du
  projet**, affiché par **xterm.js** (le terminal de VS Code).
- **Connecté à Relay** :
  - **Erreur → Relay** : la sélection (ou la fin de la sortie) devient un nœud d'erreur du pipeline,
    avec « Corriger avec Relay » ;
  - **→ Conversation** : ajoute la sélection à ton message (pour poser une question avec la sortie).
- La session vit **côté moteur** : changer d'onglet, de disposition ou recharger la page ne tue pas
  le shell (les dernières sorties sont rejouées). *Nouveau terminal* repart d'un shell neuf.
- **Sans clés API** dans l'environnement du terminal (comme pour les commandes des agents).
- **Sécurité** : le serveur de Relay n'écoute plus que sur la machine (`127.0.0.1` et `::1`) — avant,
  il était joignable depuis le réseau local, ce qui aurait été grave avec un terminal et les
  commandes. Les requêtes d'autres origines restaient déjà refusées.

## Décisions

- **Pont Python (`pty`)** plutôt que **node-pty** : node-pty est un module natif à compiler, et à
  recompiler pour Electron (versions de Node différentes entre Electron et le mode navigateur).
  Le pont fait ~50 lignes, utilise la bibliothèque standard de Python (déjà requise par les projets
  Python) et gère le redimensionnement par un canal dédié. Limite : Linux et macOS (Windows plus tard,
  via ConPTY).
- **SSE + POST** plutôt que WebSocket : Node n'a pas de serveur WebSocket intégré ; en local, la
  latence d'une requête par paquet de frappe (regroupée par 8 ms) est imperceptible.
- Dépendances ajoutées : `@xterm/xterm`, `@xterm/addon-fit` (JavaScript pur), justifiées par la
  demande explicite.

## Fichiers touchés

| Fichier | Rôle |
|---|---|
| `packages/server/src/terminal.ts` | sessions, pont pty, flux, saisie, redimensionnement, environnement sans secrets |
| `packages/server/src/index.ts` | `/api/terminal/{open,stream,input,resize,close,list}`, écoute limitée à 127.0.0.1 / ::1 |
| `packages/web/src/terminal.tsx` | panneau Terminal (xterm.js), Erreur → Relay, → Conversation |
| `packages/web/src/{App.tsx,api.ts,styles.css}` | onglet Terminal (disposition v7), lecteur SSE partagé |

## Comment tester

```bash
pnpm test        # 140 tests (dont le terminal : shell, dossier, redimensionnement, pas de clé API)
pnpm desktop
```

Ouvre un projet → onglet **Terminal** → `python3 src/main.py` ; si ça plante, sélectionne
l'erreur → **Erreur → Relay** → « Corriger avec Relay ».

**Testé** : en test automatique et dans l'app (commande tapée, sortie colorée, nœud d'erreur créé) ;
serveur injoignable depuis l'IP réseau de la machine (127.0.0.1, localhost et ::1 répondent).
