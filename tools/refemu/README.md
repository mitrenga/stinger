# tools/refemu — referenční emulátor Stingeru (ST-M3)

Vlastní emulátor celého automatu v JavaScriptu. Slouží ke třem věcem:

1. **generuje referenční data**, proti kterým se regresně testuje remake (ST‑M4/M5: `tools/regress.mjs`,
   ST‑M6: registry AY),
2. **kreslí obraz stejným kódem jako prohlížeč** — `app/tileMapRender.js` je sdílený modul, takže pixelová
   shoda remaku s referencí je konstrukční, ne náhodná,
3. **je nezávislou kontrolou** disassemblace: pokud se emulátor chová jinak než přepsaná logika, chyba je
   v jednom ze dvou míst a trasy ukážou kde.

## Soubory

| soubor | co dělá |
|---|---|
| `z80.js` | jádro Z80 s přesnými T‑stavy, MEMPTR a nedokumentovanými instrukcemi/příznaky |
| `zexrun.mjs` | CP/M harness (BDOS stub na 0005h) pro ZEXDOC/ZEXALL |
| `machine.js` | automat: paměťová mapa obou CPU, dešifrování opkódů, NMI 60 Hz / 240 Hz, DIP, latch, AY log |
| `run.mjs` | běhoun: skript vstupů, PNG, dumpy, trasy, AY log |
| `render-dump.mjs` | vykreslí PNG z dumpu (refemu i `trace-stinger.py`) sdíleným rendererem |
| `pngdiff.mjs` | porovná dva PNG po pixelech (bajtové srovnání nejde: RGB vs. RGBA) |
| `profile.mjs` | změří, kolik T-stavů originál skutečně utratí v daném rozsahu adres (per snímek i celkem) |
| `make-reference.sh` | vyrobí všechna referenční data do `sources/reference/` a `data/screens.json` |
| `compare-python.sh` | ověří renderer proti trasovacímu emulátoru z ST‑M1 nad **stejným dumpem** |
| `browser-check.html` + `browser-check.sh` | přejímací test ST‑M3: obraz z headless prohlížeče musí být pixelově shodný s PNG z refemu |
| `browser-game-check.html` + `browser-game-check.sh` | přejímací test ST‑M4: **worker běžící v prohlížeči** musí vykreslit tentýž obraz jako refemu |

## Předpoklady

- `sources/rom/stinger/` s ROM setem (mimo git) a `decrypted/{opcodes,program}.bin`
  (`node tools/decrypt-stinger.mjs`),
- `data/{tiles,sprites,palette}.json` (`node tools/rom2tiles.mjs`).

## Test jádra Z80

```
node tools/refemu/zexrun.mjs sources/reference/zex/zexdoc.com
node tools/refemu/zexrun.mjs sources/reference/zex/zexall.com
```

Oba běhy musí skončit samými `OK`. ZEXALL testuje i nedokumentované příznaky; bez jeho průchodu
se referenční data negenerují (rozhodnutí ST‑M3).

## Proč nelze porovnávat po snímcích s emulátorem z ST‑M1

`tools/dis/trace-stinger.py` počítá **instrukce** (`--ipf 51200`), ne T‑stavy, a běží proto zhruba
**10× rychleji** než skutečný automat: init mu skončí snímkem 25, refemu snímkem 194. Stejná čísla
snímků tedy u obou nástrojů znamenají různé stavy programu. `compare-python.sh` proto porovnává
*obraz vykreslený ze stejného dumpu*, čímž oddělí renderer od procesoru; procesor ověřuje ZEXALL
a časování attractu (titul 898 snímků proti „≈ 900" odvozeným v `notes/A.md`).

## Běh automatu

```
node tools/refemu/run.mjs --frames 600 [volby]
```

| volba | význam |
|---|---|
| `--input soubor` | skript vstupů, řádky `snímek klávesy` (`c` mince, `1`/`2` start, `l r u d` páka, `f` výstřel, `b` Bongo); stav platí do dalšího řádku |
| `--shot N=out.png` | obraz po snímku N (224×256, orientace hráče) |
| `--layers N=out.png` / `--sprites N=out.png` | jen dlaždicové vrstvy / jen sprajty (ladění) |
| `--state N=out.json` | video stav (VRAM, atributy, sprite RAM, registry; base64) ve tvaru zprávy `frame` |
| `--dump N=out.bin` | RAM 800h + VRAM/ATTR/SPR obou vrstev + registry, bajtově shodné s `trace-stinger.py --dump` |
| `--trace out.tsv` | per snímek: PC/SP/AF/BC/DE/HL/IX/IY, sledované bajty RAM, latche F800, počty F80A a F808 |
| `--trace-addrs a,b,…` | které adresy RAM sledovat (hex) |
| `--ay out.tsv` | per snímek: všech 16 registrů obou AY‑3‑8910 + počet zápisů (ST‑M6) |
| `--dsw0 EF` / `--dsw1 AE` | DIP (výchozí = tovární, kap. 2.4) |
| `--no-sound` | neběží zvukový CPU (rychlejší dlouhé trasy bez AY logu) |
| `--scale N` | celočíselné zvětšení PNG |

## Model automatu (kap. 2.1/2.2, MAME `wiz.cpp`)

- **Hlavní CPU** Z80 3,072 MHz (18,432/6). Snímek = přesně **51 200 T‑stavů**; přetečení poslední
  instrukce se přenáší do dalšího snímku. NMI 1× za snímek na začátku (VBLANK), maskované F001 bit 0.
  Opkódy se čtou z dešifrovaného obrazu, operandy z původního — proto má sběrnice zvlášť `fetch()`
  a `read()`.
- **Zvukový CPU** Z80 3,072 MHz, NMI 4× za snímek (240 Hz, maskované zápisem na 3000h), ROM `6-9f.bin`,
  RAM 2000–23FF, latch 3000 R, AY1 5000/5001, AY2 6000/6001 (adresa/data), 4000 W ignorováno.
  Zvukový CPU je **povinný** — AY log je vstup pro ST‑M6.
- **T‑stavy místo instrukcí**: hra má čekací smyčky nesynchronizované s NMI (kap. 2.5, S_160B), takže
  hrubý počet instrukcí za snímek (co dělá `trace-stinger.py`) nestačí.
- **Watchdog** (čtení F800h) se nevynucuje: refemu jen ohlásí, když ho program 300 snímků nenakrmil.
  Skutečný automat by se restartoval; tady by rozdíl v časování tiše restartoval trasu, což je horší
  než hlášení.
- **Flip X/Y** (F006/F007) se zaznamenávají, ale nekreslí — jsou to registry cocktail skříně a remake
  je ignoruje (kap. 2.3).

## Formát dumpu

`RAM 2048 B (C000–C7FF) | VRAM1 1024 | ATTR1 64 | SPR1 32 | VRAM0 1024 | ATTR0 64 | SPR0 32 |
nmiEnable, palbank0, palbank1, charbank0, charbank1, bgcolor` — stejné pořadí jako
`tools/dis/trace-stinger.py --dump`, aby šly oba emulátory porovnat příkazem `cmp`.

## Profilování T-stavů (ST-M4)

`app/gameWorker.js` je ruční přepis, takže neví, jak dlouho která rutina trvá — musí se mu to říct.
Odhadnout průměr nestačí: cena práce za snímek kolísá o desetitisíce T-stavů podle počtu živých objektů
(`collide` 124 → 10 768 T, `scripts` 4 076 → 9 218 T, `nmiCallees` 1 234 → 7 297 T) a právě tenhle rozdíl
rozhoduje, jestli se do snímku vejde další iterace herní smyčky. Konstanta to zachytit nemůže; účtovaná cena
musí záviset na tom, kolik práce se v daném snímku opravdu udělalo.

```
node tools/refemu/profile.mjs --frames 700 --from 640 --to 660
node tools/refemu/profile.mjs --script sources/reference/input-attract.txt --frames 3400 --from 3340 --to 3360
node tools/refemu/profile.mjs --frames 700 --range shot1=2443-2622 --range bongo=053F-0C60 --csv /tmp/p.csv
```

`--write-at ADRESA` navíc hlásí, **ve kterém T-stavu snímku** originál zapsal danou adresu. To je přístroj na
fázové chyby: když přepis zapíše týž bajt o pár set T později, spadne zápis do dalšího snímku a regrese ukáže
posun o snímek bez jakéhokoli jiného rozdílu. Například `--write-at C119` ukáže, že blik „PLAYER 1 READY"
padne ve snímku 569 do T+49 758, tedy 1 442 T před koncem snímku — tam se pak pozná i malý dluh v modelu.

**Past při čtení výstupu:** profiler přiřazuje T-stavy podle PC právě prováděné instrukce, takže rozsah
**nezahrnuje to, co rutina volá** — včetně 44 T těla watchdogu (`RST 38h`, 0038h–003Dh), které se v přepisu
obvykle účtuje volajícímu. Naivní porovnání součtu za rozsah s tím, co worker účtuje `charge()`, pak ukazuje
neexistující chyby v řádu 20–60 %; volané rutiny je potřeba odečíst zvlášť (`--range` na ně).

**Druhá past — porovnávání `--write-at` s workerem:** refemu udává skutečný okamžik zápisu, kdežto worker
zápis provede dřív, než se jeho `charge()` odečte z rozpočtu snímku. Porovnávat se proto musí
`51200 − budget + state.pending`, ne `51200 − budget`; jinak vyjdou konstantní pseudo-odchylky desítek T.

Výchozí rozsahy sledují stavbu programu: `nmiCore` 0066–0102, `nmiCallees` 0103–0FFF, `mainLoop` 1000–27FF,
`collide` 2820–2CFF, `gameLoop` 2D00–33FF, `spawn` 3400–41FF, `scripts` 8000–95FF; vlastní přes `--range`.
Referenční emulátor má přesné T-stavy (jádro prošlo ZEXALL), takže jde o **měření, ne odhad** — každá
konstanta v přepisu by měla mít v komentáři, jestli je spočítaná z instrukcí, nebo změřená tímhle.

## Přejímací test workeru v prohlížeči (ST-M4)

`tools/regress.mjs` pouští `app/gameWorker.js` v Node a porovnává RAM. `browser-game-check.sh` ověřuje druhou
polovinu: že přepis skutečně běží v prohlížečovém jádru (jeho podmnožina ES2018, generátory, `atob` nad
`data/tables.json`) a že obraz nakreslený přes `ImageData` a canvas sedí s refemu pixel po pixelu.

```
tools/refemu/browser-game-check.sh 640 play      # snímek 640 herního scénáře
tools/refemu/browser-game-check.sh 600 attract   # titul
```
Stránka odtiká worker o jeden snímek víc, než kolik jich refemu odběhne před `--shot`, protože refemu kreslí
*po* snímku N. Obraz se z canvasu čte jako data URL, takže na velikosti okna ani na device scale factoru
nezáleží.
