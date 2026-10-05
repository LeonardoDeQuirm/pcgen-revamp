"""Builds a corpus of test characters through the sidecar API and saves them as .pcg files in harness/characters/.

Usage: python harness/build_corpus.py
Why: the regression harness is only as good as its characters. This makes a spread of classes and races (casters,
martial classes, pet classes, gear, feats, skills) on the same 49-source data set as the real test character, so
engine changes are checked against many kinds of character, not just a few. The characters contain nothing personal.
Engine questions are answered with the first option(s); the results are plain valid characters, not optimised builds.
Needs revamp/local/clarent.pcg (only to pick the source books).
"""
import json, shutil, subprocess, sys, tempfile, threading, time, urllib.error, urllib.request
from pathlib import Path

from run_harness import DEFAULT_JDK, PCGEN, REVAMP

PORT = 8790
OUT = REVAMP / "harness" / "characters"
OUT.mkdir(exist_ok=True)
B = f"http://127.0.0.1:{PORT}"
SOURCE = REVAMP / "local" / "clarent.pcg"

# name, race, class plan [(class, levels)], base scores STR DEX CON INT WIS CHA, spells to try adding, gear
PLANS = [
    ("corpus_wizard5", "Human", [("Wizard", 5)], [8, 14, 12, 18, 12, 10], True, ["Quarterstaff", "Dagger", "Spell Component Pouch"]),
    ("corpus_fighter6", "Dwarf", [("Fighter", 6)], [17, 12, 16, 10, 12, 8], False, ["Longsword", "Chainmail", "Shield, Heavy Steel", "Longbow"]),
    ("corpus_rogue4", "Elf", [("Rogue", 4)], [10, 18, 12, 14, 10, 12], False, ["Rapier", "Leather Armor", "Dagger"]),
    ("corpus_cleric5", "Half-Elf", [("Cleric", 5)], [12, 10, 14, 10, 18, 12], True, ["Mace, Heavy", "Scale Mail", "Shield, Heavy Wooden"]),
    ("corpus_sorcerer3", "Halfling", [("Sorcerer", 3)], [8, 14, 12, 10, 10, 18], True, ["Dagger"]),
    ("corpus_bard4", "Gnome", [("Bard", 4)], [8, 14, 12, 12, 10, 18], True, ["Rapier"]),
    ("corpus_barbarian7", "Human", [("Barbarian", 7)], [18, 14, 16, 8, 10, 8], False, ["Greataxe", "Hide Armor"]),
    ("corpus_paladin5", "Human", [("Paladin", 5)], [16, 10, 14, 8, 12, 16], False, ["Longsword", "Banded Mail", "Shield, Heavy Steel"]),
    ("corpus_ranger4", "Half-Orc", [("Ranger", 4)], [14, 16, 12, 10, 14, 8], False, ["Longbow", "Sword, Short", "Studded Leather"]),
    ("corpus_druid4", "Human", [("Druid", 4)], [10, 12, 14, 10, 18, 10], True, ["Scimitar", "Hide Armor"]),
    ("corpus_monk3", "Human", [("Monk", 3)], [14, 16, 12, 10, 16, 8], False, ["Quarterstaff"]),
    ("corpus_multi", "Human", [("Fighter", 2), ("Wizard", 2), ("Rogue", 2)], [14, 14, 12, 14, 10, 10], True, ["Longsword", "Dagger"]),
    ("corpus_alchemist3", "Human", [("Alchemist", 3)], [10, 14, 14, 18, 10, 8], True, ["Dagger"]),
    ("corpus_oracle3", "Human", [("Oracle", 3)], [10, 12, 14, 8, 10, 18], True, ["Dagger"]),
    ("corpus_inquisitor5", "Dwarf", [("Inquisitor", 5)], [14, 10, 14, 10, 18, 10], True, ["Longsword", "Chain Shirt"]),
    ("corpus_magus4", "Elf", [("Magus", 4)], [12, 14, 12, 16, 10, 8], True, ["Longsword", "Chain Shirt"]),
]
STATS = ["STR", "DEX", "CON", "INT", "WIS", "CHA"]


def call(method, path, body=None):
    req = urllib.request.Request(B + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def settle(st, d, log=None):
    """Answer engine questions: yes to confirms, the first N options of a chooser."""
    guard = 0
    while st == 202 and guard < 40:
        guard += 1
        if "pendingConfirm" in d:
            st, d = call("POST", f"/confirms/{d['pendingConfirm']['id']}", {"ok": True})
        elif "pendingChooser" in d:
            ch = d["pendingChooser"]
            n = max(ch.get("choicesRequired", 1), 1)
            have = len(ch.get("alreadySelected", []))
            pick = list(range(min(n, len(ch.get("options", [])))))
            if log is not None:
                log.append(f"chooser '{ch.get('title', '')[:50]}' -> {pick}")
            st, d = call("POST", f"/choosers/{ch['id']}", {"select": pick} if pick else {"cancel": True})
        elif "pendingBuilder" in d:
            st, d = call("POST", "/builder/cancel", {})
        else:
            break
    return st, d


def build(plan, notes):
    name, race, classes, scores, caster, gear = plan
    cid = name
    st, d = call("POST", "/characters/new", {"name": name.replace("corpus_", "Corpus ").title(), "id": cid})
    assert st == 200, d
    C = f"/characters/{cid}"
    for stat, v in zip(STATS, scores):
        call("PUT", f"{C}/stats/{stat}", {"base": v})
    st, d = settle(*call("PATCH", C, {"race": race}), notes)
    if st != 200:
        notes.append(f"race {race}: {st} {str(d)[:100]}")
    # Some classes only admit certain alignments.
    align = {"Paladin": "Lawful Good", "Monk": "Lawful Good", "Druid": "Neutral"}.get(classes[0][0])
    if align:
        st, d = call("PATCH", C, {"alignment": align})
        if st != 200:
            notes.append(f"alignment {align}: {st} {str(d)[:80]}")
    for cls, count in classes:
        for _ in range(count):
            st, d = settle(*call("POST", f"{C}/levels", {"class": cls}), notes)
            if st != 200:
                notes.append(f"level {cls}: {st} {str(d)[:120]}")
                break
            # spend this level's skill points on class skills, one rank at a time
            sk = call("GET", f"{C}/skills", )[1]
            levels = sk["levels"]
            remaining = levels[-1]["skillPointsRemaining"] if levels else 0
            class_skills = [s["key"] for s in call("GET", f"{C}/skills?all=true")[1]["skills"] if s.get("cost") == "CLASS"]
            i = 0
            guard = 0
            while remaining > 0 and class_skills and guard < 60:
                guard += 1
                ok = call("POST", f"{C}/skills", {"skill": class_skills[i % len(class_skills)], "points": 1})[1]
                if not ok.get("applied", True):
                    i += 1
                    continue
                remaining -= 1
                i += 1
    # feats: take the first few it qualifies for, in every category that still has picks
    snap = call("GET", C)[1]
    for cat in snap["abilityCategories"]:
        tries = 0
        while cat["remaining"] and cat["remaining"] > 0 and tries < 6:
            tries += 1
            items = call("GET", f"/dataset/abilities?category={urllib.request.quote(cat['key'])}&character={cid}&qualified=true&limit=40")[1]["items"]
            if not items:
                break
            have = {a["key"] for a in cat["abilities"]}
            pick = next((i for i in items if i["key"] not in have), None)
            if not pick:
                break
            st, d = settle(*call("POST", f"{C}/abilities", {"category": cat["key"], "name": pick["key"]}), notes)
            snap = call("GET", C)[1]
            cat = next((c for c in snap["abilityCategories"] if c["key"] == cat["key"]), cat)
    # spells: a few known spells per caster class at each spell level it can use
    if caster:
        sp = call("GET", f"{C}/spells")[1]
        for cls in sp.get("classes", []):
            for lv in cls["levels"]:
                if not lv["usable"] or lv["known"] <= lv["knownNow"]:
                    continue
                avail = call("GET", f"{C}/spells?available=true&class={urllib.request.quote(cls['class'])}&limit=100000")[1].get("available", [])
                for row in [r for r in avail if r["level"] == str(lv["level"])][: lv["known"] - lv["knownNow"]]:
                    call("POST", f"{C}/spells/known", {"class": cls["class"], "level": row["level"], "spell": row["spell"]})
    # gear: buy and equip
    call("PATCH", C, {"funds": "5000"})
    for item in gear:
        st, d = settle(*call("POST", f"{C}/equipment/buy", {"item": item, "quantity": 1}), notes)
        if st == 200:
            call("POST", f"{C}/equipment/equip", {"item": item})
        else:
            notes.append(f"gear {item}: {st} {str(d)[:80]}")
    path = str(OUT / f"{name}.pcg")
    st, d = call("POST", f"{C}/save", {"path": path})
    final = call("GET", C)[1]
    call("DELETE", C)
    return st == 200, final


def main():
    work = Path(tempfile.mkdtemp(prefix="corpus-"))
    char = work / "clarent.pcg"
    shutil.copyfile(SOURCE, char)
    proc = subprocess.Popen([str(DEFAULT_JDK / "bin" / "java.exe"), "-cp", "revamp/sidecar/build;build/libs/*", "pcgen.sidecar.Sidecar",
                             "--settings-dir", tempfile.mkdtemp(prefix="corpus-settings-"), "--from-character", str(char),
                             "--port", str(PORT)], cwd=PCGEN, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    ready = threading.Event()
    threading.Thread(target=lambda: [ready.set() for l in proc.stdout if l.startswith("READY")], daemon=True).start()
    try:
        if not ready.wait(300):
            raise SystemExit("sidecar never ready")
        only = set(sys.argv[1:])
        for plan in PLANS:
            if only and plan[0] not in only:
                continue
            notes = []
            t0 = time.time()
            try:
                ok, final = build(plan, notes)
            except Exception as e:  # keep going: one broken archetype should not stop the rest
                print(f"FAIL  {plan[0]}: {e!r}")
                continue
            lv = [f"{c['class']} {c['level']}" for c in final.get("classes", [])]
            print(f"{'ok  ' if ok else 'FAIL'}  {plan[0]:20s} {final.get('race')} {', '.join(lv)}  hp {final.get('hp')}  "
                  f"todo {len(final.get('todo', []))}  ({time.time() - t0:.0f}s)")
            for n in notes[:4]:
                print("        note:", n)
    finally:
        proc.kill()


if __name__ == "__main__":
    main()
