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
