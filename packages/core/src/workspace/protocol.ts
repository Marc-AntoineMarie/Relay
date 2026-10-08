/**
 * Protocole d'action texte : le modèle agit sur le dossier de travail en écrivant des
 * balises dans sa réponse. Choisi plutôt que l'appel d'outils natif pour fonctionner avec
 * tous les fournisseurs (Gemini, Groq, Claude Code…) et grouper plusieurs fichiers par
 * réponse (moins d'allers-retours, donc moins de tokens).
 *
 * Analyse ligne à ligne : un bloc FILE va jusqu'à sa ligne ===END=== (ou jusqu'au FILE
 * suivant si le modèle l'a oubliée) ; un bloc non terminé (réponse coupée) n'est pas écrit.
 */

export interface AgentActions {
  files: Array<{ path: string; content: string }>;
  runs: string[];
  reads: string[];
  /** Blocs FILE sans ===END=== (réponse tronquée) : non écrits, signalés au modèle. */
  incomplete: string[];
}

const FILE_HEAD = /^\s*===FILE:\s*(.+?)\s*===\s*$/;
const FILE_END = /^\s*===END===\s*$/;
// Le « === » final est parfois oublié par les modèles : une ligne qui commence par ===RUN: suffit.
const RUN = /^\s*===RUN:\s*(.+?)\s*(?:===)?\s*$/;
const READ = /^\s*===READ:\s*(.+?)\s*(?:===)?\s*$/;
/** Lignes de protocole sans contenu utile pour un lecteur (commandes listées à part, END orphelin). */
const NOISE = /^\s*===(RUN|READ):.*$|^\s*===END===\s*$/;

export const ACTION_PROTOCOL = `## Protocole d'action (pour agir réellement sur le dossier de travail)
Tu n'as pas d'outils ni d'appels de fonction : tu agis uniquement en écrivant ces balises dans ta réponse.

Créer ou remplacer un fichier — contenu COMPLET, sans bloc de code autour :
===FILE: chemin/relatif/fichier.py===
…contenu du fichier…
===END===
Lancer une commande dans le dossier (tests, exécution) — une ligne par commande :
===RUN: python3 -m unittest -v===
Lire un fichier existant avant de le modifier :
===READ: chemin/relatif/fichier.py===

Règles :
- Décrire un fichier ne suffit pas : s'il doit exister, écris-le avec ===FILE===.
- Chemins relatifs au dossier de travail. Écris toujours le fichier entier, jamais un extrait.
- Pas de commande interactive ni de programme qui ne s'arrête pas seul ; pas d'installation
  de paquets : n'utilise que ce qui est installé (bibliothèque standard, ex. unittest en Python).
- Si tu écris ou modifies le programme principal, vérifie qu'il démarre avec la commande
  EXACTE donnée à l'utilisateur (README, contrats), depuis la racine du projet — pas une
  variante (« python3 -c "import …" » ne prouve pas que « python3 src/main.py » marche).
  Programme qui ne s'arrête pas seul (fenêtre, jeu, serveur) : ===RUN: timeout 5 <commande>===
  → « toujours en marche » = il démarre bien ; une erreur = à corriger.
- Le programme doit se lancer par une commande simple depuis la racine, sans variable
  d'environnement (ex. « python3 main.py », ou « python3 -m paquet.main »).
- Piège Python : « python3 dossier/script.py » cherche les imports dans dossier/, pas à la
  racine. Dans ce cas, importe les modules voisins directement (« from game import … »), ou
  lance en module depuis la racine (« python3 -m dossier.script ») — et garde la même commande partout.
- Après tes commandes, tu recevras leur sortie et pourras corriger. Si un test échoue, corrige
  le code plutôt que le test, sauf si le test est manifestement faux.
- Termine par une phrase de résumé de ce que tu as fait.`;

interface Block {
  path: string;
  start: number;
  end: number;
  content: string;
}

/** Découpe la réponse : blocs de fichiers (terminés ou non) et lignes hors blocs. */
function scan(text: string): { blocks: Block[]; incomplete: Block[]; outside: string[] } {
  const lines = text.split(/\r?\n/);
  const blocks: Block[] = [];
  const incomplete: Block[] = [];
  const outside: string[] = [];
  let open: { path: string; start: number; body: string[] } | undefined;

  const close = (end: number, done: boolean): void => {
    if (open === undefined) return;
    const block = { path: open.path, start: open.start, end, content: normalizeContent(open.body.join("\n")) };
    (done ? blocks : incomplete).push(block);
    open = undefined;
  };

  lines.forEach((line, i) => {
    const head = FILE_HEAD.exec(line);
    if (head !== null) {
      close(i - 1, true); // ===END=== oublié : le FILE suivant ferme le précédent
      open = { path: (head[1] ?? "").trim(), start: i, body: [] };
    } else if (open !== undefined) {
      if (FILE_END.test(line)) close(i, true);
      else open.body.push(line);
    } else {
      outside.push(line);
    }
  });
  close(lines.length - 1, false);
  return { blocks, incomplete, outside };
}

/** Extrait les actions d'une réponse. Les RUN/READ à l'intérieur d'un fichier sont ignorés. */
export function parseActions(text: string): AgentActions {
  const { blocks, incomplete, outside } = scan(text);
  const pick = (re: RegExp): string[] =>
    outside.map((l) => re.exec(l)?.[1]?.trim() ?? "").filter((v) => v.length > 0);
  return {
    files: blocks.filter((b) => b.path.length > 0).map((b) => ({ path: b.path, content: b.content })),
    runs: pick(RUN),
    reads: pick(READ),
    incomplete: incomplete.map((b) => b.path),
  };
}

/**
 * Réponse dégénérée (le modèle « déraille ») : ponctuation en rafale, alphabets mélangés hors
 * du code, commandes qui n'en sont pas. Mieux vaut changer de modèle que lui demander de corriger.
 */
export function looksDegenerate(text: string, promptHasCjk = false): boolean {
  const { outside } = scan(text);
  const prose = outside.join("\n");
  if ((prose.match(/[?!？！]{4,}/g) ?? []).length >= 3) return true;
  const cjk = (prose.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) ?? []).length;
  const letters = (prose.match(/\p{L}/gu) ?? []).length;
  if (!promptHasCjk && cjk >= 15 && cjk / Math.max(1, letters) > 0.02) return true;
  const runs = parseActions(text).runs;
  const bogus = runs.filter((r) => !/^[A-Za-z0-9_.\/+=-]+$/.test(r.split(/\s+/)[0] ?? "")).length;
  return bogus >= 2;
}

/** Remplace les blocs de fichiers par une mention courte (résultat transmis aux tâches suivantes). */
export function condense(text: string): string {
  const lines = text.split(/\r?\n/);
  const { blocks, incomplete } = scan(text);
  const out: string[] = [];
  let i = 0;
  for (const b of [...blocks, ...incomplete].sort((x, y) => x.start - y.start)) {
    out.push(...lines.slice(i, b.start), `[fichier ${blocks.includes(b) ? "écrit" : "incomplet, non écrit"} : ${b.path}]`);
    i = b.end + 1;
  }
  out.push(...lines.slice(i));
  return out
    .filter((l) => !NOISE.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Retire un éventuel bloc de code Markdown englobant et garantit une fin de ligne. */
function normalizeContent(raw: string): string {
  const fenced = /^\s*```[\w.+-]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(raw);
  const body = fenced?.[1] ?? raw;
  return body.length === 0 || body.endsWith("\n") ? body : `${body}\n`;
}
