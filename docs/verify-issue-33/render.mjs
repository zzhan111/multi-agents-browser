#!/usr/bin/env node
// Render captured terminal output (*.txt) to a PNG with headless Chromium.
// Usage: node docs/verify-issue-33/render.mjs <in.txt> <out.png> [title]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [input, output, title = input] = process.argv.slice(2);
const text = readFileSync(input, "utf8").replace(/\s+$/, "");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const body = esc(text)
  .split("\n")
  .map((line) => {
    if (line.startsWith("$ ") || line.trimStart().startsWith("$ ")) return `<span class="cmd">${line}</span>`;
    if (/错误|✖|fail [1-9]|Failed:|degraded|stalled|timed out/.test(line)) return `<span class="bad">${line}</span>`;
    if (/PASS|✔|Health:\s+ok|已上传|fail 0|exit 0/.test(line)) return `<span class="good">${line}</span>`;
    return line;
  })
  .join("\n");
const lines = text.split("\n").length;
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#1e1f24;color:#d7dae0;font:13px/18px "DejaVu Sans Mono","Noto Sans Mono CJK SC",monospace}
h1{margin:0;padding:10px 16px;font:600 13px sans-serif;background:#2b2d35;color:#9aa4b2}
pre{margin:0;padding:12px 16px;white-space:pre-wrap;word-break:break-all}
.cmd{color:#8ab4f8}.good{color:#7ccf8a}.bad{color:#f28b82}
</style><h1>${esc(title)}</h1><pre>${body}</pre>`;
const dir = mkdtempSync(join(tmpdir(), "ma-render-"));
try {
  const page = join(dir, "page.html");
  writeFileSync(page, html);
  const height = 60 + lines * 18 + Math.ceil(text.length / 160) * 18;
  execFileSync(process.env.CHROMIUM ?? "/usr/lib/chromium/chromium", [
    "--headless=new", "--no-first-run", "--hide-scrollbars", `--user-data-dir=${join(dir, "p")}`,
    `--window-size=1280,${height}`, `--screenshot=${resolve(output)}`, `file://${page}`,
  ], { stdio: "ignore" });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
