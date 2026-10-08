/**
 * Worker agentique (phase D) : la tâche agit réellement sur le dossier de travail.
 *
 * Boucle : le modèle répond avec des actions (protocole FILE / RUN / READ) → Relay écrit
 * les fichiers, lit ce qui est demandé, lance les commandes (selon la politique) → renvoie
 * les résultats au modèle, qui corrige. Fin quand plus rien n'échoue ni n'est demandé, ou
 * au bout de `maxIterations` tours (la tâche est alors marquée « vérifications en échec »
 * et l'exécuteur peut l'escalader).
 */
import { abortError, ProviderRequestError } from "../errors.js";
import type { RunTask, WorkerResult } from "../executor/index.js";
import type { CompletionRequest, LogEntry, Message, PipelineEvent, Provider } from "../types.js";
import { checkCommand, runCommand, type CommandPolicy, type CommandResult } from "../workspace/commands.js";
import { ACTION_PROTOCOL, condense, looksDegenerate, parseActions } from "../workspace/protocol.js";
import type { Workspace } from "../workspace/workspace.js";

export const AGENT_SYSTEM =
  "Tu es un agent de développement dans le pipeline Relay. Tu travailles dans un vrai dossier : tu crées et modifies des fichiers et lances des commandes grâce au protocole d'action. Fais exactement ta tâche, vérifie ton travail quand c'est pertinent, et reste concis hors des fichiers. Écris tes phrases (hors code) dans la langue de la demande originale.";

export interface AgentOptions {
  workspace: Workspace;
  policy: CommandPolicy;
  /** Mode Prudent : demande à l'utilisateur d'autoriser une commande. */
  approve?: (req: { taskId: string; id: string; command: string }) => Promise<boolean>;
  /** Tours maximum (réponse du modèle → actions → résultats). Défaut 4. */
  maxIterations?: number;
  /** Outils disponibles sur la machine (ex. « python3 3.13, node 22 »). */
  environment?: string;
  commandTimeoutMs?: number;
}

type Emit = (event: PipelineEvent) => void;

/** Types de tâches qui doivent laisser des fichiers dans le dossier. */
const EXPECTS_FILES = new Set(["scaffold", "implement", "test", "document", "format"]);

const log = (taskId: string, level: LogEntry["level"], title: string, detail?: string): PipelineEvent => ({
  type: "log",
  entry: { at: Date.now(), level, category: "tool", taskId, title, ...(detail !== undefined ? { detail } : {}) },
});

export function agenticRunTask(opts: AgentOptions): RunTask {
  const maxIterations = opts.maxIterations ?? 4;
  let commandSeq = 0;

  return async (ctx) => {
    const { task, provider, emit } = ctx;
    const signal = ctx.request.signal;
    const checkAbort = (): void => {
      if (signal?.aborted === true) throw abortError(signal, provider.name, ctx.request.model);
    };
    const promptHasCjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(ctx.request.messages[0]?.content ?? "");
    const ws = opts.workspace;
    const [first, ...rest] = ctx.request.messages;
    const messages: Message[] = [
      { role: "user", content: `${first?.content ?? ""}\n\n${workspaceSection(ws, opts.environment)}\n\n${ACTION_PROTOCOL}` },
      ...rest,
    ];
    const result: WorkerResult = { text: "", inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
    const written = new Set<string>();
    const commands: Array<{ command: string; exitCode: number | null }> = [];
    let verifyNudged = false;
    let lastReply = "";
    let checksFailed = false;

    const runOne = async (command: string): Promise<CommandResult & { refused?: string }> => {
      const id = `${task.id}-${++commandSeq}`;
      const check = checkCommand(command, opts.policy);
      let refused = check.allowed ? undefined : check.reason;
      if (refused === undefined && check.needsApproval === true) {
        emit(log(task.id, "info", `#${task.id} attend ta validation : ${command}`));
        const ok = opts.approve !== undefined ? await opts.approve({ taskId: task.id, id, command }) : false;
        if (!ok) refused = "refusée par l'utilisateur";
      }
      if (refused !== undefined) {
        const r = { command, exitCode: null, output: "", durationMs: 0, timedOut: false, refused };
        emit({ type: "command:done", taskId: task.id, id, ...r });
        emit(log(task.id, "warn", `#${task.id} commande refusée : ${command}`, refused));
        return r;
      }
      emit({ type: "command:start", taskId: task.id, id, command });
      emit(log(task.id, "info", `#${task.id} ▶ ${command}`));
      const r = await runCommand(command, { cwd: ws.root, timeoutMs: opts.commandTimeoutMs ?? 60_000, ...(signal !== undefined ? { signal } : {}) });
      emit({ type: "command:done", taskId: task.id, id, ...r });
      emit(
        log(
          task.id,
          r.exitCode === 0 ? "info" : "warn",
          `#${task.id} ${r.exitCode === 0 ? "✓" : "✗"} ${command} → ${r.timedOut ? "délai dépassé" : `code ${r.exitCode}`} (${(r.durationMs / 1000).toFixed(1)} s)`,
          r.output || "(aucune sortie)",
        ),
      );
      return r;
    };

    for (let iter = 0; iter < maxIterations; iter++) {
      checkAbort();
      const reply = await collect(provider, { ...ctx.request, system: AGENT_SYSTEM, messages }, ctx.onChunk);
      checkAbort();
      if (iter === 0 && reply.text.trim().length === 0) {
        // Tout parti en réflexion, ou rien : un autre modèle fera mieux.
        throw new ProviderRequestError("invalid_output", "réponse vide (aucun texte produit)", provider.name, ctx.request.model);
      }
      if (looksDegenerate(reply.text, promptHasCjk)) {
        // Le modèle « déraille » (charabia, commandes absurdes) : on change de modèle au lieu de lui faire corriger.
        emit(log(task.id, "warn", `#${task.id} réponse incohérente de ${ctx.request.model} → autre modèle`, reply.text.slice(0, 2_000)));
        throw new ProviderRequestError("invalid_output", "réponse incohérente (texte dégénéré)", provider.name, ctx.request.model);
      }
      result.inputTokens += reply.inputTokens;
      result.outputTokens += reply.outputTokens;
      result.thinkingTokens += reply.thinkingTokens;
      if (reply.servedModel !== undefined) result.servedModel = reply.servedModel;
      if (reply.firstChunkMs !== undefined) result.firstChunkMs ??= reply.firstChunkMs;
      if (reply.stop !== undefined) result.stop = reply.stop;
      lastReply = reply.text;

      const actions = parseActions(reply.text);
      const feedback: string[] = [];

      for (const f of actions.files) {
        try {
          const w = ws.write(f.path, f.content);
          written.add(w.path);
          emit({ type: "file:write", taskId: task.id, path: w.path, bytes: w.bytes, created: w.created });
          emit(log(task.id, "info", `#${task.id} ${w.created ? "crée" : "modifie"} ${w.path} (${lineCount(f.content)} lignes)`, f.content));
        } catch (err) {
          feedback.push(`### Écriture de ${f.path} refusée\n${message(err)}`);
          emit(log(task.id, "warn", `#${task.id} écriture refusée : ${f.path}`, message(err)));
        }
      }

      for (const p of actions.reads) {
        try {
          feedback.push(`### Contenu de ${p}\n\`\`\`\n${ws.read(p, 40_000)}\n\`\`\``);
          emit(log(task.id, "info", `#${task.id} lit ${p}`));
        } catch (err) {
          feedback.push(`### Lecture de ${p} impossible\n${message(err)}`);
        }
      }

      let failed = 0;
      for (const command of actions.runs) {
        checkAbort();
        const r = await runOne(command);
        // `timeout N <app>` qui renvoie 124 : l'app tournait encore au bout de N s → elle démarre bien.
        const stillRunning = r.exitCode === 124 && /^\s*timeout\s/.test(command);
        commands.push({ command, exitCode: stillRunning ? 0 : r.exitCode });
        if (r.exitCode !== 0 && !stillRunning) failed++;
        const status =
          r.refused !== undefined
            ? `refusée : ${r.refused}`
            : r.timedOut
              ? "délai dépassé"
              : stillRunning
                ? "toujours en marche au bout du délai : démarrage réussi"
                : `code ${r.exitCode}`;
        feedback.push(`### Commande \`${command}\` → ${status} (${(r.durationMs / 1000).toFixed(1)} s)\n\`\`\`\n${r.output || "(aucune sortie)"}\n\`\`\``);
      }

      for (const p of actions.incomplete) {
        feedback.push(`### ${p} non écrit\nBloc ===FILE=== sans ===END=== (réponse coupée ?) : réécris ce fichier en entier.`);
        emit(log(task.id, "warn", `#${task.id} fichier incomplet ignoré : ${p}`));
      }

      // Un modèle qui décrit son travail sans l'écrire : on le lui dit, une fois.
      let nudge: string | undefined;
      if (iter === 0 && actions.files.length === 0 && actions.runs.length === 0 && actions.reads.length === 0) {
        if (EXPECTS_FILES.has(task.type)) {
          nudge =
            "Tu n'as écrit aucun fichier. Si ta tâche demande de créer ou de modifier des fichiers et que ce n'est pas déjà fait, écris-les maintenant avec ===FILE=== (contenu complet). Si le dossier contient déjà ce qu'il faut, ne réécris rien : dis-le en une phrase.";
        } else if (task.type === "verify") {
          nudge = "Tu n'as lancé aucune vérification : lance-la réellement avec ===RUN===.";
        }
        if (nudge !== undefined) emit(log(task.id, "warn", `#${task.id} aucune action dans la réponse → relance`, nudge));
      }
      // Tâche qui doit prouver son résultat (correction) : modifier sans relancer ne suffit pas.
      if (nudge === undefined && task.mustVerify === true && task.verifyCommand === undefined && !verifyNudged && written.size > 0 && commands.length === 0 && actions.runs.length === 0) {
        verifyNudged = true;
        nudge =
          "Tu as modifié des fichiers sans vérifier. Relance maintenant la commande exacte de l'utilisateur avec ===RUN=== (préfixée par « timeout 5 » si le programme ne s'arrête pas seul) et corrige si elle échoue.";
        emit(log(task.id, "warn", `#${task.id} correction non vérifiée → relance de la vérification`));
      }

      // Correction d'un lancement : Relay relance lui-même la commande après chaque modification
      // et montre le vrai résultat au modèle (il ne peut pas « oublier » de vérifier).
      if (task.verifyCommand !== undefined && actions.files.length > 0) {
        checkAbort();
        const command = `timeout 8 ${task.verifyCommand}`;
        const r = await runOne(command);
        const ok = r.refused === undefined && (r.exitCode === 0 || r.exitCode === 124 || /EOFError|EOF when reading/.test(r.output));
        commands.push({ command, exitCode: ok ? 0 : r.exitCode });
        if (!ok) failed++;
        feedback.push(
          `### Vérification par Relay : \`${task.verifyCommand}\` → ${ok ? "le programme démarre ✓" : r.refused !== undefined ? `refusée : ${r.refused}` : `ÉCHEC (code ${r.exitCode})`}\n\`\`\`\n${r.output || "(aucune sortie)"}\n\`\`\``,
        );
      }

      checksFailed = failed > 0;
      const needMore = actions.reads.length > 0 || failed > 0 || actions.incomplete.length > 0 || nudge !== undefined;
      if (!needMore || iter === maxIterations - 1) break;

      if (nudge === undefined) {
        emit(log(task.id, failed > 0 ? "warn" : "info", `#${task.id} tour ${iter + 2} : ${failed > 0 ? `${failed} commande(s) en échec → correction` : actions.incomplete.length > 0 ? "fichier(s) à réécrire" : "lecture de fichiers"}`));
      }
      messages.push(
        { role: "assistant", content: reply.text },
        {
          role: "user",
          content: `${feedback.length > 0 ? `## Résultats\n${feedback.join("\n\n")}\n\n` : ""}${
            nudge ??
            (failed > 0
              ? "Des commandes échouent : corrige (fichiers COMPLETS avec ===FILE===) puis relance-les avec ===RUN===."
              : "Continue ta tâche avec ces informations.")
          } Termine par une phrase de résumé.`,
        },
      );
    }

    const condensed = condense(lastReply);
    result.text = [
      condensed,
      written.size > 0 ? `Fichiers : ${[...written].join(", ")}` : "",
      commands.length > 0 ? `Commandes : ${commands.map((c) => `\`${c.command}\` → ${c.exitCode ?? "refusée"}`).join(" ; ")}` : "",
      checksFailed ? "⚠ Des vérifications échouent encore." : "",
    ]
      .filter((s) => s.length > 0)
      .join("\n\n");
    result.summary = lastMeaningfulLine(condensed) ?? (written.size > 0 ? `Fichiers écrits : ${[...written].join(", ")}` : undefined);
    result.data = { files: [...written], commands, ...(checksFailed ? { checksFailed: true } : {}) };
    if (checksFailed) result.checksFailed = true;
    return result;
  };
}

function workspaceSection(ws: Workspace, environment?: string): string {
  return `## Dossier de travail
Tes fichiers et commandes s'exécutent dans ce dossier (chemins relatifs).${environment ? `\nOutils disponibles : ${environment}.` : ""}

### État actuel du dossier
${ws.snapshot()}`;
}

interface Reply {
  text: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  servedModel?: string;
  stop?: WorkerResult["stop"];
  firstChunkMs?: number;
}

async function collect(provider: Provider, request: CompletionRequest, onChunk: (t: string) => void): Promise<Reply> {
  const reply: Reply = { text: "", inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
  for await (const chunk of provider.complete(request)) {
    if (chunk.type === "text") {
      reply.text += chunk.text;
      onChunk(chunk.text);
    } else if (chunk.type === "usage") {
      reply.inputTokens += chunk.usage.inputTokens;
      reply.outputTokens += chunk.usage.outputTokens;
      reply.thinkingTokens += chunk.usage.thinkingTokens ?? 0;
    } else if (chunk.type === "model") reply.servedModel = chunk.model;
    else if (chunk.type === "latency") reply.firstChunkMs = chunk.firstChunkMs;
    else if (chunk.type === "stop") reply.stop = chunk.reason;
  }
  return reply;
}

function lastMeaningfulLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((l) => l.replace(/^[#*\s>-]+/, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("[fichier écrit") && !l.startsWith("===") && !l.startsWith("```"))
    .at(-1);
}

const lineCount = (s: string): number => (s.length === 0 ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0));
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export type { Emit };
