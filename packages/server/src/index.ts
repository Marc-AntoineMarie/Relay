#!/usr/bin/env node
/**
 * @relay/server — serveur local qui expose le moteur Relay à l'interface web.
 *
 * - Détient les clés (lues/écrites dans `.env`, côté machine — jamais envoyées au navigateur).
 * - `GET  /api/state` : backends prêts, modèles du registre, routes.
 * - `POST /api/keys`  : enregistre une clé dans `.env`.
 * - `POST /api/run`   : exécute un pipeline, streame les événements en SSE.
 * - sert l'app web buildée (packages/web/dist) si présente.
 *
 * Écoute uniquement sur 127.0.0.1 (outil local).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import {
  decompose,
  defaultRegistry,
  execute,
  loadConfig,
  Router,
  type PipelineEvent,
  type RelayConfig,
} from "@relay/core";
import {
  createProvider,
  PROVIDER_PRESETS,
  ProviderError,
  providerReadiness,
} from "@relay/providers";

const HOST = "127.0.0.1";
const PORT = Number(process.env["RELAY_PORT"] ?? 5174);
const ENV_PATH = join(process.cwd(), ".env");
const WEB_DIST = join(process.cwd(), "packages", "web", "dist");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function loadEnv(): void {
  try {
    process.loadEnvFile(ENV_PATH);
  } catch {
    /* pas de .env */
  }
}

/** Écrit (ou remplace) une clé dans .env et dans process.env. */
function setEnvKey(key: string, value: string): void {
  let content = "";
  try {
    content = readFileSync(ENV_PATH, "utf8");
  } catch {
    /* fichier absent : on le crée */
  }
  const kept = content
    .split("\n")
    .filter((l) => l.trim().length > 0 && !l.startsWith(`${key}=`));
  kept.push(`${key}=${value}`);
  writeFileSync(ENV_PATH, `${kept.join("\n")}\n`);
  process.env[key] = value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

function safeLoadConfig(): RelayConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

function handleState(res: ServerResponse): void {
  const config = safeLoadConfig();
  sendJson(res, 200, {
    providers: providerReadiness(),
    models: defaultRegistry.all(),
    routes: config?.routes ?? null,
    decomposer: config?.decomposer ?? null,
    defaultProvider: config?.decomposer.provider ?? "anthropic",
  });
}

async function handleKeys(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { provider?: string; value?: string };
  const preset = body.provider ? PROVIDER_PRESETS[body.provider] : undefined;
  if (!preset || preset.envKey === undefined) {
    sendJson(res, 400, { error: "provider sans clé configurable" });
    return;
  }
  if (typeof body.value !== "string" || body.value.trim().length === 0) {
    sendJson(res, 400, { error: "valeur de clé vide" });
    return;
  }
  setEnvKey(preset.envKey, body.value.trim());
  sendJson(res, 200, { providers: providerReadiness() });
}

function sseWrite(res: ServerResponse, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { prompt?: string; provider?: string; model?: string };
  const prompt = (body.prompt ?? "").trim();
  if (prompt.length === 0) {
    sendJson(res, 400, { error: "prompt vide" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const config = safeLoadConfig();
  if (config === null) {
    sseWrite(res, { type: "error", error: "relay.config.json introuvable ou invalide" });
    res.end();
    return;
  }

  if (body.model !== undefined && body.model.length > 0) {
    config.decomposer = { ...config.decomposer, model: body.model };
    for (const tier of ["quick", "build", "deep", "escalate"] as const) {
      config.routes[tier] = { ...config.routes[tier], model: body.model };
    }
  }

  const providerName = body.provider ?? config.decomposer.provider;
  try {
    const provider = createProvider(providerName, { cwd: process.cwd() });
    sseWrite(res, { type: "backend", name: provider.name, billing: provider.billing });
    sseWrite(res, { type: "decomposing" });

    const pipeline = await decompose({
      prompt,
      context: { cwd: process.cwd() },
      provider,
      model: config.decomposer,
    });

    const router = new Router(config);
    for await (const event of execute({ pipeline, provider, router })) {
      sseWrite(res, event satisfies PipelineEvent);
    }
  } catch (err) {
    const message = err instanceof ProviderError || err instanceof Error ? err.message : String(err);
    sseWrite(res, { type: "error", error: message });
  } finally {
    sseWrite(res, { type: "end" });
    res.end();
  }
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  if (!existsSync(join(WEB_DIST, "index.html"))) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<h1>Relay</h1><p>L'interface web n'est pas encore buildée.<br>" +
        "Lance <code>pnpm --filter @relay/web dev</code> (dev) ou <code>pnpm --filter @relay/web build</code>.</p>",
    );
    return;
  }
  const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = normalize(join(WEB_DIST, rel));
  // Empêche la traversée hors du dossier dist ; sinon, fallback SPA.
  const target = filePath.startsWith(WEB_DIST) && existsSync(filePath) ? filePath : join(WEB_DIST, "index.html");
  res.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream" });
  res.end(readFileSync(target));
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = (req.url ?? "/").split("?")[0] ?? "/";

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  void (async () => {
    try {
      if (url === "/api/state" && req.method === "GET") return handleState(res);
      if (url === "/api/keys" && req.method === "POST") return await handleKeys(req, res);
      if (url === "/api/run" && req.method === "POST") return await handleRun(req, res);
      return serveStatic(req, res);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  })();
}

export function startServer(): void {
  loadEnv();
  createServer(handler).listen(PORT, HOST, () => {
    console.log(`Relay — serveur local sur http://${HOST}:${PORT}`);
    if (!existsSync(join(WEB_DIST, "index.html"))) {
      console.log("UI non buildée : lance l'app web en dev (pnpm --filter @relay/web dev).");
    }
  });
}

startServer();
