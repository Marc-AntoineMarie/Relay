#!/usr/bin/env node
/**
 * @relay/cli — `relay "prompt"` : décompose, route, exécute, affiche les métriques.
 */
import {
  CORE_VERSION,
  ConfigError,
  DecomposerError,
  decompose,
  execute,
  loadConfig,
  Router,
  type Pipeline,
  type PipelineEvent,
  type PipelineMetrics,
} from "@relay/core";
import { AnthropicProvider, PROVIDERS_VERSION } from "@relay/providers";

const HELP = `relay — orchestrateur de pipeline agentique

Usage :
  relay "votre prompt"      Décompose, route et exécute le prompt
  relay --version           Affiche la version
  relay --help              Affiche cette aide

Config : relay.config.json (routes par défaut). Clé : ANTHROPIC_API_KEY dans .env`;

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

  const prompt = args.join(" ");

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

  const apiKey = config.providers["anthropic"]?.apiKey?.trim() || process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY manquante. Copie .env.example en .env et renseigne ta clé.");
    return 1;
  }

  const provider = new AnthropicProvider({ apiKey });
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
    if (err instanceof DecomposerError) {
      console.error(`Échec de la décomposition : ${err.message}`);
      return 1;
    }
    throw err;
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
    case "task:done":
      return `  ✓ [${event.taskId}] ${event.result.summary}  —  ${money(event.metrics.cost)}, ${event.metrics.inputTokens + event.metrics.outputTokens} tok, ${event.metrics.durationMs} ms`;
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
  console.log(`  Coût total        ${money(m.totalCost)}`);
  console.log(`  Baseline (deep)   ${money(m.baselineCost)}`);
  console.log(`  Économies         ${m.savings.toFixed(1)} %`);
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
