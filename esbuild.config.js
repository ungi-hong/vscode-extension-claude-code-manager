// @ts-check
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  // VSCode が提供するモジュールは external (bundle に含めない)。
  // SDK (`@anthropic-ai/claude-agent-sdk`) は依存から削除し、代わりに
  // ユーザー環境の `claude` CLI を `child_process.spawn` で直接呼ぶようにした
  // (公式の VSCode 拡張と同じ方式)。これにより VSIX サイズが大幅に縮小し、
  // SDK バージョン追従の保守コストも消えた。
  external: ["vscode", "fsevents"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  entryPoints: ["src/views/webview/main.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: "dist/webview/main.js",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

function copyStatic() {
  const targets = [
    { from: "src/views/webview/index.html", to: "dist/webview/index.html" },
    { from: "src/views/webview/style.css", to: "dist/webview/style.css" },
  ];
  for (const { from, to } of targets) {
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

async function run() {
  if (watch) {
    const ctxExt = await esbuild.context(extensionOptions);
    const ctxWeb = await esbuild.context(webviewOptions);
    copyStatic();
    await Promise.all([ctxExt.watch(), ctxWeb.watch()]);
    console.log("watching...");
  } else {
    await Promise.all([
      esbuild.build(extensionOptions),
      esbuild.build(webviewOptions),
    ]);
    copyStatic();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
