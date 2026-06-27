// Portable Windows zip builder for ma-browser-tray.
// Run: pnpm package:win  (from packages/tray-app)
// Produces: dist/ma-browser-tray-portable-v{VERSION}.zip
//
// Phases:
//   0. Version sync (package.json -> Cargo.toml + tauri.conf.json)
//   1. pnpm build (daemon + mcp bundles) + tauri build (exe with embedded resources)
//   2. Assemble staging dir (exe + daemon + mcp + node + icons + readme + mcp-config)
//   3. Fetch node.exe (download official Node LTS, extract node.exe only)
//   4. zip + structure verify

import { spawnSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  statSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Ensure cargo (Rust/Tauri) is on PATH for spawned children. On Windows the
// user's ~/.cargo/bin is added by rustup to the user PATH, but child spawns
// inherit the *process* env which may not have it when run from some shells.
const cargoBin = join(homedir(), '.cargo', 'bin');
if (process.env.PATH && !process.env.PATH.includes(cargoBin)) {
  process.env.PATH = `${cargoBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRAY_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(TRAY_DIR, '..', '..');
const NODE_VERSION = 'v20.15.0'; // pinned LTS; bump here to upgrade bundled Node

// mcp-config.json template. <APP_DIR> is filled at first tray run with the
// actual extraction root (current_exe().parent()). Backslashes are doubled
// because this is JSON; the tray's fill_placeholders escapes them too.
const MCP_CONFIG_TEMPLATE = `{
  "mcpServers": {
    "ma-browser": {
      "command": "<APP_DIR>\\\\node\\\\node.exe",
      "args": ["<APP_DIR>\\\\mcp\\\\mcp.js"],
      "env": { "MA_BROWSER_CONNECT_ONLY": "1" }
    }
  },
  "_meta": {
    "description": "ma-browser MCP server (connect-only; connects to the tray-owned daemon via ~/.bb-browser/daemon.json)",
    "app_dir_placeholder": "<APP_DIR>",
    "requires_daemon_running": true,
    "daemon_status_hint": "Tray icon must be green (daemon running) before MCP calls will succeed"
  }
}
`;

// --- helpers ----------------------------------------------------------------

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}${cwd ? '  (in ' + cwd + ')' : ''}`);
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} exited with ${r.status}`);
  }
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function patchFileRegex(path, regex, replacement) {
  const txt = readFileSync(path, 'utf8');
  if (!regex.test(txt)) throw new Error(`patchFile: pattern not found in ${path}`);
  writeFileSync(path, txt.replace(regex, replacement));
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

// --- Phase 0: version sync --------------------------------------------------

function syncVersion() {
  console.log('\n=== Phase 0: version sync ===');
  const { version } = readJson(join(REPO_ROOT, 'package.json'));
  console.log(`package.json version = ${version}`);
  patchFileRegex(
    join(TRAY_DIR, 'src-tauri', 'Cargo.toml'),
    /^version = ".*"/m,
    `version = "${version}"`
  );
  const confPath = join(TRAY_DIR, 'src-tauri', 'tauri.conf.json');
  const conf = readJson(confPath);
  conf.version = version;
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
  console.log('Synced Cargo.toml + tauri.conf.json');
}

// --- Phase 1: build ---------------------------------------------------------

function stageResources(resDir) {
  // Stage resources into src-tauri/resources/ so tauri.conf.json globs resolve.
  rmSync(resDir, { recursive: true, force: true });
  mkdirSync(join(resDir, 'node'), { recursive: true });
  mkdirSync(join(resDir, 'daemon', 'node_modules'), { recursive: true });
  mkdirSync(join(resDir, 'mcp'), { recursive: true });
  copyFileSync(
    join(TRAY_DIR, 'vendor', 'MicrosoftEdgeWebview2Setup.exe'),
    join(resDir, 'MicrosoftEdgeWebview2Setup.exe')
  );
  // daemon bundle + runtime deps
  copyFileSync(
    join(REPO_ROOT, 'packages', 'daemon', 'dist', 'index.js'),
    join(resDir, 'daemon', 'index.js')
  );
  copyFileSync(
    join(REPO_ROOT, 'packages', 'daemon', 'dist', 'buildDomTree.js'),
    join(resDir, 'daemon', 'buildDomTree.js')
  );
  copyDir(
    join(REPO_ROOT, 'packages', 'daemon', 'node_modules', 'ws'),
    join(resDir, 'daemon', 'node_modules', 'ws')
  );
  // MCP server bundle
  copyFileSync(join(REPO_ROOT, 'dist', 'mcp.js'), join(resDir, 'mcp', 'mcp.js'));
  // mcp-config.json template (with <APP_DIR> placeholder; tray fills it at first run)
  writeFileSync(join(resDir, 'mcp-config.json'), MCP_CONFIG_TEMPLATE);
}

function build() {
  console.log('\n=== Phase 1: build (pnpm build + tauri build) ===');
  run('pnpm', ['build'], REPO_ROOT); // turbo build -> daemon + mcp tsup bundles
  const resDir = join(TRAY_DIR, 'src-tauri', 'resources');
  stageResources(resDir);
  // node.exe must be present in resources for the tauri build's resource glob.
  ensureNodeExe(join(resDir, 'node', 'node.exe'));
  run('pnpm', ['tauri', 'build'], TRAY_DIR);
}

// --- Phase 2: assemble staging ----------------------------------------------

function assembleStaging(staging) {
  console.log('\n=== Phase 2: assemble staging ===');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const exe = join(TRAY_DIR, 'src-tauri', 'target', 'release', 'ma-browser-tray.exe');
  if (!existsSync(exe)) throw new Error(`exe not found: ${exe}`);
  copyFileSync(exe, join(staging, 'ma-browser-tray.exe'));
  // Copy sibling DLLs the exe loads at startup (WebView2Loader.dll is
  // statically imported by Tauri's webview2-com-sys; without it the exe
  // fails to load on a clean machine BEFORE any Rust code runs).
  const releaseDir = dirname(exe);
  for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.dll')) {
      copyFileSync(join(releaseDir, entry.name), join(staging, entry.name));
      console.log(`  + sibling DLL: ${entry.name}`);
    }
  }
  copyFileSync(
    join(TRAY_DIR, 'vendor', 'MicrosoftEdgeWebview2Setup.exe'),
    join(staging, 'MicrosoftEdgeWebview2Setup.exe')
  );
  mkdirSync(join(staging, 'daemon', 'node_modules'), { recursive: true });
  copyFileSync(
    join(REPO_ROOT, 'packages', 'daemon', 'dist', 'index.js'),
    join(staging, 'daemon', 'index.js')
  );
  copyFileSync(
    join(REPO_ROOT, 'packages', 'daemon', 'dist', 'buildDomTree.js'),
    join(staging, 'daemon', 'buildDomTree.js')
  );
  copyDir(
    join(REPO_ROOT, 'packages', 'daemon', 'node_modules', 'ws'),
    join(staging, 'daemon', 'node_modules', 'ws')
  );
  mkdirSync(join(staging, 'mcp'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'dist', 'mcp.js'), join(staging, 'mcp', 'mcp.js'));
  writeFileSync(join(staging, 'mcp-config.json'), MCP_CONFIG_TEMPLATE);
  mkdirSync(join(staging, 'node'), { recursive: true });
  ensureNodeExe(join(staging, 'node', 'node.exe'));
  copyDir(join(TRAY_DIR, 'icons'), join(staging, 'icons'));
  copyFileSync(join(TRAY_DIR, 'README.txt'), join(staging, 'README.txt'));
  copyFileSync(join(TRAY_DIR, 'README-EN.txt'), join(staging, 'README-EN.txt'));
  console.log('Staging assembled at', staging);
}

// --- Phase 3: fetch node.exe ------------------------------------------------

async function ensureNodeExe(dest) {
  if (existsSync(dest) && statSync(dest).size > 10_000_000) return; // already have it
  // Offline / local override: if LOCAL_NODE_EXE points at a real node.exe,
  // copy it instead of downloading (useful when nodejs.org is unreachable
  // but a local Node install exists).
  const local = process.env.LOCAL_NODE_EXE;
  if (local && existsSync(local) && statSync(local).size > 10_000_000) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(local, dest);
    console.log(`node.exe copied from LOCAL_NODE_EXE=${local} -> ${dest}`);
    return;
  }
  const cacheDir = join(TRAY_DIR, '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const cacheZip = join(cacheDir, `node-${NODE_VERSION}-win-x64.zip`);
  if (!existsSync(cacheZip)) {
    const url = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`;
    console.log(`Downloading ${url} ...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(cacheZip, buf);
  }
  // Extract only node.exe from the zip. Use the system 'tar' (Win10+ ships it).
  mkdirSync(dirname(dest), { recursive: true });
  const member = `node-${NODE_VERSION}-win-x64/node.exe`;
  const r = spawnSync('tar', ['-xf', cacheZip, '-C', dirname(dest), member], {
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) throw new Error(`tar extract failed: ${r.status}`);
  // tar extracts to <destDir>/node-.../node.exe; move it up.
  const extracted = join(dirname(dest), member);
  copyFileSync(extracted, dest);
  rmSync(join(dirname(dest), `node-${NODE_VERSION}-win-x64`), {
    recursive: true,
    force: true,
  });
  console.log('node.exe ready at', dest);
}

// --- Phase 4: zip + verify --------------------------------------------------

function zipAndVerify(staging, version) {
  console.log('\n=== Phase 4: zip + verify ===');
  const distDir = join(TRAY_DIR, 'dist');
  mkdirSync(distDir, { recursive: true });
  const zipName = `ma-browser-tray-portable-v${version}.zip`;
  const zipPath = join(distDir, zipName);
  if (existsSync(zipPath)) rmSync(zipPath);
  // Use PowerShell Compress-Archive on Windows; tar fallback otherwise.
  if (process.platform === 'win32') {
    const ps = `Compress-Archive -Path '${staging}' -DestinationPath '${zipPath}' -Force`;
    spawnSync('powershell', ['-NoProfile', '-Command', ps], {
      stdio: 'inherit',
      shell: true,
    });
  } else {
    run('tar', ['-a', '-c', '-f', zipPath, '-C', dirname(staging), 'ma-browser-tray']);
  }
  // Verify structure (extract to temp and assert required files).
  verifyStructure(staging);
  console.log(`\n✓ Built ${zipPath}`);

  // Convenience: also drop a copy in the user's Downloads dir so it's easy
  // to grab for testing on another machine.
  try {
    const downloads = join(homedir(), 'Downloads');
    if (existsSync(downloads)) {
      const dest = join(downloads, zipName);
      copyFileSync(zipPath, dest);
      console.log(`✓ Copied to ${dest}`);
    }
  } catch (e) {
    console.warn(`(could not copy to Downloads: ${e})`);
  }
}

function verifyStructure(staging) {
  const required = [
    'ma-browser-tray.exe',
    'WebView2Loader.dll',
    'MicrosoftEdgeWebview2Setup.exe',
    'node/node.exe',
    'daemon/index.js',
    'daemon/buildDomTree.js',
    'daemon/node_modules/ws/index.js',
    'mcp/mcp.js',
    'mcp-config.json',
    'icons/tray-green.png',
    'icons/tray-red.png',
    'icons/tray-yellow.png',
    'README.txt',
    'README-EN.txt',
  ];
  const missing = required.filter((r) => !existsSync(join(staging, r)));
  if (missing.length) {
    throw new Error(`verifyStructure: missing files: ${missing.join(', ')}`);
  }
  console.log('Structure verified: all required files present.');
}

// --- main -------------------------------------------------------------------

async function main() {
  // Pre-check: vendored bootstrapper must exist.
  const bootstrapper = join(TRAY_DIR, 'vendor', 'MicrosoftEdgeWebview2Setup.exe');
  if (!existsSync(bootstrapper)) {
    throw new Error(
      `Missing ${bootstrapper}. Download the WebView2 Evergreen Bootstrapper from ` +
        `https://developer.microsoft.com/microsoft-edge/webview2/ and place it there.`
    );
  }
  syncVersion();
  build();
  const { version } = readJson(join(REPO_ROOT, 'package.json'));
  const staging = join(TRAY_DIR, 'dist', 'portable-staging', 'ma-browser-tray');
  assembleStaging(staging);
  zipAndVerify(staging, version);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
