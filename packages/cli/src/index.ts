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
  type Provider,
  type RelayConfig,
} from "@relay/core";
import { AnthropicProvider, ClaudeCodeProvider, PROVIDERS_VERSION } from "@relay/providers";

const HELP = `relay — orchestrateur de pipeline agentique

Usage :
  relay "votre prompt"              Décompose, route et exécute le prompt
  relay --provider claude-code "…"  Utilise Claude Code (ton abonnement, sans clé API)
  relay --version                   Affiche la version
  relay --help                      Affiche cette aide

Backends (--provider) :
  anthropic    (défaut) API Messages, nécessite ANTHROPIC_API_KEY dans .env
  claude-code  pilote le binaire 'claude' (abonnement) — aucune clé requise

Config : relay.config.json (routes par défaut).`;

/** Instancie le provider choisi. Lève une erreur lisible si indisponible. */
function makeProvider(name: string, config: RelayConfig): Provider {
  switch (name) {
    case "anthropic": {
      const apiKey = config.providers["anthropic"]?.apiKey?.trim() || process.env["ANTHROPIC_API_KEY"];
      if (!apiKey) {
        throw new ConfigError(
          "ANTHROPIC_API_KEY manquante. Copie .env.example en .env, ou utilise --provider claude-code.",
        );
      }
      return new AnthropicProvider({ apiKey });
    }
    case "claude-code":
      // Abonnement : aucune clé. permissionMode "none" => pas d'effet de bord disque en v0.1.
      return new ClaudeCodeProvider({ cwd: process.cwd(), permissionMode: "none" });
    default:
      throw new ConfigError(`provider inconnu en v0.1 : ${name} (anthropic | claude-code)`);
  }
}

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

  // Option --provider <nom> (par défaut : celui du décomposeur dans la config).
  let providerName: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider") {
      providerName = args[++i];
    } else {
      rest.push(args[i] as string);
    }
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

  const chosenProvider = providerName ?? config.decomposer.provider;
  let provider: Provider;
  try {
    provider = makeProvider(chosenProvider, config);
  } catch (err) {
    if (err instanceof ConfigError) {
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
