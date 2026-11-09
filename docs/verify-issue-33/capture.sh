#!/usr/bin/env bash
# Reproduce the issue-33 evidence: isolated Chromium + daemon + BB_BROWSER_HOME
# (never touches ~/.bb-browser). Writes upload.txt and health.txt next to this
# script. Usage: bash docs/verify-issue-33/capture.sh   (after `pnpm build`)
set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
home=$(mktemp -d /tmp/ma-v33-XXXX)
port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
CDP=$(port); HTTP=$(port); WEB=$(port)
mkdir -p "$home/www" "$home/files"
cat >"$home/www/upload.html" <<'EOF'
<title>upload</title>
<input type="file" id="doc" accept=".txt" aria-label="Doc">
<button id="plain">Plain</button>
EOF
printf 'hello upload' >"$home/files/note.txt"
printf 'png' >"$home/files/pic.png"

"${CHROMIUM:-/usr/lib/chromium/chromium}" --headless=new --remote-debugging-port="$CDP" \
  --user-data-dir="$home/profile" --no-first-run about:blank >/dev/null 2>&1 &
chrome=$!
python3 -m http.server "$WEB" --bind 127.0.0.1 --directory "$home/www" >/dev/null 2>&1 &
web=$!
BB_BROWSER_HOME="$home" node "$root/dist/daemon.js" --port "$HTTP" --cdp-port "$CDP" >/dev/null 2>&1 &
daemon=$!
trap 'kill $daemon $web $chrome 2>/dev/null; wait 2>/dev/null; rm -rf "$home"' EXIT
for _ in $(seq 50); do [ -f "$home/daemon.json" ] && curl -s "http://127.0.0.1:$CDP/json/version" >/dev/null && break; sleep 0.2; done

ma() { BB_BROWSER_HOME="$home" BB_BROWSER_CDP_URL="http://127.0.0.1:$CDP" node "$root/dist/cli.js" "$@" 2>&1; }
run() { echo "\$ ma-browser $*"; ma "$@"; echo; }

{
  tab=$(ma open "http://127.0.0.1:$WEB/upload.html" --json | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).data.tab))')
  run snapshot -i --tab "$tab"
  run upload "#doc" "$home/files/note.txt" --tab "$tab"
  run eval "document.querySelector('#doc').files[0].name" --tab "$tab"
  run upload "#doc" "$home/files/pic.png" --tab "$tab"
  run upload "#doc" "$home/files/missing.txt" --tab "$tab"
  run upload "#plain" "$home/files/note.txt" --tab "$tab"
  run upload "#doc" "$home/files/note.txt" "$home/files/pic.png" --tab "$tab"
} | sed "s#$home#<tmp>#g" >"$here/upload.txt"

{
  run status
  echo "\$ BB_COMMAND_TIMEOUT_EVAL_MS=2000 ma-browser eval 'new Promise(() => {})'"
  BB_COMMAND_TIMEOUT_EVAL_MS=2000 ma eval 'new Promise(() => {})'; echo
  echo "\$ BB_COMMAND_TIMEOUT_WAIT_MS=1000 ma-browser wait 3000"
  BB_COMMAND_TIMEOUT_WAIT_MS=1000 ma wait 3000; echo
  run status
} | sed "s#$home#<tmp>#g" >"$here/health.txt"
