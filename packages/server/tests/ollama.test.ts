import { describe, expect, it } from "vitest";
import { checkRemote, machineVerdict, modelFit, REMOTE_INSTALL, SUGGESTED_MODELS } from "../src/ollama.js";

const laptop = { ramTotalGb: 7.1, vramGb: null };

describe("Ollama : conseils selon la machine", () => {
  it("petite machine (7 Go, sans GPU) : petits modèles seulement", () => {
    expect(modelFit(1.4, laptop)).toBe("ok");
    expect(modelFit(2.5, laptop)).toBe("tight");
    expect(modelFit(5.2, laptop)).toBe("too_big");
    expect(modelFit(14, { ramTotalGb: 32, vramGb: null })).toBe("ok");
    expect(modelFit(14, { ramTotalGb: 16, vramGb: 24 })).toBe("ok"); // la mémoire vidéo compte
    const verdict = machineVerdict({ platform: "linux", arch: "x64", cpu: "x", cores: 12, ramTotalGb: 7.1, ramAvailableGb: 1, gpu: null, vramGb: null, diskFreeGb: 30 });
    expect(verdict).toContain("petits modèles");
    expect(verdict).toContain("VPS");
    expect(SUGGESTED_MODELS.length).toBeGreaterThan(5);
  });
});

describe("Ollama sur VPS", () => {
  it("refuse les champs SSH dangereux (rien n'est passé à un shell local)", () => {
    expect(() => checkRemote({ host: "1.2.3.4; rm -rf ~", keyPath: "/etc/hostname" })).toThrow(/adresse/);
    expect(() => checkRemote({ host: "1.2.3.4", user: "root$(id)", keyPath: "/etc/hostname" })).toThrow(/utilisateur/);
    expect(() => checkRemote({ host: "1.2.3.4", keyPath: "/nexiste/pas" })).toThrow(/clé SSH/);
    expect(checkRemote({ host: "vps.example.org", keyPath: "/etc/hostname" })).toEqual({ host: "vps.example.org", user: "ubuntu", port: 22, keyPath: "/etc/hostname" });
  });

  it("l'installation distante n'ouvre aucun port : Ollama reste en local sur le VPS", () => {
    expect(REMOTE_INSTALL).toContain("https://ollama.com/install.sh");
    expect(REMOTE_INSTALL).toContain("sudo -n"); // jamais d'invite de mot de passe bloquante
    expect(REMOTE_INSTALL).not.toContain("0.0.0.0");
  });
});

describe("installation sans mot de passe", () => {
  it("télécharge l'archive .tar.zst, l'extrait dans un dossier à part et vérifie le binaire", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const { createServer } = await import("node:http");
    const { installManaged } = await import("../src/ollama.js");

    // Fausse archive au format officiel : bin/ollama (script qui affiche une version).
    const src = mkdtempSync(join(tmpdir(), "relay-ollama-src-"));
    mkdirSync(join(src, "bin"));
    writeFileSync(join(src, "bin", "ollama"), "#!/bin/sh\necho 'ollama version is 0.99.1'\n");
    chmodSync(join(src, "bin", "ollama"), 0o755);
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const archive = join(src, `ollama-linux-${arch}.tar.zst`);
    expect(spawnSync("sh", ["-c", `tar -C '${src}' -cf - bin | zstd -q -o '${archive}'`]).status).toBe(0);

    const server = createServer((req, res) => {
      if (req.url?.endsWith(".tar.zst")) {
        const data = readFileSync(archive);
        res.writeHead(200, { "Content-Length": data.length });
        res.end(data);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;

    const dir = mkdtempSync(join(tmpdir(), "relay-ollama-dest-"));
    const seen: string[] = [];
    const version = await installManaged((p) => seen.push(p.status), undefined, { downloadBase: `http://127.0.0.1:${port}`, dir });
    server.close();
    expect(version).toBe("0.99.1");
    expect(existsSync(join(dir, "bin", "ollama"))).toBe(true);
    expect(seen).toContain("téléchargement");
    expect(seen.at(-1)).toBe("installé");
  });
});
