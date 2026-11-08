#!/bin/bash
# browser-sound-check.sh — ST-M6 end-to-end test: the sound board must produce
# sound inside a real browser.
#
# tools/regress-sound.mjs proves the transcription of the sound program against
# the reference emulator and tools/render-sound.mjs turns it into a WAV, both
# under Node. This checks the other half — that app/stingerSoundHandler.js's way
# of composing the AudioWorklet really works: the three ES modules
# (app/aySynth.js, app/soundDriver.js, app/stingerSoundProcessor.js) put through
# the svtool bundle transformation, concatenated into one classic script, loaded
# from a blob URL and registered in an OfflineAudioContext, then driven by a
# script of latch writes. The page reports length, peak and RMS of every case;
# this script also renders the same latch script with tools/render-sound.mjs and
# compares the numbers (not sample-exact — different code path, same board).
#
# Usage: tools/refemu/browser-sound-check.sh [seconds] [path-to-chrome]
set -e
cd "$(dirname "$0")/../.."

SECONDS_LEN=${1:-5}
CHROME="${2:-}"
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
  echo "no Chrome/Chromium found — pass the path as the second argument" >&2
  exit 2
fi

PORT=${PORT:-8733}
OUT=${OUT:-/tmp/refemu-browser-sound}
RATE=48000
mkdir -p "$OUT"

python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
sleep 1

# ---------------------------------------------------------------- the Node reference
# An --ay-nmi log in the shape tools/refemu/run.mjs writes, but made here: the
# latch column is all render-sound.mjs --from-driver reads, and that column is
# exactly the page's script — command 02h once, then 00h in every frame, as the
# main CPU does (0CB8h). Four NMI rows per 60 Hz frame.
SECONDS_LEN="$SECONDS_LEN" RATE="$RATE" OUT="$OUT" python3 -c "
import os
rows = int(float(os.environ['SECONDS_LEN'])*240)
zeros = '\t'.join(['00']*32)
with open(os.path.join(os.environ['OUT'], 'cmd02.tsv'), 'w') as f:
    f.write('frame\tnmi\tlatch\t' + '\t'.join('r%d' % i for i in range(32)) + '\n')
    for i in range(rows):
        latch = '02' if i < 4 else '00'   # the command is held for one frame, as the main CPU holds it
        f.write('%d\t%d\t%s\t%s\n' % (i//4, i%4, latch, zeros))
"
# --limit applies the worklet's own output stage (app/aySynth.js softLimit), so
# this is the same code on both sides and the ratio below has to be 1.000
RENDER=$(node tools/render-sound.mjs --from-driver --limit --from-log "$OUT/cmd02.tsv" \
  --out "$OUT/cmd02.wav" --rate "$RATE" | tail -1)
echo "node reference: $RENDER"
# render-sound.mjs normalises the WAV to a peak of 0.89 and prints the raw one,
# so the RMS of the file has to be scaled back to compare with the browser
NODE_PEAK=$(echo "$RENDER" | sed -n 's/.*peak \([0-9.]*\).*/\1/p')
NODE_RMS=$(OUT="$OUT" NODE_PEAK="$NODE_PEAK" python3 -c "
import os, wave, struct, math
w = wave.open(os.path.join(os.environ['OUT'], 'cmd02.wav'))
n = w.getnframes()
data = struct.unpack('<%dh' % n, w.readframes(n))
rms = math.sqrt(sum(v*v for v in data)/n)/32767.0
print('%.6f' % (rms*float(os.environ['NODE_PEAK'])/0.89))
")
echo "node reference cmd 02: raw peak $NODE_PEAK, raw RMS $NODE_RMS"

# ---------------------------------------------------------------- the browser
"$CHROME" --headless --disable-gpu --no-sandbox --virtual-time-budget=900000 \
  --dump-dom "http://127.0.0.1:$PORT/tools/refemu/browser-sound-check.html?seconds=$SECONDS_LEN&rate=$RATE" 2>/dev/null \
| NODE_RMS="$NODE_RMS" python3 -c "
import sys, re, json, os
html = sys.stdin.read()
m = re.search(r'<div id=\"result\">(.*?)</div>', html, re.S)
if not m:
    sys.stderr.write('no result in the DOM — the page threw before it could report\n')
    sys.exit(1)
r = json.loads(m.group(1).replace('&quot;', '\"').replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>'))
if r.get('failed'):
    sys.stderr.write('page failed: ' + r['failed'] + '\n')
    sys.exit(1)
print('worklet module: %d bytes, sample rate %d' % (r['moduleBytes'], r['rate']))
bad = []
for name, c in r['cases'].items():
    print('  %-10s %.2f s, %d samples, peak %.4f, RMS %.4f' %
          (name, c['seconds'], c['samples'], c['peak'], c['rms']))
if r['errors']:
    for e in r['errors']:
        sys.stderr.write('console: ' + str(e) + '\n')
    bad.append('%d error(s) on the console' % len(r['errors']))
music = r['cases']['music-02']
sounds = r['cases']['sounds-10']
masked = r['cases']['sounds-02']
if music['peak'] <= 0.001 or music['rms'] <= 0.0005:
    bad.append('the MUSIC case is silent')
if sounds['peak'] <= 0.001 or sounds['rms'] <= 0.0005:
    bad.append('the SOUNDS case is silent')
if masked['peak'] > 0.001:
    bad.append('the role mask leaks: a tune is audible on the SOUNDS bus')
ref = float(os.environ['NODE_RMS'])
if ref > 0:
    ratio = music['rms']/ref
    print('  RMS against tools/render-sound.mjs: %.4f / %.4f = %.3f' % (music['rms'], ref, ratio))
    # Both sides now run the same output stage, so anything but 1.000 is a real
    # difference between the browser and Node.
    if not (0.99 <= ratio <= 1.01):
        bad.append('the browser and Node renders differ (%.3f, expected 1.000)' % ratio)
if bad:
    sys.stderr.write('FAILED: ' + '; '.join(bad) + '\n')
    sys.exit(1)
print('sound in the browser: OK')
"
