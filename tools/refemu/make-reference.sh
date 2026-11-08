#!/bin/bash
# make-reference.sh — regenerates every reference artifact of ST-M3 from the ROM.
#
# Produces (all derived from the ROM, which itself stays out of git):
#   sources/reference/screens/refemu-*.png   pictures of the title, the demo and the game
#   sources/reference/dump-*.bin             RAM/VRAM/attributes/sprite RAM + registers
#   sources/reference/trace-*.tsv            per-frame registers, watched RAM, sound latches
#   sources/reference/ay-*.tsv               per-frame registers of both AY-3-8910 (ST-M6)
#   data/screens.json                        the frames the browser shows until ST-M4
#
# Frame numbers are real 60 Hz frames (refemu counts T-states): init ends at frame
# 194, the attract title runs 194-1092 (898 frames, matching the ~900 derived from
# the disassembly in notes/A.md) and the demo 1092-4633.
#
# Usage: tools/refemu/make-reference.sh
set -e
cd "$(dirname "$0")/../.."

REF=sources/reference
RUN="node tools/refemu/run.mjs"
# game-state bytes of RAMUse.md: state, frame counter, credits, round, lives, score
ADDRS=c0a2,c0a0,c0ac,c0bb,c0a8,c06d,c06e,c06f

mkdir -p "$REF/screens"

echo "== attract (no input, 6000 frames = title, demo, title again) =="
$RUN --frames 6000 \
  --shot 600="$REF/screens/refemu-title-f600.png" \
  --shot 2000="$REF/screens/refemu-demo-f2000.png" \
  --state 600="$REF/state-title-f600.json" \
  --dump 600="$REF/dump-title-f600.bin" \
  --trace "$REF/trace-attract.tsv" --trace-addrs "$ADDRS" \
  --ay "$REF/ay-attract.tsv"

echo
echo "== game (sources/reference/input-play.txt, 2200 frames) =="
$RUN --frames 2200 --input "$REF/input-play.txt" \
  --shot 420="$REF/screens/refemu-game-f420.png" \
  --shot 2100="$REF/screens/refemu-fortress-f2100.png" \
  --layers 2100="$REF/screens/refemu-fortress-f2100-layers.png" \
  --sprites 2100="$REF/screens/refemu-fortress-f2100-sprites.png" \
  --state 420="$REF/state-game-f420.json" \
  --state 2100="$REF/state-fortress-f2100.json" \
  --dump 420="$REF/dump-game-f420.bin" \
  --trace "$REF/trace-game.tsv" --trace-addrs "$ADDRS" \
  --ay "$REF/ay-game.tsv"

echo
echo "== data/screens.json =="
node -e '
const fs = require("fs");
const pick = (f) => { const s = JSON.parse(fs.readFileSync(f, "utf8")); delete s.source; return s; };
fs.writeFileSync("data/screens.json", JSON.stringify({
  note: "Video states captured by tools/refemu (ST-M3, tools/refemu/make-reference.sh): the attract title, the start of the game and a fortress section. ST-M4 replaces them with live worker frames.",
  title: pick("sources/reference/state-title-f600.json"),
  gameStart: pick("sources/reference/state-game-f420.json"),
  fortress: pick("sources/reference/state-fortress-f2100.json")
}, null, 1));
console.log("data/screens.json: "+fs.statSync("data/screens.json").size+" B");
'

echo
echo "done. Checks:"
echo "  tools/refemu/compare-python.sh     renderer against the ST-M1 Python tracer"
echo "  node tools/refemu/zexrun.mjs sources/reference/zex/zexall.com"
