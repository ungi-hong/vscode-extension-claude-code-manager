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
  // SDK は ESM 専用 + 自身の executable パスを内部で解決する。
  // bundle に含めるとパス解決が壊れるので external 化し、ランタイムで
  // dynamic import で読み込む (VSCode は Node20 ベースで CJS → ESM dynamic import 可)。
  external: ["vscode", "fsevents", "@anthropic-ai/claude-agent-sdk"],
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

/**
 * SDK + プラットフォーム別バイナリを dist/node_modules/ に物理コピーする。
 *
 * - external 設定のため esbuild が SDK を bundle しない。
 * - VSIX 内に SDK を含めないと runtime で `Cannot find package` エラー。
 * - pnpm の .pnpm/<pkg>@<ver>/node_modules/<pkg> は symlink なので dereference して
 *   `dist/node_modules/@anthropic-ai/...` に flat 配置する。
 * - Node の解決は dist/extension.js の親 dir から node_modules/ を探すので、
 *   dist/node_modules/ にあれば自動で見つけられる。
 */
function copySdkVendor() {
  const platform = process.platform; // "darwin" | "linux" | "win32"
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const platformPkg = `claude-agent-sdk-${platform}-${arch}`;

  // 「@anthropic-ai/<name>」のパッケージを node_modules から見つける。
  // pnpm の optional dep は top-level に symlink されないので、見つからなければ
  // .pnpm/ ストア内を totally探す (バージョン情報から)。
  const findPkg = (subName) => {
    const direct = path.join("node_modules", "@anthropic-ai", subName);
    if (fs.existsSync(direct)) return direct;
    // fallback: .pnpm/<scope>+<name>@<ver>/node_modules/<scope>/<name>
    const pnpmRoot = path.join("node_modules", ".pnpm");
    if (!fs.existsSync(pnpmRoot)) return undefined;
    for (const entry of fs.readdirSync(pnpmRoot)) {
      if (!entry.startsWith(`@anthropic-ai+${subName}@`)) continue;
      const candidate = path.join(
        pnpmRoot,
        entry,
        "node_modules",
        "@anthropic-ai",
        subName,
      );
      if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
  };

  // 注: プラットフォーム別バイナリ (claude-agent-sdk-<platform>-<arch>, 約 208MB)
  // は同梱しない。代わりに extension.ts で `which claude` で解決した実行ファイルを
  // SDK の `pathToClaudeCodeExecutable` オプションに渡す。これで VSIX サイズが
  // 60MB+ → ~5MB に縮む & プラットフォーム横断 (mac/Linux/Win) になる。
  // ユーザー環境に `claude` CLI が無い場合は SDK が同梱バイナリを探しに行くので
  // 動かないが、この拡張を使う人は Claude Code 利用者なので既に持ってる前提。
  const sources = [
    {
      label: "claude-agent-sdk (main)",
      src: findPkg("claude-agent-sdk"),
      dest: "dist/node_modules/@anthropic-ai/claude-agent-sdk",
    },
  ];

  for (const { label, src, dest } of sources) {
    if (!src || !fs.existsSync(src)) {
      console.warn(`[copySdkVendor] skip ${label}: not found in node_modules`);
      continue;
    }
    // 既存削除してから dereference (pnpm symlink を解決) でコピー
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, {
      recursive: true,
      dereference: true,
      preserveTimestamps: true,
    });
    const size = dirSizeMB(dest);
    console.log(`[copySdkVendor] ${label}: ${size.toFixed(1)} MB  (${src} → ${dest})`);
  }
}

function dirSizeMB(p) {
  let total = 0;
  const walk = (q) => {
    const stat = fs.statSync(q);
    if (stat.isFile()) {
      total += stat.size;
      return;
    }
    if (stat.isDirectory()) {
      for (const e of fs.readdirSync(q)) walk(path.join(q, e));
    }
  };
  walk(p);
  return total / 1024 / 1024;
}

async function run() {
  if (watch) {
    const ctxExt = await esbuild.context(extensionOptions);
    const ctxWeb = await esbuild.context(webviewOptions);
    copyStatic();
    copySdkVendor();
    await Promise.all([ctxExt.watch(), ctxWeb.watch()]);
    console.log("watching...");
  } else {
    await Promise.all([
      esbuild.build(extensionOptions),
      esbuild.build(webviewOptions),
    ]);
    copyStatic();
    copySdkVendor();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
