#!/bin/bash
# compare-python.sh — independent check of the renderer against the ST-M1 Python
# tracer (tools/dis/trace-stinger.py), whose title screen was verified pixel by
# pixel against the MAME screenshot from arcade-museum.
#
# What is compared is a *picture rendered from the same machine state*: the two
# emulators cannot be compared frame by frame, because the Python tracer counts
# instructions instead of T-states (it runs roughly ten times too fast — its init
# ends at frame 25, refemu's at 194, which is the correct value). So the check is:
# take the Python tracer's dump, render it with app/tileMapRender.js, and require
# the result to be identical to the picture the Python tracer drew itself. That
# isolates the renderer from the CPU; the CPU is verified by ZEXDOC/ZEXALL and by
# the attract timing (title = 898 frames vs. the ~900 derived in notes/A.md).
#
# Usage: tools/refemu/compare-python.sh [scratch-dir]
set -e
cd "$(dirname "$0")/../.."
OUT="${1:-/tmp/refemu-compare}"
mkdir -p "$OUT"

echo "== ST-M1 Python tracer: dump + its own picture =="
python3 tools/dis/trace-stinger.py --frames 301 --shot 300="$OUT/py-title.png" --dump 300="$OUT/py-title.bin" >/dev/null
python3 tools/dis/trace-stinger.py --frames 201 --input sources/reference/input-game.txt \
  --shot 200="$OUT/py-game.png" --dump 200="$OUT/py-game.bin" >/dev/null

echo "== app/tileMapRender.js on the same dumps =="
node tools/refemu/render-dump.mjs "$OUT/py-title.bin" "$OUT/js-title.png"
node tools/refemu/render-dump.mjs "$OUT/py-game.bin" "$OUT/js-game.png"

# a byte comparison would be useless: the Python tracer writes RGB PNGs and
# tools/lib/png.mjs writes RGBA ones, so the pixels are what must be compared
status=0
for name in title game; do
  printf '%-6s ' "$name:"
  node tools/refemu/pngdiff.mjs "$OUT/py-$name.png" "$OUT/js-$name.png" --diff "$OUT/diff-$name.png" || status=1
done
exit $status
