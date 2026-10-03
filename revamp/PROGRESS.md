# Progress

Plan: modern UI over the unchanged PCGen Java engine, through a local sidecar HTTP API. `CLAUDE.md` (repository root) has the rules, layout, commands and gotchas; this file has the state, the facts we learned, the decisions the user made, and the to-do list.

The repository is a permanent fork of PCGen (`origin` = `LeonardoDeQuirm/pcgen-revamp`, `upstream` = `PCGen/pcgen`); our code is in `revamp/`.

## Status (end of session 2)
Everything below is committed and all tests pass (harness 10, sidecar 5, API 118, browser e2e 39). The app runs with `revamp\start-dev.ps1`.

- [x] 0. Scaffolding: PCGen cloned, JDK 25 installed, engine builds (`gradlew qbuild -x test`, ~1.5 min).
- [x] 1. Headless smoke test.
- [x] 2. Regression harness (`harness/`): CLI export snapshots for 5 characters x 2 templates. Clarent is compared as an unordered set of lines (see "Engine quirks").
- [x] 3. Sidecar: routes for characters, stats, levels (+ hit points), feats/abilities (+ info, conflicts), skills, equipment (+ custom item builder), spells (+ info, per-class slots), languages, biography, notes, chronicle, PDF/text export, dataset catalogs, file browser. Questions from the engine are bridged to the client.
- [x] 4./5. Read and editing API: done for the areas above. Gaps listed under "Not exposed yet".
- [~] 6. New UI (`ui/`): Overview, Class, Feats, Skills, Spells, Gear, Biography, Sheet (PDF) tabs working. See "UI" and the to-do list.
- [ ] 7. Packaging (desktop wrapper, installer, serving the built UI from the sidecar). Not started.

## How the pieces fit
`browser (ui/) --/api--> Vite dev server --proxy--> sidecar (Java, 127.0.0.1:8765) --> PCGen engine (pcgen/)`

- One sidecar process = one game mode + source set (the engine allows one data set per JVM). `start-dev.ps1` picks the sources from the character it is given. Requests are serialized on one worker thread. After READY a throwaway PDF is rendered to warm FOP (`-Dsidecar.warmup=false` disables; `/health` shows `pdfWarmup`).
- `GET /routes` lists every route. Arguments come from a JSON body or the query string. Replies for changes are `{character: <fresh snapshot>, messages: [...], ...}`; `CharacterView.java` is the one place that decides what the client sees of a character.
- Questions from the engine: **202** with `pendingChooser` (answer `POST /choosers/{id} {select:[..], deselect:[..]}` or `{cancel:true}`), `pendingConfirm` (`POST /confirms/{id} {ok}`) or `pendingBuilder` (custom item: edit via `/builder`, finish with `/builder/commit` or `/builder/cancel`). The answer call returns the operation's final result. Other calls get 409 while one is open. `/health` and `/shutdown` always work.
- Latency (server side, warm): reads 0-15 ms, catalog queries 0-300 ms, most writes 10-130 ms, level up/down 200-420 ms, race change ~1-1.4 s, first character open ~1-4 s, PDF 2-4.5 s (first one after warm-up ~4.5 s). The `slow request` log line (500 ms+) is only a log line.
- Startup: ~5 s for the core set, ~13 s for Clarent's 49 sources. Cold CLI export was ~6.5 s per run, so the sidecar delivers the main performance goal (load once).

## UI (React 19 + TypeScript + Vite 8; light/dark follow the system)
- `src/api.ts` typed client; `change()` handles 202 questions via dialogs. `src/store.tsx` app state. `src/detail.tsx` right-hand details panel (feats/class features/traits and spells). `src/components/`: `Overview` (ability scores, levels, hit points dialog, vitals, identity, to-do), `Feats` (+ `groups.ts` that sorts the engine's ability categories into Feats / Class / background), `Skills`, `Spells`, `Gear`, `Bio` (appearance, languages, notes, race & background), `Export` (PDF preview), `PreviewPicker` (two-pane Add pickers with a live description), `Dialogs` (chooser, confirm, builder, open-file), `InfoBody` (description rendering; PCGen "Type" tags and rule flags are hidden behind a "Technical details" fold-out that opens only to explain a conflict).
- Behaviours the user asked for and that must be kept: sections fold; clicking an entry opens details; Add pickers show descriptions first; unavailable picks explain why in plain words (`Requirements.java`) and disable Add; spell levels shown only for what the class can use, with a switch to browse higher ones (spellbook casters may add spells above their reach and they are flagged red; fixed-table casters cannot); Favored Class Bonus picker starts filtered to what the character qualifies for; a new level asks for the hit die result (type, roll, max, average; Constitution shown and added).

## Decisions and preferences from the user
- Slow replies are fine, failed ones are not. No deadlines on engine work.
- Fix core issues "under the hood" when they come up, small and recorded, at lower priority than the UI.
- Hooks (the API) before UI, to avoid spaghetti. Do all engine hooks needed for the sheet.
- PDF export is crucial. Details side panels everywhere an entry can be read about.
- Wizards must be able to scribe spells they cannot cast yet; mark those red on the Spells tab.
- The user's real test character is `clarent.pcg` (Half-Orc Inquisitor 4 / Fighter 1, 49 sources), kept only in `revamp/local/` (not published). One approved edit was made to it earlier (3 unresolved spell lines removed). Never edit it again.
- The GitHub repo is public. The user chose: permanent fork, our code merged into it, no personal character file in it.

## Changes we made to PCGen's own files (each is its own commit, so they can be offered upstream)
1. Engine: `VariableChannelFactoryInst` and `VariableWrapperFactoryInst` cached by `VariableID` only, so **funds (and any global variable channel) were shared by every open character**. Now keyed by (CharID, VariableID). Regression test: "funds are per character" in the API test.
2. Data: Half-Orcs never received the hidden `Race ~ Half-Orc` template, so every `PREFACT:...IsHalfOrc=true` requirement failed (all half-orc favored class bonuses). One token added in `data/pathfinder/.../races/half_orc/halforc_abilities_race.lst`.
Neither is reported upstream yet. (Before the fork was set up these lived as patch files; the commits replace them.)

## Engine quirks and rough edges found (not fixed unless said)
- Possibly the same missing-template omission as the half-orc: monkey_goblin, samsaran, skinwalker, svirfneblin (from a regex scan of `core_essentials/races`; NOT verified).
- Core+APG loads log `Illegal FACT subtoken 'IsOrc'` for `orc_templates.lst` (3 LSTERRORs, plus ~72 "invalid variable 'Score'" warnings). Clarent's set doesn't log it. Not investigated.
- Clarent's exports list same-level spells in a different order from run to run (same lines), mostly under parallel load; not caused by the unresolved spells. Likely identity-hash ordering somewhere in the engine. `UNORDERED` in `harness/run_harness.py`.
- `FopTask` recompiles the PDF stylesheet on every export (`TransformerFactory.newTransformer`); caching a `Templates` per XSLT would save about a second per PDF.
- The engine can list one spell twice (Ravener Hunter archetype: Blinding Ray at levels 2 and 3, each twice); `SpellRoutes` drops duplicates.
- The engine's HP method is a user setting; default is a random roll (`HP_STANDARD`). `maybeShowWarningConfirm` must be answered (see CLAUDE.md).
- Free-text choosers (`isUserInput`) are not handled: they would be declined/unusable.

## Not exposed yet (API or UI)
- API missing: companions/familiars/animal companions, kits, temporary bonuses, portrait, parties, custom spells, skill filter, equipment notes/charges, deleting custom equipment, `getCoreViewTree`, free-text choosers.
- API present, no UI yet: chronicle entries, equipment sets, spell preparation / spell books / spell lists, domains, templates add/remove, stat rolling, XP table / character type, save-as with a chosen path (Save works only for characters that already have a file).

## To do next (suggested order)
1. **Level-up / new-character flow** (the user's current focus): setting for the default hit point method (ask / auto-roll / average / max) and check the first-level-max rule; new-character wizard (stat roll or point buy, race, class, favored class, first feat/skills/languages) with Save As.
2. **More details panels**: skills, equipment (`InfoFactory.getHTMLInfo(EquipmentFacade)`), class entries; descriptions in the race/class/deity pickers too.
3. **Spells depth**: prepared spells, spell books and lists UI, per-day slots display, domain spells.
4. **Gear depth**: equipment sets UI, charges/notes, weight/encumbrance display.
5. **Missing hooks and their UI**: companions/familiars, kits, temp bonuses, portrait, parties, chronicle UI.
6. **Launcher and packaging (milestone 7)**: let the user choose a source set (campaign picker from `GET /campaigns`) and start/stop a sidecar per set; serve the built UI from the sidecar; desktop wrapper (Tauri or Electron), bundled JDK via jlink, installer. Add a Settings screen.
7. **Upstream/core**: offer the two fixes upstream (separate commits already); verify the four other races; cache the XSLT in `FopTask`; investigate the `IsOrc` FACT error and the unstable spell ordering.
8. **Quality**: more test characters (ask the user for a few), stat-level snapshots in the harness, keyboard/accessibility pass, narrow-screen layout, shorten the Class tab (per-class sections).

## Measurements
Headless CLI export (Core Rulebook + APG, `pf_Cleric.pcg`, plain text sheet), JDK 25, run from `pcgen/`: cold JVM end to end 6.1-6.7 s (source load ~1.4 s of that); peak working set 634-971 MB (default heap sizing); output byte-identical across runs. Command: `java -cp "build/libs/*" pcgen.system.Main -s <settingsdir> -c <char.pcg> -E <template> -o <out>`. Not measured: Swing GUI startup, true heap need. Sample characters in `pcgen/characters/` are 3e; the Pathfinder ones are `pcgen/code/testsuite/PCGfiles/pf_*.pcg` (4 of them).

## Session log (short)
- Session 1: planned the approach, set up the repo notes.
- Session 2: cloned and built PCGen (JDK 25 installed); built the regression harness; built the sidecar (chooser bridge, then every route group above); added PDF export with warm-up; installed poppler; built the UI slice by slice from the user's feedback (tabs, details panel, Add pickers, spell levels, hit points, favored class bonus); found and fixed the two upstream bugs above; wrote the browser test; committed.
