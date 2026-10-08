/**
 * Phase H : registre d'usage — chaque appel de modèle (réussi ou non) est enregistré dans une
 * base SQLite locale (`node:sqlite`, intégré à Node : aucun module natif à compiler).
 * Toutes les métriques (tableau de bord, budget mensuel, export) en découlent : une seule
 * source de vérité, recalculable.
 *
 * Ce qu'on stocke est brut (tokens, durée, issue) ; les coûts « équivalent API » et « baseline »
 * sont recalculés à la lecture avec les prix actuels (ceux des Réglages › Métriques). Le montant
 * réellement **payé** est figé au moment de l'appel (c'est une dépense).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { referenceCost, type BillingMode, type CallPurpose, type CompletionChunk, type Provider, type RateLimitSnapshot } from "@relay/core";

export interface CallRecord {
  at: number;
  runId: string;
  project: string;
  purpose: CallPurpose;
  taskId?: string;
  provider: string;
  billing: BillingMode;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  billed: number;
  durationMs: number;
  firstChunkMs?: number;
  /** "ok", ou le type d'erreur (rate_limited, timeout, invalid_output…). */
  outcome: string;
}

export interface RunRecord {
  runId: string;
  at: number;
  project: string;
  root: string;
  prompt: string;
  mode: string;
  outcome: string;
  durationMs: number;
  tasks: number;
  launchOk?: boolean;
}

export class UsageStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL, run_id TEXT, project TEXT, purpose TEXT, task_id TEXT,
        provider TEXT, billing TEXT, model TEXT, input INTEGER, output INTEGER, thinking INTEGER,
        billed REAL, duration_ms INTEGER, first_chunk_ms INTEGER, outcome TEXT
      );
      CREATE INDEX IF NOT EXISTS calls_at ON calls(at);
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY, at INTEGER NOT NULL, project TEXT, root TEXT, prompt TEXT, mode TEXT,
        outcome TEXT, duration_ms INTEGER, tasks INTEGER, launch_ok INTEGER
      );
      CREATE TABLE IF NOT EXISTS quotas (provider TEXT PRIMARY KEY, at INTEGER, json TEXT);
    `);
  }

  addCall(c: CallRecord): void {
    this.db
      .prepare(
        "INSERT INTO calls (at, run_id, project, purpose, task_id, provider, billing, model, input, output, thinking, billed, duration_ms, first_chunk_ms, outcome) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(c.at, c.runId, c.project, c.purpose, c.taskId ?? null, c.provider, c.billing, c.model, c.inputTokens, c.outputTokens, c.thinkingTokens, c.billed, c.durationMs, c.firstChunkMs ?? null, c.outcome);
  }

  addRun(r: RunRecord): void {
    this.db
      .prepare("INSERT OR REPLACE INTO runs (run_id, at, project, root, prompt, mode, outcome, duration_ms, tasks, launch_ok) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(r.runId, r.at, r.project, r.root, r.prompt.slice(0, 300), r.mode, r.outcome, r.durationMs, r.tasks, r.launchOk === undefined ? null : r.launchOk ? 1 : 0);
  }

  setQuota(provider: string, q: RateLimitSnapshot, at = Date.now()): void {
    this.db.prepare("INSERT OR REPLACE INTO quotas (provider, at, json) VALUES (?,?,?)").run(provider, at, JSON.stringify(q));
  }

  quotas(): Record<string, RateLimitSnapshot & { at: number }> {
    const rows = this.db.prepare("SELECT provider, at, json FROM quotas").all() as Array<{ provider: string; at: number; json: string }>;
    return Object.fromEntries(rows.map((r) => [r.provider, { ...(JSON.parse(r.json) as RateLimitSnapshot), at: r.at }]));
  }

  calls(since: number): CallRecord[] {
    const rows = this.db.prepare("SELECT * FROM calls WHERE at >= ? ORDER BY at").all(since) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      at: Number(r["at"]),
      runId: String(r["run_id"] ?? ""),
      project: String(r["project"] ?? ""),
      purpose: String(r["purpose"] ?? "other") as CallPurpose,
      ...(r["task_id"] ? { taskId: String(r["task_id"]) } : {}),
      provider: String(r["provider"]),
      billing: String(r["billing"]) as BillingMode,
      model: String(r["model"]),
      inputTokens: Number(r["input"] ?? 0),
      outputTokens: Number(r["output"] ?? 0),
      thinkingTokens: Number(r["thinking"] ?? 0),
      billed: Number(r["billed"] ?? 0),
      durationMs: Number(r["duration_ms"] ?? 0),
      ...(r["first_chunk_ms"] !== null && r["first_chunk_ms"] !== undefined ? { firstChunkMs: Number(r["first_chunk_ms"]) } : {}),
      outcome: String(r["outcome"] ?? "ok"),
    }));
  }

  runs(since: number, limit = 200): RunRecord[] {
    const rows = this.db.prepare("SELECT * FROM runs WHERE at >= ? ORDER BY at DESC LIMIT ?").all(since, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      runId: String(r["run_id"]),
      at: Number(r["at"]),
      project: String(r["project"] ?? ""),
      root: String(r["root"] ?? ""),
      prompt: String(r["prompt"] ?? ""),
      mode: String(r["mode"] ?? ""),
      outcome: String(r["outcome"] ?? ""),
      durationMs: Number(r["duration_ms"] ?? 0),
      tasks: Number(r["tasks"] ?? 0),
      ...(r["launch_ok"] !== null && r["launch_ok"] !== undefined ? { launchOk: Number(r["launch_ok"]) === 1 } : {}),
    }));
  }

  /** Montant réellement payé depuis une date (budget mensuel). */
  billedSince(since: number): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(billed), 0) AS s FROM calls WHERE at >= ?").get(since) as { s: number };
    return Number(row.s);
  }

  reset(): void {
    this.db.exec("DELETE FROM calls; DELETE FROM runs; DELETE FROM quotas;");
  }

  close(): void {
    this.db.close();
  }
}

/** Contexte de l'appel en cours (un seul run à la fois) : à quel run et projet l'imputer. */
export interface MeterContext {
  runId: string;
  project: string;
}

/**
 * Enveloppe un provider : chaque appel est mesuré et enregistré (tokens, durée, 1re réponse,
 * issue, quota annoncé), sans rien changer à ce que voit l'appelant.
 */
export function meter(provider: Provider, store: UsageStore, context: () => MeterContext): Provider {
  return {
    name: provider.name,
    billing: provider.billing,
    models: () => provider.models(),
    estimateCost: (m, i, o) => provider.estimateCost(m, i, o),
    countTokens: (r) => provider.countTokens(r),
    async *complete(request) {
      const started = Date.now();
      const ctx = context();
      let model = request.model;
      let usage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
      let firstChunkMs: number | undefined;
      let outcome = "ok";
      const record = (): void => {
        const billed = provider.billing === "per-token" ? referenceCost(model, usage.inputTokens, usage.outputTokens) : 0;
        try {
          store.addCall({
            at: started,
            runId: ctx.runId,
            project: ctx.project,
            purpose: request.tag?.purpose ?? "other",
            ...(request.tag?.taskId !== undefined ? { taskId: request.tag.taskId } : {}),
            provider: provider.name,
            billing: provider.billing,
            model,
            ...usage,
            billed,
            durationMs: Date.now() - started,
            ...(firstChunkMs !== undefined ? { firstChunkMs } : {}),
            outcome,
          });
        } catch {
          /* le registre ne doit jamais faire échouer un run */
        }
      };
      try {
        for await (const chunk of provider.complete(request) as AsyncIterable<CompletionChunk>) {
          if (chunk.type === "usage") usage = { inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens, thinkingTokens: chunk.usage.thinkingTokens ?? 0 };
          else if (chunk.type === "model") model = chunk.model;
          else if (chunk.type === "latency") firstChunkMs = chunk.firstChunkMs;
          else if (chunk.type === "quota") {
            try {
              store.setQuota(provider.name, chunk.quota);
            } catch {
              /* sans importance */
            }
          }
          yield chunk;
        }
      } catch (err) {
        outcome = typeof err === "object" && err !== null && "kind" in err ? String((err as { kind: unknown }).kind) : "unknown";
        throw err;
      } finally {
        record();
      }
    },
  };
}

// ── Tableau de bord ────────────────────────────────────────────────────────

export type Period = "day" | "7d" | "30d" | "all";

export function periodStart(period: Period, now = new Date()): number {
  if (period === "all") return 0;
  if (period === "day") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return now.getTime() - (period === "7d" ? 7 : 30) * 86_400_000;
}

export const monthStart = (now = new Date()): number => new Date(now.getFullYear(), now.getMonth(), 1).getTime();

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

const day = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

interface Money {
  calls: number;
  failed: number;
  tokens: number;
  billed: number;
  reference: number;
  baseline: number;
}

const empty = (): Money => ({ calls: 0, failed: 0, tokens: 0, billed: 0, reference: 0, baseline: 0 });

/**
 * Agrège les appels d'une période. Définitions (affichées dans l'interface) :
 * - payé : dépense réelle (comptes à l'usage seulement ; gratuit et abonnement = 0) ;
 * - équivalent API : tokens × prix public de référence du modèle utilisé ;
 * - baseline : mêmes tokens × prix du modèle de référence choisi (ex. tout sur Opus) ;
 * - économie de routage = baseline − équivalent API ; économie totale = baseline − payé.
 */
export function summarize(calls: CallRecord[], runs: RunRecord[], opts: { baselineModel: string; period: Period; since: number; budgetMonthly: number | null; budgetAlertPct: number; spentThisMonth: number; quotas: Record<string, RateLimitSnapshot & { at: number }> }) {
  const add = (m: Money, c: CallRecord, ref: number, base: number): void => {
    m.calls++;
    if (c.outcome !== "ok") m.failed++;
    m.tokens += c.inputTokens + c.outputTokens;
    m.billed += c.billed;
    m.reference += ref;
    m.baseline += base;
  };
  const totals = { ...empty(), inputTokens: 0, outputTokens: 0, thinkingTokens: 0, durationMs: 0, rateLimited: 0 };
  const providers = new Map<string, Money & { billing: string; rateLimited: number; latencies: number[] }>();
  const models = new Map<string, Money & { provider: string; model: string; latencies: number[] }>();
  const projects = new Map<string, Money & { lastAt: number }>();
  const purposes = new Map<string, Money>();
  const days = new Map<string, Money>();
  const byRun = new Map<string, Money>();

  for (const c of calls) {
    const ref = referenceCost(c.model, c.inputTokens, c.outputTokens);
    const base = referenceCost(opts.baselineModel, c.inputTokens, c.outputTokens);
    add(totals, c, ref, base);
    totals.inputTokens += c.inputTokens;
    totals.outputTokens += c.outputTokens;
    totals.thinkingTokens += c.thinkingTokens;
    totals.durationMs += c.durationMs;
    if (c.outcome === "rate_limited") totals.rateLimited++;

    const p = providers.get(c.provider) ?? { ...empty(), billing: c.billing, rateLimited: 0, latencies: [] };
    add(p, c, ref, base);
    if (c.outcome === "rate_limited") p.rateLimited++;
    if (c.firstChunkMs !== undefined) p.latencies.push(c.firstChunkMs);
    providers.set(c.provider, p);

    const mk = `${c.provider}/${c.model}`;
    const m = models.get(mk) ?? { ...empty(), provider: c.provider, model: c.model, latencies: [] };
    add(m, c, ref, base);
    if (c.firstChunkMs !== undefined) m.latencies.push(c.firstChunkMs);
    models.set(mk, m);

    const pr = projects.get(c.project || "(sans projet)") ?? { ...empty(), lastAt: 0 };
    add(pr, c, ref, base);
    pr.lastAt = Math.max(pr.lastAt, c.at);
    projects.set(c.project || "(sans projet)", pr);

    const pu = purposes.get(c.purpose) ?? empty();
    add(pu, c, ref, base);
    purposes.set(c.purpose, pu);

    const d = days.get(day(c.at)) ?? empty();
    add(d, c, ref, base);
    days.set(day(c.at), d);

    const r = byRun.get(c.runId) ?? empty();
    add(r, c, ref, base);
    byRun.set(c.runId, r);
  }

  const sortByRef = <T extends Money>(xs: T[]): T[] => xs.sort((a, b) => b.reference - a.reference || b.calls - a.calls);
  const runsInPeriod = runs.filter((r) => r.at >= opts.since);

  return {
    period: opts.period,
    since: opts.since,
    baselineModel: opts.baselineModel,
    totals: {
      ...totals,
      routingSavings: totals.baseline - totals.reference,
      totalSavings: totals.baseline - totals.billed,
      runs: runsInPeriod.length,
      runsDone: runsInPeriod.filter((r) => r.outcome === "done").length,
      launchChecked: runsInPeriod.filter((r) => r.launchOk !== undefined).length,
      launchOk: runsInPeriod.filter((r) => r.launchOk === true).length,
    },
    byProvider: sortByRef(
      [...providers.entries()].map(([provider, p]) => {
        const { latencies, ...rest } = p;
        return { provider, ...rest, medianFirstChunkMs: median(latencies), ...(opts.quotas[provider] ? { quota: opts.quotas[provider] } : {}) };
      }),
    ),
    byModel: sortByRef([...models.values()].map(({ latencies, ...rest }) => ({ ...rest, medianFirstChunkMs: median(latencies) }))).slice(0, 25),
    byProject: [...projects.entries()].map(([project, p]) => ({ project, ...p, runs: runsInPeriod.filter((r) => r.project === project).length })).sort((a, b) => b.lastAt - a.lastAt),
    byPurpose: [...purposes.entries()].map(([purpose, p]) => ({ purpose, ...p })),
    daily: [...days.entries()].map(([d, m]) => ({ day: d, ...m })).sort((a, b) => a.day.localeCompare(b.day)),
    recentRuns: runsInPeriod.slice(0, 25).map((r) => ({ ...r, ...(byRun.get(r.runId) ?? empty()) })),
    budget: {
      monthly: opts.budgetMonthly,
      spentThisMonth: opts.spentThisMonth,
      alertPct: opts.budgetAlertPct,
      alert: opts.budgetMonthly !== null && opts.budgetMonthly > 0 && opts.spentThisMonth >= (opts.budgetMonthly * opts.budgetAlertPct) / 100,
      exceeded: opts.budgetMonthly !== null && opts.spentThisMonth >= opts.budgetMonthly,
    },
  };
}

export type UsageSummary = ReturnType<typeof summarize>;

/** Export CSV (une ligne par appel), coûts recalculés avec les prix actuels. */
export function toCsv(calls: CallRecord[], baselineModel: string): string {
  const head = "date,projet,run,usage,tache,fournisseur,facturation,modele,tokens_entree,tokens_sortie,tokens_reflexion,paye_usd,equivalent_api_usd,baseline_usd,duree_ms,premiere_reponse_ms,issue";
  const esc = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = calls.map((c) =>
    [
      new Date(c.at).toISOString(),
      esc(c.project),
      c.runId,
      c.purpose,
      c.taskId ?? "",
      c.provider,
      c.billing,
      esc(c.model),
      c.inputTokens,
      c.outputTokens,
      c.thinkingTokens,
      c.billed.toFixed(6),
      referenceCost(c.model, c.inputTokens, c.outputTokens).toFixed(6),
      referenceCost(baselineModel, c.inputTokens, c.outputTokens).toFixed(6),
      c.durationMs,
      c.firstChunkMs ?? "",
      c.outcome,
    ].join(","),
  );
  return [head, ...lines].join("\n") + "\n";
}
