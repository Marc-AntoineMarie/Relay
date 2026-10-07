import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendMessage, checkImportable, conversationContext, loadConversation, ProjectStore, slugify, suggestName, uniqueDir } from "../src/projects.js";

describe("projets", () => {
  it("nom simple tiré de la demande, ou choisi", () => {
    expect(suggestName("Crée-moi une calculatrice en Python avec ses tests")).toBe("calculatrice");
    expect(suggestName("fait moi un jeu du serpent en javascript")).toBe("jeu-serpent");
    expect(suggestName("fais une appli")).toBe("projet");
    expect(slugify("Ma Super Appli !")).toBe("ma-super-appli");
  });

  it("jamais deux projets dans le même dossier", () => {
    const base = mkdtempSync(join(tmpdir(), "relay-p-"));
    mkdirSync(join(base, "calculatrice"));
    expect(uniqueDir(base, "calculatrice")).toBe(join(base, "calculatrice-2"));
  });

  it("seuls les projets connus sont accessibles ; import d'un dossier existant", () => {
    const base = mkdtempSync(join(tmpdir(), "relay-p-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "relay-ailleurs-"));
    mkdirSync(join(base, "calc"));
    const store = new ProjectStore(() => join(base, ".relay", "projects.json"), () => base);
    expect(store.resolveProject(join(base, "calc"))).toBe(join(base, "calc"));
    expect(() => store.resolveProject(elsewhere)).toThrow();
    store.register(checkImportable(elsewhere, []));
    expect(store.resolveProject(elsewhere)).toBe(elsewhere);
    expect(store.list().map((p) => p.root).sort()).toEqual([join(base, "calc"), elsewhere].sort());
    expect(() => checkImportable("/", [])).toThrow();
    expect(() => checkImportable("relatif", [])).toThrow();
  });

  it("conversation gardée et résumée pour les modèles", () => {
    const root = mkdtempSync(join(tmpdir(), "relay-c-"));
    appendMessage(root, { role: "user", kind: "prompt", text: "fais une appli" });
    appendMessage(root, { role: "relay", kind: "questions", text: "", questions: [{ question: "Quel type ?", options: ["web", "cli"] }] });
    appendMessage(root, { role: "user", kind: "answer", text: "Quel type ? → web" });
    expect(loadConversation(root)).toHaveLength(3);
    const ctx = conversationContext(loadConversation(root));
    expect(ctx).toContain("Relay : questions : Quel type ?");
    expect(ctx).toContain("Toi (réponses) : Quel type ? → web");
  });
});
