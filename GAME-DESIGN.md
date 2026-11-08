# Stinger — zadání remaku

Stav k 2026-08-30. Pracovní zadání; body **[?]** jsou otevřené, body **[ověřit]**
je nutné potvrdit z vlastní disassemblace / MAME před implementací.
Společná pravidla arkádových remaků (SI, Pleiads, Battlezone) jsou do tohoto dokumentu
**zapracována** a přizpůsobena Stingeru; sesterské projekty: `~/sw/spaceinvaders/GAME-DESIGN.md`,
`~/sw/pleiades/GAME-DESIGN.md`, `~/sw/battlezone/GAME-DESIGN.md`. Milníky a závislosti: `MILESTONES.md`.

## 0. Společný rámec a role Stingeru

> **Změna 2026-08-30:** `ArcadeRasterPlatform`/`ArcadeRasterLayout` byly přesunuty z `app/` do svision jako
> **`svision/js/platform/canvas2D/arcade/arcadePlatform.js` + `arcadeLayout.js`** (třídy `ArcadePlatform`,
> `ArcadeLayout`), sdílené SI, Pleiades i Stingerem; projekt drží jen konfiguraci v `app/appPlatform.js`.
> Platforma **neplní** `app.stack.ButtonEntity` (hover/klik barvy) — společný mechanismus pro ZX i arcade
> (`config.buttonColors`) se navrhne později. Zmínky „v `app/`, ne ve svision" níže jsou historické.

- **Věrný remake, ne emulátor.** Logika se přepisuje do JavaScriptu; zachovává se původní
  celočíselná aritmetika, tabulky, pořadí výpočtů a časování po snímcích. Referencí je
  ROM set `stinger` v MAME s továrním nastavením DIP.
- **Stinger je čtvrtá hra** (Space Invaders → Pleiads → Battlezone → Stinger) a **první, která
  začíná na hotové kostře**: SI dodal `ArcadeRasterPlatform`/`Layout`, pevný tick ve workeru,
  syntetizátor efektů a skelet menu/HoF; Pleiads dodal `TileMapEntity` (dlaždice z ROM, palety
  z PROM, scroll, cache), `rom2tiles`, `tools/refemu` (headless referenční emulátor) a
  `tools/regress.mjs`. Stinger **přebírá vše kopií souborů do `app/`/`tools/`** (ne přes svision)
  a **přidává**: 3 bpp dlaždice, **dvě nezávisle scrollované vrstvy s per‑řádkovým scrollem**,
  **hardwarové sprajty 16×16** (`SpriteLayerEntity`), **druhý procesor** (zvukový Z80 řídící
  2× AY‑3‑8910 → přepis do syntézy AY) a **dešifrování programové ROM**.
- Vzor kódu: MM/JSW (`gameApp.js`, `menuModel.js`, `mainModel.js`, `gameWorker.js`,
  `hallOfFameEntity.js`, `aboutEntity.js`, `audioManager.js`) a jeho arkádová podoba
  v Pleiads (`WORKER-PROTOCOL.md`, virtuální RAM/VRAM ve workeru, hlavní smyčka jako generátor
  s `yield` = VBLANK). Herní fyzika ve **workeru** s pevným tickem, UI vrstva v modelu/entitách.
- Kostra jako MM/JSW: `index.php` + `app/` + `config/` + `db/`, symlink `app/svision`,
  `svtool build/verify`, PWA, hall of fame.
- Rozdíly proti MM/JSW: `ArcadeRasterPlatform` místo `ZXPlatform`; obraz **na výšku**;
  barvy z PROM palet místo ZX atributů; arkádový font 8×8 z ROM; **attract mode** místo
  tape-loading menu; vstup mapovaný na páku + 2 tlačítka; **žádné save game**, jen hall of fame.

## 1. Referenční verze

- **Seibu Denshi Stinger (1983)**, ROM set `stinger` v MAME (parent). Prototyp `stinger2`
  („Stinger (prototype?)", jiná gfx2 a DIP) a bootleg `finger` slouží jen k porovnání.
  Sesterská hra **Scion (1984)** běží na tomtéž hardwaru (bez šifrování, ROT0) — jen reference.
- Stinger je **první hra Seibu Denshi** (později Seibu Kaihatsu — Raiden). V Japonsku
  distribuovala Sigma Enterprises, v USA Venture Line; vydání 09/1983 (Game Machine 1. 11. 1983:
  6. nejúspěšnější nový stolní automat měsíce). Reedice **Arcade Archives (Hamster) 24. 7. 2025**
  (Switch/PS4) — potvrzuje, že práva drží dnešní Seibu Kaihatsu / Hamster; viz kap. 8.
- Původní zdrojáky nejsou veřejné a **neexistuje žádná disassemblace** (ani částečná, ani
  příbuzné hry) → první fází je **vlastní disassemblace 40 KiB programové ROM (Z80, šifrovaná)
  a 8 KiB zvukové ROM (Z80)**. Disassembler `dis8085.py` z Pleiads se nedá použít — **rozhodnuto
  2026-08-30: vlastní `tools/dis/disz80.py`** po vzoru `dis8085.py`/`merge_hints.py` (hinty, návěští,
  komentáře) s **dvojím vstupem** (opkódy z dešifrovaného obrazu, operandy z původního) — to žádný
  hotový nástroj (z80dasm) neumí.
- Zdroj hardwaru: MAME driver `src/mame/seibu/wiz.cpp` (Zsolt Vasvari, BSD‑3; jediný soubor —
  video, diskrétní zvuk i dešifrování jsou v něm), MAME je označuje
  `MACHINE_IMPERFECT_SOUND | MACHINE_IMPERFECT_COLORS`. Manuál: existuje jen **1‑stránkový list
  pinout + DIP** od Seibu (`sources/docs/Stinger-pin-DIP_arcade-museum.pdf`); servisní manuál ani
  schémata nenalezeny (2026-08-30). Referenční snímky (titul, hra, 224×256) v `sources/docs/`.

## 2. Fakta z originálu

Ověřeno 2026-08-30 z MAME `sources/mame/wiz.cpp` (master, commit `774a180d` z 2026-07-24). Vše, co
plyne z programu (průběh hry, bodování, chování nepřátel, RNG), je zatím **[ověřit]** — doplní ST‑M1
z vlastní disassemblace. MAME komentáře k taktům jsou s otazníky („18.432 MHz??", „3.072 MHz ???").

### 2.1 Hardware a časování
- **Hlavní CPU Z80** 18,432 MHz / 6 = **3,072 MHz** [ověřit takt]; **zvukový CPU Z80** 3,072 MHz
  (arcadeitalia uvádí 1,78975 MHz — rozpor, MAME kód má /6) [ověřit]. Tabulka not zvukového programu sedí přesně na
  **AY 1,5 MHz**, ne 1,536 (notes E) → krystal je možná 18,0 MHz; pro remake použít 1,5 MHz, ověřit poslechem. **2× AY‑3‑8910** na
  18,432/12 = **1,536 MHz** + **diskrétní obvody** (výstřel, exploze). Mono.
- **Snímek:** MAME 60 Hz, 256×256 rastr, VBLANK „2500 µs, not accurate"; **NMI hlavního CPU
  1× za snímek** (VBLANK, maskované registrem F001); **NMI zvukového CPU 4× za snímek (240 Hz)**
  „???" — maskované 3000h. Pevný tick remaku = 60 Hz. Referenční emulátor (ST‑M3) z toho počítá
  **51 200 T‑stavů na snímek** a přetečení poslední instrukce přenáší do dalšího snímku; jádro Z80 prošlo
  ZEXDOC i ZEXALL a jeho součet T‑stavů odpovídá skutečnému Z80, takže časování instrukcí je ověřené —
  nejistý zůstává jen krystal (viz výše).
- **Watchdog** čtením F800h.

### 2.2 Mapa paměti (hlavní CPU)
| Adresa | Funkce |
|---|---|
| 0000–BFFF | ROM 48 KiB (5 × 8 KiB = 40 KiB osazeno: 0000–9FFF; A000–BFFF prázdné) — **šifrované opkódy** (kap. 2.7) |
| C000–C7FF | RAM 2 KiB (C500h = příznak „TEST PLAY", Stephh) |
| D000–D3FF | VRAM **popředí** (vrstva 1, 32×32 kódů dlaždic) |
| D800–D83F | atributy popředí: 32 × (scroll, barva) po sloupcích hw |
| D840–D85F | sprite RAM 1 (8 sprajtů × 4 B) |
| E000–E3FF | VRAM **pozadí** (vrstva 0) |
| E800–E83F | atributy pozadí |
| E840–E85F | sprite RAM 2 |
| F000 R | DSW0; **F001 W** povolení NMI (bit 0) |
| F002/F003 W | banka palety bit 0/1 |
| F004/F005 W | banka znaků vrstvy 0 / vrstvy 1 (bit 0) |
| F006/F007 W | flip X / flip Y |
| F008 R | DSW1; F010 R IN0; F018 R IN1 |
| F800 R | watchdog; **F800 W** sound latch (příkaz zvukovému CPU) |
| F808 W | trigger **exploze** (diskrétní); **F80A W** trigger **výstřelu** (diskrétní) |
| F818 W | barva pozadí (`bgcolor`, index palety pro výplň) |

Zvukový CPU: 0000–1FFF ROM 8 KiB, 2000–23FF RAM, 3000 R sound latch / W povolení NMI, 5000/5001 AY1
(adresa/data), 6000/6001 AY2, 4000 W „?" (nop). MAME TODO: po latchi 0x90 zvukový program „skočí do
neznáma" a resetuje se — pravděpodobně chyba originálu [ověřit z disassemblace].

### 2.3 Video
- **Dlaždice 8×8, 3 bpp** (3 oddělené bitové roviny = 3 ROM soubory regionu, LSB rovina první), 256 kódů na
  banku; každá vrstva má 2 banky (bank 0 @0000, bank 1 @0800 každé roviny): **vrstva 1 (popředí, D000) kreslí
  gfx1** (7/8/9‑xe: font A–Z 0–9, „RUB END", ©, HUD, hvězdy), **vrstva 0 (pozadí, E000) kreslí gfx2** (10/11/12‑xh:
  dlaždice pevnosti). Ověřeno 2026-08-30 náhledem `rom2tiles --preview` a renderem titulu z emulátoru shodným
  s MAME snímkem (`sources/reference/screens/`).
- **Sprajty 16×16, 3 bpp**, 256 na ROM (stejná data jako dlaždice, jiný layout, 32 B/sprajt);
  sada 1 (D840) z gfx1, sada 0 (E840) z gfx2. Záznam 4 B: `Y, kód, barva (&7), X`; sprajt s X=0
  nebo Y=0 se nekreslí; první tři sprajty sady 0 mají Y−1 („jako Galaxian"); `sy = 240 − Y`
  (bez flipu). **Celkem max. 16 sprajtů.**
- **Pořadí kreslení:** výplň `bgcolor` → vrstva 0 (pozadí, E000) → vrstva 1 (popředí, D000) →
  sprajty sady 1 → sprajty sady 0. Pixel 0 je průhledný (`transpen 0`) u dlaždic i sprajtů, tj.
  **obě vrstvy jsou průhledné** nad barvou pozadí. MAME TODO: priority sprajt–sprajt nejsou správně
  („popcorn" nepřátelé na začátku mají mít vyšší prioritu než „vysavačová" koule).
- **Scroll:** per sloupec hw: `attr[2·sx]` = scroll sloupce (8 bitů, `(8·sy + 256 − attr) & 0xFF`),
  `attr[2·sx+1] & 7` = barva sloupce. Po otočení ROT90 → **per‑řádkový vodorovný scroll obou
  vrstev** — přesně to dělá „horizontálně scrollující hra na vertikálním monitoru".
- **Paleta:** 3 PROM 256×4 (a7 R, b7 G, a8 B), odpory 1k/470/220/100 Ω, `compute_resistor_weights`
  → 256 barev. Index pixelu = `palbank(2 b) << 3 | barva(3 b)` → 32 „color codes" × 8 pixelových
  hodnot. MAME TODO: „globální paleta neodpovídá PCB (gama/hue?)" — pro remake brát PROM, případně
  korekce až po porovnání s fotkami PCB [?].
- **Rastr:** 256×256, viditelné řádky 16–239 → hw 256 (š) × 224 (v); hra je **ROT90** → hráč vidí
  **224 (š) × 256 (v)** — **shodná logická plocha jako Space Invaders** (platformu SI lze
  převzít beze změny konfigurace). Flip X/Y registry slouží cocktail módu (remake ignoruje).

### 2.4 Vstupy a DIP (výchozí MAME)
- IN0: bit 0 mince 1, 2 tlačítko 2 = **BONGO CALL** (potvrzeno DIP listem Seibu: konektor pin 14/15
  „1P/2P BONGO CALL"), 3 start 2P, 4 start 1P, 5 mince 2, 6 tlačítko 1 (Fire), bity 1/7 cocktail.
  IN1: bit 0 vpravo, 1 vlevo, 4 nahoru, 5 dolů (2/3/6/7 cocktail) — **4‑směrná páka (8 směrů
  kombinací) + 2 tlačítka**. Originální názvy z DIP listu: životy = „**STINGER WOLF**" (2–5),
  obtížnost = „ENEMY: STRONG/WEAK", „BONGO WORK TIME" LONGEST/LONG/SHORT/SHORTEST, „TEST PLAY /
  NORMAL PLAY", „TABLE/UPRIGHT TYPE". Titulní obrazovka: logo STINGER, „© SEIBU DENSHI 1983", INSERT
  COIN, 1 COIN 1 CREDIT / 2 COINS 2 CREDITS; HUD: 1UP · HIGH SCORE · 2UP nahoře, životy vlevo dole.
- DSW0 (tovární **EFh** = součet výchozích DIPSETTING; hodnota „E7" z automatického výtahu byla chybná): Coin A 1C/1C; **životy 3** (2/3/4/5); **bonus 20 000 a 50 000** (dále 20k+60/70/80/90k,
  30k+80/90k, none). DSW1 (tovární **AEh**): Debug OFF (pozůstatek „TEST PLAY" ze `stinger2`: C500h, kód 0EF6h);
  Coin B 1C/1C; **Bongo Time Medium** (Long/Medium/Short/Shortest); **Difficulty Normal** (Hard);
  Upright. Poznámka Stephh: kód 0E69–0E9Ch je shodný se `stinger2`, kde tytéž bity znamenají Coin B.

### 2.5 Hratelnost (z disassemblace, ST‑M1 2026-08-30 — podrobnosti a důkazy `sources/asm/stinger/notes/A–D.md`)
- **Architektura programu:** hlavní smyčka 0CA3h obsluhuje jen attract; demo (S_1252) a hra (L_296B) jsou blokující smyčky
  čekající na čítač snímků C0A0h. Stavy C0A2h: 0 init, 1 překreslení titulu, 2 titul + tabulka, 4 demo, 5 hra. NMI (60 Hz):
  stíny atributů → HW, čítače, mince, skripty nepřátel (S_36DB), Bongo (S_053F), 3 sloty střel, logika lodi (S_0103).
  Hra obsahuje **čekací smyčky nesynchronizované s NMI** (S_160B, výbuch lodi) → `refemu` musí počítat T‑stavy.
- **Attract** (změřeno referenčním emulátorem ST‑M3, reálné snímky): init 0–194, **titul 194–1092 = 898 snímků**
  (logo se odkrývá po sloupcích z tabulky 110Bh, řádky tabulky high score každých 128 snímků), **demo 1092–4633 =
  3 541 snímků** (páka z tabulky 6B00h[frameCounter], končí smrtí; bez zvuku — latch 90h), pak znovu titul.
  Odhad „demo ≈ 2 420“ z ST‑M1 neplatil: trasovací emulátor `trace-stinger.py` počítá instrukce místo T‑stavů
  a běží ~10× rychleji, takže jeho čísla snímků nejsou reálná (init mu končí snímkem 25). High score tabulka 5×: jména
  MIE, KIN, JIM, H.K, KAS (5460h), 20000; tituly PRO. (≥ 999 990) / SEMI (≥ 30 000) / AMA. Zadání jména: páka mění znak,
  Fire potvrdí, 3 znaky, timeout ≈ 8,5 s. **1P/2P:** start 1P = −1 kredit, 2P = −2, hráči se střídají po každém životě.
- **DIP → RAM:** životy C0A8h (2–5), bonusové prahy C082h/C088h, Bongo time C00Ah (20h/18h/10h/08h → trvání (C00Ah+1)·16
  snímků = 528/400/272/144), obtížnost C005h (5 Normal / 0 Hard), cocktail C0BDh. TEST PLAY je mrtvý kód.
- **Mapa a scroll (notes B):** **hra není nekonečná** — 31 kol (C0BBh 1–1Fh) po **1 024 snímcích ≈ 17 s**, kolo 0 = úvodní
  obraz, kolo 1Fh = finále. Mapa nekomprimovaná: stránky 1 KiB (32 sloupců × 32 kódů) pro vrstvu 0 (hvězdy + zelená pevnost,
  gfx2), bloky 200h B pro dolní polovinu vrstvy 1 (okraj/tělo/kanály/hvězdy, gfx1); tabulky per kolo 5700h/5740h/5780h/57A0h
  (blok, registry F001–F005 = paleta/banky, barva, stránka); kódy < A0h se překládají tabulkou podle kola (varianty pevnosti).
  **Paralaxa:** vrstva 0 = 1 px / 4 snímky, vrstva 1 (jen řádky sx 15–30) = 1 px / snímek; horní polovina vrstvy 1 = HUD/texty.
  Texty v ROM pozpátku (drawText32 15ACh), znaková sada 00–09 číslice, 10 mezera, 11–2A A–Z, 2B `.`, 2C `-`, 36 `!`. BGCOLOR = 0.
  Sprite sloty: sada 1 (gfx1) 0 loď, 1 střela, 2–5 nepřátelé, 6/7 Bongo; sada 0 (gfx2) 0–3 výbuch lodi 2×2, 2–5 druhé díly
  nepřátel/střely, 6/7 projektily. Kompenzaci Y−1 prvních tří sprajtů sady 0 program nedělá. Celá mapa: `tools/dis/dump-map.py`
  → `data/map/*.png`.
- **Loď (notes C):** 2 px/snímek v obou osách, bez setrvačnosti, meze Y 16h–AEh (vodorovně), X 10h–E6h (svisle); animace 80h–82h,
  barva 3 (6 se střelou). **Zóna nízkého letu** (C310h, v úsecích typu 2 podle výšky): poloviční rychlost, stín 95h, značka 96h;
  chyba originálu 23EDh (nahoru testuje C130h). „Vysavač" táhne loď 1–3 px/snímek. **Střely:** 3 sloty, +10 px/snímek, zánik Y ≥ F0h,
  F80Ah při každém výstřelu, bez autofire, cooldown ≈ 6/8/16 snímků; odražená střela letí zpět; v nízké zóně **bomba** (C9h/CAh).
  **Bongo:** zásoba C2A0h start 2, max 5; BONGO CALL (IN0 bit 2) −1, přiletí zleva 3 px/snímek, 64 snímků obíhá loď (tabulka
  0AB3h), pak loví nepřátele slot po slotu, zabíjí dotykem; trvání dle DIP; doplnění: každých 512 snímků v úseku typu 2 zásobovací
  objekt (A0h–A7h) → dok v nízké zóně, ukazatel 16 dlaždic (C280h), +1 Bongo, +600 b. **Kolize:** |ΔY|,|ΔX| < min. poloměrů
  (4300h), loď 0Ch; **terén není pevný**, věže jsou sprajty. **Smrt:** 12 kroků výbuchu ≈ 50 snímků, F808h každý průchod smyčky;
  bez nesmrtelnosti; nová loď 30h/50h. Životy 2 + DIP. **Extend** max 2 (20k/30k a 50k–90k). **Skóre** 6 BCD číslic C06Dh…,
  jednotka = 10 bodů (zobrazení přidává „0"); body = 4300h[kód sprajtu − 80h] × 10; high score se přepisuje ihned.
- **Nepřátelé (notes D):** žádná struktura objektu — objekt = stín sprajtu (4 B) + záznam {typ, čítač} (2 B); skupina A 4 sloty
  (C224h / C148h, gfx1), B 6 slotů (C230h / C1A0h, gfx2), A slot n má partnerský B slot 2+n pro střely/kopie. `run_script` 8000h
  = **konečný automat**: čítač +1/snímek, `JP 5A00h[typ]`; 174 typů (brouci, koule, ostnatá koule, medúza, parazit, popcorn,
  větrník, talíř, výbuch 2Fh, **střely 30h–3Bh 12 směrů 2 px/snímek**, oko, mina, pouzdra, rakety, vysavač 50h–52h, skála,
  hvězdice, jiskra, houba, vrtule, formace 70h–76h); dráhy `movePaths` 4400h (16 fází bitových masek směrů). **Spawn** 3743h:
  plán 4200h[20h·(kolo mod 4) + sekce] → `requestSets` 38BBh (posun o cifru desítek skóre), dlaždice pevnosti ve VRAM0
  (hangáry → pouzdra, A9h → skála+hvězdice, 1Ch → oka), náhodné doplňky (rakety, talíře, miny), handlery samy. **Body** ×10:
  popcorn 3, brouk/talíř 8, větrník 10, parazit 11, hvězdice/vrtule 20, ostnatá koule/mina 30, oko 40, koule z teček 50, raketa
  +200, vysavač 255, skála 32/zásah (10 zásahů). HP jen skála a vysavač (zranitelný jen se sprajtem 8Dh). Výbuch = F808h každý
  snímek 24 snímků → remake spouští jen na hraně. **RNG** 1694h: 16‑bit stav C0A4h:C0A5h, seed 5A36h,
  `HL=2·HL+swap(HL); HL=2·(L0<<8|L1); A=L1+H; H=A; HL<<=1`, **perioda 611**; zaměřování deterministické (12 sektorů 927Bh).
  **Obtížnost** C000h = 8·kolo + (sekce>>4) + 5·Hard; prahy řídí střelbu, kopie, rakety, `spawnRateMask`, počet min.
- **Zvukové příkazy hlavního CPU** (→ 2.6): 00 klid každý snímek, 02 nová loď, 04 game over, 06 jméno, 08 vysavač, 0A/20 tep
  každých 64 snímků, 10 Bongo call/odraz, 12 objekt mění směr, 14/0C ze skriptů, 16 přitahování, 22 extend/2000 b./doplnění,
  24 dok, 26 únik objektu, 28 Bongo aktivní, 2A ze skriptů, 90 reset (přechody, demo).

### 2.6 Zvuk (zvukový program analyzován 2026-08-30 — `sources/asm/stinger/notes/E.md`, `RAMUse-sound.md`)
- **2× AY‑3‑8910** řízené zvukovým Z80 (ROM 8 KiB, kód 2,7 KiB + hudební data 0890–0B65h, 0E45–1FFFh). Příkaz z hlavního
  CPU: latch F800h → NMI zvukového CPU jej kopíruje do 2000h. **Bit 5 příkazu = skupina B (AY2), jinak A (AY1)**; ve skupině se
  přijme jen vyšší číslo než právě hrající (2001h/2002h), po dohrání (`busy` 2005h/2006h = 0) cokoli. Držený latch by skladbu
  spouštěl znovu, proto hlavní CPU zapisuje **00h do F800h každý snímek** (0CB8h).
- **Tabulka příkazů 0520h** (sudé 00–30h): 02/04/06/08/0A = 6‑kanálové skladby (5,0 / 3,6 / 8,4 / 0,35 / 3,3 s); 0C/0E vadné
  ukazatele (0000h); 10/12/14/16 = efekty AY1 (pípnutí 0,2 s, alarm 1,7 s, siréna 0,46 s, swoop 0,37 s); 20 = dlouhá skladba AY2
  16,7 s; 22/24/26/28/2A = efekty AY2 (arpeggio, fanfárka, pád, melodie 2,2 s, „exploze"); 2C/2E stop B/A; 30 nic; 18–1E → 0000h
  = reset. Hlavní CPU používá: 00, 02, 04, 06, 08, 0C, 10, 12, 14, 16, 22, 24, 26, 28, 2A, 90 (přiřazení k událostem: notes A–D).
- **Formát not:** `[kód délky][perioda]`; perioda 2 B (hi < 10h, pak lo) nebo 1 B (jen lo); pauza = perioda 0; hlasitost vždy 0Fh;
  kód délky = index×3 do JP tabulky 0380h: 00–18h softwarové doznívání (−1 každých N tiků), 1Bh–48h držení 384…1 tik; značky
  FF smyčka (nepoužito), FE/FD/FC konec A/B/vše. Šum ani obálky AY se nepoužívají, mixer F8h.
- **Tempo:** tik = 1 NMI; osmina = 24 tiků. Při 240 Hz NMI = 150 BPM (skladby 3–17 s) — potvrzuje MAME „4×60 Hz"; při 60 Hz by
  hudba byla 4× pomalá. **Takt AY:** tabulka not sedí přesně na **1,5 MHz** (při 1,536 MHz vše +0,35 půltónu) → krystal 18,432 MHz
  v MAME je asi špatně (možná 18,0 MHz). **Potvrzeno 2026-08-31 syntézou** (`app/aySynth.js`): změřená
  frekvence tónů při 1,5 MHz je A4 = 440,0 Hz, B4 −3 centy, C5 +1 cent; při 1,536 MHz je celá stupnice
  +39 až +42 centů. Remake jede na 1,5 MHz. Zbývá **A/B proti nahrávce z automatu** — to potvrdí takt
  skutečného hardwaru, ne jen to, pro co byla tabulka not spočítaná. Délka znělky startu života
  (příkaz 02) změřená z referenčního emulátoru je **4,8 s**, což sedí na 1 200 tiků při NMI 240 Hz.
- **Příkaz 90h = reset zvukového CPU** (ukazatel z 05B0h míří do kódu → `JP 5436h` → nemapováno → pád na 0000h): ticho +
  zapomenuté priority; hlavní CPU ho posílá při přechodech obrazovek a **v demu nepřetržitě** (demo je bez zvuku) — MAME
  poznámka „jumps to lalaland" je tedy záměrné (nebo tolerované) chování. 4000h se nikde nezapisuje.
- **Diskrétní obvody:** **výstřel hráče** (F80Ah) a **exploze** (F808h) — MAME aproximace: RC obálka (0,2 s / 0,25 s) × obdélník
  2 kHz resp. LFSR šum 1,8 kHz („cut‑and‑pasted from Asteroid“, TODO „výstřel má obsahovat šum"); triggery se střídají mezi
  dvěma obvody (sudý/lichý). Za 700 snímků hry: 6 výstřelů, 139 explozí (exploze se spouští i pro nepřátelské zásahy/efekty).

### 2.7 Šifrování programové ROM
- Šifrovány jsou **jen opkódy** (M1 fetch), data ne; adresy s `a & 0x2040 ≠ 0` nešifrované. Pro ostatní:
  řádek tabulky = bit 3 + 2·bit 5 adresy; `swap_xor_table = {7,3,5,0xA0},{3,7,5,0x88},{5,3,7,0x80},
  {5,7,3,0x28}`; `dec = bitswap(src, t0,6,t1,4,t2,2,1,0) ^ t3`. Nástroj `tools/decrypt-stinger.mjs`
  vyrobí `sources/rom/stinger/decrypted/` pro disassembler (vstup: opkódový i datový obraz —
  disassembler musí umět číst opkód z jednoho a operandy z druhého obrazu!).

## 3. Rozsah remaku

- **Jen jeden hráč** (jako SI/Pleiads); cocktail/flip a 2P z originálu se nedělá.
- **High score a hall of fame na serveru, úplně stejně jako v Manic Mineru:** stejná DB tabulka/API
  (`db/`, `hallOfFameEntity.js`, prefix `st`, tabulka `rg_st_hallOfFame`), jméno hráče jako v MM,
  zápis po game over, zobrazení v attract mode / menu.
- **Úvodní menu jako v MM/SI/Pleiads:** `menuModel` (START GAME, PLAYER NAME, HALL OF FAME, SOUNDS,
  MUSIC, SETTINGS, ATTRACT MODE, ABOUT GAME); menu **neotevírá zvukové kanály** (`needEventForAudio()`
  jen před startem). Attract mode je položka menu, implementovaná per hra.
- **CRT vzhled** = přepínač sharp/retro v SETTINGS (`layout.displayStyle`), default jako v MM.
- Attract mode, náhrada INSERT COIN, nastavení, About, PWA. Žádné save game.
- **Pixelově a barevně věrný** obraz (dlaždice + sprajty + palety z PROM). DIP: tovární (kap. 2.4);
  „Difficulty" a „Bongo Time" **ne** jako uživatelské volby [?] (rozhodnout po zjištění, co dělají).
- Hudba a efekty z AY: **syntéza**, ne nahrávky (kap. 7).

## 4. Platforma a vzhled

- **`ArcadePlatform`** + **`ArcadeLayout`** — sdílené ve svision (`canvas2D/arcade/`, od 2026-08-30), projekt má jen
  `appPlatform.js` `{width: 224, height: 256, overlay: {enabled: false}}` — stejné rozměry jako SI.
  Layout: celočíselné zvětšení, centrování; mobil na výšku vyplní displej, desktop vysoký výřez;
  dotykové ovladače v černém okolí. Bezel: sdílený se SI/Pleiads [?].
- **`TileMapEntity`/`tileMapRender.js`** z Pleiads, rozšířené na: 3 bpp, 2 banky znaků per vrstva,
  **per‑řádkový scroll obou vrstev** (v orientaci hráče; hw per sloupec), barva per řádek,
  průhlednost obou vrstev nad `bgcolor`, banka palety 2 bity. Cache dlaždic per (vrstva, kód, banka,
  barva).
- Nová **`SpriteLayerEntity`** (v `app/`): 16 sprajtů 16×16 3 bpp, průhledný pixel 0, pořadí sada 1 →
  sada 0, korekce Y−1 prvních tří (jen pokud se v hře skutečně projeví [ověřit]).
- Data z ROM: `tools/rom2tiles.mjs` (Pleiads) rozšířit o 3 bpp a sprite layout → `data/tiles.json`,
  `data/sprites.json`, `data/palette.json` (256 barev přes 1:1 port MAME `resnet`).
- Render referenčního snímku: `tools/refemu` z Pleiads přepsat/rozšířit na **Z80 + HW Stingeru**
  (dešifrování, dvě vrstvy, sprajty, DIP, sound latch log) — je to největší kus infrastruktury
  Stingeru a zároveň jediný zdroj referenčních tras, dokud není k dispozici MAME. Rozhodnuto 2026-08-30:
  **vlastní jádro Z80 v JS** (jako 8085 u Pleiads; MAME `z80.lst` jen jako reference chování), ověřené
  **ZEXDOC + ZEXALL** (`sources/reference/zex/`) před generováním tras; **zvukový Z80 se v `refemu`
  emuluje povinně** (stejné jádro, ROM 6‑9f, NMI 240 Hz, log zápisů do registrů obou AY per snímek) —
  je to jediné měřitelné kritérium pro ST‑M6. Pro nezávislou kontrolu nainstalovat MAME (apt) v ST‑M3.

## 5. Ovládání

- **4‑směrná páka** (←→↑↓, 8 směrů kombinací) + **Fire** + **Bongo**; klávesnice, gamepad.
- Dotyk: layouty z `controlsOptions.touchscreen` jako v MM, ale **joystick musí být 2‑osý** (MM/SI/Pleiads
  mají jen horizontální) + **dvě tlačítka** — první rozšíření dotykového schématu v rodině
  arkádových remaků; prohoditelné strany, volba v SETTINGS.

## 6. Architektura

- **Pevný tick = snímek originálu (60 Hz).** Worker běží akumulátorově (`dt` → N ticků), bez
  interpolace. Hlavní smyčka jako generátor, `yield` = čekání na NMI/VBLANK — stejné číslování snímků
  jako `refemu` (vzor Pleiads PL‑M4).
- Worker drží stav jako originál ve **virtuální RAM C000–C7FF + VRAM/atributy/sprite RAM** na původních
  offsetech; logika přepsaná 1:1 z disassemblace (komentáře s adresami ROM). **Do prohlížeče nejde obraz
  ROM** (rozhodnuto 2026-08-30, odchylka od PL‑M4): `tools/rom2tables.mjs` exportuje do `data/tables.json`
  jen tabulky vyjmenované v `tools/rom2tables.spec.json` (adresa, délka, název, formát) z disassemblace;
  kód se přepisuje, data se extrahují. Registry F001–F818 =
  pole ve `frame` pro model. Protokol `app/WORKER-PROTOCOL.md` (z Pleiads, rozšířit o sprajty, banky,
  bgcolor, sound latch, diskrétní triggery).
- **Deterministický RNG** — přepsat původní generátor (z disassemblace), attract/demo shodné
  s originálem.
- Zvukový CPU se **neemuluje**: jeho program se přepíše na **sekvencer** v hlavním vlákně
  (`app/soundDriver.js`): latch → stav hudby/efektů → registry AY per 1/240 s → `AYSynth`. Alternativa
  (jednodušší, méně věrná): sekvencer taky ve workeru, do modelu jdou hotové registry AY [?].

## 7. Zvuk

- **Syntéza AY‑3‑8910** v JS (2 čipy × 3 kanály + šum + obálky) — nový instrument nad svision
  `AudioOscillatorHandler` nebo AudioWorklet [?]; parametry (takt 1,536 MHz, log DAC tabulka AY) 1:1.
  Řízen registry ze sekvenceru (kap. 6). Je to **nová sdílená část** pro případné další AY hry.
- **Diskrétní výstřel a exploze** = syntetizátor efektů ze SI (šum + filtr + obálka, sweep); parametry
  podle MAME aproximace a **poslechem proti PCB/Arcade Archives nahrávkám** [?]; MAME sám je
  označuje za nepřesné („shot should include noise").
- Řízení přes stejné události z workeru jako v MM/JSW (bus `sounds`, `music`). Nahrávky se do hry
  nevkládají.

## 8. Data z ROM a právní rámec (společné)

- Grafika, font, tabulky, dlaždice, sprajty a palety se získají **z ROM převodem nástroji v `tools/`**
  do JSON v `data/`. Hra jen čte data. Programová ROM se **neposílá do prohlížeče**; worker má pouze
  přepsanou logiku + tabulky (`data/tables.json` jako u Pleiads).
- **Všechny podklady v `~/sw/stinger/sources/`**: `rom/` (set `stinger`, pro porovnání `stinger2`,
  `scion`), `asm/` (vlastní disassemblace Z80: hlavní + zvuková ROM), `mame/` (`wiz.cpp`), `sound/`
  (nahrávky k ladění), `docs/` (manuál, schémata, longplay odkazy), `reference/` (dumpy a trasy
  z `refemu`). Evidence v `sources/FILES.md` (URL, datum, velikost, checksum, licence); každý
  podadresář `README.md`. `sources/rom/` **mimo git**, zbytek `sources/` trackovaný (jako Pleiads).
- Vše převzaté se eviduje v `CREDITS.md` (projekt) a `SOURCES.md` (svision).
- **Práva:** Stinger je aktivně komerčně využívaný titul (Arcade Archives 2025, Seibu Kaihatsu /
  Hamster) — riziko je **vyšší než u SI/Pleiads**. Postup jako u MM/JSW (nekomerční, CC BY‑NC‑SA),
  před veřejným vydáním **rozhodnout název a míru vlastní grafiky/zvuku** [?]; do rozhodnutí jen
  testflight.

## 9. Ověřování

- **Měřitelné reference** z disassemblace/`refemu`: tabulky skóre, rychlosti scrollu obou vrstev,
  skripty nepřátel, chování Bonga, pozice sprajtů po N snímcích, RNG.
- Regresní test: `tools/regress.mjs` (Pleiads) — worker headless (Node) na N ticků s daným vstupem →
  porovnání RAM/VRAM/sprite RAM proti trasám z `refemu`; cíl **0 odchylek** bez vstupu i s náhodnými
  vstupy (seedy) jako u PL‑M4.
- Zvuk: log latchů + registrů AY z `refemu` vs. sekvencer v JS → shodné registry per tick.
- Testflight stránka jako u MM/JSW (`testFlightPage.php`, `~/sw/testflights/stinger`).

## 10. Postup (podrobně v `MILESTONES.md`)

1. Podklady do `sources/`, dešifrování ROM, **disassemblace Z80** (hlavní + zvuková), mapa RAM, popis
   průběhu hry; vyplnit kap. 2.5; paralelně `rom2tiles` 3 bpp + sprajty + paleta → JSON.
2. Skelet projektu: kopie kostry Pleiads (bez herní logiky), DB `stinger`, `svtool build/verify`.
3. `refemu` pro Z80/Stinger; `TileMapEntity` 3 bpp + per‑řádkový scroll + `SpriteLayerEntity`;
   statický screenshot startu hry shodný s `refemu`.
4. Hratelný začátek (loď, střelba, scroll pevnosti, první nepřátelé, kolize, skóre, smrt).
5. Kompletní hra (Bongo, všechny typy nepřátel, cyklus obtížnosti, bonusy, game over, HoF).
6. Zvuk: AY syntéza + sekvencer ze zvukové ROM, diskrétní výstřel/exploze.
7. Attract mode, nastavení (2‑osý dotyk, 2 tlačítka), PWA, testflight.
8. Regresní testy, About/Credits, rozhodnutí o veřejném vydání.

## 11. Otevřené otázky [?]

- Skutečné takty CPU/AY a frekvence NMI zvukového CPU (MAME „???"); vliv na tempo hudby.
- Korekce palety podle PCB (MAME TODO) — ano/ne.
- Umístění AY sekvenceru (worker vs. hlavní vlákno); implementace AY syntézy (oscilátor vs. worklet) — ST‑M6.
- Rozhodnuto 2026-08-30 (nejsou už otevřené): vlastní `disz80.py` s dvojím obrazem; vlastní Z80 jádro v JS
  + ZEXALL; zvukový Z80 v `refemu` povinně; do prohlížeče jen tabulky, ne obraz ROM.
- DIP Difficulty/Bongo Time jako uživatelské nastavení.
- Bezel sdílený se SI/Pleiads; veřejný název a doména; míra vlastních audiovizuálních prvků
  (Arcade Archives 2025 → aktivní držitel práv).

- **Zrevidovat časování workeru** (operátor 2026-10-07, `../DECISIONS.md`
  R-046 „Co zbývá“). Worker odměřuje tiky **akumulátorem** –
  `app/gameWorker.js` i `app/bootWorker.js`, tik 16,67 ms, 60 Hz. Rozhodnuto
  akumulátor ve všech hrách zrušit a časovat jen konstantou `setTimeout`,
  nastavenou co nejblíž originálu (časem změřenou), jeden tik na volání;
  vzor je `../booty/app/gameWorker.js`.
