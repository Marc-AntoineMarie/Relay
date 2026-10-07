/**
 * Mémoire de projet (inspirée de CLAUDE.md dans Claude Code) : un fichier `RELAY.md` à la
 * racine du projet, lisible et modifiable par l'utilisateur, que Relay tient à jour après
 * chaque tour avec un petit modèle. Il est relu au début de chaque tour : les modèles
 * retrouvent l'objectif, la structure, les commandes et les décisions sans tout relire.
 */
import type { ModelAssignment, Provider, StopReason } from "../types.js";

export const MEMORY_FILE = "RELAY.md";
/** Taille max de la mémoire transmise aux modèles (caractères). */
export const MEMORY_BUDGET = 6_000;

const MEMORY_SYSTEM =
  "Tu tiens la mémoire d'un projet logiciel géré par l'orchestrateur Relay. Tu écris un fichier Markdown court, factuel et à jour, destiné aux modèles qui travailleront ensuite sur le projet.";

export interface MemoryUpdate {
  text: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  servedModel?: string;
  stop?: StopReason;
}

export function memoryPrompt(input: { projectName: string; current: string; turn: string; files: string[] }): string {
  return `# Mémoire actuelle (${MEMORY_FILE})
${input.current.trim() || "(vide : premier tour)"}

# Ce qui vient de se passer
${input.turn}

# Fichiers du projet
${input.files.join("\n") || "(aucun)"}

# Consignes
Réécris ${MEMORY_FILE} en entier (60 lignes max), en français, avec exactement ces titres :

# ${input.projectName}
## Objectif
## Structure
## Lancer et tester
## Décisions et contraintes
## Historique
## À faire / problèmes connus

Contenu attendu sous chaque titre :
- Objectif : ce que l'utilisateur veut obtenir, en 1 à 3 lignes.
- Structure : fichiers clés et leur rôle.
- Lancer et tester : commandes exactes, depuis le dossier du projet.
- Décisions et contraintes : choix faits et pourquoi, dont les outils absents de la machine et leurs conséquences.
- Historique : une ligne par tour (demande ou correction → résultat).
- À faire / problèmes connus : ce qui reste, ce qui risque de ne pas marcher (ex. un module absent ici).
Garde ce que l'utilisateur a écrit à la main, sauf si c'est devenu faux. Pas de bloc de code autour du fichier : uniquement son contenu.`;
}

/** Demande à un modèle (petit, rapide) la nouvelle version de la mémoire. */
export async function updateProjectMemory(opts: {
  provider: Provider;
  model: ModelAssignment;
  projectName: string;
  current: string;
  turn: string;
  files: string[];
}): Promise<MemoryUpdate> {
  const out: MemoryUpdate = { text: "", inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
  for await (const chunk of opts.provider.complete({
    model: opts.model.model,
    ...(opts.model.effort !== undefined ? { effort: opts.model.effort } : {}),
    system: MEMORY_SYSTEM,
    messages: [{ role: "user", content: memoryPrompt(opts) }],
    maxTokens: 4_000,
  })) {
    if (chunk.type === "text") out.text += chunk.text;
    else if (chunk.type === "usage") {
      out.inputTokens += chunk.usage.inputTokens;
      out.outputTokens += chunk.usage.outputTokens;
      out.thinkingTokens += chunk.usage.thinkingTokens ?? 0;
    } else if (chunk.type === "model") out.servedModel = chunk.model;
    else if (chunk.type === "stop") out.stop = chunk.reason;
  }
  out.text = cleanMemory(out.text);
  return out;
}

/** Retire un éventuel bloc de code englobant ; garantit une fin de ligne. */
export function cleanMemory(raw: string): string {
  const fenced = /^\s*```[\w-]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(raw);
  const body = (fenced?.[1] ?? raw).trim();
  return body.length === 0 ? "" : `${body}\n`;
}

/** Mémoire bornée pour un prompt. */
export function clipMemory(text: string, budget = MEMORY_BUDGET): string {
  return text.length > budget ? `${text.slice(0, budget)}\n[…mémoire tronquée]` : text;
}
