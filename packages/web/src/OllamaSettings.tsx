/**
 * Réglages › Ollama (phase F) : tout le setup depuis Relay, avec explications.
 * Machine → installation (sans mot de passe) → serveur → modèles ; ou un VPS (tunnel SSH),
 * ou Ollama Cloud.
 */
import { useEffect, useState } from "react";
import { getOllama, ollamaAction, streamAction } from "./api";
import { Segmented } from "./components";
import { useRelay } from "./store";
import type { OllamaInfo, OllamaServer, RemoteTarget } from "./types";

const FIT: Record<string, { label: string; cls: string }> = {
  ok: { label: "adapté", cls: "ok" },
  tight: { label: "limite", cls: "warn" },
  too_big: { label: "trop gros ici", cls: "err" },
};

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} Go`;
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Progress {
  label: string;
  completed?: number;
  total?: number;
}

export function OllamaSection(): React.JSX.Element {
  const r = useRelay();
  const [info, setInfo] = useState<OllamaInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [tests, setTests] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState("");

  const refresh = async (): Promise<void> => {
    try {
      setInfo(await getOllama());
      setError(null);
    } catch (e: unknown) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  /** Lance une opération ; met à jour l'état et le pool de modèles à la fin. */
  const act = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      await refresh();
      r.refreshPool();
    }
  };

  /** Opération en flux (installation, téléchargement) avec barre de progression. */
  const stream = (key: string, action: string, body: unknown, onLog?: (line: string) => void): Promise<void> =>
    act(key, async () => {
      for await (const ev of streamAction(action, body)) {
        if (ev["type"] === "progress") {
          setProgress((p) => ({
            ...p,
            [key]: {
              label: String(ev["status"] ?? ""),
              ...(typeof ev["completed"] === "number" ? { completed: ev["completed"] } : {}),
              ...(typeof ev["total"] === "number" ? { total: ev["total"] } : {}),
            },
          }));
        } else if (ev["type"] === "log") onLog?.(String(ev["line"]));
        else if (ev["type"] === "error") {
          const d = ev["error"] as { title?: string; detail?: string } | undefined;
          throw new Error(d?.detail ?? d?.title ?? "échec");
        }
      }
      setProgress((p) => {
        const { [key]: _done, ...rest } = p;
        return rest;
      });
    });

  if (info === null) {
    return (
      <section>
        <h3>Ollama</h3>
        <p className="muted">{error ?? "Analyse de ta machine…"}</p>
      </section>
    );
  }

  const m = info.machine;
  const server: OllamaServer | null = info.target === "remote" ? info.remote : info.local;
  const installed = new Set(server?.models.map((x) => x.name) ?? []);
  const where = info.target === "remote" ? "sur le VPS" : "sur cette machine";

  return (
    <section className="ollama">
      <h3>Ollama</h3>
      <p className="muted small">
        Ollama fait tourner des modèles ouverts <strong>gratuitement</strong>, sur ta machine ou sur un serveur à toi. Relay
        les ajoute au routage automatique, marqués « lents » (ils servent surtout quand les quotas gratuits en ligne sont
        épuisés), et tes données ne quittent pas tes machines.
      </p>
      {error !== null ? <p className="inline-error">⚠ {error}</p> : null}

      <h4>Ta machine</h4>
      <div className="machine-card">
        <div>
          <span className="muted small">Processeur</span>
          <strong>{m.cpu}</strong>
          <span className="muted small">{m.cores} cœurs</span>
        </div>
        <div>
          <span className="muted small">Mémoire</span>
          <strong>{m.ramTotalGb} Go</strong>
          <span className="muted small">{m.ramAvailableGb} Go libres maintenant</span>
        </div>
        <div>
          <span className="muted small">Carte graphique</span>
          <strong>{m.vramGb !== null ? `${m.vramGb} Go dédiés` : "intégrée / aucune"}</strong>
          <span className="muted small">{m.gpu ?? "—"}</span>
        </div>
        <div>
          <span className="muted small">Disque libre</span>
          <strong>{m.diskFreeGb ?? "?"} Go</strong>
        </div>
      </div>
      <p className="verdict">{info.verdict}</p>
      {m.ramAvailableGb < 2 ? (
        <p className="muted small">
          Seulement {m.ramAvailableGb} Go libres en ce moment : ferme des applications (navigateur…) avant de lancer un modèle local.
        </p>
      ) : null}

      <div className="field">
        <span className="field-label">Où tourne Ollama</span>
        <Segmented
          value={info.target}
          disabled={busy !== null}
          onChange={(v) =>
            v === "local"
              ? void act("target", () => ollamaAction("remote/disconnect"))
              : setInfo({ ...info, target: "remote", remote: null })
          }
          options={[
            { value: "local", label: "Sur cette machine", hint: "Installation locale, sans mot de passe" },
            { value: "remote", label: "Sur un VPS", hint: "Un serveur à toi, relié par un tunnel SSH chiffré" },
          ]}
        />
      </div>

      {info.target === "local" ? (
        <LocalPanel info={info} busy={busy} progress={progress["install"]} act={act} stream={stream} />
      ) : (
        <RemotePanel info={info} busy={busy} act={act} stream={stream} />
      )}

      <h4>Modèles {where}</h4>
      {server === null || !server.running ? (
        <p className="muted small">
          {info.target === "remote" ? "Connecte le VPS pour gérer ses modèles." : "Démarre Ollama pour gérer les modèles."}
        </p>
      ) : (
        <>
          {server.models.length === 0 ? <p className="muted small">Aucun modèle installé : choisis-en un ci-dessous.</p> : null}
          <ul className="ollama-models">
            {server.models.map((x) => (
              <li key={x.name}>
                <code>{x.name}</code>
                <span className="muted small">
                  {x.sizeGb} Go{x.parameters ? ` · ${x.parameters}` : ""}
                  {x.quantization ? ` · ${x.quantization}` : ""}
                  {server.loaded.includes(x.name) ? " · en mémoire" : ""}
                </span>
                <button
                  disabled={busy !== null}
                  onClick={() =>
                    void act(`test:${x.name}`, async () => {
                      setTests((t) => ({ ...t, [x.name]: "essai en cours… (le premier chargement peut être long)" }));
                      const res = await ollamaAction<{ reply: string; seconds: number; tokensPerSecond: number | null }>("test", { model: x.name });
                      setTests((t) => ({
                        ...t,
                        [x.name]: `${res.seconds} s${res.tokensPerSecond !== null ? ` · ${res.tokensPerSecond} tokens/s` : ""} — « ${res.reply} »`,
                      }));
                    })
                  }
                >
                  {busy === `test:${x.name}` ? "…" : "Tester"}
                </button>
                <button disabled={busy !== null} onClick={() => void act(`del:${x.name}`, () => ollamaAction("delete", { model: x.name }))}>
                  Supprimer
                </button>
                {tests[x.name] ? <span className="muted small test-line">{tests[x.name]}</span> : null}
              </li>
            ))}
          </ul>

          <span className="field-label">Conseillés pour {info.target === "remote" ? "un serveur" : "ta machine"}</span>
          <table className="suggest">
            <tbody>
              {info.suggestions.map((s) => {
                const fit = FIT[s.fit] ?? { label: s.fit, cls: "" };
                const p = progress[`pull:${s.name}`];
                return (
                  <tr key={s.name}>
                    <td>
                      <code>{s.name}</code>
                    </td>
                    <td className="muted small">~{s.sizeGb} Go</td>
                    <td className="muted small">{s.use}</td>
                    <td>{info.target === "local" ? <span className={`badge ${fit.cls}`}>{fit.label}</span> : null}</td>
                    <td>
                      {installed.has(s.name) ? (
                        <span className="muted small">installé</span>
                      ) : p !== undefined ? (
                        <ProgressBar p={p} />
                      ) : (
                        <button disabled={busy !== null} onClick={() => void stream(`pull:${s.name}`, "pull", { model: s.name })}>
                          Télécharger
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="runner-line">
            <input
              className="runner-input"
              placeholder="autre modèle de ollama.com/library, ex. mistral:7b, gemma3:12b…"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
            {progress[`pull:${custom.trim()}`] !== undefined ? (
              <ProgressBar p={progress[`pull:${custom.trim()}`] as Progress} />
            ) : (
              <button disabled={busy !== null || custom.trim() === ""} onClick={() => void stream(`pull:${custom.trim()}`, "pull", { model: custom.trim() })}>
                Télécharger
              </button>
            )}
            <a className="link" href="https://ollama.com/library" target="_blank" rel="noreferrer">
              bibliothèque
            </a>
          </div>
          <p className="muted small">
            Les modèles de familles connues entrent automatiquement dans le pool du mode auto (Réglages › Modèles pour les
            retirer ou en ajouter).
          </p>
        </>
      )}

      <h4>Ollama Cloud</h4>
      <p className="muted small">
        Les modèles « cloud » d'Ollama tournent sur ses serveurs : rien à installer, rien à faire tourner chez toi (compte
        ollama.com, palier gratuit limité puis abonnement).{" "}
        <button className="link" onClick={() => r.openSettings("accounts")}>
          Ajouter la clé « Ollama Cloud »
        </button>
      </p>
    </section>
  );
}

function ProgressBar({ p }: { p: Progress }): React.JSX.Element {
  const pct = p.total ? Math.min(100, Math.round(((p.completed ?? 0) / p.total) * 100)) : null;
  return (
    <span className="progress">
      <span className="progress-track">
        <span className={`progress-fill ${pct === null ? "indeterminate" : ""}`} style={pct !== null ? { width: `${pct}%` } : undefined} />
      </span>
      <span className="muted small">
        {p.label}
        {pct !== null ? ` ${pct} %` : ""}
        {p.total ? ` · ${gb(p.completed ?? 0)} / ${gb(p.total)}` : ""}
      </span>
    </span>
  );
}

type Act = (key: string, fn: () => Promise<unknown>) => Promise<void>;
type Stream = (key: string, action: string, body: unknown, onLog?: (line: string) => void) => Promise<void>;

function LocalPanel(props: { info: OllamaInfo; busy: string | null; progress: Progress | undefined; act: Act; stream: Stream }): React.JSX.Element {
  const { info, busy, act, stream } = props;
  const s = info.local;
  const linux = info.machine.platform === "linux";
  const state = !s.installed
    ? "non installé"
    : s.running
      ? `en marche · version ${s.version ?? "?"}${s.startedByRelay ? " · démarré par Relay" : ""}`
      : "installé, serveur arrêté";
  return (
    <div className="ollama-panel">
      <h4>Ollama sur cette machine</h4>
      <p>
        <span className={`dot dot-${s.running ? "done" : s.installed ? "pending" : "failed"}`} /> {state}
        {s.binary !== null ? <span className="muted small"> · {s.binary}</span> : null}
      </p>
      {!s.installed ? (
        linux ? (
          <>
            {props.progress !== undefined ? (
              <ProgressBar p={props.progress} />
            ) : (
              <button className="run-btn" disabled={busy !== null} onClick={() => void stream("install", "install", {})}>
                Installer Ollama (sans mot de passe)
              </button>
            )}
            <p className="muted small">
              Relay télécharge l'archive officielle d'ollama.com (~1,4 Go, elle contient aussi les bibliothèques GPU) dans
              <code> ~/.local/share/relay/ollama</code>. Pas de sudo, pas de service système : Relay démarre Ollama quand tu
              le demandes et l'arrête en quittant. Installation système officielle, si tu préfères :{" "}
              <code>curl -fsSL https://ollama.com/install.sh | sh</code>
            </p>
          </>
        ) : (
          <p className="muted small">
            Télécharge Ollama sur{" "}
            <a className="link" href="https://ollama.com/download" target="_blank" rel="noreferrer">
              ollama.com/download
            </a>
            , installe-le, puis reviens ici.
          </p>
        )
      ) : !s.running ? (
        <button className="run-btn" disabled={busy !== null} onClick={() => void act("start", () => ollamaAction("start"))}>
          {busy === "start" ? "Démarrage…" : "Démarrer Ollama"}
        </button>
      ) : s.startedByRelay ? (
        <button disabled={busy !== null} onClick={() => void act("stop", () => ollamaAction("stop"))}>
          Arrêter Ollama (libère la mémoire)
        </button>
      ) : (
        <p className="muted small">Ollama tourne déjà (service système) : Relay l'utilise tel quel.</p>
      )}
      <p className="muted small">Ollama écoute uniquement en local (127.0.0.1) : rien n'est ouvert sur le réseau.</p>
    </div>
  );
}

function RemotePanel(props: { info: OllamaInfo; busy: string | null; act: Act; stream: Stream }): React.JSX.Element {
  const { info, busy, act, stream } = props;
  const [t, setT] = useState<RemoteTarget>({ user: "ubuntu", port: 22, ...info.remoteTarget });
  const [key, setKey] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const connected = info.tunnel.running && info.remote?.running === true;
  const target = { ...t, port: Number(t.port) || 22 };

  return (
    <div className="ollama-panel">
      <h4>Ollama sur un VPS</h4>
      <p className="muted small">
        Utile si ta machine est trop juste. Ollama reste fermé au monde sur le serveur : Relay s'y relie par un{" "}
        <strong>tunnel SSH chiffré</strong> (aucun port à ouvrir, aucun mot de passe stocké, ta clé reste chez toi).
      </p>
      <p>
        <span className={`dot dot-${connected ? "done" : "pending"}`} />{" "}
        {connected ? `connecté · Ollama ${info.remote?.version ?? ""}` : info.tunnel.error ? `déconnecté — ${info.tunnel.error}` : "non connecté"}
      </p>

      <ol className="steps">
        <li>
          <strong>Clé SSH de Relay</strong>
          <button
            disabled={busy !== null}
            onClick={() =>
              void act("key", async () => {
                const k = await ollamaAction<{ publicKey: string; keyPath: string }>("remote/key");
                setKey(k.publicKey);
                setT((x) => ({ ...x, keyPath: k.keyPath }));
              })
            }
          >
            Générer / afficher la clé
          </button>
          {key !== null ? (
            <>
              <textarea className="pubkey" readOnly value={key} onFocus={(e) => e.currentTarget.select()} />
              <span className="muted small">
                Colle cette clé <em>publique</em> chez ton hébergeur, à la création du serveur (champ « clé SSH »). La clé
                privée ne quitte jamais ta machine.
              </span>
            </>
          ) : null}
        </li>
        <li>
          <strong>Ton serveur</strong>
          <div className="vps-fields">
            <input placeholder="adresse IP ou domaine" value={t.host ?? ""} onChange={(e) => setT({ ...t, host: e.target.value })} />
            <input placeholder="utilisateur" value={t.user ?? ""} onChange={(e) => setT({ ...t, user: e.target.value })} />
            <input placeholder="port" value={String(t.port ?? 22)} onChange={(e) => setT({ ...t, port: Number(e.target.value) || 22 })} />
            <input placeholder="clé privée (~/.ssh/relay_ed25519)" value={t.keyPath ?? ""} onChange={(e) => setT({ ...t, keyPath: e.target.value })} />
          </div>
          <button
            disabled={busy !== null || !t.host}
            onClick={() =>
              void act("check", async () => {
                const res = await ollamaAction<{ ok: boolean; lines: string[] }>("remote/check", target);
                setLines(res.ok ? res.lines : ["Connexion impossible :", ...res.lines]);
              })
            }
          >
            {busy === "check" ? "Connexion…" : "Tester la connexion"}
          </button>
        </li>
        <li>
          <strong>Installer Ollama sur le serveur</strong>
          <button
            disabled={busy !== null || !t.host}
            onClick={() => {
              setLines([]);
              void stream("remote-install", "remote/install", target, (line) => setLines((l) => [...l.slice(-200), line]));
            }}
          >
            {busy === "remote-install" ? "Installation…" : "Installer (commande officielle)"}
          </button>
        </li>
        <li>
          <strong>Relier Relay au serveur</strong>
          {connected ? (
            <button disabled={busy !== null} onClick={() => void act("disconnect", () => ollamaAction("remote/disconnect"))}>
              Déconnecter
            </button>
          ) : (
            <button className="run-btn" disabled={busy !== null || !t.host} onClick={() => void act("connect", () => ollamaAction("remote/connect", target))}>
              {busy === "connect" ? "Ouverture du tunnel…" : "Connecter"}
            </button>
          )}
        </li>
      </ol>
      {lines.length > 0 ? <pre className="log-detail vps-log">{lines.join("\n")}</pre> : null}

      <details className="guide">
        <summary>Pas de serveur ? Où en trouver un</summary>
        <p>
          <strong>Gratuit — Oracle Cloud « Always Free »</strong> : une machine ARM de 2 cœurs et 12 Go de RAM (depuis
          juin 2026), sans limite de durée. Assez pour des modèles de 7–8 milliards de paramètres, lentement.
        </p>
        <ol>
          <li>Crée un compte sur cloud.oracle.com (carte bancaire demandée pour vérification, rien n'est débité en Always Free).</li>
          <li>Compute › Instances › Create : image <em>Ubuntu</em>, forme <em>VM.Standard.A1.Flex</em> (2 OCPU, 12 Go).</li>
          <li>Dans « Add SSH keys », colle la clé publique générée à l'étape 1.</li>
          <li>Une fois l'instance prête, copie son adresse IP publique ici, utilisateur <code>ubuntu</code>.</li>
          <li>Tester la connexion → Installer → Connecter. Rien d'autre à ouvrir dans le pare-feu.</li>
        </ol>
        <p className="muted small">
          Si Oracle répond « Out of capacity », réessaie plus tard ou change de zone. Toute autre machine Ubuntu avec au moins
          8–16 Go de RAM convient aussi : un VPS payant de quelques euros par mois (CPU, modèles moyens), ou un serveur GPU
          loué à l'heure pour de gros modèles. Sans serveur du tout : Ollama Cloud (ci-dessous).
        </p>
      </details>
    </div>
  );
}
