#!/usr/bin/env node
/**
 * @relay/cli — `relay "prompt"` : décompose, route, exécute, affiche les métriques.
 */
import {
  CORE_VERSION,
  ConfigError,
  decompose,
  describeError,
  execute,
  loadConfig,
  Router,
  type Pipeline,
  type PipelineEvent,
  type PipelineMetrics,
  type Provider,
} from "@relay/core";
import { createProvider, PROVIDER_PRESETS, ProviderError, PROVIDERS_VERSION } from "@relay/providers";

const HELP = `relay — orchestrateur de pipeline agentique

Usage :
  relay "votre prompt"                        Décompose, route et exécute (backend par défaut)
  relay --provider claude-code "…"            Ton abonnement Claude, sans clé API
  relay --provider gemini --model <id> "…"    Backend gratuit (ne touche pas ton quota Claude)
  relay --version | --help

Backends (--provider) :
  anthropic    (défaut) API Messages — ANTHROPIC_API_KEY dans .env
  claude-code  binaire 'claude' (abonnement) — aucune clé
  gemini       palier GRATUIT — GEMINI_API_KEY (ai.google.dev)
  groq         GRATUIT — GROQ_API_KEY (console.groq.com)
  openrouter   OPENROUTER_API_KEY (modèles ':free' dispo)
  deepseek     DEEPSEEK_API_KEY (très bon marché)
  ollama       local (http://localhost:11434) — aucune clé

--model <id>   force un modèle unique (requis pour les backends non-Claude)
Config : relay.config.json (routes par défaut).`;

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    return 0;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(`relay cli 0.1.0 (core ${CORE_VERSION}, providers ${PROVIDERS_VERSION})`);
    return 0;
  }

  // Options --provider <nom> et --model <id> ; le reste forme le prompt.
  let providerName: string | undefined;
  let modelOverride: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider") providerName = args[++i];
    else if (args[i] === "--model") modelOverride = args[++i];
    else rest.push(args[i] as string);
  }
  const prompt = rest.join(" ");
  if (prompt.length === 0) {
    console.error("Aucun prompt fourni. Exemple : relay \"ajoute une fonction de recherche\"");
    return 1;
  }

  // Charge .env si présent (best-effort).
  try {
    process.loadEnvFile();
  } catch {
    /* pas de .env : on compte sur l'environnement */
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Erreur de configuration : ${err.message}`);
      return 1;
    }
    throw err;
  }

  // --model force un modèle unique sur le décomposeur et toutes les routes
  // (indispensable pour tester sur un backend non-Claude : gemini, groq, ollama…).
  if (modelOverride !== undefined) {
    config.decomposer = { ...config.decomposer, model: modelOverride };
    for (const tier of ["quick", "build", "deep", "escalate"] as const) {
      config.routes[tier] = { ...config.routes[tier], model: modelOverride };
    }
  }

  const chosenProvider = providerName ?? config.decomposer.provider;
  if (PROVIDER_PRESETS[chosenProvider]?.needsModelOverride === true && modelOverride === undefined) {
    console.error(
      `Avec --provider ${chosenProvider}, précise aussi --model <id> (ex. gemini-2.0-flash), ` +
        `car les modèles par défaut sont des modèles Claude.`,
    );
    return 1;
  }

  let provider: Provider;
  try {
    provider = createProvider(chosenProvider, { cwd: process.cwd() });
  } catch (err) {
    if (err instanceof ProviderError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
  console.log(`\n🔌 Backend : ${provider.name} (facturation : ${provider.billing})`);

  const router = new Router(config);

  for (const warning of router.validate()) console.error(`⚠ ${warning}`);

  // 1. Décomposition
  console.log(`\n⏳ Décomposition du prompt…`);
  let pipeline: Pipeline;
  try {
    pipeline = await decompose({
      prompt,
      context: { cwd: process.cwd() },
      provider,
      model: config.decomposer,
    });
  } catch (err) {
    const d = describeError(err);
    console.error(`\n❌ ${d.title}\n   ${d.detail}${d.hint ? `\n   → ${d.hint}` : ""}`);
    return 1;
  }

  printPlan(pipeline);

  // 2. Exécution
  console.log(`\n🚀 Exécution\n`);
  let metrics: PipelineMetrics | undefined;
  for await (const event of execute({ pipeline, provider, router })) {
    const line = renderEvent(event);
    if (line !== undefined) console.log(line);
    if (event.type === "pipeline:done") metrics = event.metrics;
    if (event.type === "pipeline:failed") return 1;
  }

  if (metrics) printMetrics(metrics);
  return 0;
}

function printPlan(pipeline: Pipeline): void {
  console.log(`\n📋 Plan — ${pipeline.tasks.length} tâche(s) :`);
  for (const t of pipeline.tasks) {
    const deps = t.dependsOn.length > 0 ? ` ← ${t.dependsOn.join(", ")}` : "";
    console.log(`  [${t.id}] ${t.tier.padEnd(6)} ${t.type.padEnd(12)} ${t.description}${deps}`);
  }
}

function renderEvent(event: PipelineEvent): string | undefined {
  switch (event.type) {
    case "task:start":
      return `  ▶ [${event.taskId}] ${event.model}${event.effort ? ` (${event.effort})` : ""}`;
    case "task:done": {
      const m = event.metrics;
      const cost = m.billedCost > 0 ? money(m.billedCost) : `${money(m.referenceCost)} équiv.`;
      return `  ✓ [${event.taskId}] ${event.result.summary}  —  ${cost}, ${m.inputTokens + m.outputTokens} tok, ${m.durationMs} ms`;
    }
    case "task:failed":
      return `  ✗ [${event.taskId}] ${event.error}`;
    case "pipeline:failed":
      return `\n❌ Pipeline en échec : ${event.error}`;
    default:
      return undefined;
  }
}

function printMetrics(m: PipelineMetrics): void {
  console.log(`\n📊 Métriques`);
  console.log(`  Payé (facturé)    ${money(m.totalBilledCost)}`);
  console.log(`  Équivalent API    ${money(m.totalReferenceCost)}`);
  console.log(`  Baseline (deep)   ${money(m.baselineCost)}`);
  console.log(`  Économies routage ${m.savings.toFixed(1)} %  (vs tout sur deep)`);
  if (m.totalReferenceCost > m.totalBilledCost) {
    const vsRef = m.totalReferenceCost > 0 ? ((m.totalReferenceCost - m.totalBilledCost) / m.totalReferenceCost) * 100 : 0;
    console.log(`  Gain facturation  ${vsRef.toFixed(1)} %  (abonnement/local vs API)`);
  }
  console.log(`  Tokens            ${m.totalTokens}`);
  console.log(`  Durée             ${m.totalDurationMs} ms`);
  console.log(`  Tâches            ${m.successCount}/${m.taskCount} réussies`);
}

function money(n: number): string {
  return `$${n.toFixed(4)}`;
}

main(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
