# Ollama dans Relay (phase F)

Ollama fait tourner des modèles ouverts **gratuitement**, sur ta machine ou sur un serveur à
toi. Relay les ajoute au routage automatique, marqués « lents » s'ils tournent sur CPU : ils
servent surtout quand les quotas gratuits en ligne sont épuisés, et tes données restent chez toi.

Tout se règle dans **Réglages › Ollama**.

## 1. Ta machine

Relay détecte processeur, mémoire (totale et libre), carte graphique et disque, puis donne un
verdict. Règle utilisée : un modèle demande à peu près `taille × 1,2 + 1 Go` de mémoire
(contexte compris). Sans GPU dédié, tout passe par la RAM, dont ~2,5 Go restent au système.

Exemple : 7 Go de RAM sans GPU dédié → modèles de ~3 Go au plus (1,7 à 3 milliards de
paramètres), lents. Pour mieux : un VPS ou Ollama Cloud.

## 2. Installer sur cette machine (Linux, sans mot de passe)

« Installer Ollama » télécharge l'**archive officielle** (`ollama.com/download/ollama-linux-<arch>.tar.zst`,
~1,4 Go — la même que le script officiel) et l'extrait dans `~/.local/share/relay/ollama`.
Pas de sudo, pas de service système : Relay démarre `ollama serve` (lié à `127.0.0.1`) quand
tu le demandes et l'arrête en quittant. Pour une installation système à la place :

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

macOS / Windows : télécharger sur <https://ollama.com/download>.

## 3. Modèles

- Liste des modèles installés : taille, paramètres, quantification ; **Tester** (temps de
  réponse, tokens/s) ; **Supprimer**.
- Modèles conseillés avec une pastille *adapté / limite / trop gros ici*, **Télécharger** avec
  progression, ou n'importe quel nom de <https://ollama.com/library>.
- Les familles connues du catalogue entrent dans le pool du mode auto (Réglages › Modèles pour
  ajuster).

## 4. Ollama sur un VPS (tunnel SSH)

Ollama reste **fermé au monde** sur le serveur (il écoute en local) : Relay s'y relie par un
tunnel SSH chiffré (`127.0.0.1:11435` ici → `127.0.0.1:11434` sur le VPS). Aucun port à ouvrir,
aucun mot de passe stocké, la clé privée reste sur ta machine.

1. **Clé SSH de Relay** : `~/.ssh/relay_ed25519` (générée sans phrase de passe) ; colle la clé
   *publique* chez l'hébergeur à la création du serveur.
2. **Ton serveur** : IP, utilisateur (`ubuntu` par défaut), port → *Tester la connexion*
   (système, cœurs, RAM, disque, Ollama présent ou non).
3. **Installer** : commande officielle exécutée par SSH (`curl -fsSL https://ollama.com/install.sh | sudo -n sh`).
   Il faut un sudo sans mot de passe (c'est le cas de l'utilisateur `ubuntu` sur Oracle Cloud) ;
   sinon, lance la commande à la main sur le VPS.
4. **Connecter** : ouvre le tunnel ; Relay utilise alors l'Ollama du VPS (réglage mémorisé, tunnel
   rouvert au démarrage de Relay).

### Où trouver un serveur

- **Gratuit — Oracle Cloud « Always Free »** : une machine ARM de **2 cœurs et 12 Go de RAM**
  (réduite de 4 cœurs / 24 Go le 15 juin 2026), sans limite de durée. Modèles de 7–8 milliards
  de paramètres, lentement. Image Ubuntu, forme `VM.Standard.A1.Flex`, clé SSH de Relay. En cas
  de « Out of capacity », réessayer plus tard ou changer de zone.
- **Payant** : n'importe quelle machine Ubuntu avec 8 à 16 Go de RAM (VPS CPU de quelques euros
  par mois, modèles moyens) ou un serveur GPU loué à l'heure (gros modèles).
- **Sans serveur** : Ollama Cloud (clé dans Comptes et clés › Ollama Cloud).

Un accès VPS fourni directement par Relay (payant, prêt à l'emploi) demanderait un service en
ligne côté Relay (comptes, facturation) : noté pour plus tard, hors de l'app locale.

## Sécurité

- Ollama local et distant écoutent uniquement sur `127.0.0.1`.
- Les champs SSH sont validés et passés en arguments (jamais à un shell local) ; les commandes
  distantes sont fixes.
- Le tunnel et le serveur démarrés par Relay sont arrêtés quand Relay quitte.
