import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { confineRunDir, describeEnvironment, listRunDirs, newRunDir, runDirName } from "../src/workspace.js";

describe("environnement de la machine", () => {
  it("signale les modules absents aux agents", () => {
    expect(describeEnvironment({ tools: "python3 3.13.5", missing: ["tkinter (aucune interface graphique Tk possible)"] })).toBe(
      "python3 3.13.5 — ABSENTS : tkinter (aucune interface graphique Tk possible)",
    );
    expect(describeEnvironment({ tools: "node 22.1.0", missing: [] })).toBe("node 22.1.0");
  });
});

describe("dossiers de run", () => {
  it("nomme le dossier par date puis par sujet", () => {
    const name = runDirName("Crée une calculatrice en Python !", new Date(2026, 9, 7, 23, 15, 2));
    expect(name).toBe("20261007-231502-cree-une-calculatrice-en-python");
    expect(runDirName("???", new Date(2026, 0, 1, 0, 0, 0))).toBe("20260101-000000-run");
  });

  it("ne réutilise jamais un dossier existant et liste les plus récents d'abord", () => {
    const base = mkdtempSync(join(tmpdir(), "relay-runs-"));
    const a = newRunDir(base, "x");
    mkdirSync(a);
    const b = newRunDir(base, "x");
    expect(b).not.toBe(a);
    mkdirSync(b);
    expect(listRunDirs(base)[0]?.root).toBe(b);
  });

  it("confine les accès à la racine des espaces de travail", () => {
    const base = mkdtempSync(join(tmpdir(), "relay-runs-"));
    const run = join(base, "20261007-000000-ok");
    mkdirSync(run);
    expect(confineRunDir(base, run)).toBe(run);
    expect(() => confineRunDir(base, base)).toThrow();
    expect(() => confineRunDir(base, "/etc")).toThrow();
    expect(() => confineRunDir(base, join(base, "..", "ailleurs"))).toThrow();
    symlinkSync("/etc", join(base, "lien"));
    expect(() => confineRunDir(base, join(base, "lien"))).toThrow();
  });
});
