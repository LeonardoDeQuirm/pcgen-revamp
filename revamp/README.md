# revamp: a modern front end for PCGen

This repository is a fork of [PCGen](https://github.com/PCGen/pcgen). The folder you are in holds the new front end for the Pathfinder 1e character builder; everything outside it is PCGen.

- `sidecar/`: a small Java server that wraps the unchanged PCGen rules engine behind a local HTTP API.
- `ui/`: a React + TypeScript app (Vite) that uses that API: character sheet tabs, details panels, add-pickers with descriptions, PDF sheets.
- `harness/`: tests that run against the real engine (`run_harness.py`, `run_sidecar_test.py`, `run_api_test.py`; the browser test is `ui/e2e/smoke.mjs`).
- `start-dev.ps1` / `stop-dev.ps1`: run the whole stack on a copy of a character.

Start with `../CLAUDE.md` (how to build, run and test) and `PROGRESS.md` (state, decisions, what is next).

Needs: JDK 25, Node, Python 3, Microsoft Edge (for the browser test).
