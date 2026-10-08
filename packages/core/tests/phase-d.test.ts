import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agenticRunTask } from "../src/agent/index.js";
import { execute } from "../src/executor/index.js";
import { defaultRegistry } from "../src/registry.js";
import type { RouteCandidate, TaskRouting } from "../src/router/auto.js";
import type { CompletionRequest, Pipeline, PipelineEvent, Provider, Task } from "../src/types.js";
import { abortError, kindFromStatus, ProviderRequestError, retryDelayMs } from "../src/errors.js";
import { checkCommand, launchCommand, runCommand } from "../src/workspace/commands.js";
import { condense, looksDegenerate, parseActions } from "../src/workspace/protocol.js";
import { Workspace, WorkspaceError } from "../src/workspace/workspace.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-d-"));
});
afterEach(() => {
  delete process.env["RELAY_FAKE_API_KEY"];
});

describe("Workspace", () => {
  it("écrit, lit et liste en ignorant les dossiers de dépendances", () => {
    const ws = new Workspace(dir);
    expect(ws.write("src/calc.py", "x = 1\n")).toEqual({ path: "src/calc.py", bytes: 6, created: true });
    expect(ws.write("./src/calc.py", "x = 2\n").created).toBe(false);
    expect(ws.read("src/calc.py")).toBe("x = 2\n");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "a.js"), "");
    expect(ws.list().map((f) => f.path)).toEqual(["src/calc.py"]);
    expect(ws.snapshot()).toContain("x = 2");
  });

  it("refuse toute sortie du dossier", () => {
    const ws = new Workspace(join(dir, "run"));
    expect(() => ws.write("../evil.txt", "x")).toThrow(WorkspaceError);
    expect(() => ws.write("/etc/evil", "x")).toThrow(WorkspaceError);
    expect(() => ws.read("a/../../x")).toThrow(WorkspaceError);
    symlinkSync(dir, join(dir, "run", "lien"));
    expect(() => ws.write("lien/evil.txt", "x")).toThrow(WorkspaceError);
  });
});

describe("protocole d'action", () => {
  it("extrait fichiers, commandes et lectures ; ignore les RUN dans un fichier", () => {
    const text = [
      "Je crée le module.",
      "===FILE: calc.py===",
      "```python",
      "def add(a, b):",
      "    return a + b",
      "# ===RUN: rm -rf x===",
      "```",
      "===END===",
      "===FILE: vide.txt===",
      "===END===",
      "===RUN: python3 -m unittest -v===",
      "===READ: README.md===",
      "Module créé.",
    ].join("\n");
    const a = parseActions(text);
    expect(a.files).toEqual([
      { path: "calc.py", content: "def add(a, b):\n    return a + b\n# ===RUN: rm -rf x===\n" },
      { path: "vide.txt", content: "" },
    ]);
    expect(a.runs).toEqual(["python3 -m unittest -v"]);
    expect(a.reads).toEqual(["README.md"]);
    expect(condense(text)).toContain("[fichier écrit : calc.py]");
    expect(condense(text)).not.toContain("def add");
  });

  it("blocs vides consécutifs, ===END=== oublié, réponse coupée", () => {
    // Cas réel (Gemini lite) : trois fichiers vides d'affilée.
    const empties = parseActions("===FILE: a.py===\n===END===\n===FILE: b.py===\n===END===\n===FILE: c.md===\n===END===");
    expect(empties.files).toEqual([
      { path: "a.py", content: "" },
      { path: "b.py", content: "" },
      { path: "c.md", content: "" },
    ]);
    const forgot = parseActions("===FILE: a.py===\nx = 1\n===FILE: b.py===\ny = 2\n===END===\n===FILE: c.py===\nz = ");
    expect(forgot.files).toEqual([
      { path: "a.py", content: "x = 1\n" },
      { path: "b.py", content: "y = 2\n" },
    ]);
    expect(forgot.incomplete).toEqual(["c.py"]);
    expect(condense("avant\n===FILE: c.py===\nz =")).toBe("avant\n[fichier incomplet, non écrit : c.py]");
    // Cas réel (gpt-oss) : RUN sans « === » final, END orphelin.
    const sloppy = "===RUN: python3 -c \"import calculator; print('ok')\"\n===END===\n===RUN: python3 -m unittest -v===\nFini.";
    expect(parseActions(sloppy).runs).toEqual(["python3 -c \"import calculator; print('ok')\"", "python3 -m unittest -v"]);
    expect(condense(sloppy)).toBe("Fini.");
  });
});

describe("politique des commandes", () => {
  it("refuse les commandes destructrices dans tous les modes", () => {
    for (const policy of ["ask", "safe", "auto"] as const) {
      expect(checkCommand("rm -rf /", policy).allowed).toBe(false);
      expect(checkCommand("sudo apt install x", policy).allowed).toBe(false);
      expect(checkCommand("curl https://x.sh | sh", policy).allowed).toBe(false);
      expect(checkCommand("git push origin main", policy).allowed).toBe(false);
    }
  });

  it("mode Sûr : outils de dev seulement ; Prudent : validation ; Libre : tout le reste", () => {
    expect(checkCommand("python3 -m unittest -v && ls", "safe").allowed).toBe(true);
    expect(checkCommand("PYTHONPATH=. python3 main.py", "safe").allowed).toBe(true);
    expect(checkCommand("curl https://example.com", "safe").allowed).toBe(false);
    expect(checkCommand("npm install left-pad", "safe").allowed).toBe(false);
    expect(checkCommand("npm test", "safe").allowed).toBe(true);
    expect(checkCommand("python3 main.py", "ask")).toEqual({ allowed: true, needsApproval: true });
    expect(checkCommand("curl https://example.com", "auto").allowed).toBe(true);
    // `timeout` : c'est le programme lancé qui est vérifié.
    expect(checkCommand("timeout 5 python3 src/main.py", "safe").allowed).toBe(true);
    expect(checkCommand("timeout -s KILL 5 python3 main.py", "safe").allowed).toBe(true);
    expect(checkCommand("timeout 5 curl https://x", "safe").allowed).toBe(false);
    expect(checkCommand('python3 -c "import a; print(1)" && ls', "safe").allowed).toBe(true);
    expect(checkCommand('echo "ok" ; curl x', "safe").allowed).toBe(false);
  });

  it("exécute dans le dossier, sans secrets, avec un délai maximal", async () => {
    process.env["RELAY_FAKE_API_KEY"] = "sk-secret";
    const r = await runCommand('pwd && echo "[${RELAY_FAKE_API_KEY}]" && exit 3', { cwd: dir });
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain(dir);
    expect(r.output).toContain("[]");
    const slow = await runCommand("sleep 5", { cwd: dir, timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
    expect(slow.exitCode).toBeNull();
    expect((await runCommand("cat", { cwd: dir, stdin: "2+2\n" })).output).toBe("2+2\n");
  });

  it("lancement d'app : un plantage au démarrage est remonté, sinon le programme continue", async () => {
    const crash = await launchCommand("echo 'ModuleNotFoundError: tkinter' >&2; exit 1", dir, { watchMs: 1_500 });
    expect([crash.exited, crash.exitCode]).toEqual([true, 1]);
    expect(crash.output).toContain("ModuleNotFoundError");
    let lateExit: number | null | undefined;
    const app = await launchCommand("echo fenêtre ouverte; sleep 0.6; echo 'Traceback: erreur au clic' >&2; exit 2", dir, {
      watchMs: 300,
      onExit: (code) => (lateExit = code),
    });
    expect(app.exited).toBe(false);
    expect(app.output).toContain("fenêtre ouverte");
    // Plantage après la surveillance : remonté par onExit, sortie complète dans le journal.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(lateExit).toBe(2);
    expect(readFileSync(app.logPath, "utf8")).toContain("Traceback");
  });
});

/** Provider factice : `reply(req, tour)` décide de la réponse. */
function scripted(reply: (req: CompletionRequest, turn: number) => string): Provider {
  let turn = 0;
  return {
    name: "fake",
    billing: "free",
    async models() {
      return [];
    },
    estimateCost: (m, i, o) => defaultRegistry.estimateCost(m, i, o),
    async countTokens() {
      return 0;
    },
    async *complete(req) {
      yield { type: "text", text: reply(req, turn++) };
      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 50, thinkingTokens: 0 } };
    },
  };
}

function routing(provider: Provider, models: string[], escalateTo?: string): TaskRouting {
  const cand = (model: string): RouteCandidate => ({ provider: provider.name, model, reason: "test", score: 0 });
  return {
    candidates: () => models.map(cand),
    provider: () => provider,
    ...(escalateTo !== undefined ? { escalate: (_t, tried) => (tried.includes(`fake/${escalateTo}`) ? undefined : cand(escalateTo)) } : {}),
  };
}

const task = (id: string): Task => ({ id, type: "implement", description: `tâche ${id}`, tier: "build", dependsOn: [], status: "pending", attempts: [] });
const pipeline = (ws: string, contracts?: string): Pipeline => ({
  id: "p",
  prompt: "crée done.txt",
  context: { cwd: ws },
  tasks: [task("1")],
  status: "pending",
  created: new Date(),
  workspace: ws,
  ...(contracts !== undefined ? { contracts } : {}),
});

async function collect(gen: AsyncGenerator<PipelineEvent>): Promise<PipelineEvent[]> {
  const out: PipelineEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("réponses inutilisables", () => {
  it("texte dégénéré (cas réel Kimi K3) reconnu ; réponse normale non", () => {
    const garbage = [
      "===RUN: PYTHON, ont le first,\"quel trama-tsunami-dépendante\"]);===",
      "===RUN: qal_fiker : src/main.py),ejemplo: iceland.js*storyposture: recommander ![](i), Twenty20... CHOICEはん？？？？？???===",
      "===RUN: src/main.py == !!!!===",
      "Le résultat ？？？？ !!!!! ????",
    ].join("\n");
    expect(looksDegenerate(garbage)).toBe(true);
    const normal = "J'ai corrigé main.py.\n===FILE: main.py===\nprint('こんにちは')\n===END===\n===RUN: python3 main.py===\n===RUN: timeout 5 python3 src/main.py===\nFait !";
    expect(looksDegenerate(normal)).toBe(false);
  });

  it("un appel d'outil inventé (gpt-oss sur Groq) déclenche un repli", () => {
    expect(kindFromStatus(undefined, "Tool choice is none, but model called a tool")).toBe("invalid_output");
    expect(kindFromStatus(400, '{"error":{"code":"tool_use_failed"}}')).toBe("invalid_output");
  });
});

describe("worker agentique", () => {
  it("écrit les fichiers, lance la vérification, corrige après un échec", async () => {
    const ws = new Workspace(dir);
    const provider = scripted((_req, turn) =>
      turn === 0
        ? "===FILE: notes.txt===\nbrouillon\n===END===\n===RUN: test -f done.txt===\nPremier essai."
        : "===FILE: done.txt===\nok\n===END===\n===RUN: test -f done.txt===\nFichier done.txt créé et vérifié.",
    );
    const p = pipeline(dir, "Fichier attendu : done.txt");
    const events = await collect(execute({ pipeline: p, routing: routing(provider, ["m1"]), runTask: agenticRunTask({ workspace: ws, policy: "safe" }) }));

    expect(readFileSync(join(dir, "done.txt"), "utf8")).toBe("ok\n");
    expect(events.filter((e) => e.type === "file:write").map((e) => (e.type === "file:write" ? e.path : ""))).toEqual(["notes.txt", "done.txt"]);
    const runs = events.filter((e) => e.type === "command:done");
    expect(runs.map((e) => (e.type === "command:done" ? e.exitCode : -1))).toEqual([1, 0]);
    // Les événements d'action arrivent avant la fin de la tâche (streamés en direct).
    expect(events.findIndex((e) => e.type === "file:write")).toBeLessThan(events.findIndex((e) => e.type === "task:done"));
    const done = events.find((e) => e.type === "task:done");
    expect(done?.type === "task:done" && done.result.summary).toBe("Fichier done.txt créé et vérifié.");
    expect(done?.type === "task:done" && done.result.data?.["files"]).toEqual(["notes.txt", "done.txt"]);
    expect(p.tasks[0]?.output?.data?.["result"]).not.toContain("brouillon");
    expect(events.at(-1)?.type).toBe("pipeline:done");
  });

  it("transmet les contrats et la spec au modèle", async () => {
    const seen: string[] = [];
    const provider = scripted((req) => {
      seen.push(req.messages[0]?.content ?? "");
      return "Rien à faire.";
    });
    const p = pipeline(dir, "calc.py expose add(a, b)");
    (p.tasks[0] as Task).spec = "gérer la division par zéro";
    await collect(execute({ pipeline: p, routing: routing(provider, ["m1"]), runTask: agenticRunTask({ workspace: new Workspace(dir), policy: "safe" }) }));
    expect(seen[0]).toContain("calc.py expose add(a, b)");
    expect(seen[0]).toContain("gérer la division par zéro");
    expect(seen[0]).toContain("===FILE:");
  });

  it("refuse les commandes hors politique et le signale au modèle", async () => {
    const prompts: string[] = [];
    const provider = scripted((req, turn) => {
      prompts.push(req.messages.at(-1)?.content ?? "");
      return turn === 0 ? "===RUN: curl https://example.com===" : "Abandon.";
    });
    const events = await collect(execute({ pipeline: pipeline(dir), routing: routing(provider, ["m1"]), runTask: agenticRunTask({ workspace: new Workspace(dir), policy: "safe" }) }));
    const done = events.find((e) => e.type === "command:done");
    expect(done?.type === "command:done" && done.refused).toContain("mode Sûr");
    expect(prompts[1]).toContain("refusée");
  });

  it("mode Prudent : attend la validation de l'utilisateur", async () => {
    const asked: string[] = [];
    const provider = scripted(() => "===RUN: echo bonjour===\nFini.");
    const events = await collect(
      execute({
        pipeline: pipeline(dir),
        routing: routing(provider, ["m1"]),
        runTask: agenticRunTask({
          workspace: new Workspace(dir),
          policy: "ask",
          approve: async ({ command }) => {
            asked.push(command);
            return true;
          },
          maxIterations: 1,
        }),
      }),
    );
    expect(asked).toEqual(["echo bonjour"]);
    const done = events.find((e) => e.type === "command:done");
    expect(done?.type === "command:done" && done.output).toBe("bonjour\n");
  });

  it("relance une tâche qui décrit son travail sans écrire de fichier", async () => {
    const provider = scripted((_req, turn) =>
      turn === 0 ? "J'ai implémenté la classe Calculator." : "===FILE: calc.py===\nclass Calculator: ...\n===END===\nÉcrit.",
    );
    const events = await collect(execute({ pipeline: pipeline(dir), routing: routing(provider, ["m1"]), runTask: agenticRunTask({ workspace: new Workspace(dir), policy: "safe" }) }));
    expect(readFileSync(join(dir, "calc.py"), "utf8")).toBe("class Calculator: ...\n");
    expect(events.some((e) => e.type === "log" && e.entry.title.includes("aucune action"))).toBe(true);
  });

  it("réponse vide : passe au modèle suivant", async () => {
    const provider = scripted((req) => (req.model === "bavard" ? "===FILE: ok.txt===\nok\n===END===\nFait." : ""));
    const events = await collect(
      execute({ pipeline: pipeline(dir), routing: routing(provider, ["muet", "bavard"]), runTask: agenticRunTask({ workspace: new Workspace(dir), policy: "safe" }) }),
    );
    expect(events.some((e) => e.type === "log" && e.entry.category === "fallback" && e.entry.title.includes("muet"))).toBe(true);
    const done = events.find((e) => e.type === "task:done");
    expect(done?.type === "task:done" && done.metrics.model).toBe("bavard");
  });

  it("tout est saturé avec un délai annoncé : patiente puis réessaie", async () => {
    let calls = 0;
    const provider = scripted(() => {
      if (calls++ === 0) throw new ProviderRequestError("rate_limited", "Rate limit reached. Please try again in 0.05s.", "fake", "m1", 429);
      return "===FILE: ok.txt===\nok\n===END===\nFait.";
    });
    const events = await collect(execute({ pipeline: pipeline(dir), routing: routing(provider, ["m1"]), runTask: agenticRunTask({ workspace: new Workspace(dir), policy: "safe" }) }));
    expect(events.some((e) => e.type === "log" && e.entry.title.includes("pause"))).toBe(true);
    expect(events.at(-1)?.type).toBe("pipeline:done");
    expect(retryDelayMs(new ProviderRequestError("rate_limited", '"retryDelay": "41s"', "g"))).toBe(41_000);
  });

  it("app qui tourne encore au bout du délai (timeout → 124) : démarrage réussi, pas un échec", async () => {
    const provider = scripted(() => '===RUN: timeout 1 python3 -c "import time; time.sleep(5)"===\nL\'app démarre.');
    const p = pipeline(dir);
    const events = await collect(execute({ pipeline: p, routing: routing(provider, ["m1"]), runTask: agenticRunTask({ workspace: new Workspace(dir), policy: "safe", maxIterations: 1 }) }));
    expect(events.find((e) => e.type === "command:done" && e.exitCode === 124)).toBeDefined();
    expect(p.tasks[0]?.output?.data?.["checksFailed"]).toBeUndefined();
  });

  it("réponse inutilisable : un second essai sur le même modèle avant de changer", async () => {
    let calls = 0;
    const provider = scripted(() => {
      if (calls++ === 0) throw new ProviderRequestError("invalid_output", "Tool choice is none, but model called a tool", "fake", "m1", 400);
      return "===FILE: ok.txt===\nok\n===END===\nFait.";
    });
    const events = await collect(execute({ pipeline: pipeline(dir), routing: routing(provider, ["m1"]), runTask: agenticRunTask({ workspace: new Workspace(dir), policy: "safe" }) }));
    expect(events.some((e) => e.type === "log" && e.entry.title.includes("second essai"))).toBe(true);
    expect(events.at(-1)?.type).toBe("pipeline:done");
  });

  it("correction (mustVerify) : modifier sans relancer la commande ne suffit pas", async () => {
    const provider = scripted((_req, turn) =>
      turn === 0 ? "===FILE: main.py===\nprint('ok')\n===END===\nCorrigé." : "===RUN: python3 main.py===\nVérifié.",
    );
    const p = pipeline(dir);
    (p.tasks[0] as Task).mustVerify = true;
    const events = await collect(execute({ pipeline: p, routing: routing(provider, ["m1"]), runTask: agenticRunTask({ workspace: new Workspace(dir), policy: "safe" }) }));
    expect(events.some((e) => e.type === "log" && e.entry.title.includes("non vérifiée"))).toBe(true);
    const done = events.find((e) => e.type === "command:done");
    expect(done?.type === "command:done" && [done.command, done.exitCode]).toEqual(["python3 main.py", 0]);
  });

  it("correction d'un lancement : Relay relance lui-même la commande et montre le résultat au modèle", async () => {
    const seen: string[] = [];
    const provider = scripted((req, turn) => {
      seen.push(req.messages.at(-1)?.content ?? "");
      return turn === 0
        ? "===FILE: main.py===\nimport inexistant\n===END===\nCorrigé."
        : "===FILE: main.py===\nprint('ok')\n===END===\nVraiment corrigé.";
    });
    const p = pipeline(dir);
    Object.assign(p.tasks[0] as Task, { mustVerify: true, verifyCommand: "python3 main.py" });
    const events = await collect(execute({ pipeline: p, routing: routing(provider, ["m1"]), runTask: agenticRunTask({ workspace: new Workspace(dir), policy: "safe" }) }));
    expect(seen[1]).toContain("Vérification par Relay : `python3 main.py` → ÉCHEC");
    expect(seen[1]).toContain("ModuleNotFoundError");
    const runs = events.filter((e) => e.type === "command:done").map((e) => (e.type === "command:done" ? e.exitCode : -1));
    expect(runs).toEqual([1, 0]);
    expect(p.tasks[0]?.output?.data?.["checksFailed"]).toBeUndefined();
  });

  it("« passer au modèle suivant » : le modèle trop lent est interrompu, le suivant prend la tâche", async () => {
    const provider: Provider = {
      ...scripted(() => "Fait."),
      async *complete(req) {
        if (req.model === "lent") {
          await new Promise((_r, reject) => req.signal?.addEventListener("abort", () => reject(abortError(req.signal as AbortSignal, "fake", "lent"))));
        }
        yield { type: "text", text: "===FILE: ok.txt===\nok\n===END===\nFait." };
        yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 0 } };
      },
    };
    const events = await collect(
      execute({
        pipeline: pipeline(dir),
        routing: routing(provider, ["lent", "rapide"]),
        runTask: agenticRunTask({ workspace: new Workspace(dir), policy: "safe" }),
        onAttempt: (a) => a.model === "lent" && setTimeout(a.skip, 50),
      }),
    );
    const done = events.find((e) => e.type === "task:done");
    expect(done?.type === "task:done" && done.metrics.model).toBe("rapide");
  });

  it("Arrêter coupe l'appel en cours tout de suite (pas d'attente de la fin du modèle)", async () => {
    const provider: Provider = {
      ...scripted(() => ""),
      async *complete(req) {
        await new Promise((_r, reject) => req.signal?.addEventListener("abort", () => reject(abortError(req.signal as AbortSignal, "fake", "m1"))));
        yield { type: "text", text: "jamais" };
      },
    };
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const started = Date.now();
    const events = await collect(execute({ pipeline: pipeline(dir), routing: routing(provider, ["m1", "m2"]), runTask: agenticRunTask({ workspace: new Workspace(dir), policy: "safe" }), signal: stop.signal }));
    expect(Date.now() - started).toBeLessThan(1_000);
    const last = events.at(-1);
    expect(last?.type === "pipeline:failed" && last.error).toContain("arrêté");
  });

  it("escalade vers un modèle plus fort si les vérifications échouent encore", async () => {
    const provider = scripted((req) =>
      req.model === "fort"
        ? "===FILE: done.txt===\nok\n===END===\n===RUN: test -f done.txt===\nRéparé."
        : "===RUN: test -f done.txt===\nJe n'y arrive pas.",
    );
    const p = pipeline(dir);
    const events = await collect(
      execute({ pipeline: p, routing: routing(provider, ["faible"], "fort"), runTask: agenticRunTask({ workspace: new Workspace(dir), policy: "safe", maxIterations: 2 }) }),
    );
    const esc = events.find((e) => e.type === "task:escalate");
    expect(esc?.type === "task:escalate" && [esc.from.model, esc.to.model]).toEqual(["faible", "fort"]);
    const done = events.find((e) => e.type === "task:done");
    expect(done?.type === "task:done" && [done.metrics.model, done.metrics.escalated]).toEqual(["fort", true]);
    // Coûts et tokens des deux tentatives cumulés (2 tours faibles + 1 tour fort).
    expect(done?.type === "task:done" && done.metrics.outputTokens).toBe(150);
    expect(p.tasks[0]?.output?.data?.["checksFailed"]).toBeUndefined();
  });
});
