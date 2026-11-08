#!/bin/bash
# browser-check.sh — ST-M3 acceptance test: the picture the browser draws must be
# pixel-identical to the picture refemu renders.
#
# Both sides run app/tileMapRender.js, so this checks the browser half of the
# path — ImageData, the canvas, the base64 decoding of data/screens.json and the
# ES2018 subset — against the Node half that produced sources/reference/screens/.
# The canvas is read back as a data URL from the DOM instead of screenshotting
# the window, so neither the viewport size nor the device scale factor can
# affect the result.
#
# Usage: tools/refemu/browser-check.sh [path-to-chrome]
set -e
cd "$(dirname "$0")/../.."

CHROME="${1:-}"
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
  echo "no Chrome/Chromium found — pass the path as the first argument" >&2
  exit 2
fi

PORT=${PORT:-8731}
OUT=${OUT:-/tmp/refemu-browser-check}
mkdir -p "$OUT"

python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
sleep 1

screens="title gameStart fortress"
status=0
for screen in $screens; do
  case $screen in
    title)     reference=sources/reference/screens/refemu-title-f600.png ;;
    gameStart) reference=sources/reference/screens/refemu-game-f420.png ;;
    fortress)  reference=sources/reference/screens/refemu-fortress-f2100.png ;;
  esac
  "$CHROME" --headless --disable-gpu --no-sandbox --virtual-time-budget=15000 \
    --dump-dom "http://127.0.0.1:$PORT/tools/refemu/browser-check.html?screen=$screen" 2>/dev/null \
  | OUT="$OUT" SCREEN="$screen" python3 -c "
import sys, re, base64, os
m = re.search(r'<div id=\"png\">data:image/png;base64,([A-Za-z0-9+/=]+)</div>', sys.stdin.read())
if not m:
    sys.stderr.write('no canvas data URL in the DOM\n')
    sys.exit(1)
open(os.path.join(os.environ['OUT'], 'browser-'+os.environ['SCREEN']+'.png'), 'wb').write(base64.b64decode(m.group(1)))
"
  printf '%-11s ' "$screen:"
  node tools/refemu/pngdiff.mjs "$reference" "$OUT/browser-$screen.png" --diff "$OUT/diff-$screen.png" || status=1
done
exit $status
