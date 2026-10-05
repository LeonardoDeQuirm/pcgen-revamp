# CLAUDE.md

Project: a modern front end for PCGen (Pathfinder 1e character builder). This repository is a **permanent fork** of PCGen (`PCGen/pcgen`, remote `upstream`; our fork is remote `origin`, `LeonardoDeQuirm/pcgen-revamp`, branch `master`). We keep PCGen's Java rules engine and LST data format; we replace the dated Swing UI with a React app that talks to the engine through a local "sidecar" HTTP API. Do NOT rewrite the rules engine or the data format. Target game: Pathfinder 1e. Nothing here is meant to be merged back upstream (fixes that would help upstream are separate small commits so they can be offered).

Read `revamp/PROGRESS.md` next: current state, verified engine facts, API summary, the decisions the user has made, and the prioritized to-do list. Update it at the end of every session.

`AGENTS.md` (upstream's) describes the PCGen build and conventions; it asks that LLM-made changes be recorded there, so it has a short section pointing at `revamp/`.

## Working rules
- **Commit and push freely** (the user gave blanket permission on 2026-10-05: version control makes any mistake fixable). Keep commits small and logical, engine/data changes in their own commits, and run the safety tests first. **Never delete the user's files or touch their account/system settings** (git global config, Windows settings, etc.). Ask before installing anything or changing system settings. (Already approved and installed: JDK 25, poppler, the npm packages in `revamp/ui`.) The repo is public: never commit personal data (the user's characters, local paths, email addresses; use the GitHub noreply address for commits).
- Keep our work in `revamp/`. Changes to PCGen's own files (`code/`, `data/`, ...) are deliberate, small, one concern per commit, and listed in `revamp/PROGRESS.md`. Check upstream isn't already fixed first (`git fetch upstream`).
- **Never modify the user's characters.** Their real character (`clarent.pcg`) lives only in `revamp/local/` (git-ignored) and is our hardest test case. Anything that can save must work on a temp copy (`start-dev.ps1` already works on a copy in `revamp/.run/`). Never point a test that can save at files tracked in git (an early test overwrote an upstream sample character).
- Verify with the tests below, not by eye. Look at screenshots too: this user cares about how the UI looks.
- User principles: **slow is fine, failing is not** (never time out or cut off engine work; only waits for a human answer may expire, currently 1 hour). Explain engine rules in plain words (the original UI's jargon is what we are replacing). When something is an upstream bug, say so and fix it small and recorded.
- The user is not a developer. Report in plain language, lead with what changed and what they should check, be honest about what is untested.

## Layout (repository root = the PCGen checkout)
- `revamp/sidecar/` Java HTTP API over the engine (`src/pcgen/sidecar/*`; plus two tiny bridge classes in the engine's own packages, `pcgen/system/SidecarBootstrap.java` and `pcgen/gui2/facade/SidecarAccess.java`, only to reach package-private APIs). Build: `powershell revamp/sidecar/build.ps1`.
- `revamp/ui/` React 19 + TypeScript + Vite. `revamp/ui/README.md` explains it. `revamp/ui/e2e/smoke.mjs` is the browser test (puppeteer-core driving the installed Edge).
- `revamp/harness/` Python tests and the baseline snapshots (`harness/baseline/`, Pathfinder samples only).
- `revamp/start-dev.ps1`, `stop-dev.ps1` run the whole stack on a copy of a character. `revamp/.run/` (scratch: copies, logs, screenshots in `.run/shots/`) and `revamp/local/` (private test characters) are git-ignored.
- Everything else is PCGen. Our engine changes so far: `VariableChannelFactoryInst`/`VariableWrapperFactoryInst` (funds were shared between characters) and one Half-Orc data file.

## Run it
```
powershell .\revamp\start-dev.ps1 -Character path\to\a.pcg [-NoBrowser]   # engine + UI at http://127.0.0.1:5173
powershell .\revamp\stop-dev.ps1
```
The character you start with decides which game mode and source books the engine loads (one process = one source set). A 49-source character loads in ~7.3 s (was ~12.3 s before the load-time fixes); the core set in ~5 s. Measure with `python revamp/harness/measure_load.py`.

## Tests (run all before calling something done; all passed at the last commit)
```
$env:JAVA_HOME='C:\Program Files\Eclipse Adoptium\jdk-25.0.4.101-hotspot'; .\gradlew qbuild -x test   # only if the engine changed (~1.5 min)
powershell revamp/sidecar/build.ps1                                   # after any sidecar change
python revamp/harness/run_harness.py          # CLI exports vs baselines. --update rewrites baselines
python revamp/harness/run_sidecar_test.py     # one sidecar per sample character, chooser bridge
python revamp/harness/run_all_gates.py [fp_baseline.json]   # ALL of the below plus PCGen unit tests, in one go (~10 min)
python revamp/harness/run_api_test.py         # every route group + latency budgets (225 checks)
python revamp/harness/run_packaged_test.py    # sidecar serving the built UI, free port, token (needs npm run build in revamp/ui)
cd revamp/ui; npm run typecheck; npm run e2e -- ..\.run\<copy>.pcg   # needs start-dev.ps1 running; 75 checks. Restart start-dev afterwards: the e2e edits the copy
```
The harness also compares `revamp/local/clarent.pcg` and `revamp/local/kaito.pcg` (a 14th-level Kitsune rogue with many added feats, 26 sources) when they exist; without them those cases are skipped. Their baselines are git-ignored.

## Machine notes (Windows 11, Git Bash + PowerShell)
- JDK 25 (Temurin) at `C:\Program Files\Eclipse Adoptium\jdk-25.0.4.101-hotspot`; the system `JAVA_HOME` is still JDK 17, so set it per command. Gradle does not auto-download Java 25.
- Node 26 / npm 11. Poppler installed via winget (`pdftoppm` under `%LOCALAPPDATA%\Microsoft\WinGet\Packages\oschwartz10612.Poppler_*\...\Library\bin`, not on PATH) for looking at PDFs. Edge is used for screenshots/e2e: `msedge.exe --headless=new --screenshot=...`. `gh` is logged in as LeonardoDeQuirm.
- Tooling gotchas that cost time: big Bash heredocs with quotes/backslashes often break or mangle (`\s`, `\n`, `\1`, `\u2026`): write scripts to a file with the Write tool and run them. Never `sed` a Java regex. Run `start-dev.ps1` from the PowerShell tool (from Bash it can hang). Inside JSX text `\u2026` is NOT an escape. Python 3.10 on PATH.
- A subprocess whose stderr is a PIPE you never read will deadlock the JVM (it logs a lot): redirect to DEVNULL/a file.

## Key engine facts (verified)
- Facades in `code/src/java/pcgen/facade/core/`, implementations in `pcgen/gui2/facade/`. One data set per JVM; global static state; not thread-safe. So: one process per game mode + source set, every engine call on one worker thread (`Sidecar.runOp`).
- The engine asks questions synchronously mid-operation (choosers, yes/no confirms, the custom-item builder). The sidecar parks the worker, answers the original HTTP call with **202** (`pendingChooser` / `pendingConfirm` / `pendingBuilder`), and the answer call returns the operation's final result. `revamp/ui/src/api.ts` `change()` loops on this. Only one operation at a time; others get 409.
- Requests run on their own threads; **engine calls queue** (a waiting request is fine, a failed one is not), and only an operation parked on a question gives 409. `/health`, answers and `/shutdown` bypass the queue. Don't put long work on an HTTP thread outside `runOp`.
- The API is guarded against other websites (`guardCaller`: Host, Origin, Sec-Fetch-Site) and confines templates and saves; keep those checks when adding routes that read or write files.
- `ChooserFactory.setDelegate` is only called by the Swing GUI; the sidecar sets it itself.
- Per-level skill ranks are running totals (don't sum levels). `getAvailableList()` on a language chooser rebuilds it (call once). `maybeShowWarningConfirm` returning `false` silently cancels the first level-up: it must be answered.
- The engine marks freshly opened characters as modified; the UI tracks real edits itself.
- Info text for feats/spells comes as HTML with `<b>Label:</b>` runs (`InfoText.java`); unmet requirements are wrapped in `<font color="#ff0000">`.
- The XML export contains the machine's folder names; the harness masks them so baselines contain no personal paths.
