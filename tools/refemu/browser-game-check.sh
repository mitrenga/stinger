#!/bin/bash
# browser-game-check.sh — ST-M4 end-to-end test: app/gameWorker.js run in a real
# browser must produce the same picture as the reference emulator.
#
# tools/regress.mjs runs the worker in Node and compares RAM; this checks the
# other half — that the transcription really works in a browser engine (its
# ES2018 subset, the generators, atob on data/tables.json) and that the picture
# drawn through ImageData and the canvas matches refemu pixel for pixel. The
# canvas is read back as a data URL, so viewport size and device scale factor
# cannot affect the result.
#
# Usage: tools/refemu/browser-game-check.sh [frame] [play|attract] [path-to-chrome]
set -e
cd "$(dirname "$0")/../.."

FRAME=${1:-640}
SCRIPT=${2:-play}
CHROME="${3:-}"
if [ -z "$CHROME" ]; then
  for candidate in \
    "$(command -v google-chrome || true)" \
    "$(command -v chromium || true)" \
    "$(command -v chromium-browser || true)" \
    "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux/chrome; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then CHROME="$candidate"; break; fi
  done
fi
if [ ! -x "$CHROME" ]; then
  echo "no Chrome/Chromium found — pass the path as the third argument" >&2
  exit 2
fi

PORT=${PORT:-8732}
OUT=${OUT:-/tmp/refemu-browser-game}
mkdir -p "$OUT"

python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
sleep 1

echo "reference: frame $FRAME of the $SCRIPT scenario"
node tools/refemu/run.mjs --frames $((FRAME+1)) --quiet \
  --input "sources/reference/input-$SCRIPT.txt" --shot "$FRAME=$OUT/reference.png"

# the page ticks the worker FRAME+1 times, so its state matches refemu's after frame FRAME
"$CHROME" --headless --disable-gpu --no-sandbox --virtual-time-budget=120000 \
  --dump-dom "http://127.0.0.1:$PORT/tools/refemu/browser-game-check.html?frames=$((FRAME+1))&script=$SCRIPT" 2>/dev/null \
| OUT="$OUT" python3 -c "
import sys, re, base64, os
html = sys.stdin.read()
png = re.search(r'<div id=\"png\">data:image/png;base64,([A-Za-z0-9+/=]+)</div>', html)
info = re.search(r'<div id=\"info\">(.*?)</div>', html)
if not png:
    sys.stderr.write('no canvas data URL in the DOM — the worker probably threw\n')
    sys.exit(1)
open(os.path.join(os.environ['OUT'], 'browser.png'), 'wb').write(base64.b64decode(png.group(1)))
print('worker in the browser: ' + (info.group(1) if info else '?'))
"
printf 'picture: '
node tools/refemu/pngdiff.mjs "$OUT/reference.png" "$OUT/browser.png" --diff "$OUT/diff.png"
