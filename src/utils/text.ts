/**
 * 末尾省略付きで文字列を `max` 文字以内に丸める。
 * UI 用途のシンプルな実装で、サロゲートペア境界などは考慮しない。
 */
export const truncate = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;

/** トークン数を 1.5K / 154.8K / 2.0M のように丸める。 */
export const formatTokens = (n: number): string => {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
};
