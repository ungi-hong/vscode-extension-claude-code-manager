import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import * as os from "os";
import * as path from "path";

export interface CustomCommandInfo {
  /** `/name` の name 部分 (拡張子なし)。サブディレクトリ配下は `dir:name` 形式で扱う。 */
  name: string;
  description: string;
  argumentHint: string;
  source: "user" | "project" | "plugin";
  /** plugin 由来の場合の plugin 名 (バッジ表示用)。 */
  plugin?: string;
}

/**
 * Claude Code 風のユーザー定義 slash command 一覧を返す。 3 種類のソースをマージ:
 *
 *  - `user`    : `~/.claude/commands/**\/*.md`
 *  - `project` : `<cwd>/.claude/commands/**\/*.md`
 *  - `plugin`  : `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/commands/**\/*.md`
 *                → コマンド名は `<plugin>:<file>` 形式 (例: `fe-pr:fe-pr`)
 *
 * ファイル名 (拡張子無し) がコマンド名のベース。サブディレクトリは `親:子` に潰す。
 * 先頭が YAML frontmatter (`---` で挟まれた領域) なら `description` / `argument-hint`
 * フィールドを尊重。それ以外は本文先頭の `# 見出し` 行か最初の非空行を description に使う。
 *
 * 読み取れないディレクトリ / ファイルは黙ってスキップ。
 */
export const scanCustomCommands = (cwd: string): CustomCommandInfo[] => {
  const userDir = path.join(os.homedir(), ".claude", "commands");
  const projectDir = path.join(cwd, ".claude", "commands");
  const out: CustomCommandInfo[] = [];
  out.push(...scanDir(userDir, "user"));
  if (projectDir !== userDir) out.push(...scanDir(projectDir, "project"));
  out.push(...scanPluginCommands());
  // 名前重複時は後勝ち (project > user > plugin の優先度になるよう順序設計)
  const byName = new Map<string, CustomCommandInfo>();
  for (const c of out) byName.set(c.name, c);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/commands/` を走査し、
 * `<plugin>:<file>` 形式のコマンド名で全部返す。
 * 同一 plugin に複数 version があれば、フォルダ名 sort で最後 (=多くの場合最新) を採用。
 */
const scanPluginCommands = (): CustomCommandInfo[] => {
  const pluginsCache = path.join(
    os.homedir(),
    ".claude",
    "plugins",
    "cache",
  );
  if (!existsSync(pluginsCache)) return [];
  const out: CustomCommandInfo[] = [];

  let marketplaces: string[];
  try {
    marketplaces = readdirSync(pluginsCache);
  } catch {
    return [];
  }
  for (const mp of marketplaces) {
    const mpDir = path.join(pluginsCache, mp);
    if (!isDir(mpDir)) continue;
    let plugins: string[];
    try {
      plugins = readdirSync(mpDir);
    } catch {
      continue;
    }
    for (const plugin of plugins) {
      const pDir = path.join(mpDir, plugin);
      if (!isDir(pDir)) continue;
      let versions: string[];
      try {
        versions = readdirSync(pDir);
      } catch {
        continue;
      }
      // 複数 version があるなら一番後ろ (=多くの場合最新) を使う
      versions.sort();
      const latest = versions[versions.length - 1];
      if (!latest) continue;
      const cmdDir = path.join(pDir, latest, "commands");
      if (!isDir(cmdDir)) continue;
      walkPlugin(cmdDir, cmdDir, plugin, out);
    }
  }
  return out;
};

const walkPlugin = (
  baseDir: string,
  curDir: string,
  plugin: string,
  out: CustomCommandInfo[],
): void => {
  let entries: string[];
  try {
    entries = readdirSync(curDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(curDir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkPlugin(baseDir, full, plugin, out);
      continue;
    }
    if (!entry.endsWith(".md")) continue;
    const rel = path
      .relative(baseDir, full)
      .replace(/\\/g, "/")
      .replace(/\.md$/i, "");
    const cmdName = `${plugin}:${rel.replace(/\//g, ":")}`;
    try {
      const text = readFileSync(full, "utf8");
      const { description, argumentHint } = describeMarkdown(text);
      out.push({
        name: cmdName,
        description: description || `(plugin: ${plugin})`,
        argumentHint,
        source: "plugin",
        plugin,
      });
    } catch {
      // skip
    }
  }
};

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const scanDir = (
  baseDir: string,
  source: "user" | "project",
): CustomCommandInfo[] => {
  if (!existsSync(baseDir)) return [];
  const out: CustomCommandInfo[] = [];
  walk(baseDir, baseDir, source, out);
  return out;
};

const walk = (
  baseDir: string,
  curDir: string,
  source: "user" | "project",
  out: CustomCommandInfo[],
): void => {
  let entries: string[];
  try {
    entries = readdirSync(curDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(curDir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(baseDir, full, source, out);
      continue;
    }
    if (!entry.endsWith(".md")) continue;
    const rel = path
      .relative(baseDir, full)
      .replace(/\\/g, "/")
      .replace(/\.md$/i, "");
    const cmdName = rel.replace(/\//g, ":"); // 例: claude-obsidian/canvas.md → claude-obsidian:canvas
    try {
      const text = readFileSync(full, "utf8");
      const { description, argumentHint } = describeMarkdown(text);
      out.push({
        name: cmdName,
        description: description || `(${source}) custom command`,
        argumentHint,
        source,
      });
    } catch {
      // skip unreadable
    }
  }
};

const describeMarkdown = (text: string): {
  description: string;
  argumentHint: string;
} => {
  // YAML frontmatter (--- ~ ---) があれば優先
  const fm = parseFrontmatter(text);
  if (fm) {
    const desc = fm.values.description || "";
    const hint =
      fm.values["argument-hint"] ||
      fm.values["argumentHint"] ||
      fm.values.args ||
      "";
    if (desc) return { description: oneLine(desc), argumentHint: hint };
    // frontmatter はあったが description が無いなら body から拾う
    return {
      description: firstUsefulLine(fm.body),
      argumentHint: hint,
    };
  }
  return {
    description: firstUsefulLine(text),
    argumentHint: "",
  };
};

const parseFrontmatter = (
  text: string,
): { values: Record<string, string>; body: string } | undefined => {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return undefined;
  const values: Record<string, string> = {};
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    values[kv[1]] = v;
  }
  return { values, body: m[2] };
};

const firstUsefulLine = (text: string): string => {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("---")) continue;
    return oneLine(line.replace(/^#{1,6}\s+/, ""));
  }
  return "";
};

const oneLine = (s: string): string =>
  s.replace(/\s+/g, " ").trim().slice(0, 120);
