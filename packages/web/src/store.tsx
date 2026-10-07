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
  getLaunches,
  getProject,
  getProjects,
  getState,
  importProject,
  launchInWorkspace,
  listFiles,
  openWorkspace,
  runInWorkspace,
  runPipeline,
  saveProjectMemory,
  saveSettings,
  setKey,
  stopLaunch,
  testKey,
  type RunBody,
} from "./api";
import {
  TIERS,
  type AccountPolicy,
  type ApprovalRequest,
  type CommandView,
  type ConversationMessage,
  type FixRequest,
  type ProjectInfo,
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
  askQuestions: true,
  globalMemory: "",
  projectMemory: true,
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Tâches du tour en cours (sans les nœuds d'erreur ni les tours précédents). */
const roundViews = (vs: TaskView[], round: number): TaskView[] =>
  vs.filter((v) => v.userError === undefined && (round < 2 || v.task.id.startsWith(`${round}.`)));

/** Tâches dont rien ne dépend : la « fin » actuelle du graphe. */
const sinks = (vs: TaskView[]): string[] => {
  const used = new Set(vs.flatMap((v) => v.task.dependsOn));
  return vs.filter((v) => !used.has(v.task.id)).map((v) => v.task.id);
};

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
  // Phase E : projets (historique), conversation et mémoire du projet ouvert.
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [memory, setMemory] = useState("");
  // Nouveau projet : nom (proposé d'après la demande tant qu'il n'est pas modifié) et emplacement.
  const [draft, setDraft] = useState<{ name: string; edited: boolean; location: string }>({ name: "", edited: false, location: "" });
  const abortRef = useRef<AbortController | null>(null);
  const userSeq = useRef(0);
  const [round, setRound] = useState(1);
  // Aperçu d'une page du dossier (iframe isolée) ; `nonce` force le rechargement.
  const [preview, setPreview] = useState<{ path: string; nonce: number } | null>(null);
  const [previewTick, setPreviewTick] = useState(0);
  // Erreurs rencontrées en testant, remontées dans le graphe (une seule fois par source).
  const [errorTick, setErrorTick] = useState(0);
  const errSeq = useRef(0);
  const raised = useRef(new Set<string>());

  const busy = phase === "planning" || phase === "running";
  const viewsRef = useRef(views);
  viewsRef.current = views;
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
          // Au démarrage : l'historique des projets, et le dernier projet rouvert.
          const list = await getProjects().catch(() => null);
          if (!cancelled && list !== null) {
            setProjects(list.projects);
            const last = list.projects[0];
            if (last !== undefined) {
              const d = await getProject(last.root).catch(() => null);
              if (!cancelled && d !== null) {
                setWorkspace((w) => w ?? d.root);
                setProjectName((n) => n ?? d.name);
                setMessages((m) => (m.length === 0 ? d.messages : m));
                setMemory(d.memory);
                void listFiles(d.root).then((r) => !cancelled && setFiles((f) => (f.length === 0 ? r.files : f)), () => undefined);
              }
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

  async function refreshProjects(): Promise<void> {
    try {
      setProjects((await getProjects()).projects);
    } catch {
      /* moteur injoignable : la liste reste telle quelle */
    }
  }

  /** Vue du run (graphe, journal, commandes…) remise à zéro : changement de projet. */
  function resetRunView(): void {
    setViews([]);
    setLogs([]);
    setSelectedId(null);
    setCommands([]);
    setPreview(null);
    setSynthesis(null);
    setMetrics(null);
    setError(null);
    setPhase("idle");
    setStartedAt(null);
    raised.current.clear();
  }

  /** Rouvre un projet de l'historique : sa conversation, sa mémoire, ses fichiers. */
  async function loadProject(root: string): Promise<void> {
    if (busy) return;
    try {
      const d = await getProject(root);
      resetRunView();
      setWorkspace(d.root);
      setProjectName(d.name);
      setMessages(d.messages);
      setMemory(d.memory);
      setRound(1);
      void refreshFiles(d.root);
    } catch (e: unknown) {
      setError({ kind: "config", title: "Projet illisible", detail: errorText(e) });
    }
  }

  /** Recharge conversation et mémoire (fin de run) sans toucher à la vue du run. */
  async function reloadProject(root: string): Promise<void> {
    const d = await getProject(root).catch(() => null);
    if (d === null) return;
    setMessages(d.messages);
    setMemory(d.memory);
  }

  function newProject(): void {
    if (busy) return;
    resetRunView();
    setWorkspace(null);
    setProjectName(null);
    setMessages([]);
    setMemory("");
    setFiles([]);
    setDraft({ name: "", edited: false, location: "" });
  }

  async function importFolder(path: string): Promise<void> {
    try {
      const p = await importProject(path);
      await refreshProjects();
      await loadProject(p.root);
    } catch (e: unknown) {
      setError({ kind: "config", title: "Import impossible", detail: errorText(e) });
    }
  }

  async function saveMemory(text: string): Promise<void> {
    if (workspace === null) return;
    try {
      await saveProjectMemory(workspace, text);
      setMemory(text);
    } catch (e: unknown) {
      setError({ kind: "config", title: "Mémoire non enregistrée", detail: errorText(e) });
    }
  }

  const upsertCommand = (id: string, update: Partial<CommandView> & Pick<CommandView, "command" | "by">): void =>
    setCommands((cs) =>
      cs.some((c) => c.id === id)
        ? cs.map((c) => (c.id === id ? { ...c, ...update } : c))
        : [...cs, { id, running: false, ...update }],
    );

  /** Erreur rencontrée en testant : nœud rouge dans le graphe + journal, prêt à « Corriger avec Relay ». */
  function raiseError(err: FixRequest, key: string): void {
    if (raised.current.has(key)) return;
    raised.current.add(key);
    const id = `err${++errSeq.current}`;
    setViews((vs) => [
      ...vs,
      {
        task: { id, type: "erreur", tier: "quick", description: `Erreur en testant ${err.source}`, dependsOn: sinks(vs) },
        status: "failed",
        output: err.output,
        provider: "toi",
        model: "test",
        error: err.output.slice(-800) || "(aucune sortie)",
        userError: err,
      },
    ]);
    pushLog({
      at: Date.now(),
      level: "error",
      category: "error",
      taskId: id,
      title: `Erreur en testant ${err.source}${err.exitCode !== undefined && err.exitCode !== null ? ` (code ${err.exitCode})` : ""}`,
      ...(err.output ? { detail: err.output } : {}),
    });
    setSelectedId(id);
    setErrorTick((t) => t + 1);
  }

  /** Relay corrige : une tâche d'agent dans le même dossier, avec l'erreur et l'historique. */
  function fixError(err: FixRequest, note?: string): void {
    if (busy || workspace === null) return;
    const trimmed = note?.trim();
    void run({ fix: { ...err, ...(trimmed ? { note: trimmed } : {}) } });
  }

  /** Commande lancée par toi depuis le panneau Exécution (attend la fin, sortie capturée). */
  async function runUserCommand(command: string, stdin?: string): Promise<void> {
    if (workspace === null || command.trim().length === 0) return;
    const id = `toi-${++userSeq.current}`;
    upsertCommand(id, { command, by: "toi", running: true });
    try {
      const r = await runInWorkspace(workspace, command, stdin);
      upsertCommand(id, { command, by: "toi", running: false, exitCode: r.exitCode, output: r.output, durationMs: r.durationMs, timedOut: r.timedOut });
      if (r.exitCode !== 0) raiseError({ source: `« ${command} »`, output: r.output, exitCode: r.exitCode }, id);
      void refreshFiles();
    } catch (e: unknown) {
      upsertCommand(id, { command, by: "toi", running: false, exitCode: null, refused: errorText(e) });
    }
  }

  /** Lance sans attendre (application graphique) : la fenêtre s'ouvre à côté. */
  async function launchUserCommand(command: string): Promise<void> {
    if (workspace === null || command.trim().length === 0) return;
    const id = `toi-${++userSeq.current}`;
    upsertCommand(id, { command, by: "toi", running: true });
    try {
      const r = await launchInWorkspace(workspace, command);
      // Arrêté pendant les premières secondes : souvent un plantage au démarrage → on montre l'erreur.
      upsertCommand(id, {
        command,
        by: "toi",
        running: !r.exited,
        launched: true,
        launchId: r.id,
        output: r.output,
        ...(r.exited ? { exitCode: r.exitCode } : {}),
      });
      if (r.exited && r.exitCode !== 0) raiseError({ source: `« ${command} »`, output: r.output, exitCode: r.exitCode }, r.id);
    } catch (e: unknown) {
      upsertCommand(id, { command, by: "toi", running: false, exitCode: null, refused: errorText(e) });
    }
  }

  async function openIn(target: "folder" | "vscode", path?: string): Promise<void> {
    if (workspace === null) return;
    try {
      await openWorkspace(workspace, target, path);
    } catch (e: unknown) {
      setError({ kind: "config", title: "Ouverture impossible", detail: errorText(e) });
    }
  }

  function stopApp(c: CommandView): void {
    if (c.launchId !== undefined) void stopLaunch(c.launchId).catch(() => undefined);
  }

  // Apps lancées : on suit leur sortie et leur fermeture ; une erreur (même après coup) remonte.
  const watching = commands.some((c) => c.launchId !== undefined && c.running);
  useEffect(() => {
    if (!watching || workspace === null) return;
    const root = workspace;
    const id = window.setInterval(() => {
      void getLaunches(root).then(({ launches }) => {
        for (const l of launches) {
          setCommands((cs) =>
            cs.map((c) => (c.launchId === l.id ? { ...c, output: l.output, running: l.running, ...(l.running ? {} : { exitCode: l.exitCode }) } : c)),
          );
          const crashed = !l.running && l.exitCode !== null && l.exitCode !== 0;
          if (crashed || /Traceback|Exception|Error:/.test(l.output)) {
            raiseError({ source: `« ${l.command} »`, output: l.output, ...(l.running ? {} : { exitCode: l.exitCode }) }, l.id);
          }
        }
      }, () => undefined);
    }, 1_500);
    return () => clearInterval(id);
  }, [watching, workspace]); // eslint-disable-line react-hooks/exhaustive-deps

  function openPreview(path: string): void {
    setPreview({ path, nonce: Date.now() });
    setPreviewTick((t) => t + 1);
  }

  // Run terminé avec une page web : l'aperçu est prêt (sans changer d'onglet).
  useEffect(() => {
    if (phase !== "done" || preview !== null) return;
    const page = files.find((f) => /\.html?$/i.test(f.path));
    if (page !== undefined) setPreview({ path: page.path, nonce: Date.now() });
  }, [phase, files]); // eslint-disable-line react-hooks/exhaustive-deps

  function approve(key: string, ok: boolean): void {
    setApprovals((as) => as.filter((a) => a.key !== key));
    void answerApproval(key, ok).catch(() => undefined);
  }

  // ── Exécution ─────────────────────────────────────────────────────────────
  const patch = (id: string, update: (v: TaskView) => Partial<TaskView>): void =>
    setViews((vs) => vs.map((v) => (v.task.id === id ? { ...v, ...update(v) } : v)));

  const pushLog = (entry: LogEntry): void =>
    setLogs((ls) => (ls.length >= MAX_LOGS ? [...ls.slice(-MAX_LOGS + 1), entry] : [...ls, entry]));

  async function run(opts: { fix?: FixRequest; text?: string; kind?: "prompt" | "answer" } = {}): Promise<void> {
    const fix = opts.fix;
    // Projet ouvert : la conversation continue (même dossier, graphe, journal) ; sinon nouveau projet.
    const continuing = workspace !== null && cfg.agentic;
    const text = fix !== undefined ? `Corriger l'erreur rencontrée en testant ${fix.source}` : (opts.text ?? prompt).trim();
    if (text.length === 0) return;
    const project = {
      ...(draft.edited && draft.name.trim() ? { name: draft.name.trim() } : {}),
      ...(draft.location.trim() ? { location: draft.location.trim() } : {}),
    };
    const session =
      continuing && workspace !== null
        ? { workspace, ...(fix !== undefined ? { fix } : {}), ...(opts.kind !== undefined ? { kind: opts.kind } : {}) }
        : { project, ...(opts.kind !== undefined ? { kind: opts.kind } : {}) };
    let body: RunBody;
    if (cfg.mode === "auto") {
      body = { mode: "auto", prompt: text, strategy: cfg.strategy, policies: cfg.policies, ...session };
    } else {
      if (tiers === null) return;
      body = { mode: "manual", prompt: text, provider, models: tiers, ...session };
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase("planning");
    setError(null);
    setMetrics(null);
    setRunInfo(null);
    setStartedAt(Date.now());
    setApprovals([]);
    // Le message part tout de suite dans la conversation (la version du moteur le remplace à la fin).
    setMessages((ms) => [
      ...(continuing ? ms : []),
      {
        id: `local-${Date.now()}`,
        at: new Date().toISOString(),
        role: "user",
        kind: fix !== undefined ? "fix" : (opts.kind ?? "prompt"),
        text: fix !== undefined ? fix.note?.trim() || `Corriger l'erreur de ${fix.source}` : text,
        ...(fix !== undefined ? { error: fix.output } : {}),
      },
    ]);
    if (fix === undefined && opts.text === undefined) setPrompt("");
    const prevSinks = continuing ? sinks(viewsRef.current) : [];
    if (continuing) {
      if (fix === undefined) setSynthesis(null);
      pushLog({
        at: Date.now(),
        level: "info",
        category: "info",
        title: fix !== undefined ? `── Correction : ${fix.source}${fix.note ? ` — ${fix.note}` : ""} ──` : `── Suite : ${text} ──`,
      });
    } else {
      setSynthesis(null);
      setViews([]);
      setLogs([]);
      setSelectedId(null);
      setWorkspace(null);
      setFiles([]);
      setCommands([]);
      setPreview(null);
      raised.current.clear();
    }
    let runRoot: string | null = continuing ? workspace : null;

    try {
      for await (const ev of runPipeline(body, ac.signal)) {
        switch (ev.type) {
          case "mode":
            setRunInfo({ mode: ev.mode, accounts: ev.accounts, ...(ev.strategy ? { strategy: ev.strategy } : {}) });
            break;
          case "log":
            pushLog(ev.entry);
            break;
          case "pipeline:plan": {
            setPhase("running");
            // Les premières tâches du tour se rattachent (à l'affichage) à la fin du tour précédent.
            const fresh = ev.tasks.map((task) => ({
              task: continuing && task.dependsOn.length === 0 ? { ...task, dependsOn: prevSinks } : task,
              status: "pending" as const,
              output: "",
            }));
            setViews((vs) => (continuing ? [...vs, ...fresh] : fresh));
            break;
          }
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
            setRound(ev.round ?? 1);
            setWorkspace(ev.root);
            setProjectName(ev.name ?? ev.root.split(/[\\/]/).filter(Boolean).at(-1) ?? ev.root);
            break;
          case "questions":
            setMessages((ms) => [
              ...ms,
              { id: `local-q-${Date.now()}`, at: new Date().toISOString(), role: "relay", kind: "questions", text: ev.analysis, questions: ev.questions },
            ]);
            break;
          case "file:write":
            setFiles((fs) =>
              [...fs.filter((f) => f.path !== ev.path), { path: ev.path, size: ev.bytes }].sort((a, b) => a.path.localeCompare(b.path)),
            );
            setLastWrite({ path: ev.path, at: Date.now() });
            setPreview((p) => (p === null ? p : { ...p, nonce: Date.now() })); // l'aperçu suit les corrections
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
      void refreshProjects();
      if (runRoot !== null) {
        void refreshFiles(runRoot); // fichiers créés par les commandes aussi (et RELAY.md)
        void reloadProject(runRoot); // conversation et mémoire, version du moteur
      }
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
    doneCount: roundViews(views, round).filter((v) => v.status === "done").length,
    taskCount: roundViews(views, round).length,
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
    refreshFiles: () => void refreshFiles(),
    refreshRuns: () => void refreshProjects(),
    selectWorkspace: (root: string) => void loadProject(root),
    continuing: workspace !== null && cfg.agentic,
    projects,
    projectName,
    messages,
    memory,
    draft,
    setDraft,
    loadProject: (root: string) => void loadProject(root),
    newProject,
    importFolder: (path: string) => void importFolder(path),
    saveMemory,
    refreshProjects: () => void refreshProjects(),
    answer: (text: string) => void run({ text, kind: "answer" }),
    round,
    raiseError,
    fixError,
    stopApp,
    preview,
    previewTick,
    openPreview,
    reloadPreview: () => setPreview((p) => (p === null ? p : { ...p, nonce: Date.now() })),
    errorTick,
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
