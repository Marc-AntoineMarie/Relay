#!/usr/bin/env node
/**
 * @relay/cli — point d'entrée en ligne de commande.
 *
 * Objectif v0.1 : `relay "prompt"` → décompose, route, exécute, affiche les métriques.
 * Pour l'instant, squelette : affiche la version et un rappel d'usage.
 */
import { CORE_VERSION } from "@relay/core";
import { PROVIDERS_VERSION } from "@relay/providers";

function main(argv: string[]): void {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(
      [
        "relay — orchestrateur de pipeline agentique",
        "",
        "Usage :",
        '  relay "votre prompt"      Décompose, route et exécute le prompt (à venir)',
        "  relay --version           Affiche la version",
        "  relay --help              Affiche cette aide",
      ].join("\n"),
    );
    return;
  }

  if (args[0] === "--version" || args[0] === "-v") {
    console.log(`relay cli 0.1.0 (core ${CORE_VERSION}, providers ${PROVIDERS_VERSION})`);
    return;
  }

  console.log("Le pipeline n'est pas encore implémenté (v0.1 en cours). Prompt reçu :");
  console.log(`  ${args.join(" ")}`);
}

main(process.argv);
