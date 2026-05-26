import * as path from "path";

/**
 * Windows でドライブレターを大文字に揃え、`path.normalize` を通した cwd を返す。
 *
 * 経緯: `claude remote-control` は `.claude.json` の `projects` キーで trust 状態を
 * lookup するが、キーは大文字小文字を区別する。VSCode が小文字ドライブで cwd を
 * 渡すと、ターミナルで大文字キーに承認した trust が再利用されず "Workspace not
 * trusted" で落ちる。CLI に cwd を渡す箇所では必ずこの関数を通す。
 */
export const normalizeCwd = (cwd: string): string => {
  const normalized = path.normalize(cwd);
  if (process.platform === "win32" && /^[a-z]:/.test(normalized)) {
    return normalized[0].toUpperCase() + normalized.slice(1);
  }
  return normalized;
};
