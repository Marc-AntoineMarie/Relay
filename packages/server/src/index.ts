#!/usr/bin/env node
/**
 * @relay/server — serveur local qui expose le moteur Relay à l'interface web.
 *
 * - Détient les clés (lues/écrites dans `.env`, côté machine — jamais envoyées au navigateur).
 * - `GET  /api/state`  : backends prêts, modèles du registre, routes.
 * - `GET  /api/models` : modèles de chat d'un backend + suggestion par tier.
 * - `GET  /api/pool`   : pool du mode auto (tous les comptes prêts, profils, santé).
 * - `POST /api/keys`   : enregistre une clé dans `.env`.
 * - `POST /api/run`    : exécute un pipeline (mode auto ou manuel), streame les événements en SSE.
 * - sert l'app web buildée (packages/web/dist) si présente.
 *
 * Écoute uniquement sur 127.0.0.1 (outil local).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize, extname, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  AutoRouter,
  autoRouting,
  ConfigError,
  decompose,
  defaultRegistry,
  describeError,
  execute,
  HealthTracker,
  loadConfig,
  profileModel,
  ProviderRequestError,
  Router,
  STRATEGIES,
  type AccountPolicy,
  type BillingMode,
  type Effort,
  type ErrorDescription,
  type LogEntry,
  type Pipeline,
  type PipelineEvent,
  type PoolEntry,
  type Provider,
  type RelayConfig,
  type RouteTier,
  type Strategy,
  type TierModels,
} from "@relay/core";
import {
  autoPoolModels,
  createProvider,
  filterChatModels,
  PROVIDER_PRESETS,
  providerReadiness,
  suggestTierModels,
} from "@relay/providers";

const TIERS: readonly RouteTier[] = ["quick", "build", "deep"];
/** Effort par tier pour les backends à réflexion réglable (reasoning_effort). */
const TIER_EFFORT: Record<RouteTier, Effort> = { quick: "low", build: "medium", deep: "high" };

/**
 * Plafonds par défaut du mode auto : l'abonnement Claude Code est désactivé (préserver le
 * quota de travail de l'utilisateur), l'API Anthropic payante est réservée au « deep ».
 */
const DEFAULT_POLICIES: Record<string, AccountPolicy> = {
  "claude-code": { enabled: false, levels: ["deep"], maxCallsPerRun: 2 },
  anthropic: { enabled: true, levels: ["deep"] },
};

/** Santé des modèles, partagée entre les runs (évite un modèle qui vient de saturer). */
const health = new HealthTracker();

/** Cache de détection des modèles par compte (la liste change rarement). */
const MODEL_CACHE_MS = 10 * 60_000;
const modelCache = new Map<string, { at: number; models: string[] }>();

async function detectModels(name: string): Promise<string[]> {
  const cached = modelCache.get(name);
  if (cached !== undefined && Date.now() - cached.at < MODEL_CACHE_MS) return cached.models;
  const raw = (await createProvider(name, { cwd: ROOT_DIR }).models()).map((m) => m.id);
  const models = PROVIDER_PRESETS[name]?.kind === "openai-compatible" ? filterChatModels(raw) : raw;
  modelCache.set(name, { at: Date.now(), models });
  return models;
}

interface PoolAccount {
  name: string;
  label: string;
  billing: BillingMode;
  models: Array<{
    model: string;
    level: RouteTier;
    tags: string[];
    family: string;
    inputPerM: number;
    outputPerM: number;
    health?: string;
  }>;
  error?: ErrorDescription;
}

/** Pool du mode auto : chaque compte prêt apporte ses modèles connus, profilés. */
async function buildPool(): Promise<PoolAccount[]> {
  const ready = providerReadiness().filter((p) => p.ready);
  return Promise.all(
    ready.map(async (p): Promise<PoolAccount> => {
      try {
        const models = autoPoolModels(p.name, await detectModels(p.name)).map((model) => {
          const prof = profileModel(model);
          const h = health.status(p.name, model);
          return {
            model,
            level: prof.level,
            tags: prof.tags,
            family: prof.family,
            inputPerM: prof.inputPerM,
            outputPerM: prof.outputPerM,
            ...(h !== undefined ? { health: h } : {}),
          };
        });
        return { name: p.name, label: p.label, billing: p.billing, models };
      } catch (err) {
        return { name: p.name, label: p.label, billing: p.billing, models: [], error: describeError(err) };
      }
    }),
  );
}

const PORT = Number(process.env["RELAY_PORT"] ?? 5174);
// Racine du dépôt, résolue depuis l'emplacement de ce fichier (packages/server/dist/)
// → les chemins sont corrects quel que soit le cwd (CLI, dashboard ou Electron).
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENV_PATH = join(ROOT_DIR, ".env");
const WEB_DIST = join(ROOT_DIR, "packages", "web", "dist");
const CONFIG_PATH = join(ROOT_DIR, "relay.config.json");

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
    return loadConfig(CONFIG_PATH);
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

async function handleModels(fullUrl: string, res: ServerResponse): Promise<void> {
  const name = new URL(fullUrl, "http://localhost").searchParams.get("provider") ?? "";
  try {
    const models = await detectModels(name);
    sendJson(res, 200, { models, suggested: suggestTierModels(name, models) ?? null });
  } catch (err) {
    sendJson(res, 200, { models: [], suggested: suggestTierModels(name, []) ?? null, error: describeError(err) });
  }
}

async function handlePool(res: ServerResponse): Promise<void> {
  sendJson(res, 200, { accounts: await buildPool(), defaultPolicies: DEFAULT_POLICIES });
}

interface RunBody {
  prompt?: string;
  /** "auto" : le routeur choisit parmi tous les comptes ; "manual" : un backend, un modèle par tier. */
  mode?: "auto" | "manual";
  provider?: string;
  /** Un modèle par tier (mode manuel). */
  models?: Partial<TierModels>;
  /** Ancien format : un modèle unique pour tous les tiers. */
  model?: string;
  strategy?: Strategy;
  policies?: Record<string, AccountPolicy>;
}

/**
 * Applique le routage par tier (choisi dans l'UI, sinon recommandé par le preset).
 * Sans choix explicite, un backend Claude garde les routes de relay.config.json.
 */
function applyTierModels(config: RelayConfig, providerName: string, body: RunBody): void {
  const preset = PROVIDER_PRESETS[providerName];
  const chosen: Partial<TierModels> = { ...body.models };
  if (body.model) for (const t of TIERS) chosen[t] ??= body.model;
  if (preset?.needsModelOverride !== true && Object.values(chosen).every((m) => !m)) return;

  for (const t of TIERS) {
    const model = chosen[t] || preset?.tierModels?.[t];
    if (!model) throw new ConfigError(`aucun modèle choisi pour le tier « ${t} »`);
    const effort = preset?.reasoningEffort === true ? TIER_EFFORT[t] : config.routes[t].effort;
    config.routes[t] = { provider: providerName, model, ...(effort !== undefined ? { effort } : {}) };
  }
  config.routes.escalate = { ...config.routes.deep };
  config.decomposer = { ...config.routes.build };
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
  if (body.provider !== undefined) modelCache.delete(body.provider);
  sendJson(res, 200, { providers: providerReadiness() });
}

function sseWrite(res: ServerResponse, obj: unknown): void {
  if (res.writableEnded || res.destroyed) return; // client parti
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function sseLog(res: ServerResponse, entry: Omit<LogEntry, "at">): void {
  sseWrite(res, { type: "log", entry: { at: Date.now(), ...entry } satisfies LogEntry });
}

/** Mode manuel : un backend, un modèle par tier. */
async function runManual(body: RunBody, prompt: string, res: ServerResponse, signal: AbortSignal): Promise<void> {
  const config = safeLoadConfig();
  if (config === null) throw new ConfigError("relay.config.json introuvable ou invalide");
  const providerName = body.provider ?? config.decomposer.provider;
  applyTierModels(config, providerName, body);

  const provider = createProvider(providerName, { cwd: ROOT_DIR });
  sseWrite(res, { type: "mode", mode: "manual", accounts: [PROVIDER_PRESETS[providerName]?.label ?? providerName] });
  sseWrite(res, { type: "decomposing", provider: providerName, model: config.decomposer.model });
  const pipeline = await decompose({
    prompt,
    context: { cwd: ROOT_DIR },
    provider,
    model: config.decomposer,
    onLog: (entry) => sseWrite(res, { type: "log", entry }),
  });

  sseWrite(res, { type: "routes", routes: config.routes });
  for await (const event of execute({ pipeline, provider, router: new Router(config), signal })) {
    sseWrite(res, event satisfies PipelineEvent);
  }
}

/** Mode auto : le routeur choisit, pour le plan puis pour chaque tâche, parmi tous les comptes. */
async function runAuto(body: RunBody, prompt: string, res: ServerResponse, signal: AbortSignal): Promise<void> {
  const strategy: Strategy = body.strategy !== undefined && STRATEGIES.includes(body.strategy) ? body.strategy : "balanced";
  const policies = { ...DEFAULT_POLICIES, ...body.policies };

  const accounts = await buildPool();
  for (const a of accounts) {
    if (a.error !== undefined) {
      sseLog(res, { level: "warn", category: "info", title: `Compte ${a.label} ignoré : ${a.error.title}`, detail: a.error.detail });
    }
  }
  const entries: PoolEntry[] = accounts
    .filter((a) => policies[a.name]?.enabled !== false)
    .flatMap((a) => a.models.map((m) => ({ provider: a.name, model: m.model, billing: a.billing })));
  const router = new AutoRouter(entries, { strategy, policies, health });
  const used = accounts.filter((a) => a.models.length > 0 && policies[a.name]?.enabled !== false).map((a) => a.label);
  sseWrite(res, { type: "mode", mode: "auto", strategy, accounts: used, poolSize: router.size });
  sseLog(res, {
    level: "info",
    category: "info",
    title: `Mode auto · stratégie ${strategy} · ${used.length} compte(s) · ${router.size} modèles`,
    detail: accounts.map((a) => `${a.label} : ${a.models.map((m) => m.model).join(", ") || "aucun modèle"}`).join("\n"),
  });

  const providers = new Map<string, Provider>();
  const getProvider = (name: string): Provider => {
    let p = providers.get(name);
    if (p === undefined) {
      p = createProvider(name, { cwd: ROOT_DIR, fallbacks: false }); // les replis passent par le routeur
      providers.set(name, p);
    }
    return p;
  };

  // Planificateur : choisi par le même routeur (niveau build, deep en stratégie qualité).
  const plannerTier: RouteTier = strategy === "quality" ? "deep" : "build";
  const planners = router.rank({ tier: plannerTier }).slice(0, 3);
  if (planners.length === 0) {
    throw new ConfigError("aucun compte utilisable en mode auto : ajoute une clé ou active un compte dans le panneau Modèles");
  }

  let pipeline: Pipeline | undefined;
  for (const [i, c] of planners.entries()) {
    sseLog(res, { level: "info", category: "route", title: `Planificateur → ${c.provider} · ${c.model}`, detail: `Raison : ${c.reason}` });
    sseWrite(res, { type: "decomposing", provider: c.provider, model: c.model });
    try {
      router.consume(c.provider);
      pipeline = await decompose({
        prompt,
        context: { cwd: ROOT_DIR },
        provider: getProvider(c.provider),
        model: { provider: c.provider, model: c.model, ...(c.effort !== undefined ? { effort: c.effort } : {}) },
        onLog: (entry) => sseWrite(res, { type: "log", entry }),
      });
      health.reportSuccess(c.provider, c.model);
      break;
    } catch (err) {
      if (!(err instanceof ProviderRequestError)) throw err;
      health.reportFailure(c.provider, c.model, err.kind);
      const next = planners[i + 1];
      if (next === undefined || !(err.retryable || err.kind === "model_not_found")) throw err;
      const d = describeError(err);
      sseLog(res, {
        level: "warn",
        category: "fallback",
        title: `Planificateur ${c.model} : ${d.title.toLowerCase()} → repli sur ${next.provider} · ${next.model}`,
        detail: d.detail,
      });
    }
  }
  if (pipeline === undefined) throw new ConfigError("planification impossible");

  for await (const event of execute({ pipeline, routing: autoRouting(router, getProvider, health), signal })) {
    sseWrite(res, event satisfies PipelineEvent);
  }
}

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as RunBody;
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

  // Le client (bouton « Arrêter », fenêtre fermée) coupe la connexion → on arrête le pipeline.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    // Sans mode explicite : manuel si un backend est imposé (CLI, anciens clients), sinon auto.
    const mode = body.mode ?? (body.provider !== undefined ? "manual" : "auto");
    if (mode === "auto") await runAuto(body, prompt, res, abort.signal);
    else await runManual(body, prompt, res, abort.signal);
  } catch (err) {
    const d = describeError(err);
    sseLog(res, { level: "error", category: "error", title: d.title, detail: d.detail });
    sseWrite(res, { type: "error", error: d });
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
      if (url === "/api/models" && req.method === "GET") return await handleModels(req.url ?? "", res);
      if (url === "/api/pool" && req.method === "GET") return await handlePool(res);
      if (url === "/api/keys" && req.method === "POST") return await handleKeys(req, res);
      if (url === "/api/run" && req.method === "POST") return await handleRun(req, res);
      return serveStatic(req, res);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  })();
}

export interface StartedServer {
  port: number;
  close: () => Promise<void>;
}

/**
 * Démarre le serveur et résout avec le port réel. Sans host → écoute en IPv4 et IPv6
 * (localhost fonctionne dans les deux cas). `port: 0` ⇒ port libre choisi par l'OS.
 */
export function startServer(options: { port?: number } = {}): Promise<StartedServer> {
  loadEnv();
  const server = createServer(handler);
  const port = options.port ?? PORT;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
      resolve({
        port: actualPort,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

/** Lancement en ligne de commande : logs lisibles + gestion d'erreur. */
function runCli(): void {
  startServer()
    .then(({ port }) => {
      console.log(`\n✅ Relay — dashboard prêt :`);
      console.log(`   →  http://localhost:${port}`);
      console.log(`   →  http://127.0.0.1:${port}\n`);
      if (!existsSync(join(WEB_DIST, "index.html"))) {
        console.log("ℹ UI non buildée : 'pnpm web:build' (ou 'pnpm web:dev' pour le mode dev).\n");
      }
      console.log("Laisse ce terminal ouvert (le serveur tourne ici). Ctrl+C pour arrêter.");
    })
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[relay] le port ${PORT} est déjà utilisé.`);
        console.error(`→ ferme l'autre serveur, ou lance avec un autre port : RELAY_PORT=5180 pnpm server`);
      } else {
        console.error(`[relay] erreur serveur : ${err.message}`);
      }
      process.exit(1);
    });
}

process.on("uncaughtException", (err) => {
  console.error(`[relay] exception non gérée : ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});

// Auto-démarrage seulement si exécuté directement (pas lors d'un import depuis Electron).
const entry = process.argv[1] !== undefined ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) runCli();
