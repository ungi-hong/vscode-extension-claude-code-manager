/**
 * Webview の `script-src 'nonce-...'` CSP に渡すランダムトークンを生成。
 *
 * Math.random ベースなので暗号学的に安全ではないが、CSP nonce の用途
 * (ページ毎に違う非予測可能値で inline script を許可する) には十分。
 * 取得頻度が低く、Webview HTML 生成ごとに 1 回呼ばれるだけ。
 */
export function makeNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
