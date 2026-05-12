import * as os from "os";
import * as path from "path";

export const claudeProjectsRoot = (): string =>
  path.join(os.homedir(), ".claude", "projects");

/**
 * Decode the directory name back into a filesystem path.
 * Claude encodes "/" as "-" and prefixes with "-", so:
 *   /Users/foo/bar  →  -Users-foo-bar
 * This function reverses that for display purposes.
 */
export const decodeProjectDir = (encoded: string): string => {
  if (!encoded.startsWith("-")) return encoded;
  return "/" + encoded.slice(1).replace(/-/g, "/");
};

export const projectBaseName = (cwd: string): string => {
  const base = path.basename(cwd);
  return base || cwd;
};

/**
 * Encode a filesystem path into the directory name Claude uses:
 *   /Users/foo/bar  →  -Users-foo-bar
 * Mirror image of {@link decodeProjectDir}.
 */
export const encodeCwdToProjectDir = (cwd: string): string =>
  cwd.replace(/\//g, "-");

/**
 * Absolute path of the JSONL file Claude writes for the given session under
 * the given working directory: `~/.claude/projects/{encoded(cwd)}/{sid}.jsonl`.
 */
export const sessionJsonlPath = (cwd: string, sessionId: string): string =>
  path.join(claudeProjectsRoot(), encodeCwdToProjectDir(cwd), `${sessionId}.jsonl`);
