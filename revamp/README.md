# revamp: a modern front end for PCGen

This folder holds everything that is new in this fork of [PCGen](https://github.com/PCGen/pcgen); everything outside it is PCGen. The [repository README](../README.md) explains the idea and the overall design. This page is the map of the code.

## What is here

| Folder / file | What it is |
| --- | --- |
| `sidecar/` | A Java HTTP server (JDK built-in server, no extra libraries) that wraps the unchanged engine. `src/pcgen/sidecar/` has one class per route group; two tiny bridge classes sit in PCGen's own packages (`pcgen/system`, `pcgen/gui2/facade`) only to reach package-private APIs. |
| `ui/` | React 19 + TypeScript + Vite app. `src/api.ts` is the typed client, `src/store.tsx` the state, `src/components/` one file per screen area, `src/detail.tsx` the details side panel, `src/styles.css` the design. |
| `harness/` | Python tests against the real engine, plus `baseline/` (stored export snapshots of the Pathfinder sample characters). |
| `ui/e2e/smoke.mjs` | The browser test (puppeteer-core driving Edge). |
| `start-dev.ps1`, `stop-dev.ps1` | Start or stop the engine and the UI on a copy of a character. |
| `PROGRESS.md` | The state of the project, what was learned about the engine, decisions made, and the to-do list. |
| `local/`, `.run/` | Git-ignored: private test characters, and scratch (copies, logs, screenshots). |

## The sidecar in one page

- **Routes** are registered in `Sidecar.registerRoutes`; `GET /routes` lists them. Arguments come from a JSON body or the query string. Changes reply with `{character, messages, ...}`: a fresh snapshot built by `CharacterView` plus anything the engine said.
- **One engine call at a time.** `Sidecar.runOp` runs a call on the single worker thread. A request that arrives meanwhile waits its turn; `/health`, answering a question and `/shutdown` never wait.
- **Questions.** When PCGen asks something, `RecordingUIDelegate` parks the worker and the HTTP call answers `202` with `pendingChooser`, `pendingConfirm` or `pendingBuilder`. The answer call (`/choosers/{id}`, `/confirms/{id}`, `/builder/...`) resumes the engine. While one is open, other engine calls get `409`. A person has an hour to answer; engine work itself has no deadline.
- **Who may call.** Loopback only; requests with a foreign `Host` or `Origin`, or a browser-reported cross-site `Sec-Fetch-Site`, get `403`. Extra origins can be allowed with `--allow-origin`. Templates must live under the output-sheets folder; saves must be `.pcg` files in an existing folder.
- **Descriptions** (`InfoText`, `Requirements`): the engine's HTML info text is turned into labelled sections, and the red-marked unmet requirements into plain sentences.
- **Spells**: `SidecarAccess` reads each class's real per-level spell figures (per day, known) from the character underneath the facades.

## The UI in one page

- `api.change()` is the one function for edits. It loops on `202` replies and shows the right dialog (`ChooserDialog`, `ConfirmDialog`, `BuilderDialog`).
- `groups.ts` sorts PCGen's "ability categories" into the Feats tab, the Class tab, and the Race & background card.
- `PreviewPicker` is the two-pane Add dialog (list on the left, description on the right); `InfoBody` renders a description and hides PCGen's internal type tags in a fold-out.
- Light and dark themes follow the system setting.

## Run and test

See [`../CLAUDE.md`](../CLAUDE.md) for the exact commands. In short:

```powershell
.\revamp\start-dev.ps1 -Character path\to\your.pcg     # http://127.0.0.1:5173
python revamp\harness\run_harness.py                    # CLI export snapshots
python revamp\harness\run_sidecar_test.py               # a sidecar per sample character
python revamp\harness\run_api_test.py                   # every route group, latency budgets
cd revamp\ui; npm run typecheck; npm run e2e -- ..\.run\<copy>.pcg
```

Needs: JDK 25, Node, Python 3, Microsoft Edge (for the browser test).
