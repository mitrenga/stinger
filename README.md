![](/images/app-icon-256x256.png)

STINGER
=====================
Faithful browser remake of the 1983 Seibu Denshi arcade shooter Stinger — work in progress.

## About
Released by Seibu Denshi in 1983 (their first game; distributed by Sigma in Japan and Venture Line in
the USA). A horizontally scrolling shooter on a vertically oriented screen. The original game logic is
rewritten in JavaScript from our own disassembly of the program ROMs (not emulated); see
`GAME-DESIGN.md` for the design and `MILESTONES.md` for the plan. Sibling projects: Space Invaders
(arcade platform), Pleiades (tile map, reference emulator, worker architecture), Battlezone, Manic
Miner, Jet Set Willy (same svision kernel).

Status: **ST-M2** — project skeleton: menu, hall of fame, settings, about, placeholder game screen with a
stub worker; ST-M1 (own disassembly of both Z80 programs, tracing emulator, graphics/map data from the ROM) is
complete — see `sources/asm/stinger/notes/`. Next: ST-M3 (reference emulator in JS, tile map + sprite
entities). The app icons, poster and cover in `images/` are placeholders copied from Pleiades/Manic Miner and
will be replaced in ST-M7.

## Play now
not deployed yet

## Requirements
- PHP 8.1+
- nginx
- MySQL / MariaDB
- Node.js + terser, for building the bundle (`npm i -g terser`)
- es-check, for the ES2018 compatibility gate in `svtool verify` (`npm i -g es-check`)
- Python 3 for the disassembler (`tools/dis/`)

## Install
(`~/` below refers to the project root, not your home directory.)
- clone this repository
- clone library repository https://github.com/mitrenga/svision
- check symlink ~/app/svision
- configure nginx (example: ~/config/nginx.conf)
- create path ~/js with permissions 0777
- create database (script: ~/config/createDB.sql)
- create configuration file ~/config/config.php (example: ~/config/config.php.sample)
- build the production bundle: ~/app/svision/tools/svtool build bundle

## Build & tooling
The `svtool` CLI (`~/app/svision/tools/svtool`) builds and checks the deploy. Run it from the project root:
- `svtool build bundle` — minified production bundle `js/bundle.<version>.min.js` (requires terser)
- `svtool build debug-bundle` — the same concatenation left unminified, `js/bundle.<version>.js`, for debugging on a device whose console cannot be opened
- `svtool verify` — check the `js/` deploy is complete, matches the current sources, and stays within ES2018
- `svtool info` — show the app version, deploy state and the most recent database records
- `svtool clean` — remove everything generated from `js/`

## Sources
Reference material (ROM, disassembly, MAME driver, manuals, sound recordings) lives in
`sources/` (see `GAME-DESIGN.md` chap. 8). The ROM sets (`sources/rom/*/`, `*.zip`) are
outside git; the rest of `sources/` is tracked.

## License
See the [LICENSE](LICENSE) file.
