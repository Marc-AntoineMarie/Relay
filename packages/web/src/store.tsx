/**
 * État partagé de l'application, exposé aux panneaux via un contexte React
 * (les panneaux sont rendus par dockview, chacun dans son propre conteneur).
 *
 * Les réglages (mode, stratégie, plafonds, budget, synthèse) vivent côté moteur
 * (`.relay/settings.json`) ; le navigateur ne garde que des conforts (disposition,
 * dernier compte manuel, modèles manuels).
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  answerApproval,
  deleteKey,
  getModels,
  getPool,
  getSettings,
  getState,
  launchInWorkspace,
  listFiles,
  listRuns,
  openWorkspace,
  runInWorkspace,
  runPipeline,
  saveSettings,
  setKey,
  testKey,
  type RunBody,
} from "./api";
import {
  TIERS,
  type AccountPolicy,
  type ApprovalRequest,
  type CommandView,
  type RunDir,
  type WorkspaceFile,
  type AppState,
  type ErrorDescription,
  type KeyTestResult,
  type LogEntry,
  type Mode,
  type Phase,
  type PipelineMetrics,
  type PoolResponse,
  type ProviderReadiness,
  type Settings,
  type Strategy,
  type Synthesis,
  type TaskView,
  type TierModels,
} from "./types";

/** Taille max du journal gardé en mémoire (les runs très longs restent fluides). */
const MAX_LOGS = 3000;

// Conforts locaux (disposition, compte et modèles du mode manuel).
export const load = <T,>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
};
export const save = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage indisponible : sans conséquence */
  }
};

export const BILLING: Record<ProviderReadiness["billing"], string> = {
  free: "gratuit",
  subscription: "abonnement",
  "per-token": "à l'usage",
};

/** Compte du mode manuel : le dernier utilisé, sinon un compte gratuit prêt. */
function pickProvider(providers: ProviderReadiness[], fallback: string): string {
  const last = load<string>("relay.provider");
  if (last !== null && providers.some((p) => p.name === last)) return last;
  const free = providers.find((p) => p.ready && p.billing === "free" && p.name !== "ollama");
  return free?.name ?? providers.find((p) => p.ready && p.name === fallback)?.name ?? fallback;
}

interface Catalog {
  loading: boolean;
  models: string[];
  suggested: TierModels | null;
  error?: ErrorDescription;
}

export type SettingsSection = "accounts" | "models" | "routing" | "general";

const DEFAULT_SETTINGS: Settings = {
  mode: "auto",
  strategy: "balanced",
  policies: {},
  budgetPerRun: null,
  synthesis: true,
  agentic: true,
  workspaceRoot: "",
  commandPolicy: "safe",
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function useRelayState() {
  const [state, setState] = useState<AppState | null>(null);
  const [serverDown, setServerDown] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [provider, setProvider] = useState("");
  const [catalog, setCatalog] = useState<Catalog>({ loading: false, models: [], suggested: null });
  const [tiers, setTiers] = useState<TierModels | null>(null);
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [views, setViews] = useState<TaskView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<PipelineMetrics | null>(null);
  const [synthesis, setSynthesis] = useState<Synthesis | null>(null);
  const [error, setError] = useState<ErrorDescription | null>(null);
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  const [keyTests, setKeyTests] = useState<Record<string, KeyTestResult | "pending">>({});
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [pool, setPool] = useState<PoolResponse | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [runInfo, setRunInfo] = useState<{ mode: Mode; accounts: string[]; strategy?: Strategy } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null);
  // Phase D : dossier de travail du run, fichiers, commandes, validations.
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [lastWrite, setLastWrite] = useState<{ path: string; at: number } | null>(null);
  const [commands, setCommands] = useState<CommandView[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [runs, setRuns] = useState<RunDir[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const userSeq = useRef(0);

  const busy = phase === "planning" || phase === "running";
  const selected = useMemo(() => state?.providers.find((p) => p.name === provider), [state, provider]);
  const cfg = settings ?? DEFAULT_SETTINGS;

  // État du moteur (avec reconnexion automatique), puis réglages.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const loadState = (): void => {
      getState()
        .then(async (s) => {
          if (cancelled) return;
          setState(s);
          setServerDown(false);
          setProvider((p) => p || pickProvider(s.providers, s.defaultProvider));
          const loaded = await getSettings();
          if (!cancelled && loaded !== null) setSettings(loaded);
          // Au démarrage, les Fichiers montrent le dernier run.
          const previous = await listRuns().catch(() => null);
          if (!cancelled && previous !== null) {
            setRuns(previous.runs);
            const last = previous.runs[0];
            if (last !== undefined) {
              setWorkspace((w) => w ?? last.root);
              void listFiles(last.root).then((r) => !cancelled && setFiles((f) => (f.length === 0 ? r.files : f)), () => undefined);
            }
          }
        })
        .catch(() => {
          if (cancelled) return;
          setServerDown(true);
          timer = window.setTimeout(loadState, 2000);
        });
    };
    loadState();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  // Mode manuel : modèles du compte choisi + modèles par niveau (mémorisés ou recommandés).
  useEffect(() => {
    if (!provider || selected?.ready !== true) {
      setCatalog({ loading: false, models: [], suggested: selected?.tierModels ?? null });
      setTiers(selected?.tierModels ?? null);
      return;
    }
    let cancelled = false;
    setCatalog((c) => ({ ...c, loading: true }));
    void getModels(provider).then((res) => {
      if (cancelled) return;
      setCatalog({ loading: false, models: res.models, suggested: res.suggested, ...(res.error ? { error: res.error } : {}) });
      const saved = load<TierModels>(`relay.tiers.${provider}`);
      const valid =
        saved !== null && TIERS.every((t) => saved[t] && (res.models.length === 0 || res.models.includes(saved[t])));
      setTiers(valid ? saved : res.suggested);
    });
    return () => {
      cancelled = true;
    };
  }, [provider, selected?.ready, selected?.tierModels]);

  // Pool du mode auto : rechargé quand les comptes ou leurs réglages changent.
  const policiesKey = JSON.stringify(settings?.policies ?? {});
  useEffect(() => {
    if (state === null) return;
    let cancelled = false;
    void getPool().then((p) => {
      if (!cancelled && p !== null) setPool(p);
    });
    return () => {
      cancelled = true;
    };
  }, [state, policiesKey]);

  // Chrono pendant l'exécution : montre que ça tourne.
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [busy]);

  // ── Réglages ──────────────────────────────────────────────────────────────
  function updateSettings(patch: Partial<Settings>): void {
    setSettings((s) => ({ ...(s ?? DEFAULT_SETTINGS), ...patch }));
    void saveSettings(patch).then((saved) => {
      if (saved !== null) setSettings(saved);
    });
  }

  const policyOf = (name: string): AccountPolicy => cfg.policies[name] ?? { enabled: true };
  const setPolicy = (name: string, next: AccountPolicy): void =>
    updateSettings({ policies: { ...cfg.policies, [name]: next } });

  /** Ajoute / retire un modèle du pool auto d'un compte. */
  function setModelInPool(account: string, model: string, recommended: boolean, inPool: boolean): void {
    const p = policyOf(account);
    const without = (xs: string[] | undefined): string[] => (xs ?? []).filter((m) => m !== model);
    setPolicy(
      account,
      recommended
        ? { ...p, disabledModels: inPool ? without(p.disabledModels) : [...without(p.disabledModels), model] }
        : { ...p, extraModels: inPool ? [...without(p.extraModels), model] : without(p.extraModels) },
    );
  }

  const usableAccounts = pool?.accounts.filter((a) => a.models.length > 0 && policyOf(a.name).enabled) ?? [];

  // ── Comptes et clés ───────────────────────────────────────────────────────
  function chooseProvider(name: string): void {
    if (busy) return;
    setProvider(name);
    save("relay.provider", name);
  }

  function changeTiers(next: TierModels): void {
    setTiers(next);
    save(`relay.tiers.${provider}`, next);
  }

  function resetTiers(): void {
    if (catalog.suggested !== null) changeTiers(catalog.suggested);
    setError(null);
  }

  async function saveKey(name: string): Promise<void> {
    const value = (keyDraft[name] ?? "").trim();
    if (!value) return;
    try {
      const providers = await setKey(name, value);
      setState((s) => (s ? { ...s, providers } : s));
      setKeyDraft((d) => ({ ...d, [name]: "" }));
      setKeyTests((t) => ({ ...t, [name]: "pending" }));
      const result = await testKey(name);
      setKeyTests((t) => ({ ...t, [name]: result }));
    } catch (e: unknown) {
      setError({ kind: "config", title: "Clé non enregistrée", detail: e instanceof Error ? e.message : String(e) });
    }
  }

  async function checkKey(name: string): Promise<void> {
    const draft = (keyDraft[name] ?? "").trim();
    setKeyTests((t) => ({ ...t, [name]: "pending" }));
    const result = await testKey(name, draft || undefined);
    setKeyTests((t) => ({ ...t, [name]: result }));
  }

  async function removeKey(name: string): Promise<void> {
    try {
      const providers = await deleteKey(name);
      setState((s) => (s ? { ...s, providers } : s));
      setKeyTests((t) => {
        const { [name]: _drop, ...rest } = t;
        return rest;
      });
    } catch (e: unknown) {
      setError({ kind: "config", title: "Suppression impossible", detail: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── Dossier de travail ────────────────────────────────────────────────────
  async function refreshFiles(root = workspace): Promise<void> {
    if (root === null) return;
    try {
      setFiles((await listFiles(root)).files);
    } catch (e: unknown) {
      setError({ kind: "config", title: "Dossier illisible", detail: errorText(e) });
    }
  }

  async function refreshRuns(): Promise<void> {
    try {
      setRuns((await listRuns()).runs);
    } catch {
      /* moteur injoignable : la liste reste vide */
    }
  }

  /** Rouvre le dossier d'un run précédent. */
  function selectWorkspace(root: string): void {
    if (busy) return;
    setWorkspace(root);
    setCommands([]);
    void refreshFiles(root);
  }

  const upsertCommand = (id: string, update: Partial<CommandView> & Pick<CommandView, "command" | "by">): void =>
    setCommands((cs) =>
      cs.some((c) => c.id === id)
        ? cs.map((c) => (c.id === id ? { ...c, ...update } : c))
        : [...cs, { id, running: false, ...update }],
    );

  /** Commande lancée par toi depuis le panneau Exécution (attend la fin, sortie capturée). */
  async function runUserCommand(command: string, stdin?: string): Promise<void> {
    if (workspace === null || command.trim().length === 0) return;
    const id = `toi-${++userSeq.current}`;
    upsertCommand(id, { command, by: "toi", running: true });
    try {
      const r = await runInWorkspace(workspace, command, stdin);
      upsertCommand(id, { command, by: "toi", running: false, exitCode: r.exitCode, output: r.output, durationMs: r.durationMs, timedOut: r.timedOut });
      void refreshFiles();
    } catch (e: unknown) {
      upsertCommand(id, { command, by: "toi", running: false, exitCode: null, refused: errorText(e) });
    }
  }

  /** Lance sans attendre (application graphique) : la fenêtre s'ouvre à côté. */
  async function launchUserCommand(command: string): Promise<void> {
    if (workspace === null || command.trim().length === 0) return;
    const id = `toi-${++userSeq.current}`;
    try {
      await launchInWorkspace(workspace, command);
      upsertCommand(id, { command, by: "toi", running: false, launched: true });
    } catch (e: unknown) {
      upsertCommand(id, { command, by: "toi", running: false, exitCode: null, refused: errorText(e) });
    }
  }

  async function openIn(target: "folder" | "vscode"): Promise<void> {
    if (workspace === null) return;
    try {
      await openWorkspace(workspace, target);
    } catch (e: unknown) {
      setError({ kind: "config", title: "Ouverture impossible", detail: errorText(e) });
    }
  }

  function approve(key: string, ok: boolean): void {
    setApprovals((as) => as.filter((a) => a.key !== key));
    void answerApproval(key, ok).catch(() => undefined);
  }

  // ── Exécution ─────────────────────────────────────────────────────────────
  const patch = (id: string, update: (v: TaskView) => Partial<TaskView>): void =>
    setViews((vs) => vs.map((v) => (v.task.id === id ? { ...v, ...update(v) } : v)));

  const pushLog = (entry: LogEntry): void =>
    setLogs((ls) => (ls.length >= MAX_LOGS ? [...ls.slice(-MAX_LOGS + 1), entry] : [...ls, entry]));

  async function run(): Promise<void> {
    let body: RunBody;
    if (cfg.mode === "auto") {
      body = { mode: "auto", prompt, strategy: cfg.strategy, policies: cfg.policies };
    } else {
      if (tiers === null) return;
      body = { mode: "manual", prompt, provider, models: tiers };
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase("planning");
    setError(null);
    setMetrics(null);
    setSynthesis(null);
    setViews([]);
    setLogs([]);
    setRunInfo(null);
    setSelectedId(null);
    setStartedAt(Date.now());
    setWorkspace(null);
    setFiles([]);
    setCommands([]);
    setApprovals([]);
    let runRoot: string | null = null;

    try {
      for await (const ev of runPipeline(body, ac.signal)) {
        switch (ev.type) {
          case "mode":
            setRunInfo({ mode: ev.mode, accounts: ev.accounts, ...(ev.strategy ? { strategy: ev.strategy } : {}) });
            break;
          case "log":
            pushLog(ev.entry);
            break;
          case "pipeline:plan":
            setPhase("running");
            setViews(ev.tasks.map((task) => ({ task, status: "pending", output: "" })));
            break;
          case "task:route":
            patch(ev.taskId, () => ({ provider: ev.provider, model: ev.model, reason: ev.reason, alternatives: ev.alternatives }));
            break;
          case "task:start":
            patch(ev.taskId, () => ({
              status: "running",
              model: ev.model,
              ...(ev.provider ? { provider: ev.provider } : {}),
              ...(ev.reason ? { reason: ev.reason } : {}),
            }));
            setSelectedId(ev.taskId);
            break;
          case "task:chunk":
            patch(ev.taskId, (v) => ({ output: v.output + ev.text }));
            break;
          case "task:done":
            patch(ev.taskId, (v) => ({
              status: "done",
              summary: ev.result.summary,
              output: ev.result.data?.result ?? v.output,
              metrics: ev.metrics,
              model: ev.metrics.model,
              provider: ev.metrics.provider,
              ...(ev.metrics.fallbackFrom !== undefined ? { fallbackFrom: ev.metrics.fallbackFrom } : {}),
              ...(ev.result.data?.truncated === true ? { truncated: true } : {}),
              ...(ev.result.data?.files !== undefined ? { files: ev.result.data.files } : {}),
              ...(ev.result.data?.commands !== undefined ? { commands: ev.result.data.commands } : {}),
              ...(ev.result.data?.checksFailed === true ? { checksFailed: true } : {}),
            }));
            break;
          case "task:failed":
            patch(ev.taskId, () => ({ status: "failed", error: ev.error }));
            setSelectedId(ev.taskId);
            break;
          case "task:escalate":
            patch(ev.taskId, () => ({ escalatedFrom: ev.from.model }));
            break;
          case "workspace":
            runRoot = ev.root;
            setWorkspace(ev.root);
            break;
          case "file:write":
            setFiles((fs) =>
              [...fs.filter((f) => f.path !== ev.path), { path: ev.path, size: ev.bytes }].sort((a, b) => a.path.localeCompare(b.path)),
            );
            setLastWrite({ path: ev.path, at: Date.now() });
            break;
          case "command:start":
            upsertCommand(ev.id, { taskId: ev.taskId, command: ev.command, by: "agent", running: true });
            break;
          case "command:done":
            upsertCommand(ev.id, {
              taskId: ev.taskId,
              command: ev.command,
              by: "agent",
              running: false,
              exitCode: ev.exitCode,
              output: ev.output,
              durationMs: ev.durationMs,
              timedOut: ev.timedOut,
              ...(ev.refused !== undefined ? { refused: ev.refused } : {}),
            });
            break;
          case "approval:request":
            setApprovals((as) => [...as, { key: ev.key, taskId: ev.taskId, command: ev.command }]);
            break;
          case "approval:done":
            setApprovals((as) => as.filter((a) => a.key !== ev.key));
            break;
          case "pipeline:synthesis":
            setSynthesis({ text: ev.text, provider: ev.provider, model: ev.model, metrics: ev.metrics });
            break;
          case "pipeline:done":
            setMetrics(ev.metrics);
            setPhase("done");
            break;
          case "pipeline:failed":
            setError(ev.description ?? { kind: "unknown", title: "Pipeline interrompu", detail: ev.error });
            setPhase("failed");
            break;
          case "error":
            setError(ev.error);
            setPhase("failed");
            break;
          default:
            break;
        }
      }
    } catch (e: unknown) {
      if (ac.signal.aborted) {
        setPhase("stopped");
      } else {
        setError({
          kind: "network",
          title: "Connexion au moteur perdue",
          detail: e instanceof Error ? e.message : String(e),
          hint: "Relance l'application si le problème persiste.",
        });
        setPhase("failed");
      }
    } finally {
      abortRef.current = null;
      setApprovals([]);
      void refreshRuns();
      if (runRoot !== null) void refreshFiles(runRoot); // fichiers créés par les commandes aussi
      setNow(Date.now()); // fige le chrono sur la durée réelle
      setPhase((p) => (p === "planning" || p === "running" ? "done" : p));
    }
  }

  const tiersComplete = tiers !== null && TIERS.every((t) => tiers[t].trim().length > 0);

  return {
    state,
    serverDown,
    settings: cfg,
    settingsLoaded: settings !== null,
    updateSettings,
    mode: cfg.mode,
    setMode: (mode: Mode) => !busy && updateSettings({ mode }),
    strategy: cfg.strategy,
    setStrategy: (strategy: Strategy) => updateSettings({ strategy }),
    policyOf,
    setPolicy,
    setModelInPool,
    pool,
    usableAccounts,
    provider,
    selected,
    catalog,
    tiers,
    tiersComplete,
    prompt,
    setPrompt,
    phase,
    busy,
    views,
    selectedId,
    setSelectedId,
    selectedView: views.find((v) => v.task.id === selectedId) ?? views.find((v) => v.status === "running"),
    metrics,
    synthesis,
    error,
    setError,
    keyDraft,
    setKeyDraft,
    keyTests,
    elapsed: startedAt !== null ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0,
    doneCount: views.filter((v) => v.status === "done").length,
    canRun:
      !busy &&
      prompt.trim().length > 0 &&
      (cfg.mode === "auto" ? usableAccounts.length > 0 : selected?.ready === true && tiersComplete),
    isRecommended:
      tiers !== null && catalog.suggested !== null && TIERS.every((t) => tiers[t] === catalog.suggested?.[t]),
    logs,
    runInfo,
    settingsOpen,
    openSettings: (section: SettingsSection = "accounts") => setSettingsOpen(section),
    closeSettings: () => setSettingsOpen(null),
    chooseProvider,
    changeTiers,
    resetTiers,
    saveKey,
    checkKey,
    removeKey,
    run,
    stop: () => abortRef.current?.abort(),
    workspace,
    files,
    lastWrite,
    commands,
    approvals,
    runs,
    refreshFiles: () => void refreshFiles(),
    refreshRuns: () => void refreshRuns(),
    selectWorkspace,
    runUserCommand,
    launchUserCommand,
    clearCommands: () => setCommands([]),
    openIn,
    approve,
  };
}

export type Relay = ReturnType<typeof useRelayState>;

const RelayContext = createContext<Relay | null>(null);

export function RelayProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const relay = useRelayState();
  return <RelayContext.Provider value={relay}>{children}</RelayContext.Provider>;
}

export function useRelay(): Relay {
  const relay = useContext(RelayContext);
  if (relay === null) throw new Error("useRelay doit être utilisé dans <RelayProvider>");
  return relay;
}
