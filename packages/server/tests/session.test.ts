import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendTurn, fixPipeline, lastContracts, loadSession, renumber, sessionContext, turnFromPipeline } from "../src/session.js";

describe("session d'un dossier de run", () => {
  it("garde les tours et les rend aux modèles comme contexte", () => {
    const root = mkdtempSync(join(tmpdir(), "relay-session-"));
    expect(loadSession(root).turns).toEqual([]);
    const p = fixPipeline({ source: "« python3 calculator.py »", output: "ModuleNotFoundError: No module named 'tkinter'", exitCode: 1 }, { cwd: root }, "calculator.py : main()");
    p.tasks[0]!.status = "done";
    appendTurn(root, turnFromPipeline(p, "fix", "Corriger", "done", undefined, "ModuleNotFoundError: tkinter"));
    const s = loadSession(root);
    expect(s.turns).toHaveLength(1);
    expect(lastContracts(s)).toBe("calculator.py : main()");
    const ctx = sessionContext(s);
    expect(ctx).toContain("Tour 1 — correction (terminé)");
    expect(ctx).toContain("ModuleNotFoundError");
  });

  it("correction directe : une tâche d'agent avec l'erreur en spec", () => {
    const p = fixPipeline({ source: "« npm test »", output: "x".repeat(6_000), exitCode: 1, note: "le bouton = ne marche pas" }, { cwd: "/tmp" });
    expect(p.tasks).toHaveLength(1);
    expect(p.tasks[0]?.description).toContain("le bouton = ne marche pas");
    expect(p.tasks[0]?.spec).not.toContain("x".repeat(4_100)); // sortie bornée
    expect(p.tasks[0]?.spec).toContain("INTERDIT de masquer l'erreur");
  });

  it("numérote les tâches par tour pour ne pas confondre avec les précédentes", () => {
    const p = fixPipeline({ source: "x", output: "" }, { cwd: "/tmp" });
    p.tasks.push({ ...p.tasks[0]!, id: "2", dependsOn: ["1"] });
    renumber(p, 3);
    expect(p.tasks.map((t) => [t.id, t.dependsOn])).toEqual([
      ["3.1", []],
      ["3.2", ["3.1"]],
    ]);
  });
});
