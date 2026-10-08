# 2026-10-08 — Phase F : Ollama intégré, comptes gratuits NVIDIA & co, lancements vérifiés

- **Statut** : en attente de validation par l'utilisateur
- **Commits** : `82f796e` (comptes + correctifs) · `8864024` (Ollama, vérification des corrections) · docs

## Demande

« Ajouter bien d'autres modèles comme kimi-k3, deepseek ou des modèles de NVIDIA (j'ai un
compte NVIDIA dev, plein de modèles gratuits). Ensuite la phase F : setup d'Ollama facile depuis
Relay, avec explications et doc ; si ma machine n'a pas les ressources, proposer facilement un
Ollama gratuit sur un VPS, ou un accès VPS facile mais payant. » Plus une erreur au lancement du
dernier projet (`python3 src/main.py` → `No module named 'src'`) que « Corriger » n'avait pas réglée.

## Ce qui a changé

### Comptes et modèles

- Presets **NVIDIA** (`integrate.api.nvidia.com/v1`, clé `nvapi-…`, gratuit, ~40 req/min pour le
  compte ; sélection : Nemotron 3.5 Lightning en quick, DeepSeek V4.1 Flash en build, Kimi K3 en
  deep, replis DeepSeek V4 Pro et Nemotron 3 Ultra), **Cerebras**, **Mistral**, **Hugging Face**,
  **Ollama Cloud** — tous via l'adaptateur compatible OpenAI, clés dans `.env`.
- Catalogue : familles Nemotron (Ultra/Super/Nano), Kimi K3, DeepSeek V4 Pro / Flash, Mistral
  (Large/Code/Small), GLM, MiniMax, Gemma, Phi, petits Qwen.
- Grands catalogues sans sélection disponible : 2 meilleurs modèles connus par niveau (pas des
  dizaines).

### Erreur de lancement (cause et correctifs)

- Cause : les agents vérifiaient `python3 -c "import src.main"` (qui marche depuis la racine)
  au lieu de la commande réellement donnée (`python3 src/main.py`), puis la correction a échoué
  faute de modèle disponible (pool gratuit saturé).
- Les agents vérifient désormais la **commande de lancement exacte** ; pour un programme qui ne
  s'arrête pas seul (fenêtre, jeu) : `timeout 5 <commande>`, et « toujours en marche » (code 124)
  compte comme un démarrage réussi. Le point d'entrée doit se lancer par une commande simple, sans
  variable d'environnement.
- Une **correction** doit prouver son résultat : modifier sans relancer la commande déclenche une
  relance de la vérification.
- Réponse inutilisable (outil inventé, réponse vide) : **second essai** sur le même modèle avant le
  repli.
- Découpage des commandes **tenant compte des guillemets** (`python3 -c "a; b"`).
- Ollama compté comme lent dans le routage (CPU).

### Ollama (Réglages › Ollama, guide `docs/OLLAMA.md`)

- **Ta machine** : processeur, RAM (totale et libre), GPU, disque, verdict ; pastilles
  *adapté / limite / trop gros* pour les modèles conseillés.
- **Installation en un clic, sans mot de passe** (Linux) : archive officielle `.tar.zst` (~1,4 Go)
  extraite dans `~/.local/share/relay/ollama`, progression affichée ; démarrage / arrêt par Relay
  (lié à 127.0.0.1, arrêté quand Relay quitte).
- **Modèles** : installés (tester → tokens/s, supprimer), conseillés et n'importe quel modèle de
  la bibliothèque, téléchargement avec progression.
- **VPS** : clé SSH dédiée générée, test de connexion (specs du serveur), installation officielle
  à distance, **tunnel SSH** (aucun port ouvert) rouvert au démarrage ; guide Oracle Cloud Always
  Free (2 cœurs / 12 Go depuis juin 2026), options payantes, Ollama Cloud.

## Fichiers touchés

| Fichier | Rôle |
|---|---|
| `packages/providers/src/factory.ts` | presets NVIDIA, Cerebras, Mistral, Hugging Face, Ollama Cloud ; `timeoutMs`, `baseURLEnv` ; pool des grands catalogues |
| `packages/core/src/catalog.ts` | nouvelles familles |
| `packages/core/src/router/auto.ts` | vitesse réelle d'un compte (`PoolEntry.speed`) |
| `packages/core/src/workspace/{commands,protocol}.ts` | `timeout`, découpage avec guillemets, vérification de la commande exacte |
| `packages/core/src/agent/index.ts` | `timeout` → 124 = en marche, vérification obligatoire (`mustVerify`) |
| `packages/core/src/executor/index.ts` | second essai sur réponse inutilisable |
| `packages/server/src/ollama.ts` | machine, conseils, installation, serveur, modèles, VPS (SSH, tunnel) |
| `packages/server/src/index.ts` | `/api/ollama/*`, réglages `ollamaTarget` / `ollamaRemote`, `OLLAMA_BASE_URL`, arrêt propre |
| `packages/web/src/OllamaSettings.tsx` | écran Réglages › Ollama |
| `docs/OLLAMA.md`, `docs/PROVIDERS.md` | guide Ollama, tableau des fournisseurs |

## Décisions

- **Installation utilisateur** plutôt que système : aucun mot de passe, réversible (un dossier),
  Relay maîtrise démarrage et arrêt (important avec 7 Go de RAM).
- **Tunnel SSH** plutôt qu'exposer Ollama (qui n'a pas d'authentification) : rien d'ouvert, pas de
  domaine ni de certificat à gérer.
- Accès VPS **fourni par Relay** (payant) : nécessite un service en ligne (comptes, facturation) —
  reporté, hors de l'app locale.

## Comment tester

```bash
pnpm test        # 128 tests
pnpm desktop
```

- Réglages › Comptes et clés › **NVIDIA** : colle ta clé `nvapi-…` → *Tester* → Réglages › Modèles.
- Réglages › **Ollama** : lis le verdict, *Installer* (1,4 Go), *Démarrer*, télécharge
  `qwen3:1.7b`, *Tester*.
- Projet existant : lance `python3 src/main.py` depuis Exécution ; en cas d'erreur, *Corriger avec
  Relay*.

**Testé** : détection de la machine (Ryzen 5 5500U, 7,1 Go, iGPU) ; installation de bout en bout
sur une archive `.tar.zst` de test servie en local (le vrai téléchargement de 1,4 Go n'a pas été
lancé sans accord) ; écran Ollama et VPS ; correction réelle de `No module named 'src'` sur une
copie du projet (4 replis + second essai avant qu'un modèle gratuit réponde). **Non testé en
réel** : clés NVIDIA/Cerebras/Mistral/HF/Ollama Cloud (pas de clé), installation réelle, VPS.

## Complément (2026-10-08, matin) — modèle bloqué 15 min, erreur qui revenait

**Constat de l'utilisateur** : Kimi K3 (NVIDIA) « tournait en échec depuis 15 min », puis a
produit des commandes incohérentes ; son projet `annoy` affichait encore une `TypeError` alors
qu'un run précédent annonçait « lancement validé ».

**Causes** : aucune limite de durée pendant le flux (le délai ne couvrait que la connexion) ;
« Arrêter » ne coupait pas l'appel en cours ; réponses dégénérées renvoyées au même modèle ;
vérification laissée à la discipline du modèle ; files d'attente énormes sur le palier gratuit
NVIDIA (mesures : Lightning < 1 s, GLM 5.3 Flash ~25 s, DeepSeek V4.1 Flash ~114 s, Kimi K3 > 120 s).

**Correctifs** : délais d'inactivité (90 s) et durée max (5 min, réglable) ; annulation réelle
(arrêt, « passer au modèle suivant ») ; détection des réponses incohérentes ; vérification finale
du lancement **par Relay** + correction automatique (une fois) + ▶ Lancer le projet ; pendant une
correction, Relay relance lui-même la commande après chaque modification ; routage qui mesure la
latence et évite les modèles lents ; sélection NVIDIA revue. Commit `45c4ee1`.

**Essais réels** (copie du projet) : la vérification finale a bien détecté qu'une correction avait
réintroduit `No module named 'src'` ; au 3ᵉ essai, tous les fournisseurs gratuits étaient lents ou
saturés (ce qui a motivé le routage par latence). La convergence de bout en bout reste à confirmer
par l'utilisateur dans l'app.
