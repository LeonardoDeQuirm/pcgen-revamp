"""Regression harness: export sample characters headlessly and compare to snapshots.

Usage:
  python harness/run_harness.py            compare against harness/baseline/
  python harness/run_harness.py --update   (re)write the baseline
  python harness/run_harness.py --jdk PATH override JDK 25 location

Each (character, template) pair runs in its own JVM, because the engine holds
static global state. Pairs run in parallel with separate settings dirs.
"""
import argparse, difflib, re, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REVAMP = Path(__file__).resolve().parent.parent      # <repo>/revamp: our code
ROOT = REVAMP                                        # (older name, still imported by the other tests)
PCGEN = REVAMP.parent                                # <repo>: the PCGen checkout, where the engine runs
BASELINE = REVAMP / "harness" / "baseline"
DEFAULT_JDK = Path(r"C:\Program Files\Eclipse Adoptium\jdk-25.0.4.101-hotspot")

CHAR_DIRS = [PCGEN / "code" / "testsuite" / "PCGfiles"]
CHAR_GLOB = "pf_*.pcg"  # Pathfinder 1e only
# Generated characters (see build_corpus.py): many classes and races on the 49-source data set. Committed.
CORPUS_DIR = REVAMP / "harness" / "characters"
# Real characters supplied by the user, kept in revamp/local (not in git). Only ever read, never saved.
EXTRA_CHARS = [REVAMP / "local" / "clarent.pcg"]   # git-ignored; skipped when absent


# Characters whose export ORDER is not stable between runs (content is). Seen with clarent.pcg: the order
# of same-level spells differs from run to run, mostly under parallel load (same lines every time). It
# survives removing the spells the data set can't find, so it is not just those placeholders. Likely
# identity-hash ordering somewhere in the engine; see PROGRESS.md "Candidate core fixes".
UNORDERED = {"clarent"}


# Exports whose CONTENT differs from run to run on the unmodified upstream engine (measured: the Aberrant bloodline
# sorcerer shows the level-3 power "Long Limbs" in 12 of 24 identical runs, with the original engine code and with
# ours). Reported but not counted as failures until the engine bug is found.
NONDETERMINISTIC = {"corpus_sorcerer3.xml"}


def is_unordered(char_stem):
    return char_stem in UNORDERED or char_stem.startswith("corpus_")


def same(char_stem, a, b):
    """Exact comparison, or same-lines-in-any-order for UNORDERED characters."""
    if is_unordered(char_stem):
        from collections import Counter
        return Counter(a.splitlines()) == Counter(b.splitlines())
    return a == b


def all_chars():
    return sorted([p for d in CHAR_DIRS for p in d.glob(CHAR_GLOB)] + [p for p in EXTRA_CHARS if p.exists()]
                  + sorted(CORPUS_DIR.glob("corpus_*.pcg")))
TEMPLATES = {
    "plain": "outputsheets/d20/fantasy/text/csheet_plain.TXT",
    "xml": "outputsheets/d20/fantasy/htmlxml/csheet_fantasy_generic_export.xml.ftl",
}


# Volatile fields that differ on every run.
VOLATILE = [(re.compile(r"<date>[^<]*</date>"), "<date>X</date>"),
            (re.compile(r"<time>[^<]*</time>"), "<time>X</time>"),
            # The XML export lists the machine's folders (install location, the user's documents). Those differ per
            # machine and contain the user's name, so they are masked before comparing or storing a baseline.
            (re.compile(r"<(pcgen|templates|pcg|html|temp)>[^<]*</\1>"), r"<\1>X</\1>"),
            # Any other absolute path into a user's profile (e.g. the portrait location).
            (re.compile(r"[A-Za-z]:\\Users\\[^\\<\"]+"), lambda m: r"C:\Users\USER")]


def normalize(text):
    for rx, repl in VOLATILE:
        text = rx.sub(repl, text)
    return text


def run_one(java, char, tname, tpath, workdir):
    out = workdir / f"{char.stem}.{tname}.out"
    settings = workdir / f"settings-{char.stem}-{tname}"
    settings.mkdir(parents=True, exist_ok=True)
    cmd = [str(java), "-cp", "build/libs/*", "pcgen.system.Main", "-s", str(settings),
           "-c", str(char), "-E", tpath, "-o", str(out)]
    t = time.time()
    p = subprocess.run(cmd, cwd=PCGEN, capture_output=True, text=True, timeout=600)
    log = p.stdout + p.stderr
    return {"name": f"{char.stem}.{tname}", "out": out, "rc": p.returncode,
            "secs": time.time() - t, "lsterrors": log.count("LSTERROR"),
            "ok": out.exists() and p.returncode == 0}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--update", action="store_true")
    ap.add_argument("--jdk", type=Path, default=DEFAULT_JDK)
    ap.add_argument("-j", type=int, default=4)
    args = ap.parse_args()
    java = args.jdk / "bin" / "java.exe"
    chars = all_chars()
    work = Path(tempfile.mkdtemp(prefix="pcgen-harness-"))
    jobs = [(java, c, n, t, work) for c in chars for n, t in TEMPLATES.items()]
    with ThreadPoolExecutor(args.j) as ex:
        results = list(ex.map(lambda a: run_one(*a), jobs))

    BASELINE.mkdir(parents=True, exist_ok=True)
    failed = 0
    for r in results:
        base = BASELINE / (r["name"] + ".out")
        if not r["ok"]:
            print(f"FAIL  {r['name']}: no output (rc={r['rc']})"); failed += 1; continue
        new = normalize(r["out"].read_text(encoding="utf-8", errors="replace"))
        if args.update:
            base.write_text(new, encoding="utf-8", newline="")
            print(f"WROTE {r['name']} ({len(new)} chars, {r['secs']:.1f}s, {r['lsterrors']} LSTERROR)")
        elif not base.exists():
            print(f"NEW   {r['name']}: no baseline (run --update)"); failed += 1
        else:
            old = base.read_text(encoding="utf-8", errors="replace")
            if same(r["name"].split(".")[0], old, new):
                print(f"PASS  {r['name']} ({r['secs']:.1f}s)")
            elif r["name"] in NONDETERMINISTIC:
                print(f"SKIP  {r['name']}: differs, but this export is known to vary between identical runs")
            else:
                failed += 1
                print(f"DIFF  {r['name']}")
                d = difflib.unified_diff(old.splitlines(), new.splitlines(), "baseline", "current", lineterm="", n=1)
                for i, line in enumerate(d):
                    if i >= 30: print("  ..."); break
                    print("  " + line)
    print(f"{len(results) - failed}/{len(results)} ok")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
