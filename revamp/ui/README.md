# PCGen UI

A modern front end for the PCGen rules engine. The browser app (React + TypeScript + Vite) talks to the
local Java sidecar, which wraps the unchanged PCGen engine.

## Run it

From the repository root, in PowerShell:

```
.\revamp\start-dev.ps1 -Character path\to\a.pcg
.\revamp\stop-dev.ps1
```

The script copies your character to `.run\` and works on the copy. It starts the engine (5 to 15 seconds,
depending on how many source books the character uses), starts the UI at http://127.0.0.1:5173 and opens it.

## How it fits together

```
browser (this app)  --/api-->  Vite dev server  --proxy-->  sidecar (Java, 127.0.0.1:8765)  -->  PCGen engine
```

- `src/api.ts`: typed client. `change()` handles the engine pausing mid-change to ask a question
  (a 202 reply): choosers become a dialog, the custom-equipment builder becomes a dialog.
- `src/store.tsx`: app state (open characters, the active one, unsaved edits, toasts).
- `src/components/`: one file per screen area (Overview, Feats, Skills, Spells, Gear, Bio, Export) plus dialogs.
- `src/styles.css`: the design tokens and components. Light and dark follow the system setting.

## Checks

```
npm run typecheck     # TypeScript
npm run build         # typecheck + production build into dist/
npm run e2e -- <copy-of-a-character.pcg>   # drives the real UI in Edge against a running sidecar
```

The e2e needs the dev stack running (`revamp\start-dev.ps1`) and is given the **copy** in `.run\` that the sidecar
loaded, never your original.
