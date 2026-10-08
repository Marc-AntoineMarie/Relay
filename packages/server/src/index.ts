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
 * - `/api/workspace/*` : runs précédents, fichiers d'un run, lancer une commande (ou une app suivie
 *   jusqu'à sa fermeture), ouvrir le dossier.
 * - `GET /ws/<run>/<chemin>` : fichiers d'un run servis pour l'aperçu (erreurs JS remontées).
 * - sert l'app web buildée (packages/web/dist) si présente.
 *
 * Outil local : l'API refuse les requêtes d'une autre origine (un site web ouvert dans le
 * navigateur ne peut pas la piloter) et les noms d'hôte autres que localhost (DNS rebinding).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, normalize, extname, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  agenticRunTask,
  clipMemory,
  MEMORY_FILE,
  updateProjectMemory,
  type ModelAssignment,
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
  type ExecutorOptions,
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
  DEFAULT_WORKSPACE_ROOT,
  describeEnvironment,
  detectEnvironment,
  expandHome,
  openDir,
} from "./workspace.js";
import {
  appendTurn,
  fixPipeline,
  lastContracts,
  lastLaunch,
  loadSession,
  renumber,
  sessionContext,
  turnFromPipeline,
  type FixRequest,
  type SessionTurn,
} from "./session.js";
import {
  checkRemote,
  closeTunnel,
  deleteModel,
  ensureKey,
  installManaged,
  LOCAL_URL,
  machineInfo,
  machineVerdict,
  modelFit,
  ollamaStatus,
  openTunnel,
  pullModel,
  REMOTE_INSTALL,
  REMOTE_SPECS,
  shutdownOllama,
  sshRun,
  startServer as startOllama,
  stopServer as stopOllama,
  SUGGESTED_MODELS,
  testModel,
  TUNNEL_URL,
  tunnelState,
  type RemoteTarget,
} from "./ollama.js";
import { closeTerminal, listTerminals, openTerminal, resizeTerminal, shutdownTerminals, streamTerminal, writeTerminal } from "./terminal.js";
import {
  appendMessage,
  checkImportable,
  conversationContext,
  expandPath,
  loadConversation,
  ProjectStore,
  readMemory,
  slugify,
  suggestName,
  uniqueDir,
  writeMemory,
  type ConversationMessage,
} from "./projects.js";

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
  /** Le planificateur peut poser des questions de cadrage si la demande est floue. */
  askQuestions: boolean;
  /** Mémoire globale : tes préférences, transmises à chaque projet. */
  globalMemory: string;
  /** Tenir à jour RELAY.md (mémoire du projet) après chaque tour. */
  projectMemory: boolean;
  /** Durée max d'une réponse de modèle (min) : au-delà, on passe au modèle suivant. */
  maxCallMinutes: number;
  /** Si la vérification finale échoue, l'interface lance une correction automatique (une fois). */
  autoFix: boolean;
  /** Ollama utilisé par Relay : sur cette machine, ou sur un VPS (tunnel SSH). */
  ollamaTarget: "local" | "remote";
  /** VPS pour Ollama (la clé SSH reste sur ta machine). */
  ollamaRemote: Partial<RemoteTarget> | null;
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
  askQuestions: true,
  globalMemory: "",
  projectMemory: true,
  maxCallMinutes: 5,
  autoFix: true,
  ollamaTarget: "local",
  ollamaRemote: null,
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
    askQuestions: typeof raw.askQuestions === "boolean" ? raw.askQuestions : DEFAULT_SETTINGS.askQuestions,
    globalMemory: typeof raw.globalMemory === "string" ? raw.globalMemory.slice(0, 4_000) : DEFAULT_SETTINGS.globalMemory,
    projectMemory: typeof raw.projectMemory === "boolean" ? raw.projectMemory : DEFAULT_SETTINGS.projectMemory,
    maxCallMinutes:
      typeof raw.maxCallMinutes === "number" && raw.maxCallMinutes >= 1 && raw.maxCallMinutes <= 60 ? raw.maxCallMinutes : DEFAULT_SETTINGS.maxCallMinutes,
    autoFix: typeof raw.autoFix === "boolean" ? raw.autoFix : DEFAULT_SETTINGS.autoFix,
    ollamaTarget: raw.ollamaTarget === "remote" ? "remote" : "local",
    ollamaRemote:
      typeof raw.ollamaRemote === "object" && raw.ollamaRemote !== null
        ? {
            ...(typeof raw.ollamaRemote.host === "string" ? { host: raw.ollamaRemote.host.trim() } : {}),
            ...(typeof raw.ollamaRemote.user === "string" ? { user: raw.ollamaRemote.user.trim() } : {}),
            ...(typeof raw.ollamaRemote.port === "number" ? { port: raw.ollamaRemote.port } : {}),
            ...(typeof raw.ollamaRemote.keyPath === "string" ? { keyPath: raw.ollamaRemote.keyPath.trim() } : {}),
          }
        : null,
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
  // Pas d'en-têtes CORS : seule l'interface Relay (même origine) parle à l'API.
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Requête venant de l'interface Relay elle-même : hôte local, et même origine si le navigateur l'indique. */
function trustedRequest(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  if (!LOCAL_HOSTS.has(host.replace(/:\d+$/, ""))) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
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
  /** Continuer dans le dossier d'un projet existant (conversation, mémoire, session). */
  workspace?: string;
  /** Nouveau projet : nom (sinon tiré de la demande) et emplacement (sinon racine des runs). */
  project?: { name?: string; location?: string };
  /** « answer » : réponses aux questions de cadrage (le planificateur n'en repose pas). */
  kind?: "prompt" | "answer";
  /** Corriger une erreur rencontrée en testant (sans re-planification). */
  fix?: FixRequest;
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
  /** Pour le planificateur et les agents : outils, préférences, mémoire, conversation, travail déjà fait. */
  conventions?: string;
  workspace?: Workspace;
  runTask?: RunTask;
  /** Nom du projet (= nom du dossier). */
  name: string;
  /** Outils de la machine, présents et absents (transmis aussi à la mémoire du projet). */
  environment?: string;
  /** Numéro du tour dans la session du dossier (1 = premier run). */
  round: number;
  /** Contrats du dernier tour, repris si le nouveau plan n'en donne pas. */
  contracts?: string;
  /** Commande de lancement connue (dernier tour), reprise si le nouveau plan n'en donne pas. */
  launch?: string;
}

const projects = new ProjectStore(
  () => join(ROOT_DIR, ".relay", "projects.json"),
  () => loadSettings().workspaceRoot,
);

/** Dossier du projet : nom simple (proposé ou choisi), emplacement facultatif ; inscrit s'il est ailleurs. */
function createProjectDir(settings: RelaySettings, prompt: string, body: RunBody): string {
  const location = body.project?.location?.trim() ? expandPath(body.project.location) : settings.workspaceRoot;
  if (!isAbsolute(location)) throw new ConfigError("emplacement du projet : chemin absolu attendu (ou commençant par ~/)");
  const root = uniqueDir(location, slugify(body.project?.name?.trim() || suggestName(prompt)));
  mkdirSync(root, { recursive: true });
  if (resolve(location) !== resolve(settings.workspaceRoot)) projects.register(root);
  return root;
}

/** Mode agentique : un projet neuf, ou un projet existant (suite, réponses, correction). */
async function setupAgent(
  settings: RelaySettings,
  prompt: string,
  body: RunBody,
  res: ServerResponse,
  signal: AbortSignal,
): Promise<AgentSetup> {
  if (!settings.agentic) {
    if (body.fix !== undefined || body.workspace !== undefined) {
      throw new ConfigError("continuer ou corriger un projet demande le mode agent (Réglages › Général)");
    }
    return { cwd: ROOT_DIR, round: 1, name: "", ...(settings.globalMemory.trim() ? { conventions: preferences(settings) } : {}) };
  }
  const continued = body.workspace !== undefined;
  const workspace = new Workspace(continued ? runRoot(body.workspace) : createProjectDir(settings, prompt, body));
  const name = basename(workspace.root);
  const session = loadSession(workspace.root);
  const round = session.turns.length + 1;
  const memory = readMemory(workspace.root);
  const conversation = loadConversation(workspace.root);
  const machine = await detectEnvironment();
  const environment = describeEnvironment(machine);
  const noTk = machine.missing.some((m) => m.startsWith("tkinter"));

  // La demande entre dans la conversation du projet dès le départ.
  appendMessage(
    workspace.root,
    body.fix !== undefined
      ? { role: "user", kind: "fix", text: body.fix.note?.trim() || `Corriger l'erreur de ${body.fix.source}`, error: body.fix.output.slice(-3_000) }
      : { role: "user", kind: body.kind === "answer" ? "answer" : "prompt", text: prompt },
  );
  sseWrite(res, { type: "workspace", root: workspace.root, name, policy: settings.commandPolicy, round });
  sseLog(res, {
    level: "info",
    category: "info",
    title: round > 1 ? `Projet ${name} · tour ${round}` : `Nouveau projet ${name} : ${workspace.root}`,
    detail: `Commandes des agents : ${POLICY_LABEL[settings.commandPolicy]}\nOutils détectés : ${environment}${
      memory ? `\nMémoire du projet : ${MEMORY_FILE} (${memory.length} caractères)` : ""
    }`,
  });
  const contracts = lastContracts(session);
  const launch = lastLaunch(session);
  return {
    cwd: workspace.root,
    conventions: [
      round > 1 || conversation.length > 0
        ? "Projet existant, sur la machine de l'utilisateur : sa mémoire, la conversation et le travail déjà fait sont ci-dessous."
        : "Projet neuf, dossier vide, sur la machine de l'utilisateur.",
      `Outils : ${environment}.`,
      "Rien d'autre n'est installé et les agents ne peuvent pas installer de paquets : n'utilise que ce qui est présent.",
      noTk
        ? "Interface graphique demandée : tkinter est absent, donc fais une page HTML autonome (HTML + CSS + JavaScript dans un seul fichier, ouverte dans le navigateur), avec la logique testable à part si besoin ; sinon une interface en ligne de commande."
        : "",
      preferences(settings),
      memory ? `## Mémoire du projet (${MEMORY_FILE})\n${clipMemory(memory)}` : "",
      conversationContext(conversation),
      sessionContext(session, 2_500),
    ]
      .filter(Boolean)
      .join("\n"),
    workspace,
    name,
    environment,
    round,
    ...(contracts !== undefined ? { contracts } : {}),
    ...(launch !== undefined ? { launch } : {}),
    runTask: agenticRunTask({
      workspace,
      policy: settings.commandPolicy,
      environment,
      approve: (r) => requestApproval(res, signal, r),
    }),
  };
}

const preferences = (settings: RelaySettings): string =>
  settings.globalMemory.trim() ? `## Préférences de l'utilisateur (mémoire globale)\n${settings.globalMemory.trim()}` : "";

/** Questions de cadrage : la conversation attend les réponses, rien ne s'exécute. */
function askQuestions(pipeline: Pipeline, agent: AgentSetup, res: ServerResponse): boolean {
  if (pipeline.tasks.length > 0 || (pipeline.questions ?? []).length === 0) return false;
  const questions = pipeline.questions ?? [];
  if (agent.workspace !== undefined) {
    appendMessage(agent.workspace.root, {
      role: "relay",
      kind: "questions",
      text: pipeline.analysis ?? "",
      questions,
      ...(pipeline.analysis !== undefined ? { analysis: pipeline.analysis } : {}),
    });
  }
  sseWrite(res, { type: "questions", questions, analysis: pipeline.analysis ?? "" });
  return true;
}

/** Tentative en cours (un seul run à la fois) : « Passer au modèle suivant » l'interrompt. */
let currentAttempt: { taskId: string; provider: string; model: string; skip: () => void } | null = null;
const trackAttempt = (a: typeof currentAttempt): void => {
  currentAttempt = a;
};

async function handleRunSkip(res: ServerResponse): Promise<void> {
  const a = currentAttempt;
  a?.skip();
  sendJson(res, a !== null ? 200 : 404, a !== null ? { skipped: true, taskId: a.taskId, model: a.model } : { skipped: false });
}

/** Modèles capables de tenir la mémoire du projet (petits, rapides, contexte long). */
type MemoryModel = { provider: Provider; model: ModelAssignment };

const agentContext = (agent: AgentSetup): Pipeline["context"] => ({
  cwd: agent.cwd,
  ...(agent.conventions !== undefined ? { conventions: agent.conventions } : {}),
});

/** Correction directe : une tâche d'agent avec l'erreur et l'historique, sans planificateur. */
function startFix(fix: FixRequest, agent: AgentSetup, res: ServerResponse): Pipeline {
  sseLog(res, {
    level: "info",
    category: "plan",
    title: `Correction directe (sans re-planification) : ${fix.source}`,
    detail: `${fix.note ? `Précision : ${fix.note}\n\n` : ""}${fix.output}`,
  });
  return fixPipeline(fix, agentContext(agent), agent.contracts, agent.launch);
}

/** Ids du tour, contrats repris, dossier : le pipeline est prêt à s'exécuter dans la session. */
function attachToSession(pipeline: Pipeline, agent: AgentSetup): void {
  renumber(pipeline, agent.round);
  if (pipeline.contracts === undefined && agent.contracts !== undefined) pipeline.contracts = agent.contracts;
  if (pipeline.launch === undefined && agent.launch !== undefined) pipeline.launch = agent.launch;
  if (agent.workspace !== undefined) pipeline.workspace = agent.workspace.root;
}

/**
 * Exécute, streame, puis inscrit le tour : session technique, réponse dans la conversation,
 * et mise à jour de la mémoire du projet (RELAY.md) — même en cas d'échec.
 */
async function executeAndRecord(
  opts: ExecutorOptions,
  res: ServerResponse,
  agent: AgentSetup,
  body: RunBody,
  prompt: string,
  memoryModels: MemoryModel[],
): Promise<void> {
  let synthesis: string | undefined;
  let outcome: SessionTurn["outcome"] = "stopped";
  let failure: string | undefined;
  let cost: ConversationMessage["cost"];
  let launchCheck: { command: string; ok: boolean; output: string } | undefined;
  try {
    for await (const event of execute(opts)) {
      sseWrite(res, event satisfies PipelineEvent);
      if (event.type === "pipeline:synthesis") synthesis = event.text;
      else if (event.type === "pipeline:done") {
        outcome = "done";
        const m = event.metrics;
        cost = { billed: m.totalBilledCost, reference: m.totalReferenceCost, durationMs: m.totalDurationMs, tokens: m.totalTokens };
      } else if (event.type === "pipeline:failed") {
        outcome = opts.signal?.aborted === true ? "stopped" : "failed";
        failure = event.error;
      }
    }
    // Vérification finale par Relay lui-même : le programme démarre-t-il vraiment ?
    if (outcome === "done" && agent.workspace !== undefined && opts.pipeline.launch !== undefined) {
      launchCheck = await checkLaunch(agent.workspace.root, opts.pipeline.launch, res, opts.signal);
    }
  } finally {
    if (agent.workspace !== undefined) {
      const root = agent.workspace.root;
      const p = opts.pipeline;
      appendTurn(root, turnFromPipeline(p, body.fix !== undefined ? "fix" : "plan", prompt, outcome, synthesis, body.fix?.output));
      const files = [...new Set(p.tasks.flatMap((t) => (Array.isArray(t.output?.data?.["files"]) ? (t.output?.data?.["files"] as string[]) : [])))];
      const summaries = p.tasks.map((t) => t.output?.summary).filter((x): x is string => x !== undefined);
      appendMessage(root, {
        role: "relay",
        kind: "result",
        text: synthesis ?? (summaries.join("\n") || failure || "(aucun résultat)"),
        outcome,
        ...(p.analysis !== undefined ? { analysis: p.analysis } : {}),
        ...(p.assumptions !== undefined ? { assumptions: p.assumptions } : {}),
        tasks: p.tasks.map((t) => ({
          id: t.id,
          description: t.description,
          tier: t.tier,
          status: t.status,
          ...(t.assignedModel !== undefined ? { model: t.assignedModel } : {}),
          ...(t.attempts.at(-1)?.metrics.provider !== undefined ? { provider: t.attempts.at(-1)?.metrics.provider } : {}),
        })),
        files,
        ...(cost !== undefined ? { cost } : {}),
        ...(failure !== undefined ? { error: failure } : {}),
        ...(launchCheck !== undefined ? { launch: { command: launchCheck.command, ok: launchCheck.ok } } : {}),
      });
      if (opts.signal?.aborted !== true && loadSettings().projectMemory) {
        const turn = [
          body.fix !== undefined ? `Correction demandée : ${body.fix.source}\n${body.fix.output.slice(-1_500)}` : `Demande : ${prompt}`,
          p.analysis !== undefined ? `Analyse : ${p.analysis}` : "",
          p.assumptions?.length ? `Hypothèses : ${p.assumptions.join(" ; ")}` : "",
          `Tâches :\n${p.tasks.map((t) => `- [${t.id}] ${t.description} → ${t.status}${t.output?.summary ? ` — ${t.output.summary}` : ""}`).join("\n")}`,
          synthesis !== undefined ? `Compte rendu :\n${synthesis.slice(0, 2_500)}` : "",
          `Issue : ${outcome}${failure !== undefined ? ` (${failure})` : ""}`,
          agent.environment !== undefined ? `Outils de la machine : ${agent.environment}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        await refreshMemory(agent, memoryModels, turn, res);
      }
    }
  }
}

/** Ouvre un navigateur ou un fichier : rien à vérifier en ligne de commande. */
const OPENS_SOMETHING = /^(xdg-open|open|start|firefox|chromium|google-chrome|code)\b/;

/**
 * Relay lance lui-même la commande du projet (8 s max) : 0 = terminé sans erreur, 124 = encore en
 * marche (fenêtre, jeu, serveur), « EOFError » = programme qui attend une saisie : tout cela démarre.
 */
async function checkLaunch(
  root: string,
  command: string,
  res: ServerResponse,
  signal?: AbortSignal,
): Promise<{ command: string; ok: boolean; output: string } | undefined> {
  if (OPENS_SOMETHING.test(command) || !checkCommand(command, "auto").allowed) return undefined;
  sseLog(res, { level: "info", category: "tool", title: `Vérification finale par Relay : ${command}` });
  const r = await runCommand(`timeout 8 ${command}`, { cwd: root, timeoutMs: 15_000, ...(signal !== undefined ? { signal } : {}) });
  const ok = r.exitCode === 0 || r.exitCode === 124 || /EOFError|EOF when reading/.test(r.output);
  sseLog(res, {
    level: ok ? "info" : "error",
    category: ok ? "tool" : "error",
    title: ok ? `✓ ${command} démarre correctement` : `✗ ${command} ne démarre pas (code ${r.exitCode ?? "?"})`,
    detail: r.output || "(aucune sortie)",
  });
  sseWrite(res, { type: "launch:check", command, ok, exitCode: r.exitCode, output: r.output });
  return { command, ok, output: r.output };
}

/** RELAY.md réécrit par un petit modèle à partir du tour qui vient de se terminer. */
async function refreshMemory(agent: AgentSetup, models: MemoryModel[], turn: string, res: ServerResponse): Promise<void> {
  if (agent.workspace === undefined) return;
  const root = agent.workspace.root;
  const files = agent.workspace.list().map((f) => f.path).filter((f) => f !== MEMORY_FILE);
  for (const m of models) {
    try {
      const r = await updateProjectMemory({ provider: m.provider, model: m.model, projectName: agent.name, current: readMemory(root), turn, files });
      if (r.text.trim().length < 40) throw new Error("mémoire vide ou trop courte");
      writeMemory(root, r.text);
      sseLog(res, {
        level: "info",
        category: "info",
        title: `Mémoire du projet mise à jour (${MEMORY_FILE}) · ${m.model.provider} · ${r.servedModel ?? m.model.model} · ${r.outputTokens} tokens`,
        detail: r.text,
      });
      sseWrite(res, { type: "memory", root });
      return;
    } catch (err) {
      sseLog(res, { level: "warn", category: "fallback", title: `Mémoire : ${m.model.model} indisponible (${describeError(err).title.toLowerCase()})` });
    }
  }
}

/** Mode manuel : un backend, un modèle par tier. */
async function runManual(body: RunBody, prompt: string, res: ServerResponse, signal: AbortSignal): Promise<void> {
  const config = safeLoadConfig();
  if (config === null) throw new ConfigError("relay.config.json introuvable ou invalide");
  const providerName = body.provider ?? config.decomposer.provider;
  applyTierModels(config, providerName, body);

  const settings = loadSettings();
  const provider = createProvider(providerName, { cwd: ROOT_DIR, maxDurationMs: settings.maxCallMinutes * 60_000 });
  sseWrite(res, { type: "mode", mode: "manual", accounts: [PROVIDER_PRESETS[providerName]?.label ?? providerName] });
  const agent = await setupAgent(settings, prompt, body, res, signal);
  let pipeline: Pipeline;
  if (body.fix !== undefined) {
    pipeline = startFix(body.fix, agent, res);
  } else {
    sseWrite(res, { type: "decomposing", provider: providerName, model: config.decomposer.model });
    pipeline = await decompose({
      prompt,
      context: agentContext(agent),
      provider,
      model: config.decomposer,
      onLog: (entry) => sseWrite(res, { type: "log", entry }),
      allowQuestions: settings.askQuestions && body.kind !== "answer",
      signal,
    });
    if (askQuestions(pipeline, agent, res)) return;
  }
  attachToSession(pipeline, agent);

  sseWrite(res, { type: "routes", routes: config.routes });
  const synthesis = body.fix === undefined && (body.synthesis ?? settings.synthesis);
  const runTask = agent.runTask !== undefined ? { runTask: agent.runTask } : {};
  const memoryModels: MemoryModel[] = [{ provider, model: config.routes.quick }];
  await executeAndRecord(
    { pipeline, provider, router: new Router(config), signal, synthesis, onAttempt: trackAttempt, ...runTask },
    res,
    agent,
    body,
    prompt,
    memoryModels,
  );
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
    // Ollama tourne souvent sur CPU (machine ou petit VPS) : lent, gardé pour quand rien d'autre ne répond.
    .flatMap((a) => a.models.map((m) => ({ provider: a.name, model: m.model, billing: a.billing, ...(a.name === "ollama" ? { speed: "slow" as const } : {}) })));
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
      p = createProvider(name, { cwd: ROOT_DIR, fallbacks: false, maxDurationMs: settings.maxCallMinutes * 60_000 }); // les replis passent par le routeur
      providers.set(name, p);
    }
    return p;
  };

  const agent = await setupAgent(settings, prompt, body, res, signal);

  // Planificateur : choisi par le même routeur (niveau build, deep en stratégie qualité).
  const plannerTier: RouteTier = strategy === "quality" ? "deep" : "build";
  const planners = router.rank({ tier: plannerTier }).slice(0, 3);
  if (planners.length === 0) {
    throw new ConfigError("aucun compte utilisable en mode auto : ajoute une clé ou active un compte dans le panneau Modèles");
  }

  let pipeline: Pipeline | undefined = body.fix !== undefined ? startFix(body.fix, agent, res) : undefined;
  for (const [i, c] of pipeline === undefined ? planners.entries() : []) {
    sseLog(res, { level: "info", category: "route", title: `Planificateur → ${c.provider} · ${c.model}`, detail: `Raison : ${c.reason}` });
    sseWrite(res, { type: "decomposing", provider: c.provider, model: c.model });
    try {
      router.consume(c.provider);
      pipeline = await decompose({
        prompt,
        context: agentContext(agent),
        provider: getProvider(c.provider),
        model: { provider: c.provider, model: c.model, ...(c.effort !== undefined ? { effort: c.effort } : {}) },
        onLog: (entry) => sseWrite(res, { type: "log", entry }),
        allowQuestions: settings.askQuestions && body.kind !== "answer",
        signal,
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
  if (askQuestions(pipeline, agent, res)) return;
  attachToSession(pipeline, agent);

  const runTask = agent.runTask !== undefined ? { runTask: agent.runTask } : {};
  const withSynthesis = synthesis && body.fix === undefined; // correction : rapide, pas de synthèse
  const memoryModels: MemoryModel[] = router
    .rank({ tier: "quick", needs: ["long_context"] })
    .slice(0, 3)
    .map((c) => ({ provider: getProvider(c.provider), model: { provider: c.provider, model: c.model, ...(c.effort !== undefined ? { effort: c.effort } : {}) } }));
  await executeAndRecord(
    { pipeline, routing: autoRouting(router, getProvider, health), signal, synthesis: withSynthesis, onAttempt: trackAttempt, ...runTask },
    res,
    agent,
    body,
    prompt,
    memoryModels,
  );
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
    currentAttempt = null;
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
/** Dossier d'un projet connu (sous la racine des runs, ou inscrit) — sinon refus. */
const runRoot = (root: unknown): string => projects.resolveProject(root);

function handleWorkspaceRuns(res: ServerResponse): void {
  sendJson(res, 200, {
    base: loadSettings().workspaceRoot,
    runs: projects.list().map((p) => ({ name: p.name, root: p.root, modified: p.updated })),
  });
}

// ── Projets : historique, conversation, mémoire, import ────────────────────

function handleProjects(res: ServerResponse): void {
  sendJson(res, 200, { base: loadSettings().workspaceRoot, projects: projects.list() });
}

function handleProjectDetail(req: IncomingMessage, res: ServerResponse): void {
  const root = runRoot(query(req).get("root"));
  const launch = lastLaunch(loadSession(root));
  sendJson(res, 200, { root, name: basename(root), messages: loadConversation(root), memory: readMemory(root), ...(launch !== undefined ? { launch } : {}) });
}

async function handleProjectMemory(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root?: string; content?: string };
  const root = runRoot(body.root);
  writeMemory(root, typeof body.content === "string" ? body.content.slice(0, 40_000) : "");
  sendJson(res, 200, { ok: true });
}

/** Un dossier existant à toi devient un projet Relay (les agents pourront y écrire). */
async function handleProjectImport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root?: string };
  const root = checkImportable(body.root ?? "", [ROOT_DIR]);
  projects.register(root);
  sendJson(res, 200, { root, name: basename(root) });
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
    const entry: Launch = { id: randomUUID(), root, command, logPath: "", exited: false, exitCode: null };
    const r = await launchCommand(command, root, {
      onExit: (code) => {
        entry.exited = true;
        entry.exitCode = code;
      },
    });
    Object.assign(entry, { logPath: r.logPath, ...(r.pid !== undefined ? { pid: r.pid } : {}) });
    if (r.exited) Object.assign(entry, { exited: true, exitCode: r.exitCode });
    launches.set(entry.id, entry);
    sendJson(res, 200, { id: entry.id, command, ...r });
    return;
  }
  sendJson(res, 200, await runCommand(command, { cwd: root, timeoutMs: 60_000, ...(body.stdin !== undefined ? { stdin: body.stdin } : {}) }));
}

/** Applications lancées depuis le panneau Exécution : suivies jusqu'à leur fermeture. */
interface Launch {
  id: string;
  root: string;
  command: string;
  pid?: number;
  logPath: string;
  exited: boolean;
  exitCode: number | null;
}
const launches = new Map<string, Launch>();

function readLog(path: string): string {
  try {
    const out = readFileSync(path, "utf8");
    return out.length > 12_000 ? `[…début tronqué…]\n${out.slice(-12_000)}` : out;
  } catch {
    return "";
  }
}

function handleWorkspaceLaunches(req: IncomingMessage, res: ServerResponse): void {
  const root = runRoot(query(req).get("root"));
  const list = [...launches.values()]
    .filter((l) => l.root === root)
    .map((l) => ({ id: l.id, command: l.command, running: !l.exited, exitCode: l.exitCode, output: readLog(l.logPath) }));
  sendJson(res, 200, { launches: list });
}

async function handleWorkspaceStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { id = "" } = (await readBody(req)) as { id?: string };
  const l = launches.get(id);
  if (l?.pid !== undefined && !l.exited) {
    try {
      process.kill(-l.pid, "SIGTERM"); // tout le groupe (l'app et ses enfants)
    } catch {
      /* déjà terminée */
    }
  }
  sendJson(res, l !== undefined ? 200 : 404, { found: l !== undefined });
}

// ── Aperçu : fichiers d'un run servis à une iframe isolée (sandbox) ─────────

const PREVIEW_TYPES: Record<string, string> = {
  ...CONTENT_TYPES,
  ".htm": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Injecté en tête des pages : remonte les erreurs JavaScript à Relay (postMessage). */
const PREVIEW_REPORTER = `<script>(function(){function s(m){try{parent.postMessage({relayPreview:true,message:String(m)},"*")}catch(e){}}
addEventListener("error",function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href)){s("Ressource introuvable : "+(t.src||t.href).split("/").pop());return}
s((e.message||"Erreur")+(e.filename?" ("+e.filename.split("/").pop()+":"+e.lineno+")":""))},true);
addEventListener("unhandledrejection",function(e){s("Promesse rejetée : "+(e.reason&&e.reason.message||e.reason))});
var ce=console.error;console.error=function(){s([].slice.call(arguments).join(" "));return ce.apply(console,arguments)}})();</script>`;

/** `/ws/<dossier du projet en base64url>/<chemin>` : tout projet connu, où qu'il soit. */
function serveWorkspaceFile(url: string, res: ServerResponse): void {
  const [, , id = "", ...rest] = url.split("/").map((p) => decodeURIComponent(p));
  const ws = new Workspace(runRoot(Buffer.from(id, "base64url").toString("utf8")));
  let file = ws.resolve(rest.join("/") || "index.html");
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("fichier introuvable");
    return;
  }
  const type = PREVIEW_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  let body: Buffer | string = readFileSync(file);
  if (type.startsWith("text/html")) {
    const html = body.toString("utf8");
    const at = /<head[^>]*>/i.exec(html);
    body = at !== null ? html.slice(0, at.index + at[0].length) + PREVIEW_REPORTER + html.slice(at.index + at[0].length) : PREVIEW_REPORTER + html;
  }
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}

async function handleWorkspaceOpen(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { root?: string; target?: string; path?: string };
  const root = runRoot(body.root);
  // Un fichier précis (ex. page HTML → navigateur), confiné au dossier du run.
  const target = typeof body.path === "string" && body.path.length > 0 ? new Workspace(root).resolve(body.path) : root;
  await openDir(target, body.target === "vscode" ? "vscode" : "folder");
  sendJson(res, 200, { ok: true });
}

// ── Terminal intégré (phase G) ──────────────────────────────────────────────

async function handleTerminal(url: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (url === "/api/terminal/stream" && req.method === "GET") return streamTerminal(query(req).get("id"), res);
  if (url === "/api/terminal/list" && req.method === "GET") return sendJson(res, 200, { terminals: listTerminals(runRoot(query(req).get("root"))) });
  const body = (await readBody(req)) as Record<string, unknown>;
  switch (url) {
    case "/api/terminal/open": {
      const s = openTerminal(runRoot(body["root"]), Number(body["cols"]) || 100, Number(body["rows"]) || 30);
      return sendJson(res, 200, { id: s.id });
    }
    case "/api/terminal/input":
      writeTerminal(body["id"], body["data"]);
      return sendJson(res, 200, { ok: true });
    case "/api/terminal/resize":
      resizeTerminal(body["id"], body["cols"], body["rows"]);
      return sendJson(res, 200, { ok: true });
    case "/api/terminal/close":
      closeTerminal(body["id"]);
      return sendJson(res, 200, { ok: true });
    default:
      return sendJson(res, 404, { error: "inconnu" });
  }
}

// ── Ollama (phase F) ────────────────────────────────────────────────────────

/** Adresse de l'Ollama utilisé : local, ou VPS via le tunnel SSH s'il est ouvert. */
function ollamaUrl(): string {
  return loadSettings().ollamaTarget === "remote" && tunnelState().running ? TUNNEL_URL : LOCAL_URL;
}

/** Les providers lisent OLLAMA_BASE_URL : on la met à jour et on oublie la liste de modèles en cache. */
function applyOllamaUrl(): void {
  process.env["OLLAMA_BASE_URL"] = `${ollamaUrl()}/v1`;
  modelCache.delete("ollama");
}

async function handleOllamaStatus(res: ServerResponse): Promise<void> {
  const settings = loadSettings();
  const machine = machineInfo();
  const [local, remote] = await Promise.all([
    ollamaStatus(LOCAL_URL),
    settings.ollamaTarget === "remote" && tunnelState().running ? ollamaStatus(TUNNEL_URL) : Promise.resolve(null),
  ]);
  sendJson(res, 200, {
    machine,
    verdict: machineVerdict(machine),
    local,
    remote,
    target: settings.ollamaTarget,
    remoteTarget: settings.ollamaRemote,
    tunnel: tunnelState(),
    url: ollamaUrl(),
    suggestions: SUGGESTED_MODELS.map((m) => ({ ...m, fit: modelFit(m.sizeGb, machine) })),
  });
}

/** Réponse en flux (SSE) pour les opérations longues : installation, téléchargement de modèle. */
async function streamTask(
  res: ServerResponse,
  req: IncomingMessage,
  task: (send: (event: Record<string, unknown>) => void, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const send = (event: Record<string, unknown>): void => sseWrite(res, event);
  try {
    const result = await task(send, abort.signal);
    send({ type: "done", ...(result !== undefined ? { result } : {}) });
  } catch (err) {
    send({ type: "error", error: describeError(err) });
  } finally {
    applyOllamaUrl();
    res.end();
  }
  void req;
}

async function handleOllama(url: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = req.method === "POST" ? ((await readBody(req)) as Record<string, unknown>) : {};
  const model = typeof body["model"] === "string" ? body["model"].trim() : "";
  const MODEL_RE = /^[A-Za-z0-9._\/:-]{1,120}$/;

  switch (url) {
    case "/api/ollama/status":
      return handleOllamaStatus(res);
    case "/api/ollama/install":
      return streamTask(res, req, (send, signal) =>
        installManaged((p) => send({ type: "progress", ...p }), signal).then((version) => ({ version })),
      );
    case "/api/ollama/start":
      await startOllama();
      applyOllamaUrl();
      return sendJson(res, 200, { ok: true });
    case "/api/ollama/stop":
      return sendJson(res, 200, { stopped: stopOllama() });
    case "/api/ollama/pull":
      if (!MODEL_RE.test(model)) return sendJson(res, 400, { error: "nom de modèle invalide" });
      return streamTask(res, req, (send, signal) => pullModel(ollamaUrl(), model, (p) => send({ type: "progress", ...p }), signal));
    case "/api/ollama/delete":
      if (!MODEL_RE.test(model)) return sendJson(res, 400, { error: "nom de modèle invalide" });
      await deleteModel(ollamaUrl(), model);
      applyOllamaUrl();
      return sendJson(res, 200, { ok: true });
    case "/api/ollama/test":
      if (!MODEL_RE.test(model)) return sendJson(res, 400, { error: "nom de modèle invalide" });
      return sendJson(res, 200, await testModel(ollamaUrl(), model));
    case "/api/ollama/remote/key":
      return sendJson(res, 200, ensureKey());
    case "/api/ollama/remote/check": {
      const t = checkRemote(body as Partial<RemoteTarget>);
      const lines: string[] = [];
      const code = await sshRun(t, REMOTE_SPECS, (l) => lines.push(l), 30_000);
      saveSettings({ ...loadSettings(), ollamaRemote: t });
      return sendJson(res, 200, { ok: code === 0, lines });
    }
    case "/api/ollama/remote/install": {
      const t = checkRemote(body as Partial<RemoteTarget>);
      return streamTask(res, req, async (send) => {
        const code = await sshRun(t, REMOTE_INSTALL, (line) => send({ type: "log", line }));
        if (code !== 0) {
          throw new Error(
            "l'installation sur le VPS a échoué (voir les lignes ci-dessus). Si « sudo » demande un mot de passe, lance la commande officielle à la main sur le VPS : curl -fsSL https://ollama.com/install.sh | sh",
          );
        }
      });
    }
    case "/api/ollama/remote/connect": {
      const t = checkRemote(body as Partial<RemoteTarget>);
      await openTunnel(t);
      saveSettings({ ...loadSettings(), ollamaTarget: "remote", ollamaRemote: t });
      applyOllamaUrl();
      return sendJson(res, 200, { ok: true, url: ollamaUrl() });
    }
    case "/api/ollama/remote/disconnect":
      closeTunnel();
      saveSettings({ ...loadSettings(), ollamaTarget: "local" });
      applyOllamaUrl();
      return sendJson(res, 200, { ok: true });
    default:
      return sendJson(res, 404, { error: "inconnu" });
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

  if (url.startsWith("/api/") && !trustedRequest(req)) {
    sendJson(res, 403, { error: "requête refusée : origine non autorisée" });
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
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
      if (url === "/api/run/skip" && req.method === "POST") return await handleRunSkip(res);
      if (url === "/api/approve" && req.method === "POST") return await handleApprove(req, res);
      if (url === "/api/workspace/runs" && req.method === "GET") return handleWorkspaceRuns(res);
      if (url.startsWith("/api/ollama/")) return await handleOllama(url, req, res);
      if (url.startsWith("/api/terminal/")) return await handleTerminal(url, req, res);
      if (url === "/api/projects" && req.method === "GET") return handleProjects(res);
      if (url === "/api/projects/detail" && req.method === "GET") return handleProjectDetail(req, res);
      if (url === "/api/projects/memory" && req.method === "PUT") return await handleProjectMemory(req, res);
      if (url === "/api/projects/import" && req.method === "POST") return await handleProjectImport(req, res);
      if (url === "/api/workspace/files" && req.method === "GET") return handleWorkspaceFiles(req, res);
      if (url === "/api/workspace/file" && req.method === "GET") return handleWorkspaceFile(req, res);
      if (url === "/api/workspace/run" && req.method === "POST") return await handleWorkspaceRun(req, res);
      if (url === "/api/workspace/open" && req.method === "POST") return await handleWorkspaceOpen(req, res);
      if (url === "/api/workspace/launches" && req.method === "GET") return handleWorkspaceLaunches(req, res);
      if (url === "/api/workspace/stop" && req.method === "POST") return await handleWorkspaceStop(req, res);
      if (url.startsWith("/ws/") && req.method === "GET") return serveWorkspaceFile(url, res);
      return serveStatic(req, res);
    } catch (err) {
      // Erreurs des endpoints de l'espace de travail : 400 lisible (chemin refusé, fichier introuvable…).
      const status =
        url.startsWith("/api/workspace/") || url.startsWith("/api/projects") || url.startsWith("/api/ollama/") || url.startsWith("/api/terminal/") || url.startsWith("/ws/")
          ? 400
          : 500;
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
  applyOllamaUrl();
  // Ollama sur VPS : on rouvre le tunnel en arrière-plan (sans bloquer le démarrage).
  const boot = loadSettings();
  if (boot.ollamaTarget === "remote" && boot.ollamaRemote !== null) {
    try {
      const t = checkRemote(boot.ollamaRemote);
      void openTunnel(t).then(applyOllamaUrl, () => undefined);
    } catch {
      /* VPS incomplet : réglages à revoir */
    }
  }
  // Uniquement sur cette machine (127.0.0.1 et ::1) : rien n'est joignable depuis le réseau local,
  // même sur un Wi-Fi public — l'API peut lancer des commandes et ouvrir un terminal.
  const server = createServer(handler);
  const server6 = createServer(handler);
  const port = options.port ?? PORT;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
      // « localhost » peut désigner ::1 : même port en IPv6 local (ignoré si IPv6 est absent).
      server6.once("error", () => undefined);
      server6.listen(actualPort, "::1");
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((res) => {
            shutdownOllama(); // ni tunnel ni serveur Ollama laissés derrière soi
            shutdownTerminals();
            server6.close();
            server.close(() => res());
          }),
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

process.on("exit", () => {
  shutdownOllama();
  shutdownTerminals();
});

process.on("uncaughtException", (err) => {
  console.error(`[relay] exception non gérée : ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});

// Auto-démarrage seulement si exécuté directement (pas lors d'un import depuis Electron).
const entry = process.argv[1] !== undefined ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) runCli();
