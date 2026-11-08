# Protokol worker ↔ model (ST-M2 návrh; závazný od ST-M4)

Vzor: `~/sw/pleiades/app/WORKER-PROTOCOL.md`. Worker (`app/gameWorker.js`, classic worker script bez importů) drží
stav hry jako originál: virtuální RAM `ram` (Uint8Array 2048 = C000h–C7FFh, proměnné na původních offsetech,
`sources/asm/stinger/RAMUse.md`) a stíny video RAM přesně jako hardware. Pevný tick = 1 snímek originálu (60 Hz,
akumulátor podle `performance.now()`); herní logika = generátor, `yield` = jedno NMI (VBLANK). Číslování snímků
shodné s referenčním emulátorem (`tools/refemu`, ST-M3; zatím `tools/dis/trace-stinger.py`).

## model → worker (postMessage)
- `{id:'init', initData:{headless:false, dip:{lives:3, bonus:[20000,50000], bongoTime:'medium', hard:false},
   tables, hiScore, attract:bool, inputScript?, seed?}}` — start ve stavu „mince + start 1P" (kap. 2.5: C0A2h = 5),
  attract = demo (C0A2h = 4). `tables` = obsah `data/tables.json` (jen tabulky vyjmenované ve spec, ne obraz ROM —
  rozhodnutí 2026-08-30).
- `{id:'controls', left, right, up, down, fire, bongo}` — stav vstupů (IN1 bity 0/1/4/5, IN0 bity 6/2).
- `{id:'pause'}` / `{id:'continue'}` / `{id:'reset'}`; headless (`tools/regress.mjs`): `{id:'tick'}` = přesně jeden snímek.

## worker → model
- `{id:'frame', frame:n, vram:[Uint8Array(1024) vrstva 0, Uint8Array(1024) vrstva 1], attr:[Uint8Array(64), Uint8Array(64)],
   sprites:[Uint8Array(32) sada 0, Uint8Array(32) sada 1], regs:{palbank:0–3, charbank:[0/1, 0/1], bgcolor, flip:[x,y]},
   score, hiScore, lives, round:0–31, state:'title'|'game'|'dying'|'gameOver'|'demo', sounds:[…],
   soundBoard:{latch:[{slot:0–3, value}], shot:n, shotSlots:[…], boom:n, boomSlots:[…]}}`
  — každý snímek; model kreslí poslední přijatý stav přes `TileMapEntity` (2 vrstvy, per‑řádkový scroll z `attr`) a
  `SpriteLayerEntity`; `soundBoard` jde do `AudioManager.playFrame` (ST-M6: AY sekvencer + diskrétní efekty).
  HUD (skóre, životy, Bongo) je součástí VRAM jako v originále.

  **`slot` u zvuku (ST-M6):** zvuková deska čte svůj latch **jednou za NMI při 240 Hz**, tedy 4× za snímek
  (notes E). Záleží proto na tom, *kde ve snímku* se do F800h zapsalo — worker to ví (sleduje, kolik
  T-stavů snímku už utratil) a posílá `slot` 0–3. Přijímací strana drží latch jako registr: v každém ze
  čtyř NMI nejdřív aplikuje zápisy svého slotu a pak hodnotu přečte. Bez toho by se muselo hádat a hudba
  by nastupovala až o snímek později. Totéž platí pro triggery diskrétních obvodů (`shotSlots` = F80Ah,
  `boomSlots` = F808h).
- `{id:'gameOver', score, hiScore}` — po dokončení game over (jediný konec hry).
- `{id:'roundComplete', round}` — informativní, při každém zvýšení C0BBh.

## Jak je worker postavený (ST-M4)

`gameWorker.js` je **ruční přepis původního programu 1:1**, ne nová implementace hry. Z toho plyne pár pravidel,
která je potřeba držet, jinak přestane fungovat regrese proti referenčnímu emulátoru:

- **Proměnné bydlí na původních adresách.** `ram` je C000h–C7FFh, `vram[1]` je D000h, `attr[0]` je E800h atd.;
  přistupuje se přes `rd(a)` / `wr(a, v)` s **původními adresami** (`wr(0xC0A2, 2)`). Jen díky tomu může
  `tools/regress.mjs` porovnávat bajt po bajtu s `tools/refemu`.
- **Data z ROM se čtou taky na původních adresách.** `data/tables.json` (`tools/rom2tables.mjs` podle
  `tools/rom2tables.spec.json`) se načte do řídkého obrazu; čtení adresy, kterou tabulky nenesou, worker ohlásí —
  to znamená, že přepis omylem sáhl do kódu, nebo že tabulka chybí ve specifikaci. Kód se do prohlížeče
  nikdy nedává (rozhodnutí 2026-08-30).
- **Funkce se jmenují podle originálu** a v komentáři nesou svou adresu (`drawTitle` 0F2Eh), aby šel přepis
  porovnat s `sources/asm/stinger/main.asm` řádek po řádku.
- **Rozhoduje disassemblace, ne poznámky.** `notes/A–D.md` jsou dobrý průvodce, ale mají chyby (např. návratová
  hodnota `rng` 1694h je podle notes D součet, ve skutečnosti instrukce 16A4/16A5 přepíšou A a vrací se `H OR L`).

### Start hry (ST-M4)

Přepis je věrný **od zapnutí automatu**: nejdřív servisní zapínací obrazovka, pak titul, a do hry se program
dostane až po vhození mince a stisku startu. V remaku ale žádné tlačítko mince není a hráč už si hru vybral
v menu, takže by jinak zůstal viset v attractu.

Worker proto na `init` **přetočí originálův vlastní průběh naplno** (`fastForwardToPlay`) a snímky začne
posílat, teprve když hra (nebo v attract režimu demo) opravdu běží:

- `attract: false` → mince na IN0 bit 0 hned, jak naskočí titul (kredit se počítá na **náběžné hraně
  uvolnění**, `coinInput` 042Eh), pak se drží start 1P na bitu 4, dokud nezačne život. Hotovo kolem
  snímku 236 originálova času, což je tady pár milisekund.
- `attract: true` → přetočí se do dema (snímek 1092).

**Nic se nepřeskakuje ani nefalšuje** — mince i start jdou na IN0 přesně tak, jak by je viděl hardware,
takže hru nastaví původní kód. Headless běhy (`tools/regress.mjs`) se přetáčení netýká: porovnávají snímek
po snímku od resetu a vstupy si řídí vlastním skriptem.

Ověřit se to dá `tools/refemu/browser-game-check.html?live=1&frames=120&script=play` (obrazovka
„PLAYER 1 READY / STAGE 1" v prohlížeči).

### Model času

Původní program není „jednou za snímek zavolej update". `main_loop` (0CA3h) čeká, až NMI změní čítač snímků,
a hra i demo jsou blokující smyčky, které dělají totéž. Navíc obsahuje **čisté zpožďovací smyčky, které s NMI
synchronizované nejsou** — `delayLoop` (S_160B, 160Bh) trvá 54 768 T, tedy 1,07 snímku. Kdy se co objeví na
obrazovce proto závisí na taktech, ne na počtu volání.

Worker je tedy generátor s rozpočtem T-stavů:

| prostředek | význam |
|---|---|
| `charge(t)` | přičte dluh v T-stavech |
| `yield 'work'` / `yield* settle()` | vrátí řízení `tick()`, aby dluh odečetl z rozpočtu snímku |
| `yield 'frame'` | originál čeká na NMI (další snímek) |
| `delay(n)` | n volání `delayLoop` |
| `FRAME_TSTATES` | 51 200 = 3,072 MHz / 60 |

`tick()` = jeden snímek: nejdřív NMI (je-li povolené registrem F001h), pak popředí dostane zbytek rozpočtu
a běží, dokud ho nevyčerpá nebo se nezablokuje. **Čas se platí před provedením** — efekt instrukce je vidět, až
uplyne její čas; opačné pořadí posune stav o jedno volání a regrese to okamžitě ukáže.

Ceny blokových rutin jsou spočítané z instrukcí (`FILL_PAGES_TSTATES` 21 T/B, `FILL_BYTES_TSTATES` 24,
`LDIR_TSTATES` 21, `MEMCPY_WD_TSTATES` 162 — RST 08h kope watchdog dvakrát na bajt). `RESET_OVERHEAD_TSTATES`
je jediná kalibrovaná konstanta: pokrývá přímočarý kód (dekódování DIP, režii volání a watchdogu), který nemá
jiný pozorovatelný efekt než spotřebu času.

### Regrese

```
node tools/regress.mjs --frames 1100 --watch all      # celá RAM C000-C6FF proti refemu
node tools/regress.mjs --frames 300  --watch frame    # jen rámcové proměnné, rychlé
node tools/regress.mjs --random 3 --frames 3000 --watch player,enemy
```
Funkční protějšek regrese je `tools/playthrough.mjs`: prožene worker celou hrou s náhodným vstupem a vypíše,
co se stalo (mince, start, střídání kol po 1 024 snímcích, smrti, game over, návrat do attractu). Referenční
emulátor nepotřebuje, takže slouží i jako rychlý smoke test po jakékoli změně:

```
node tools/playthrough.mjs --seed 7 --quiet
→ seed 7, 40000 frames: 3 deaths, 1 game over(s), highest round 6, best score 3830
```

Skupiny `--watch`: `frame` (čítače, stav, kredity, životy, kolo, skóre, RNG), `video` (stíny atributů a sprajtů),
`player` (loď, střely, Bongo), `enemy` (záznamy objektů, spawn), `ram`/`all` (celá pracovní RAM). Nástroj hlásí
**první snímek a adresu**, kde se přepis a originál rozejdou — vývoj se tím řídí.

## bootWorker (`app/bootWorker.js`)

Druhý, samostatný klasický worker: **jen zapínací sekvence** automatu (`main_start` 0C85h → `initRam` →
dekódování DIP → `powerOnScreen` 0D4Ah), přepsaná stejně jako v `gameWorker.js` a se stejným modelem času
(T-stavy, `charge` před provedením, 51 200 T/snímek). Slouží `BootModel` (`app/bootModel.js`) jako
zaváděcí animace remaku — obdoba `ZXResetModel` ze svision v rozlišení hry. Končí v okamžiku, kdy by
originál skočil na `drawTitle` (0F2Eh), tj. těsně před prvním obrazem hry; nečte žádnou tabulku z ROM,
takže `tables` nepotřebuje. `gameWorker.js` se ho netýká (ten boot přetáčí, viz „Start hry").

- model → worker: `{id:'init', initData:{dsw0?, dsw1?}}` (bez hodnot tovární DIP), `{id:'reset'}`.
- worker → model: `{id:'frame', frame, vram, attr, sprites, regs, state:'boot'}` ve stejném tvaru jako
  u herního workeru (kreslí ho tytéž `TileMapEntity`/`SpriteLayerEntity`), a jednou `{id:'booted', frame}`.
- Kontrola: `node tools/match-boot.mjs` — oba workery tikají od resetu v zákrytu, obraz musí být shodný na
  každém snímku až do konce bootu (snímek 188; `gameWorker` začne kreslit titul na 191). Přijímá se nula rozdílů.

