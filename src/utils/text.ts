/**
 * 末尾省略付きで文字列を `max` 文字以内に丸める。
 * UI 用途のシンプルな実装で、サロゲートペア境界などは考慮しない。
 */
export const truncate = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
