/**
 * Session d'un dossier de travail : l'historique des tours (demande initiale, suites,
 * corrections) est gardé dans `<run>/.relay/session.json`. Une suite ou une correction
 * repart de ce contexte : les modèles savent ce qui a été fait et ce qui a échoué.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Pipeline } from "@relay/core";

export interface SessionTurn {
  at: string;
  kind: "plan" | "fix";
  prompt: string;
  /** Tâches du tour : « [id] description (statut) ». */
  tasks: string[];
  contracts?: string;
  outcome: "done" | "failed" | "stopped";
  /** Compte rendu (synthèse ou résumés des tâches), tronqué. */
  summary?: string;
  /** Erreur signalée par l'utilisateur (tour de correction). */
  error?: string;
}

export interface Session {
  turns: SessionTurn[];
}

/** Erreur rencontrée en testant, à corriger. */
export interface FixRequest {
  /** Ce qui a été testé : une commande, ou « aperçu de page.html ». */
  source: string;
  output: string;
  exitCode?: number | null;
  /** Précision de l'utilisateur (« le bouton = ne fait rien »). */
  note?: string;
}

const sessionFile = (root: string): string => join(root, ".relay", "session.json");

export function loadSession(root: string): Session {
  try {
    const raw = JSON.parse(readFileSync(sessionFile(root), "utf8")) as Partial<Session>;
    return { turns: Array.isArray(raw.turns) ? raw.turns : [] };
  } catch {
    return { turns: [] };
  }
}

export function appendTurn(root: string, turn: SessionTurn): void {
  const session = loadSession(root);
  session.turns.push(turn);
  mkdirSync(join(root, ".relay"), { recursive: true });
  writeFileSync(sessionFile(root), `${JSON.stringify(session, null, 2)}\n`);
}

export const lastContracts = (s: Session): string | undefined => [...s.turns].reverse().find((t) => t.contracts)?.contracts;

const OUTCOME: Record<SessionTurn["outcome"], string> = { done: "terminé", failed: "échoué", stopped: "arrêté" };

/** Contexte pour le planificateur et les agents : les tours les plus récents, dans un budget. */
export function sessionContext(s: Session, budget = 5_000): string {
  if (s.turns.length === 0) return "";
  const blocks = s.turns.map((t, i) =>
    [
      `### Tour ${i + 1} — ${t.kind === "fix" ? "correction" : "demande"} (${OUTCOME[t.outcome]})`,
      t.prompt,
      t.error !== undefined ? `Erreur signalée :\n${t.error}` : "",
      t.tasks.length > 0 ? `Tâches : ${t.tasks.join(" ; ")}` : "",
      t.summary !== undefined ? `Compte rendu : ${t.summary}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const kept: string[] = [];
  let used = 0;
  for (const b of blocks.reverse()) {
    if (kept.length > 0 && used + b.length > budget) break;
    kept.unshift(b.slice(0, budget));
    used += b.length;
  }
  return `## Travail déjà fait dans ce dossier (session Relay)\n${kept.join("\n\n")}`;
}

/** Résumé d'un tour à partir du pipeline exécuté. */
export function turnFromPipeline(
  pipeline: Pipeline,
  kind: SessionTurn["kind"],
  prompt: string,
  outcome: SessionTurn["outcome"],
  synthesis?: string,
  error?: string,
): SessionTurn {
  const summary =
    synthesis ??
    pipeline.tasks
      .map((t) => t.output?.summary)
      .filter((x): x is string => x !== undefined)
      .join(" ");
  return {
    at: new Date().toISOString(),
    kind,
    prompt,
    tasks: pipeline.tasks.map((t) => `[${t.id}] ${t.description} (${t.status})`),
    ...(pipeline.contracts !== undefined ? { contracts: pipeline.contracts } : {}),
    outcome,
    ...(summary ? { summary: summary.slice(0, 1_500) } : {}),
    ...(error !== undefined ? { error: error.slice(-2_000) } : {}),
  };
}

/** Pipeline d'une correction directe : une tâche d'agent, sans re-planification. */
export function fixPipeline(fix: FixRequest, context: Pipeline["context"], contracts?: string): Pipeline {
  const output = fix.output.length > 4_000 ? `…${fix.output.slice(-4_000)}` : fix.output;
  const note = fix.note?.trim();
  return {
    id: crypto.randomUUID(),
    prompt: `Corriger l'erreur rencontrée en testant ${fix.source}${note ? ` — ${note}` : ""}`,
    context,
    tasks: [
      {
        id: "1",
        type: "implement",
        tier: "build",
        needs: ["code"],
        description: `Corriger le projet pour que ${fix.source} fonctionne${note ? ` (${note})` : ""}, puis vérifier.`,
        spec: `L'utilisateur a testé ${fix.source}${
          fix.exitCode !== undefined && fix.exitCode !== null ? ` (code ${fix.exitCode})` : ""
        } et obtenu :\n${output || "(aucune sortie)"}\n
Objectif : que l'utilisateur puisse réellement utiliser le programme comme il l'a demandé (voir l'historique du projet).
- Trouve la cause (lis les fichiers concernés avec ===READ=== si besoin) et corrige-la.
- INTERDIT de masquer l'erreur : pas de faux module, de bouchon (stub), de try/except qui avale l'erreur, ni de fonctionnalité désactivée — le programme doit faire ce qui est demandé.
- Si un outil ou un module manque sur la machine (voir « Outils » et « ABSENTS »), change d'approche avec ce qui est présent (ex. page HTML autonome à ouvrir dans le navigateur au lieu de tkinter, ou interface en ligne de commande), et adapte tests et README.
- Vérifie : relance la commande si elle se termine seule ; pour une application graphique ou interactive, vérifie au moins l'import et la logique.
- Termine par la commande exacte pour lancer le programme.`,
        dependsOn: [],
        status: "pending",
        attempts: [],
      },
    ],
    status: "pending",
    created: new Date(),
    ...(contracts !== undefined ? { contracts } : {}),
  };
}

/** Tour n ≥ 2 : ids « n.1, n.2… » pour distinguer les tâches des tours précédents. */
export function renumber(pipeline: Pipeline, round: number): void {
  if (round < 2) return;
  const id = (x: string): string => `${round}.${x}`;
  for (const t of pipeline.tasks) {
    t.id = id(t.id);
    t.dependsOn = t.dependsOn.map(id);
  }
}
