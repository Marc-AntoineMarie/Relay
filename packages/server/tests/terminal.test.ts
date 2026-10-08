import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closeTerminal, openTerminal, resizeTerminal, shutdownTerminals, terminalSupported, writeTerminal } from "../src/terminal.js";

const waitFor = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error("délai dépassé");
    await new Promise((r) => setTimeout(r, 50));
  }
};

afterAll(shutdownTerminals);

describe.skipIf(terminalSupported() !== null)("terminal intégré", () => {
  it("vrai shell dans le dossier du projet, redimensionnable, sans les clés API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-term-"));
    process.env["RELAY_FAKE_API_KEY"] = "sk-secret";
    const s = openTerminal(dir, 100, 30);
    delete process.env["RELAY_FAKE_API_KEY"];

    writeTerminal(s.id, 'echo "relay-$((1+1)) [$RELAY_FAKE_API_KEY]"; pwd\n');
    await waitFor(() => s.replay.includes("relay-2 []"));
    expect(s.replay).toContain(dir);

    resizeTerminal(s.id, 120, 40);
    await new Promise((r) => setTimeout(r, 150));
    writeTerminal(s.id, "stty size\n");
    await waitFor(() => s.replay.includes("40 120"));

    closeTerminal(s.id);
    await waitFor(() => s.exitCode !== undefined);
  });
});
