#!/usr/bin/env python3
"""
rom2font — builds the glyph table of app/stingerFonts8x8.js.

The font is a ZXFonts8x8 table (96 glyphs, 16 hex digits each, in the order of
ZXFonts8x8.fontsChars) filled from these sources, first match wins:

  1. the text tiles of Stinger, gfx1 bank 0 in data/tiles.json (rom2tiles):
     digits 00h-09h, A-Z 11h-2Ah, . ( ) = - ! ' " , and the colon 7Eh of the
     second (plain) alphabet; a pixel is set when the tile pen is not 0
  2. the two-tile copyright sign 49h+4Ah of the title picture, squeezed from
     9 to 8 pixels by hand (COPYRIGHT below)
  3. the nearest ZX Spectrum game fonts from ~/sw/zx-fonts (ranked by pixel
     distance of A-Z 0-9 to the Stinger letters), each only for the characters
     it really has as text and not as game graphics:
       Mimzoid Death Dude (1988)   ?
       G-Force (1983)              % + / ; < > ~ a-z
       Push Off (1983)             everything else (# $ & * @ [ \\ ] ^ _ £ { | })

Usage: python3 tools/rom2font.py   -> prints the hex string and the source of
every character; paste the string into StingerFonts8x8.
"""
import json, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZXFONTS = os.path.expanduser('~/sw/zx-fonts/ch8')
CH = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_£abcdefghijklmnopqrstuvwxyz{|}~©'

tiles = json.load(open(os.path.join(ROOT, 'data/tiles.json')))['gfx1'][0]
STINGER = {**{str(d): d for d in range(10)}, **{chr(65+i): 0x11+i for i in range(26)},
           '.': 0x2B, '(': 0x30, ')': 0x31, '=': 0x34, '-': 0x35, '!': 0x38, "'": 0x39, '"': 0x3A, ',': 0x43, ':': 0x7E}
COPYRIGHT = ['..####..', '.#....#.', '#..###.#', '#.#....#', '#.#....#', '#..###.#', '.#....#.', '..####..']
ZX = [('Mimzoid Death Dude (1988)(Grant Jaquest)(cs)#29800.ch8', '?'),
      ('G-Force (1983)(Eurobyte)#64000.ch8', '%+/;<>~abcdefghijklmnopqrstuvwxyz'),
      ('Push Off (1983)(Software Projects)#30400.ch8', None)]   # None = any remaining character

def tile_rows(code):
    t = tiles[code]
    return [sum((0x80 >> x) for x in range(8) if t[y*8+x] != '0') for y in range(8)]

def zx_rows(data, char):
    i = CH.index(char)*8
    return list(data[i:i+8])

fonts = [(open(os.path.join(ZXFONTS, name), 'rb').read(), chars, name.split(' (')[0]) for name, chars in ZX]
glyphs, sources = [], {}
for c in CH:
    if c == ' ':
        rows, src = [0]*8, 'space'
    elif c in STINGER:
        rows, src = tile_rows(STINGER[c]), 'Stinger'
    elif c == '©':
        rows, src = [int(r.replace('#', '1').replace('.', '0'), 2) for r in COPYRIGHT], 'Stinger 49h+4Ah'
    else:
        for data, chars, name in fonts:
            if chars is None or c in chars:
                rows, src = zx_rows(data, c), name
                break
    glyphs.append(rows)
    sources.setdefault(src, []).append(c)

hexdata = ''.join('%02X' % b for rows in glyphs for b in rows)
assert len(hexdata) == 96*16
print(hexdata)
for src, chars in sources.items():
    print('%-18s %s' % (src, ''.join(chars)), file=sys.stderr)
if '--show' in sys.argv:
    for text in ('STINGER 0123456789', '.()=-!\'",:©?', '#$%&*+/;<>@[\\]^_£{|}~', 'abcdefghijklmnopqrstuvwxyz'):
        for y in range(8):
            print(' '.join(''.join('#' if glyphs[CH.index(c)][y] & (0x80 >> x) else '.' for x in range(8)) for c in text), file=sys.stderr)
        print(file=sys.stderr)
