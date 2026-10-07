# Fournisseurs & routage multi-modèles

Comment Relay atteint « le modèle le plus compétent et le moins coûtant » à travers
plusieurs fournisseurs, sans marge de redirection.

## 1. Principe : appel direct, clés de l'utilisateur, zéro marge

- Chaque fournisseur est appelé via **son API native**, avec **la clé de l'utilisateur**.
  Le prix payé est le **prix fournisseur exact** : aucune marge de redirection.
- **Pas d'agrégateur** (OpenRouter & co.) comme route par défaut : ils ajoutent une
  marge (~5 %). Autorisé uniquement en **fallback explicite**, pour accéder à un modèle
  dont l'utilisateur n'a pas la clé — et clairement signalé comme tel dans les métriques.
- La décision de routage doit être **quasi-gratuite** : heuristique + registre local,
  **jamais** un gros appel LLM juste pour choisir. Sinon la redirection coûte plus
  qu'elle ne fait gagner.

## 2. Connexion : clés API, jamais abonnements

« Connecter un compte » = **coller une clé API par fournisseur**.

| | Clé API (compte développeur) | Abonnement grand public |
|---|---|---|
| Accès programmatique | **Oui** | **Non** — aucune API supportée |
| Facturation | à l'usage, prix exact | forfait, non routable |
| Statut | ✅ supporté | ❌ hors scope, définitif |

Les abonnements (ChatGPT Plus, Gemini Advanced, Perplexity Pro, Claude Pro) ne sont
**pas** routables : pas d'API, contraire aux CGU, risque de bannissement. Relay ne
tentera jamais de router via un login grand public.

**Stockage des clés** : `.env` en v0.1 ; trousseau / stockage chiffré local à partir du
desktop (v0.4). Une clé n'est **jamais** envoyée ailleurs que vers l'API de son
fournisseur.

**Cible** : développeurs et équipes → créer une clé par fournisseur est une friction
ponctuelle acceptable. Pour un public non technique, ce serait un vrai frein ; à
assumer dans l'onboarding.

## 3. Fournisseurs visés

| Fournisseur | Modèles | Clé requise | Version |
|---|---|---|---|
| Anthropic | Haiku, Sonnet, Opus, Fable | `ANTHROPIC_API_KEY` | v0.1 |
| OpenAI | gamme GPT | `OPENAI_API_KEY` | v0.2 |
| Ollama | modèles locaux (**gratuits**) | — (serveur local) | v0.2 |
| Google Gemini | gamme Gemini (+ **palier gratuit**) | `GEMINI_API_KEY` | v0.2–v0.3 |
| Perplexity | Sonar | `PERPLEXITY_API_KEY` | v0.3 |
| OpenRouter | tous modèles (**fallback only**, marge) | `OPENROUTER_API_KEY` | v0.3 |
| Groq | GPT-OSS, Llama 4, Kimi, Qwen (**palier gratuit**) | `GROQ_API_KEY` | testé (2026-10-07) |
| DeepSeek | DeepSeek Chat / Reasoner (à l'usage, très bon marché) | `DEEPSEEK_API_KEY` | non testé |
| **NVIDIA** (build.nvidia.com) | 100+ modèles ouverts : Kimi K3, DeepSeek V4, Nemotron, Llama, Qwen… (**gratuit** avec un compte NVIDIA Developer, ~40 req/min pour tout le compte) | `NVIDIA_API_KEY` (`nvapi-…`) | ajouté le 2026-10-08, à tester |
| Cerebras | Llama, Qwen… très rapides (**palier gratuit**) | `CEREBRAS_API_KEY` | non testé |
| Mistral | Mistral, Codestral… (**palier gratuit** « Experiment ») | `MISTRAL_API_KEY` | non testé |
| Hugging Face | routeur vers de nombreux fournisseurs (**petits crédits gratuits**) | `HF_TOKEN` | non testé |
| Ollama Cloud | modèles « cloud » d'Ollama (compte ollama.com) | `OLLAMA_API_KEY` | non testé |
| Ollama (local ou VPS) | modèles ouverts sur ta machine ou ton serveur (**gratuit**) | — ; adresse via `OLLAMA_BASE_URL` (tunnel SSH vers un VPS) | phase F, voir [OLLAMA.md](OLLAMA.md) |

Tous ces comptes passent par l'adaptateur compatible OpenAI ; les modèles sont détectés via
`GET /models`. Pour les grands catalogues (NVIDIA, Hugging Face), le pool automatique prend
la sélection du preset si elle est disponible, sinon les 2 meilleurs modèles **connus du
catalogue** par niveau.

Ajouter un fournisseur = **un adaptateur** (`packages/providers/src/<nom>.ts`) qui
implémente l'interface `Provider`, **plus** des entrées dans le registre de modèles.

## 4. Registre de modèles

Le routeur s'appuie sur un registre central `{ modèle → provider, prix in/out, fenêtre
de contexte, forces par type de tâche, disponibilité (clé présente ?) }`.

- L'embryon existe déjà : `MODELS` dans
  [`packages/providers/src/anthropic.ts`](../packages/providers/src/anthropic.ts).
- À **extraire en registre partagé** (`packages/core`) dès l'ajout du 2ᵉ fournisseur,
  pour que le routeur raisonne sur tous les modèles de la même façon.

## 5. Politique « compétent ET moins cher »

Ce n'est pas un optimum unique mais un **arbitrage**, appliqué par tâche :

1. **Exigence de la tâche** : son `tier` (déjà produit par le décomposeur) + son `type`
   donnent le niveau de capacité requis.
2. **Candidats disponibles** : modèles dont la clé est présente **et** capables de ce
   type au niveau requis.
3. **Choix** : parmi les candidats, le **moins coûtant** pour cette tâche (coût estimé
   via le registre). « Moins coûtant » inclut **gratuit** : Ollama local (0 €) et les
   paliers gratuits sont les candidats naturels du tier `quick`.
4. **Escalade** : à l'échec vérifié, monter d'un cran (effort, puis modèle plus capable)
   et re-router — `effortFirst` d'abord (voir [ARCHITECTURE.md](ARCHITECTURE.md)).

Tout le scoring reste **local et bon marché**.

## 6. Retour temps réel par modèle

Déjà porté par l'architecture : le `Monitor` streame les événements et le
`MetricsStore` enregistre `provider` + `model` + `cost` + tokens + durée pour chaque
tentative. Le dashboard affiche l'usage et le coût **par modèle**, en direct et en
historique — multi-fournisseur sans code supplémentaire côté métriques.
