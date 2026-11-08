# Stinger — milníky

Stav k 2026-08-30. Milníky navazují na kap. 10 „Postup" v `GAME-DESIGN.md`; každý má výstup a
kritérium **hotovo když**. Termíny se doplní po odhadu. Stav: ☐ nezačato · ◐ rozpracováno · ☑ hotovo.

## Závislosti mezi projekty

Stinger je čtvrtý projekt a **na nic nečeká** — všechno, co přebírá, už existuje (SI-M3/M5/M7,
PL-M2/M3/M4 ☑). Přebírá se **kopií souborů** do `app/`/`tools/`, svision se nemění.

| Část | Odkud | Kam ve Stingeru | Co se mění |
|---|---|---|---|
| `ArcadePlatform` + `ArcadeLayout` (svision `canvas2D/arcade/`, od 2026-08-30) + `appPlatform.js` (224×256) | svision / SI | ST-M2 | nic — jen config, shodná plocha se SI |
| Skelet: `gameApp`, `menuModel`, `mainModel`, `gameOverModel`, `hallOfFameEntity`, `aboutEntity`, `pauseGameEntity`, `borderEntity`, `mockWorker`, `WORKER-PROTOCOL.md` | Pleiads (`app/`) | ST-M2 | prefix `st`, texty, protokol +sprajty/banky/latch |
| `tileMapRender.js`, `tileMapEntity.js` | Pleiads | ST-M3 | 3 bpp, 2 banky/vrstva, per-řádkový scroll obou vrstev, obě vrstvy průhledné, `bgcolor` |
| `tools/rom2tiles.mjs` + spec | Pleiads | ST-M1 | 3 bpp roviny, sprite layout 16×16, 3 PROM → RGB |
| `tools/rom2tables.mjs`, `tools/regress.mjs`, `tools/vram2json.mjs`, `tools/render-screen.mjs` | Pleiads | ST-M3/M4 | formát RAM Stingeru |
| `tools/refemu` (8085 + HW Pleiads) | Pleiads | ST-M3 | **nové jádro Z80** + dešifrování + HW Stingeru (dvě scroll vrstvy, sprajty, DIP, sound latch log) |
| `dis8085.py`, `merge_hints.py`, `hints.d/` | Pleiads (`sources/asm/`) | ST-M1 | **nový `disz80.py`** (dvojí obraz opkód/data), hinty zachovány |
| `soundEffects.js`, `audioManager.js`, instrumenty šum/filtr/obálka | SI | ST-M6 | parametry výstřel/exploze |
| Dotykové ovládání (`controlsOptions.touchscreen`) | MM/SI | ST-M7 | **nové: 2-osý joystick + 2 tlačítka** |

Nové části, které Stinger dává k dispozici dalším hrám: `SpriteLayerEntity`, **AY-3-8910 syntéza +
sekvencer** (`aySynth.js`, `soundDriver.js`), Z80 `refemu` a Z80 disassembler s hinty.

## Milníky

### ST-M1 Podklady, dešifrování a disassemblace — ☑ 2026-08-30
- Výstup:
  - ☑ 2026-08-30 podklady: `sources/mame/` (wiz.cpp, ay8910, resnet, z80 jádro, discrete; commit `774a180d`),
    `sources/docs/` (DIP/pinout list Seibu, Game Machine 10–11/1983, AY datasheet, screenshoty titul+hra
    224×256, texty webů), `sources/reference/zex/` (ZEXDOC/ZEXALL pro test Z80 jádra), `sources/rom/README.md`
    s tabulkou 15 souborů + CRC/SHA1, `FILES.md`, `SHA256SUMS`. Nenalezen servisní manuál/schémata.
  - ☑ 2026-08-30 **ROM set `stinger` dodán uživatelem, 15/15 souborů SHA1 OK** (`sources/rom/stinger.sha1`).
  - ☑ 2026-08-30 `tools/decrypt-stinger.mjs` → `sources/rom/stinger/decrypted/{program,opcodes}.bin` (40 KiB; reset =
    `XOR A / LD (F001h),A / JP 0C85h`, NMI 0066h = `PUSH AF…IY`).
  - ☑ 2026-08-30 `tools/dis/z80emu.py` + `tools/dis/trace-stinger.py` — trasovací emulátor (Python) celého stroje:
    pokrytí kódu, census RAM, trasy per snímek, **screenshoty z VRAM** — titul pixelově odpovídá MAME snímku
    z arcade-museum; hra běží (mince, start, střelba, smrt, game over, demo). Referenční PNG v `sources/reference/screens/`.
  - ☑ 2026-08-30 `tools/dis/disz80.py` — **vlastní**, čte opkódy z dešifrovaného a operandy z původního obrazu; hinty/návěští/
    komentáře jako `dis8085.py`; `tools/dis/merge_hints.py` slučuje `hints.d/{cov,A,B,C,D}.txt`. Statické pokrytí 48 %
    (zbytek = data: mapa 4800–7FFF/9800, texty, tabulky). ☑ `hints.d/A–D.txt` (1 099 sloučených řádků, 146 RAM symbolů →
    `RAMUse.md`), `hints-sound.txt`, `notes/A–E.md` (1 348 řádků), `RAMUse-sound.md`, `tools/dis/dump-map.py` → `data/map/*.png`.
    ☑ 2026-08-31 (z ST-M4): opraveno 11 datových hintů s inkluzivním koncem o bajt dál + doplněny vstupní body
    `code 0x8000`/`0x957E` → **pokrytí 47,1 % → 48,0 %**, zpět 5 podprogramů (`run_script`, `objBoundsKill`,
    `nextRound`, `shadowHide`, `stageClearScreen`, `bongoApproachShip`); opraveno 8 chyb v notes A/B/D
    (větvení C515h v NMI, rozsah `setVideoRegs`, návratová hodnota `rng`, posunuté adresy typů 3D–42).
    + `sources/asm/stinger/main.asm`, `sound.asm`, `RAMUse.md`, `notes/A–E.md`: A hlavní smyčka, NMI,
    stavový automat, vstupy/kredity/DIP; B scroll a mapa pevnosti (jak se generuje pozadí obou vrstev);
    C hráč, střela, Bongo, kolize, smrt, extend; D nepřátelé (typy, skripty, spawn, bodování), RNG,
    attract; E zvukový program (příkazy latch → hudba/efekty, formát not, NMI 240 Hz).
  - ☑ 2026-08-30 `tools/rom2tiles.mjs` (3 bpp + sprajty 16×16 + 3 PROM přes port `compute_resistor_weights`) →
    `data/tiles.json`, `data/sprites.json`, `data/palette.json`; `--preview` PNG všech bank a sprajtů — abeceda čitelná,
    přiřazení gfx1 = popředí/HUD/font, gfx2 = pevnost potvrzeno.
  - kap. 2.5/2.6 GAME-DESIGN vyplněné, každá hodnota s adresou ROM/RAM.
- Hotovo když: disassemblace pokrývá hlavní smyčku, celý průběh kola, Bongo a zvukový program;
  kap. 2 bez [ověřit]; náhledy grafiky čitelné (písmo, loď) → potvrzené přiřazení ROM ↔ vrstva/sada — **splněno**
  (kap. 2.5/2.6 vyplněny). Zbývající [ověřit] v kap. 2.1 jsou takty (MAME „???"): AY podle not = 1,5 MHz.
- Otevřené drobnosti (nebrání M2–M4; na konci každého `notes/*.md`): konec kola / odlet letky a finále kola 1Fh (hráč v emulátoru
  kolo nepřežil — ověřit s autopilotem v ST‑M3), zadní střela CEh a sprajt 96h, C21Dh, 4280h+, 5800–5995 nevolaný kód,
  6B00 data, čtení nápisů B4–B6, délky čekacích smyček mimo NMI (T‑stavy).
- Poučení pro ST‑M3: `refemu` musí mít **přesné T‑stavy** (čekací smyčky S_160B nejsou synchronní s NMI) a **tovární DIP
  DSW0 = EFh, DSW1 = AEh** (chyba E7/E0 opravena 2026-08-30).

### ST-M2 Skelet projektu — ☐
- Výstup: kopie kostry Pleiads (`index.php`, `aboutPage.php`, `config/`, `db/`, `images/` placeholdery,
  `app/*` bez herní logiky), platforma ze SI (224×256, bez overlay), symlink `app/svision`, `.gitignore`
  (☑), `menuModel` bez otevírání audia, `gameWorker.js` stub, `mockWorker.js`; DB `stinger`
  (`rg_st_hallOfFame`, prefix `st`), dev URL `https://willy2.shipard.pro:34444/stinger/`.
- Hotovo když: `svtool build/verify` projdou, menu se zobrazí bez chyb v konzoli (headless Chrome),
  game over stubu zapíše do HoF.

### ST-M3 `refemu` Z80 + `TileMapEntity` 3 bpp + `SpriteLayerEntity` — ☑ 2026-08-30
- Výstup:
  - ☑ `tools/refemu/z80.js` — **vlastní jádro Z80 v JS** s přesnými T-stavy, MEMPTR a nedokumentovanými
    instrukcemi/příznaky; **ZEXDOC i ZEXALL 67× OK, 0 chyb** (`zexrun.mjs`, BDOS stub na 0005h).
    Součet 46 734 977 142 T-stavů odpovídá hodnotě známé ze skutečného Z80 → potvrzena i tabulka časování,
    kterou samotný ZEX nekontroluje.
  - ☑ `tools/refemu/machine.js` — celý automat: dešifrování opkódů (`fetch` vs. `read`), mapa paměti kap. 2.2,
    NMI 60 Hz maskované F001, DIP tovární, snímek = **51 200 T-stavů** s přenosem přetečení;
    **zvukový Z80** (ROM 6-9f, NMI 240 Hz, latch 3000h, AY1 5000/5001, AY2 6000/6001).
  - ☑ `tools/refemu/run.mjs` — vstupní skript, PNG (celý obraz / jen vrstvy / jen sprajty), dumpy
    `sources/reference/dump-*.bin`, trasy `trace-*.tsv` (registry + RAM + latche F800 + počty F80A/F808),
    `ay-*.tsv` (16 registrů obou AY per snímek), `--state` pro `data/screens.json`.
    Doplňky: `render-dump.mjs`, `pngdiff.mjs`, `make-reference.sh`, `compare-python.sh`, `browser-check.sh`.
  - ☑ `app/tileMapRender.js` — **sdílený** renderer bez závislostí na DOM i Node: importuje ho jak refemu,
    tak prohlížeč, takže pixelová shoda remaku s referencí je konstrukční. 3 bpp, 2 banky znaků a 4 banky
    palet, per-řádkový scroll a průhlednost obou vrstev, `bgcolor`, 16 sprajtů, pořadí sad, korekce Y−1.
  - ☑ `app/tileMapEntity.js` (vrstvy) + `app/spriteLayerEntity.js` (sprajty nad nimi) — kreslí přes
    `DrawingCache` a `putImageData`, obraz se počítá jednou za herní snímek.
  - ☑ `mainModel.js` zobrazuje titul attractu (attract) nebo start hry z `data/screens.json`, které vyrobil
    `refemu`; jakmile worker začne posílat `vram/attr/sprites` (ST-M4), přepne se na živý obraz beze změny kódu.
- Hotovo když: Z80 jádro projde ZEXALL bez chyby — **splněno**; render startu hry a titulu **pixelově shodný**
  s PNG z `refemu` — **splněno**, `tools/refemu/browser-check.sh` (headless Chromium, obraz čtený z canvasu)
  hlásí 0 rozdílných pixelů z 57 344 na všech třech obrazovkách; renderer je navíc pixelově shodný s ST-M1
  Python emulátorem nad stejným dumpem (`compare-python.sh`).
- Nezávislá kontrola: titul se shoduje s fotografií automatu `sources/docs/arcade-museum-stinger-34562.jpg`,
  obraz pevnosti se snímkem `sources/docs/internet-arcade-stinger-screenshot-224x256.png`.
  **MAME se neinstaluje** (rozhodnuto 2026-08-30): jeho zdrojové kódy v `sources/mame/` už svou roli splnily —
  kapitola 2 z nich vznikla — a spustitelný balík (`apt` `mame` 0.264, ~700 MB, sudo) by přinesl hlavně data,
  která už máme. Navíc má vlastní ovladač přiznané chyby právě tam, kde by se hodil (paleta „neodpovídá PCB
  (gama/hue?)", špatné priority sprajt–sprajt, takty „???"), takže by při rozdílu nebylo jasné, kdo se mýlí.
  Přesunuto k ST-M8, kde se o korekci palety stejně rozhoduje.
- Zjištění pro další milníky: trasovací emulátor z ST-M1 počítá instrukce, ne T-stavy, a běží ~10× rychleji;
  **jeho čísla snímků neplatí pro refemu** (init 25 vs. 194). Reálné časování attractu: init 0–194,
  titul 194–1092 (898 snímků ≈ „900" z notes A), demo 1092–4633 (3 541 snímků, ne 2 420), kolo 1 024 snímků.

### ST-M4 Hratelný začátek — ◐ 2026-08-31 (logika hotová, přesnost rozpracovaná)
- Přístup jako PL-M4: worker drží virtuální RAM na původních offsetech, logika 1:1 z disassemblace,
  hlavní smyčka generátor / `yield` = NMI; **jen tabulky** přes `tools/rom2tables.mjs` + `rom2tables.spec.json`
  → `data/tables.json` (rozhodnuto 2026-08-30: obraz ROM do prohlížeče nejde — odchylka od PL-M4).
- ☑ **Přepis je funkčně kompletní** — `app/gameWorker.js` (8 100 řádků): reset, DIP, zapínací obrazovka, NMI,
  titul s tabulkou nejlepších, PUSH START, start života, herní smyčka, scroll obou vrstev a mapa pevnosti,
  loď + tři sloty střel + bomba + odražená střela, **všech 174 skriptových handlerů nepřátel**, spawn (plán
  sekcí, formace, hangáry, skála s doprovodem, rakety, miny), kolize, výbuch a smrt lodi, skóre/extend/HUD,
  Bongo se zásobovacím objektem a dokováním, game over, zadání jména, demo s autopilotem.
- ☑ **Infrastruktura:** `tools/rom2tables.mjs` + spec (38 tabulek, 17 KiB dat z ROM, žádný kód);
  `tools/regress.mjs` (worker headless vedle refemu, hlásí první snímek a adresu rozdílu, `--watch`
  skupiny, `--dump-at` i obraz); `tools/refemu/profile.mjs` (změří skutečné T-stavy per rozsah adres a
  `--write-at` = ve kterém T-stavu snímku originál zapsal adresu); `tools/refemu/browser-game-check.sh`
  (worker běžící v prohlížeči vs. refemu); `tools/playthrough.mjs` (funkční smoke test bez refemu).
- ☑ **„První úsek hry dohratelný" splněno:** `tools/playthrough.mjs` projde celý cyklus — mince, start,
  kola po 1 024 snímcích, tři smrti, game over, návrat do attractu a dema (seedy 7/3/11: kola 6–8).
  Worker běžící **v prohlížeči** kreslí obraz pixelově shodný s refemu.
- ◐ **Regrese proti refemu — 0 odchylek na celé RAM (1 792 B) i obraze:**
  attract bez vstupu 0–3350 snímků; herní scénář 0–1108; náhodné vstupy seedy 1–5: 740 / 1138 / 1147 / 691 / 624.
  Kritérium „≥ 3 000 snímků" tedy splňuje attract, herní scénáře zatím ne.
- **Co zbývá** (změřeno, ne odhadnuto): zbytkový fázový posun pod 100 T na hranici snímku. Cena NMI už
  s originálem sedí na T přesně; zdroje: (a) drift ~0,35 T/snímek v popředí smyčky dema, nelokalizovaný,
  (b) `SCRIPT_HANDLER_TSTATES` je u části typů stále změřený průměr, ne spočítané instrukce (rozptyl
  −73 T na volání u typů v attractu; u nejčastějších typů je po přebázování rozptyl nulový),
  (c) dlouhé rutiny popředí jsou v modelu atomické tam, kde je originál přeruší NMI.
  Postup je zavedený a opakovatelný: změřit profilerem, spočítat cenu z instrukcí, přebázovat.
- Poznámka k metodě: **žádná konstanta se nehádá.** Každá cena v modelu času je buď spočítaná z instrukcí,
  nebo změřená profilerem — a v komentáři je uvedeno které. Jediná kalibrovaná konstanta je
  `RESET_OVERHEAD_TSTATES` (přímočarý kód zapínací sekvence, který nemá jiný pozorovatelný efekt než čas).

### ST-M5 Kompletní hra — ☐
- Výstup: Bongo (tlačítko 2, DIP Bongo Time), všechny typy nepřátel a jejich skripty, cyklus obtížnosti
  / opakování kola, bonus životy (20k/50k), extend, game over, HoF na serveru, attract demo.
- Hotovo když: celý průběh od menu po zápis skóre bez zvuku; regres 0 odchylek na dlouhých trasách
  (≥ 20 000 snímků s autopilotem).

### ST-M6 Zvuk — ◐ 2026-08-31 (hotovo, zbývá poslechové ověření)
- ☑ `app/soundDriver.js` — **přepis programu zvukového CPU 1:1** (998 řádků, ROM `6-9f.bin`): reset, NMI,
  priority obou skupin, dispatch přes tabulku 0520h, všechny obsluhy příkazů, sekvencer, formát not
  i značky. Model času je tu nutný: reset maskuje NMI na 1,85 periody, takže se po každém příkazu 90h
  jedno až dvě NMI ztratí a to rozhoduje, na kterém NMI se uslyší další hudba.
- ☑ `app/aySynth.js` — oba AY-3-8910: tóny, šum, obálky, logaritmický DAC (měřená křivka).
  **Takt 1,5 MHz** — ověřeno syntézou: A4 = 440,0 Hz, celá stupnice do 3 centů; při MAME 1,536 MHz je
  o 40 centů výš (GAME-DESIGN kap. 2.6).
- ☑ `app/stingerSoundProcessor.js` (AudioWorklet na vlastních hodinách odvozených z počtu vzorků,
  latch držený jako registr se slotovým párováním, diskrétní výstřel/exploze, měkký limiter),
  `app/stingerSoundHandler.js` (skládá worklet z modulů stejnou transformací jako `svtool`),
  napojení v `audioManager.js` a skutečné ukázky originálu v `soundEffects.js`.
- ☑ **Dvě sběrnice** (SOUNDS/MUSIC) jako **maska, ne mix**: nový příkaz kanály přebírá, nemixuje se do nich,
  takže každá sběrnice má vlastní instanci desky, obě dostávají identický proud latchů a každá umlčí čip,
  který právě patří té druhé. Jinak by MUSIC neměla co ovládat.
- ☑ Worker hlásí u zápisů do F800h a u triggerů F808/F80A **slot 0–3** (zvuková deska čte latch 4× za snímek),
  viz `app/WORKER-PROTOCOL.md`.
- ☑ Nástroje: `tools/rom2sound.mjs` + spec → `data/sound.json` (6,4 KiB hudebních dat, jen data),
  refemu `--ay-nmi` (registry obou AY po každém NMI i s latchem, který to NMI vidělo),
  `tools/regress-sound.mjs`, `tools/render-sound.mjs` (renderuje WAV z reference, ze sekvenceru
  i z celé desky včetně diskrétních obvodů), `tools/refemu/browser-sound-check.{html,sh}`.
- Hotovo když: **registry AY z JS sekvenceru shodné s logem `refemu`** — **splněno a překročeno**:
  `node tools/regress-sound.mjs --frames 4700` hlásí **18 800 NMI, 32 registrů, 0 rozdílů** (tedy po
  každém NMI, ne jen po snímku) na attractu i na herním scénáři; WAV z přepisu je **bajtově shodný**
  s WAV z registrů reference; obraz v prohlížeči dává stejné RMS jako render v Node.
  **Zbývá z původního zadání:** „tempo hudby ověřeno proti Arcade Archives / longplay" a „diskrétní efekty
  poslechem (A/B dělá uživatel)" — obojí potřebuje nahrávku z automatu. Ukázky k poslechu jsou v `tmp/sound/`
  (`tools/render-sound.mjs --from-board --live`). Odchylka od zadání: **takt AY je 1,5 MHz, ne 1,536**
  (viz kap. 2.6), a sekvencer bydlí v AudioWorkletu na vlastních hodinách (otevřená otázka „umístění
  sekvenceru [?]" je tím rozhodnutá).

### ST-M7 Attract mode, nastavení, PWA, testflight — ☐
- Výstup: attract (titul, demo, HoF, náhrada INSERT COIN), SETTINGS (ovládání, sharp/retro),
  **dotyk: 2-osý joystick + 2 tlačítka**, About, ikony/poster, PWA, `testFlightPage.php`,
  `~/sw/testflights/stinger`.
- ☑ 2026-09-12 **Zaváděcí obrazovka** — `app/bootModel.js` (`BootModel`, obdoba `ZXResetModel` v 224×256)
  přehrává skutečnou zapínací sekvenci automatu (RNG sníh, výpis DIP, plná výplň, smazání) ze samostatného
  `app/bootWorker.js` a předává řízení menu v okamžiku, kdy by originál začal kreslit titul.
  Kontrola `tools/match-boot.mjs` proti `gameWorker.js`: 0 rozdílů na 188 snímcích.
- ☑ 2026-09-12 **Menu na titulu** — bez nadpisu a rámečku; podkladem je titulní obrazovka originálu jen s logem
  STINGER a rolujícím modrým pozadím (`app/titleBackdropEntity.js`: obraz 5000h + logoTiles, pozadí 4C00h,
  scroll jako `bgScrollDec`, texty vymazané), menu posunuté pod logo (y 88).
- ☑ 2026-09-12 **Arkádový font** — `app/stingerFonts8x8.js` (`StingerFonts8x8` nad `ZXFonts8x8`, statická HEX
  tabulka 96 znaků z `tools/rom2font.py`): znaky gfx1 banky 0 (číslice 00h–09h, A–Z 11h–2Ah, interpunkce,
  dvojtečka 7Eh, © z 49h+4Ah), chybějící znaky z nejbližších ZX fontů (`~/sw/zx-fonts`: Mimzoid `?`, G-Force
  `%+/;<>~a-z`, Push Off zbytek). Vzniká v `GameApp` jako `fonts.stingerFonts8x8`; menu se jím píše (monospace 8 px).
- Hotovo když: testflight nasazen, hratelné na mobilu i desktopu bez chyb v konzoli.

### ST-M8 Věrnost a dokončení — ☐
- Výstup: regresní testy v CI rytmu (`tools/regress.mjs`), About/Credits, rozhodnutí o veřejném názvu
  a míře vlastní grafiky/zvuku (kap. 8 — Arcade Archives 2025).
- **Zde se teprve zvažuje instalace MAME** (odloženo z ST-M3): screenshoty pro porovnání a rozhodnutí
  o korekci palety. Pozor, MAME sám u palety přiznává „neodpovídá PCB (gama/hue?)", takže rozhodujícím
  podkladem zůstávají fotografie automatu a PROM, ne MAME.
- Hotovo když: regres prochází, kap. 11 bez bodů blokujících vydání.

## Pořadí a paralelismus

- **ST-M1 a ST-M2 nezávisle hned.** V M1 jde `rom2tiles` paralelně s disassemblací; dešifrování je
  první krok (den 1), bez něj nic dalšího.
- ST-M3 potřebuje z M1 jen ROM + dešifrování (refemu) a `rom2tiles` (entity); disassemblace může
  dobíhat.
- ST-M4 potřebuje M1 (notes A–D) + M3 (refemu trasy). ST-M6 potřebuje M1 (notes E) a lze dělat
  souběžně s M4/M5. ST-M7 po M5, ST-M8 po M6+M7.
- Odhad pracnosti relativně k Pleiads: M1 ≈ 2× (dvě ROM, šifrování, žádná příbuzná disassemblace),
  M3 ≈ 1,5× (Z80 jádro, sprajty), M6 ≈ 2× (AY syntéza + sekvencer jsou nové), ostatní ≈ 1×.
