#!/usr/bin/env node
/**
 * @relay/server — serveur local qui expose le moteur Relay à l'interface web.
 *
 * - Détient les clés (lues/écrites dans `.env`, côté machine — jamais envoyées au navigateur).
 * - `GET  /api/state`  : backends prêts, modèles du registre, routes.
 * - `GET  /api/models` : modèles de chat d'un backend + suggestion par tier.
 * - `GET  /api/pool`   : pool du mode auto (tous les comptes prêts, profils, santé).
 * - `GET|PUT /api/settings` : réglages (mode, stratégie, plafonds, budget, synthèse) → `.relay/settings.json`.
 * - `POST /api/keys`   : enregistre une clé dans `.env` ; `/api/keys/test`, `/api/keys/delete`.
 * - `POST /api/run`    : exécute un pipeline (mode auto ou manuel), streame les événements en SSE.
 * - `POST /api/approve` : valide/refuse une commande d'agent (mode Prudent).
 * - `/api/workspace/*` : runs précédents, fichiers d'un run, lancer une commande, ouvrir le dossier.
 * - sert l'app web buildée (packages/web/dist) si présente.
 *
 * Écoute uniquement sur 127.0.0.1 (outil local).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize, extname, dirname, isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  agenticRunTask,
  AutoRouter,
  autoRouting,
  checkCommand,
  ConfigError,
  decompose,
  defaultRegistry,
  describeError,
  execute,
  HealthTracker,
  launchCommand,
  loadConfig,
  profileModel,
  ProviderRequestError,
  Router,
  runCommand,
  shouldTryAnotherModel,
  STRATEGIES,
  type AccountPolicy,
  type BillingMode,
  type CommandPolicy,
  type Effort,
  type ErrorDescription,
  type LogEntry,
  type Pipeline,
  type PipelineEvent,
  type PoolEntry,
  type Provider,
  type RunTask,
  type RelayConfig,
  type RouteTier,
  type Strategy,
  type TierModels,
  Workspace,
} from "@relay/core";
import {
  autoPoolModels,
  createProvider,
  filterChatModels,
  PROVIDER_PRESETS,
  providerReadiness,
  suggestTierModels,
} from "@relay/providers";
import {
  confineRunDir,
  DEFAULT_WORKSPACE_ROOT,
  detectEnvironment,
  expandHome,
  listRunDirs,
  newRunDir,
  openDir,
} from "./workspace.js";

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

interface PoolModel {
  model: string;
  level: RouteTier;
  tags: string[];
  family: string;
  known: boolean;
  inputPerM: number;
  outputPerM: number;
  health?: string;
}

interface PoolAccount {
  name: string;
  label: string;
  billing: BillingMode;
  /** Modèles effectivement dans le pool auto (sélection recommandée ± choix de l'utilisateur). */
  models: PoolModel[];
  /** Tous les modèles de chat détectés, pour le catalogue des Réglages. */
  available: Array<PoolModel & { recommended: boolean; inPool: boolean }>;
  error?: ErrorDescription;
}

function profileOf(provider: string, model: string): PoolModel {
  const prof = profileModel(model);
  const h = health.status(provider, model);
  return {
    model,
    level: prof.level,
    tags: prof.tags,
    family: prof.family,
    known: prof.known,
    inputPerM: prof.inputPerM,
    outputPerM: prof.outputPerM,
    ...(h !== undefined ? { health: h } : {}),
  };
}

/** Pool du mode auto : chaque compte prêt apporte sa sélection, ajustée par ses réglages. */
async function buildPool(policies: Record<string, AccountPolicy>): Promise<PoolAccount[]> {
  const ready = providerReadiness().filter((p) => p.ready);
  return Promise.all(
    ready.map(async (p): Promise<PoolAccount> => {
      try {
        const detected = await detectModels(p.name);
        const recommended = autoPoolModels(p.name, detected);
        const policy = policies[p.name];
        const inPool = new Set([
          ...recommended.filter((m) => policy?.disabledModels?.includes(m) !== true),
          ...(policy?.extraModels ?? []).filter((m) => detected.length === 0 || detected.includes(m)),
        ]);
        return {
          name: p.name,
          label: p.label,
          billing: p.billing,
          models: [...inPool].map((m) => profileOf(p.name, m)),
          available: detected.map((m) => ({
            ...profileOf(p.name, m),
            recommended: recommended.includes(m),
            inPool: inPool.has(m),
          })),
        };
      } catch (err) {
        return { name: p.name, label: p.label, billing: p.billing, models: [], available: [], error: describeError(err) };
      }
    }),
  );
}

// ── Réglages (.relay/settings.json, ignoré par git) ──────────────────────────

interface RelaySettings {
  mode: "auto" | "manual";
  strategy: Strategy;
  policies: Record<string, AccountPolicy>;
  /** Budget max facturé par run ($), null = illimité. */
  budgetPerRun: number | null;
  /** Étape de synthèse finale. */
  synthesis: boolean;
  /** Phase D : les tâches écrivent de vrais fichiers et lancent des commandes. */
  agentic: boolean;
  /** Racine des dossiers de travail (un sous-dossier par run). */
  workspaceRoot: string;
  /** Commandes des agents : ask (Prudent), safe (Sûr), auto (Libre). */
  commandPolicy: CommandPolicy;
}

const POLICIES: readonly CommandPolicy[] = ["ask", "safe", "auto"];
const POLICY_LABEL: Record<CommandPolicy, string> = {
  ask: "Prudent (chaque commande attend ta validation)",
  safe: "Sûr (outils de développement seulement)",
  auto: "Libre (tout sauf les commandes destructrices)",
};

const settingsPath = (): string => join(ROOT_DIR, ".relay", "settings.json");
const DEFAULT_SETTINGS: RelaySettings = {
  mode: "auto",
  strategy: "balanced",
  policies: DEFAULT_POLICIES,
  budgetPerRun: null,
  synthesis: true,
  agentic: true,
  workspaceRoot: DEFAULT_WORKSPACE_ROOT,
  commandPolicy: "safe",
};

/** Réglages valides : les champs inconnus ou mal typés retombent sur les défauts. */
function sanitizeSettings(raw: Partial<RelaySettings>): RelaySettings {
  return {
    mode: raw.mode === "manual" ? "manual" : "auto",
    strategy: raw.strategy !== undefined && STRATEGIES.includes(raw.strategy) ? raw.strategy : DEFAULT_SETTINGS.strategy,
    policies: { ...DEFAULT_POLICIES, ...(typeof raw.policies === "object" && raw.policies !== null ? raw.policies : {}) },
    budgetPerRun: typeof raw.budgetPerRun === "number" && raw.budgetPerRun >= 0 ? raw.budgetPerRun : null,
    synthesis: typeof raw.synthesis === "boolean" ? raw.synthesis : DEFAULT_SETTINGS.synthesis,
    agentic: typeof raw.agentic === "boolean" ? raw.agentic : DEFAULT_SETTINGS.agentic,
    workspaceRoot:
      typeof raw.workspaceRoot === "string" && isAbsolute(expandHome(raw.workspaceRoot.trim()))
        ? expandHome(raw.workspaceRoot.trim())
        : DEFAULT_SETTINGS.workspaceRoot,
    commandPolicy: raw.commandPolicy !== undefined && POLICIES.includes(raw.commandPolicy) ? raw.commandPolicy : DEFAULT_SETTINGS.commandPolicy,
  };
}

function loadSettings(): RelaySettings {
  try {
    return sanitizeSettings(JSON.parse(readFileSync(settingsPath(), "utf8")) as Partial<RelaySettings>);
  } catch {
    return sanitizeSettings({});
  }
}

function saveSettings(settings: RelaySettings): void {
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
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

/** Écrit (ou retire, si `value` est absent) une clé dans .env et dans process.env. */
function setEnvKey(key: string, value?: string): void {
  let content = "";
  try {
    content = readFileSync(ENV_PATH, "utf8");
  } catch {
    /* fichier absent : on le crée */
  }
  const kept = content
    .split("\n")
    .filter((l) => l.trim().length > 0 && !l.startsWith(`${key}=`));
  if (value !== undefined) kept.push(`${key}=${value}`);
  writeFileSync(ENV_PATH, `${kept.join("\n")}\n`);
  if (value !== undefined) process.env[key] = value;
  else delete process.env[key];
}

/** Comptes + fin de clé masquée (jamais la clé entière). */
function accountsState(): Array<ReturnType<typeof providerReadiness>[number] & { keyHint?: string }> {
  return providerReadiness().map((p) => {
    const key = p.envKey !== undefined ? process.env[p.envKey]?.trim() : undefined;
    return key ? { ...p, keyHint: `…${key.slice(-4)}` } : p;
  });
}

/** Le binaire `claude` répond-il ? (test du compte Claude Code, sans consommer de quota) */
function checkClaudeCli(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("pas de réponse du binaire claude"));
    }, 8_000);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`binaire claude introuvable : ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`claude --version a quitté avec le code ${code}`));
    });
  });
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
    providers: accountsState(),
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
  sendJson(res, 200, { accounts: await buildPool(loadSettings().policies), defaultPolicies: DEFAULT_POLICIES });
}

async function handleSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "PUT") {
    const next = sanitizeSettings({ ...loadSettings(), ...((await readBody(req)) as Partial<RelaySettings>) });
    saveSettings(next);
    sendJson(res, 200, next);
    return;
  }
  sendJson(res, 200, loadSettings());
}

/** Teste un compte : clé enregistrée, ou clé saisie (`value`) sans l'enregistrer. */
async function handleKeyTest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { provider: name = "", value } = (await readBody(req)) as { provider?: string; value?: string };
  const preset = PROVIDER_PRESETS[name];
  if (preset === undefined) {
    sendJson(res, 400, { error: "compte inconnu" });
    return;
  }
  const started = Date.now();
  try {
    let detail: string;
    if (preset.kind === "claude-code") {
      detail = `binaire claude disponible (${await checkClaudeCli()})`;
    } else {
      const env = value?.trim() && preset.envKey ? { ...process.env, [preset.envKey]: value.trim() } : process.env;
      const provider = createProvider(name, { cwd: ROOT_DIR, env });
      if (preset.kind === "anthropic") {
        // count_tokens est gratuit : vérifie la clé sans rien consommer.
        await provider.countTokens({ model: "claude-haiku-4-5", system: "", messages: [{ role: "user", content: "ping" }] });
        detail = "clé acceptée par l'API Anthropic";
      } else {
        detail = `${(await provider.models()).length} modèles accessibles`;
      }
    }
    sendJson(res, 200, { ok: true, detail, ms: Date.now() - started });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: describeError(err), ms: Date.now() - started });
  }
}

async function handleKeyDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { provider: name = "" } = (await readBody(req)) as { provider?: string };
  const preset = PROVIDER_PRESETS[name];
  if (preset?.envKey === undefined) {
    sendJson(res, 400, { error: "compte sans clé" });
    return;
  }
  setEnvKey(preset.envKey);
  modelCache.delete(name);
  sendJson(res, 200, { providers: accountsState() });
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
  /** Budget max facturé ($) ; null = illimité. Absent ⇒ réglages. */
  budgetPerRun?: number | null;
  /** Étape de synthèse. Absent ⇒ réglages. */
  synthesis?: boolean;
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
  sendJson(res, 200, { providers: accountsState() });
}

function sseWrite(res: ServerResponse, obj: unknown): void {
  if (res.writableEnded || res.destroyed) return; // client parti
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function sseLog(res: ServerResponse, entry: Omit<LogEntry, "at">): void {
  sseWrite(res, { type: "log", entry: { at: Date.now(), ...entry } satisfies LogEntry });
}

// ── Phase D : dossier de travail, worker agentique, validations ─────────────

/** Commandes en attente de validation (mode Prudent), par clé. */
const approvals = new Map<string, (ok: boolean) => void>();
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

function requestApproval(res: ServerResponse, signal: AbortSignal, req: { taskId: string; id: string; command: string }): Promise<boolean> {
  const key = randomUUID();
  return new Promise((resolveApproval) => {
    const finish = (ok: boolean): void => {
      if (!approvals.delete(key)) return;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      sseWrite(res, { type: "approval:done", key, ok });
      resolveApproval(ok);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
    approvals.set(key, finish);
    signal.addEventListener("abort", onAbort, { once: true });
    sseWrite(res, { type: "approval:request", key, ...req });
  });
}

interface AgentSetup {
  cwd: string;
  /** Pour le planificateur : dossier neuf, outils réellement installés. */
  conventions?: string;
  workspace?: Workspace;
  runTask?: RunTask;
}

/** Mode agentique : un dossier neuf par run, annoncé à l'interface. */
async function setupAgent(settings: RelaySettings, prompt: string, res: ServerResponse, signal: AbortSignal): Promise<AgentSetup> {
  if (!settings.agentic) return { cwd: ROOT_DIR };
  const workspace = new Workspace(newRunDir(settings.workspaceRoot, prompt));
  const environment = await detectEnvironment();
  sseWrite(res, { type: "workspace", root: workspace.root, policy: settings.commandPolicy });
  sseLog(res, {
    level: "info",
    category: "info",
    title: `Dossier de travail : ${workspace.root}`,
    detail: `Commandes des agents : ${POLICY_LABEL[settings.commandPolicy]}\nOutils détectés : ${environment || "aucun"}`,
  });
  return {
    cwd: workspace.root,
    conventions: `Dossier de travail neuf et vide. Outils installés : ${environment || "inconnus"}. Rien d'autre n'est installé et les agents ne peuvent pas installer de paquets : bibliothèque standard uniquement (ex. unittest si pytest n'est pas listé).`,
    workspace,
    runTask: agenticRunTask({
      workspace,
      policy: settings.commandPolicy,
      ...(environment ? { environment } : {}),
      approve: (r) => requestApproval(res, signal, r),
    }),
  };
}

/** Mode manuel : un backend, un modèle par tier. */
async function runManual(body: RunBody, prompt: string, res: ServerResponse, signal: AbortSignal): Promise<void> {
  const config = safeLoadConfig();
  if (config === null) throw new ConfigError("relay.config.json introuvable ou invalide");
  const providerName = body.provider ?? config.decomposer.provider;
  applyTierModels(config, providerName, body);

  const settings = loadSettings();
  const provider = createProvider(providerName, { cwd: ROOT_DIR });
  sseWrite(res, { type: "mode", mode: "manual", accounts: [PROVIDER_PRESETS[providerName]?.label ?? providerName] });
  const agent = await setupAgent(settings, prompt, res, signal);
  sseWrite(res, { type: "decomposing", provider: providerName, model: config.decomposer.model });
  const pipeline = await decompose({
    prompt,
    context: { cwd: agent.cwd, ...(agent.conventions !== undefined ? { conventions: agent.conventions } : {}) },
    provider,
    model: config.decomposer,
    onLog: (entry) => sseWrite(res, { type: "log", entry }),
  });

  if (agent.workspace !== undefined) pipeline.workspace = agent.workspace.root;
  sseWrite(res, { type: "routes", routes: config.routes });
  const synthesis = body.synthesis ?? settings.synthesis;
  const runTask = agent.runTask !== undefined ? { runTask: agent.runTask } : {};
  for await (const event of execute({ pipeline, provider, router: new Router(config), signal, synthesis, ...runTask })) {
    sseWrite(res, event satisfies PipelineEvent);
  }
}

/** Mode auto : le routeur choisit, pour le plan puis pour chaque tâche, parmi tous les comptes. */
async function runAuto(body: RunBody, prompt: string, res: ServerResponse, signal: AbortSignal): Promise<void> {
  const settings = loadSettings();
  const strategy: Strategy =
    body.strategy !== undefined && STRATEGIES.includes(body.strategy) ? body.strategy : settings.strategy;
  const policies = { ...settings.policies, ...body.policies };
  const budget = body.budgetPerRun !== undefined ? body.budgetPerRun : settings.budgetPerRun;
  const synthesis = body.synthesis ?? settings.synthesis;

  const accounts = await buildPool(policies);
  for (const a of accounts) {
    if (a.error !== undefined) {
      sseLog(res, { level: "warn", category: "info", title: `Compte ${a.label} ignoré : ${a.error.title}`, detail: a.error.detail });
    }
  }
  const entries: PoolEntry[] = accounts
    .filter((a) => policies[a.name]?.enabled !== false)
    .flatMap((a) => a.models.map((m) => ({ provider: a.name, model: m.model, billing: a.billing })));
  const router = new AutoRouter(entries, { strategy, policies, health, ...(budget !== null ? { budget } : {}) });
  const used = accounts.filter((a) => a.models.length > 0 && policies[a.name]?.enabled !== false).map((a) => a.label);
  sseWrite(res, { type: "mode", mode: "auto", strategy, accounts: used, poolSize: router.size });
  sseLog(res, {
    level: "info",
    category: "info",
    title: `Mode auto · stratégie ${strategy} · ${used.length} compte(s) · ${router.size} modèles · budget ${
      budget === null ? "illimité" : `$${budget.toFixed(2)}`
    } · synthèse ${synthesis ? "oui" : "non"}`,
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

  const agent = await setupAgent(settings, prompt, res, signal);

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
        context: { cwd: agent.cwd, ...(agent.conventions !== undefined ? { conventions: agent.conventions } : {}) },
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
      if (next === undefined || !shouldTryAnotherModel(err)) throw err;
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
  router.spend(pipeline.planning?.billedCost ?? 0); // le plan compte dans le budget
  if (agent.workspace !== undefined) pipeline.workspace = agent.workspace.root;

  const runTask = agent.runTask !== undefined ? { runTask: agent.runTask } : {};
  for await (const event of execute({ pipeline, routing: autoRouting(router, getProvider, health), signal, synthesis, ...runTask })) {
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

async function handleApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { key = "", ok } = (await readBody(req)) as { key?: string; ok?: boolean };
  const finish = approvals.get(key);
  finish?.(ok === true);
  sendJson(res, finish !== undefined ? 200 : 404, { found: finish !== undefined });
}

const query = (req: IncomingMessage): URLSearchParams => new URL(req.url ?? "", "http://localhost").searchParams;
const runRoot = (root: unknown): string => confineRunDir(loadSettings().workspaceRoot, typeof root === "string" ? root : "");

function handleWorkspaceRuns(res: ServerResponse): void {
  const base = loadSettings().workspaceRoot;
  sendJson(res, 200, { base, runs: listRunDirs(base) });
}

function handleWorkspaceFiles(req: IncomingMessage, res: ServerResponse): void {
  const root = runRoot(query(req).get("root"));
  sendJson(res, 200, { root, files: new Workspace(root).list() });
}

function handleWorkspaceFile(req: IncomingMessage, res: ServerResponse): void {
  const q = query(req);
  const path = q.get("path") ?? "";
  sendJson(res, 200, { path, content: new Workspace(runRoot(q.get("root"))).read(path) });
}

/** Commande lancée par l'utilisateur depuis le panneau Exécution (liste noire appliquée). */
async function handleWorkspaceRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root?: string; command?: string; stdin?: string; detached?: boolean };
  const root = runRoot(body.root);
  const command = (body.command ?? "").trim();
  const check = checkCommand(command, "auto");
  if (command.length === 0 || !check.allowed) {
    sendJson(res, 400, { error: command.length === 0 ? "commande vide" : check.reason });
    return;
  }
  if (body.detached === true) {
    const pid = await launchCommand(command, root);
    sendJson(res, 200, { command, launched: true, pid });
    return;
  }
  sendJson(res, 200, await runCommand(command, { cwd: root, timeoutMs: 60_000, ...(body.stdin !== undefined ? { stdin: body.stdin } : {}) }));
}

async function handleWorkspaceOpen(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root?: string; target?: string };
  await openDir(runRoot(body.root), body.target === "vscode" ? "vscode" : "folder");
  sendJson(res, 200, { ok: true });
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
      if (url === "/api/settings" && (req.method === "GET" || req.method === "PUT")) return await handleSettings(req, res);
      if (url === "/api/keys/test" && req.method === "POST") return await handleKeyTest(req, res);
      if (url === "/api/keys/delete" && req.method === "POST") return await handleKeyDelete(req, res);
      if (url === "/api/keys" && req.method === "POST") return await handleKeys(req, res);
      if (url === "/api/run" && req.method === "POST") return await handleRun(req, res);
      if (url === "/api/approve" && req.method === "POST") return await handleApprove(req, res);
      if (url === "/api/workspace/runs" && req.method === "GET") return handleWorkspaceRuns(res);
      if (url === "/api/workspace/files" && req.method === "GET") return handleWorkspaceFiles(req, res);
      if (url === "/api/workspace/file" && req.method === "GET") return handleWorkspaceFile(req, res);
      if (url === "/api/workspace/run" && req.method === "POST") return await handleWorkspaceRun(req, res);
      if (url === "/api/workspace/open" && req.method === "POST") return await handleWorkspaceOpen(req, res);
      return serveStatic(req, res);
    } catch (err) {
      // Erreurs des endpoints de l'espace de travail : 400 lisible (chemin refusé, fichier introuvable…).
      const status = url.startsWith("/api/workspace/") ? 400 : 500;
      if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
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
