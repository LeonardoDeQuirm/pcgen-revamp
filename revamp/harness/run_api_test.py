"""API test: drives every route group of the sidecar against a live engine and checks the
results, including latency budgets (the point of the sidecar is to be fast once loaded).

Usage: python harness/run_api_test.py
Needs: `gradlew qbuild` in pcgen/ and `powershell sidecar/build.ps1` first.

One sidecar is started on the Cleric's sources and shared by all checks, in order. Checks
that change the character restore it, or work on a freshly created character.
"""
import json, os, shutil, subprocess, sys, tempfile, threading, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

from run_harness import CHAR_DIRS, DEFAULT_JDK, PCGEN, TEMPLATES, normalize

PORT = 8899
# Work on a copy: saving through the API writes to the character's own file, and the originals
# are upstream test data that must never be modified.
CHAR = Path(tempfile.mkdtemp(prefix="api-char-")) / "pf_Cleric.pcg"
shutil.copyfile(CHAR_DIRS[0] / "pf_Cleric.pcg", CHAR)
CID = "pf_Cleric"
C = f"/characters/{CID}"

# Latency budgets in ms, judged on the server-side X-Time-Ms header (no client/network noise).
READ_BUDGET_MS = 150      # state reads, catalogs
WRITE_BUDGET_MS = 1500    # engine writes (level-up, race change recompute the whole character)
OPEN_BUDGET_MS = 5000     # first open pays one-time warm-up costs
PDF_BUDGET_MS = 15000     # FOP rendering; the first PDF of a session is the slowest (3-8 s seen)

results = []   # (name, ok, detail)
timings = []   # (label, ms, budget)


def call(method, route, body=None, budget=None, _headers=None, **query):
    url = f"http://127.0.0.1:{PORT}{route}"
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = json.dumps(body).encode() if body is not None else (b"" if method in ("POST", "PUT", "PATCH") else None)
    headers = {"Content-Type": "application/json", **(_headers or {})}
    req = urllib.request.Request(url, method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            status, raw, ms, ctype = r.status, r.read(), r.headers.get("X-Time-Ms"), r.headers.get("Content-Type")
    except urllib.error.HTTPError as e:
        status, raw, ms, ctype = e.code, e.read(), e.headers.get("X-Time-Ms"), e.headers.get("Content-Type")
    if ctype and not ctype.startswith("application/json"):
        js = raw
        if ctype.startswith("text/"):
            js = raw.decode("utf-8", "replace").replace("\r\n", "\n")
    else:
        try:
            js = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            js = raw.decode("utf-8", "replace")
    if budget is not None and ms is not None:
        timings.append((f"{method} {route}", int(ms), budget))
    return status, js


def read(route, **q):
    return call("GET", route, budget=READ_BUDGET_MS, **q)


def write(method, route, body=None, **q):
    return call(method, route, body, budget=WRITE_BUDGET_MS, **q)


def settle(r, select=None):
    """Answer any choosers raised by a call, taking the first N options (or `select`)."""
    status, js = r
    while status == 202:
        if "pendingConfirm" in js:  # yes/no questions: always agree
            status, js = call("POST", "/confirms/" + js["pendingConfirm"]["id"], {"ok": True})
            continue
        d = js["pendingChooser"]
        n = max(d["choicesRequired"], 0)
        status, js = call("POST", "/choosers/" + d["id"], {"select": list(range(n)) if select is None else select})
    return status, js


def check(name, cond, detail=""):
    results.append((name, bool(cond), "" if cond else str(detail)[:300]))


def snap():
    return read(C)[1]


def start_sidecar():
    cmd = [str(DEFAULT_JDK / "bin" / "java.exe"), "-Dpcgen.sidecar.questionTimeoutSeconds=15", "-cp", "revamp/sidecar/build;build/libs/*", "pcgen.sidecar.Sidecar",
           "--settings-dir", tempfile.mkdtemp(prefix="api-test-"), "--from-character", str(CHAR), "--port", str(PORT)]
    proc = subprocess.Popen(cmd, cwd=PCGEN, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    ready = threading.Event()

    def watch():
        for line in proc.stdout:
            if line.startswith("READY"):
                ready.set()
    threading.Thread(target=watch, daemon=True).start()
    if not ready.wait(180):
        proc.kill()
        raise RuntimeError("sidecar never reported READY")
    # The PDF warm-up occupies the engine for several seconds after READY; wait so timings are meaningful.
    deadline = time.time() + 120
    while time.time() < deadline:
        try:
            if call("GET", "/health")[1].get("pdfWarmup") in ("done", "disabled"):
                break
        except Exception:
            pass
        time.sleep(0.5)
    return proc


def run_checks():
    # ---- dataset catalogs
    st, d = read("/dataset")
    check("dataset summary", st == 200 and d["counts"]["races"] > 50 and "FEAT" in d["abilityCategories"], d)
    st, d = read("/dataset/races", q="human")
    check("catalog search", st == 200 and any(i["key"] == "Human" for i in d["items"]), d)
    check("catalog unknown kind -> 404", read("/dataset/nope")[0] == 404)
    st, d = read("/dataset/abilities", category="FEAT", q="weapon focus")
    check("feat catalog", st == 200 and d["total"] >= 1, d)
    st, d = read("/dataset/equipment", q="dagger", limit=2)
    check("equipment catalog limit", st == 200 and len(d["items"]) <= 2 and d["total"] >= 2, d)
    check("campaigns list", read("/campaigns")[1]["total"] > 5)
    check("routes list", "GET /characters/{id}" in read("/routes")[1])
    check("405 on wrong method", call("PUT", "/characters")[0] == 405)
    check("404 unknown route", call("GET", "/nothing/here")[0] == 404)

    # ---- open + snapshot
    st, d = call("POST", "/characters", budget=OPEN_BUDGET_MS, path=str(CHAR))
    check("open", st == 200 and d["id"] == CID, d)
    s0 = snap()
    check("snapshot basics", s0["race"] == "Human" and s0["classes"] == [{"class": "Cleric", "level": 3}]
          and len(s0["stats"]) == 6 and s0["hp"] == 25, {k: s0[k] for k in ("race", "classes", "hp")})
    check("snapshot has abilities", any(c["key"] == "FEAT" and len(c["abilities"]) == 3 for c in s0["abilityCategories"]))

    # ---- descriptions of catalog entries (race, class, skill, deity, equipment, template)
    for kind, name in (("race", "Human"), ("class", "Cleric"), ("skill", "Heal"), ("deity", "Sarenrae"),
                       ("equipment", "Longsword")):
        st, d = read(C + "/info", kind=kind, name=name)
        check(f"info: {kind} {name} has readable sections", st == 200 and d["name"] and len(d["sections"]) > 0, (st, str(d)[:200]))
    check("info: unknown name is 404", read(C + "/info", kind="race", name="Nonexistent Race")[0] == 404)
    check("info: bad kind is 400", read(C + "/info", kind="spaceship", name="x")[0] == 400)

    # ---- identity + stats
    st, d = write("PATCH", C, {"name": "API Test", "addXp": 50, "playersName": "Tester"})
    s1 = d["character"] if st == 200 else {}
    check("patch name/xp", st == 200 and s1["name"] == "API Test" and s1["xp"] == s0["xp"] + 50
          and s1["playersName"] == "Tester", d)
    check("patch bad race -> 404", call("PATCH", C, {"race": "Not A Race"})[0] == 404)
    st, d = write("PUT", C + "/stats/STR", {"base": 16})
    strength = next((x for x in d["character"]["stats"] if x["key"] == "STR"), {}) if st == 200 else {}
    check("set stat", strength.get("base") == 16 and strength.get("modifier") == 3, strength)
    check("unknown stat -> 404", call("PUT", C + "/stats/ZZZ", {"base": 10})[0] == 404)

    # ---- skills
    st, d = read(C + "/skills")
    check("skills list", st == 200 and any(x["key"] == "Heal" and x["ranks"] > 0 for x in d["skills"]), d)
    # Regression: ranks were once summed across levels (a level-3 character showed 9 ranks).
    check("no skill has more ranks than the character has levels", all(x["ranks"] <= 3 for x in d["skills"]),
          [(x["key"], x["ranks"]) for x in d["skills"] if x["ranks"] > 3])
    st, d = write("POST", C + "/skills", {"skill": "Heal", "points": 1})
    check("skill with no points left is refused cleanly", st == 200 and d["applied"] is False and d["messages"], d)
    check("skill unknown -> 404", call("POST", C + "/skills", {"skill": "Nope", "points": 1})[0] == 404)

    # ---- equipment
    st, d = read(C + "/equipment")
    owned = {i["key"] for i in d["purchased"]}
    check("equipment view", st == 200 and "Bedroll" in owned and d["slots"], d)
    funds0 = float(d["funds"])
    check("buy unknown item -> 404", call("POST", C + "/equipment/buy", {"item": "Zzz Not Real"})[0] == 404)
    st, d = write("POST", C + "/equipment/buy", {"item": "Dagger", "quantity": 2})
    check("buy", st == 200 and d["qualified"] in (True, False), d)
    st, d = read(C + "/equipment")
    check("buy reduces funds and adds item", float(d["funds"]) < funds0 and any(i["key"] == "Dagger" and i["quantity"] == 2 for i in d["purchased"]), d["funds"])
    st, d = write("POST", C + "/equipment/equip", {"item": "Dagger"})
    check("equip", st == 200, d)
    st, d = read(C + "/equipment")
    equipped = [x for x in d["slots"] if x["type"] == "EQUIPMENT" and x.get("equipment") == "Dagger"]
    check("equipped item appears in slots", bool(equipped), d["slots"][:3])
    if equipped:
        st, d = write("POST", C + "/equipment/unequip", {"node": equipped[0]["node"]})
        check("unequip", st == 200, d)
    st, d = write("POST", C + "/equipment/sell", {"item": "Dagger", "quantity": 2})
    check("sell", st == 200, d)
    st, d = read(C + "/equipment")
    check("sell returns the item to the shop", not any(i["key"] == "Dagger" for i in d["purchased"]), d["purchased"])
    check("sell unowned -> 404", call("POST", C + "/equipment/sell", {"item": "Dagger"})[0] == 404)
    st, d = write("POST", C + "/equipment-sets", {"name": "Travel"})
    check("create equipment set", st == 200 and "Travel" in read(C + "/equipment")[1]["sets"], d)
    check("select set", write("PUT", C + "/equipment-sets/current", {"name": "Travel"})[0] == 200)
    check("delete set", write("DELETE", C + "/equipment-sets", None, name="Travel")[0] == 200)

    # ---- gear depth: weights and costs, what is in use, the load bands, where an item can go, equipment sets
    write("POST", C + "/equipment/buy", {"item": "Dagger", "quantity": 3})
    gv = read(C + "/equipment")[1]
    dag = next(x for x in gv["purchased"] if x["key"] == "Dagger")
    check("owned items carry their weight and cost", dag["weight"] > 0 and dag["cost"] > 0 and dag["quantity"] == 3, dag)
    check("the load comes with its bands (light < medium < heavy)", [b["name"] for b in gv["loadInfo"]["bands"]][:3] == ["Light", "Medium", "Heavy"]
          and gv["loadInfo"]["bands"][0]["upTo"] < gv["loadInfo"]["bands"][1]["upTo"] < gv["loadInfo"]["bands"][2]["upTo"] and gv["loadInfo"]["carried"] > 0, gv["loadInfo"])
    st, wh = read(C + "/equipment/where", item="Dagger")
    check("where an item can go lists real places", st == 200 and len(wh["places"]) >= 2 and all("node" in p and p["location"] for p in wh["places"]), (st, str(wh)[:200]))
    check("where for an item not owned is 404", read(C + "/equipment/where", item="Zzz Not Real")[0] == 404)
    write("POST", C + "/equipment/equip", {"item": "Dagger", "node": wh["places"][0]["node"], "quantity": 2})
    dag = next(x for x in read(C + "/equipment")[1]["purchased"] if x["key"] == "Dagger")
    check("what is in the current set is counted", dag["inSet"] == 2, dag)
    st, d = write("POST", C + "/equipment-sets", {"name": "Travel"})
    sets = read(C + "/equipment")[1]
    check("a new equipment set can be made and chosen", st == 200 and "Travel" in sets["sets"], sets["sets"])
    st, d = write("PUT", C + "/equipment-sets/current", {"name": "Travel"})
    check("choosing a set switches to it", read(C + "/equipment")[1]["currentSet"] == "Travel")
    dag = next(x for x in read(C + "/equipment")[1]["purchased"] if x["key"] == "Dagger")
    check("a new set starts as a copy of the one it was made from", dag["inSet"] == 2, dag)
    for x in [x for x in read(C + "/equipment")[1]["slots"] if x["type"] == "EQUIPMENT" and x.get("equipment") == "Dagger"]:
        write("POST", C + "/equipment/unequip", {"node": x["node"], "quantity": 99})
    check("emptying the new set empties it", next(x for x in read(C + "/equipment")[1]["purchased"] if x["key"] == "Dagger")["inSet"] == 0)
    write("PUT", C + "/equipment-sets/current", {"name": sets["sets"][0]})
    # (Engine note: sets share the same item objects, so taking an item out of one set can also take it out of another's
    # carried count; the UI therefore only promises a set is a named loadout, not a fully independent copy.)
    write("DELETE", C + "/equipment-sets", {"name": "Travel"})
    check("a set can be deleted", "Travel" not in read(C + "/equipment")[1]["sets"])
    nodes = [x for x in read(C + "/equipment")[1]["slots"] if x["type"] == "EQUIPMENT" and x.get("equipment") == "Dagger"]
    for x in nodes:
        write("POST", C + "/equipment/unequip", {"node": x["node"], "quantity": 99})
    write("POST", C + "/equipment/sell", {"item": "Dagger", "quantity": 3})

    # ---- custom equipment builder (enchantments, materials, renaming)
    check("set funds", write("PATCH", C, {"funds": "2000"})[0] == 200)  # a masterwork sword costs 315 gp
    st, d = write("POST", C + "/equipment/buy", {"item": "Longsword", "customize": True})
    check("customize raises the builder", st == 202 and d["pendingBuilder"]["baseItem"] == "Longsword", d)
    if st == 202:
        check("engine calls are refused while the builder is open", call("GET", C)[0] == 409)
        check("health shows the builder", read("/health")[1]["pendingBuilder"] == d["pendingBuilder"]["id"])
        st, m = call("GET", "/builder/modifiers", None, q="masterwork")
        check("builder offers masterwork", st == 200 and m["total"] == 1, m)
        check("unknown modifier -> 404", call("POST", "/builder/modifiers", {"name": "Zzz"})[0] == 404)
        st, m = call("POST", "/builder/modifiers", {"name": "Masterwork (Weapon)"})
        check("apply masterwork", st == 200 and any("Masterwork" in x for x in m["heads"]["PRIMARY"]["applied"]), m)
        st, m = call("PATCH", "/builder", {"name": "Fine Test Blade"})
        check("rename item", st == 200 and m["name"] == "Fine Test Blade" and m["rejected"] == [], m)
        st, d = call("POST", "/builder/commit", {"purchase": True})
        check("commit buys the custom item", st == 200 and "character" in d and not d["messages"], d.get("messages"))
        st, d = read(C + "/equipment")
        check("custom item is owned", any(i["name"] == "Fine Test Blade" for i in d["purchased"]),
              [i["name"] for i in d["purchased"] if "word" in i["name"] or "lade" in i["name"]])
        check("builder closed after commit", call("GET", "/builder")[0] == 404 and call("GET", C)[0] == 200)
    st, d = write("POST", C + "/equipment/buy", {"item": "Dagger", "customize": True})
    check("second builder opens", st == 202, d)
    if st == 202:
        st, d = call("POST", "/builder/cancel")
        check("cancel leaves nothing bought", st == 200 and not any(
            i["key"] == "Dagger" for i in read(C + "/equipment")[1]["purchased"]), d)

    # ---- a question nobody answers expires, and must not leave the engine blocked for everyone after it
    st, d = write("POST", C + "/equipment/buy", {"item": "Dagger", "customize": True})
    if st == 202:
        time.sleep(20)  # the test sidecar gives up on unanswered questions after 15 s (an hour in real use)
        st, d = call("GET", C)
        check("after an unanswered question expires, later requests still work", st == 200, (st, str(d)[:120]))
    else:
        check("an unanswered question can be raised", False, (st, str(d)[:120]))

    # ---- customising an item the character already owns, with and without paying for it
    write("PATCH", C, {"funds": "5000"})
    write("POST", C + "/equipment/buy", {"item": "Dagger", "quantity": 4})

    def funds():
        return float(read(C)[1]["funds"])

    def upgrade(charge):
        st, d = write("POST", C + "/equipment/customize", {"item": "Dagger", "quantity": 1, "charge": charge})
        if st != 202:
            return st, d
        call("POST", "/builder/modifiers", {"name": "Masterwork (Weapon)"})
        return call("POST", "/builder/commit", {"purchase": True})

    f0 = funds()
    st, d = upgrade(False)
    owned = {i["key"]: i for i in read(C + "/equipment")[1]["purchased"]}
    check("a free upgrade swaps one dagger for the better one", st == 200 and d.get("customized") is True and owned["Dagger"]["quantity"] == 3
          and any("Masterwork" in k or "Masterwork" in i["name"] for k, i in owned.items() if k != "Dagger"), (st, str(d)[:200], list(owned)))
    check("a free upgrade costs nothing", abs(funds() - f0) < 0.001 and d.get("charged") == "0", (f0, funds(), d.get("charged")))
    f1 = funds()
    st, d = upgrade(True)
    check("a paid upgrade charges the price difference", st == 200 and float(d.get("charged", "0")) > 0 and abs((f1 - funds()) - float(d["charged"])) < 0.01, (f1, funds(), d.get("charged")))
    write("PATCH", C, {"funds": "1"})
    st, d = write("POST", C + "/equipment/customize", {"item": "Dagger", "quantity": 1, "charge": True})
    if st == 202:
        call("POST", "/builder/modifiers", {"name": "Masterwork (Weapon)"})
        st, d = call("POST", "/builder/commit", {"purchase": True})
    check("an upgrade the character cannot afford is refused (409) and nothing changes", st == 409 and "gp" in str(d), (st, str(d)[:150]))
    st, d = write("POST", C + "/equipment/customize", {"item": "Dagger", "quantity": 1})
    if st == 202:
        st, d = call("POST", "/builder/cancel")
    check("cancelling an upgrade changes nothing", st == 200 and d.get("customized") is False, (st, d if st != 200 else d.get("customized")))
    check("customizing more than owned is 400", write("POST", C + "/equipment/customize", {"item": "Dagger", "quantity": 99})[0] == 400)

    # an enchantment that asks a question ("Add Type" asks which types) must come back as a 202 chooser, not hang
    st, d = write("POST", C + "/equipment/customize", {"item": "Dagger", "quantity": 1})
    if st == 202:
        st, q = call("POST", "/builder/modifiers", {"name": "Add Type"})
        check("an enchantment that asks something returns the question (202)", st == 202 and "pendingChooser" in q, (st, str(q)[:150]))
        if st == 202 and "pendingChooser" in q:
            chooser = q["pendingChooser"]
            st, m = call("POST", f"/choosers/{chooser['id']}", {"select": list(range(max(chooser["choicesRequired"], 1)))})
            check("answering it returns the edited item and keeps the builder open", st == 200 and "heads" in m
                  and read("/health")[1]["pendingBuilder"] is not None, (st, str(m)[:150]))
        call("POST", "/builder/cancel")

    # ---- notes and charges on owned items (wands)
    write("PATCH", C, {"funds": "5000"})
    write("POST", C + "/equipment/buy", {"item": "Wand of Acid Arrow", "quantity": 1})
    wand = next((i for i in read(C + "/equipment")[1]["purchased"] if i["key"] == "Wand of Acid Arrow"), None)
    check("a wand reports its charges", wand is not None and wand.get("charges", {}).get("max", 0) > 0 and wand["charges"]["remaining"] == wand["charges"]["max"], wand)
    st, d = write("PATCH", C + "/equipment/item", {"item": "Wand of Acid Arrow", "charges": 47, "note": "Found in the crypt | cursed?"})
    wand = next(i for i in read(C + "/equipment")[1]["purchased"] if i["key"].startswith("Wand of Acid Arrow"))
    check("charges can be set", st == 200 and wand["charges"]["remaining"] == 47, (st, wand))
    check("a note can be kept (pipes made safe for the file)", wand["note"] == "Found in the crypt / cursed?", wand.get("note"))
    check("more charges than the wand holds is refused", write("PATCH", C + "/equipment/item", {"item": wand["key"], "charges": 999})[0] == 400)
    check("charges on an item without charges is 409", write("PATCH", C + "/equipment/item", {"item": "Dagger", "charges": 1})[0] == 409)
    check("a patch with nothing to change is 400", write("PATCH", C + "/equipment/item", {"item": wand["key"]})[0] == 400)
    write("POST", C + "/save")
    text = open(read(C)[1]["file"], encoding="utf-8", errors="replace").read()
    check("note and charges are saved in the character file", "Found in the crypt / cursed?" in text and "47" in text.split("Wand of Acid Arrow", 1)[1][:600], "")
    write("POST", C + "/equipment/sell", {"item": wand["key"], "quantity": 1, "free": True})
    write("PATCH", C, {"funds": "5000"})

    # ---- spells
    st, d = read(C + "/spells")
    n_known = len(d["known"])
    check("spells view", st == 200 and n_known > 0 and d["autoSpells"] is True, {k: d[k] for k in ("autoSpells",)})
    st, d = write("DELETE", C + "/spells/known", {"class": "Cleric", "level": "1", "spell": "Bless"})
    check("remove known spell", st == 200 and len(read(C + "/spells")[1]["known"]) == n_known - 1, d)
    st, d = write("POST", C + "/spells/known", {"class": "Cleric", "level": "1", "spell": "Bless"})
    check("add known spell", st == 200 and len(read(C + "/spells")[1]["known"]) == n_known, d)
    check("unknown spell -> 404", call("POST", C + "/spells/known", {"class": "Cleric", "level": "1", "spell": "Zzz"})[0] == 404)
    st, d = read(C + "/spells", available="true", limit=5)
    check("available spells honour limit", st == 200 and 0 < len(d["available"]) <= 5, d)

    # ---- GM-granted feats: PCGen's own "GM Awards" (no prerequisites; a "+1 Bonus Feat" award gives the slot)
    def feat_cat():
        return next(x for x in snap()["abilityCategories"] if x["key"] == "FEAT")
    before = feat_cat()
    write("POST", C + "/abilities", {"category": "FEAT", "name": "Whirlwind Attack"})
    check("an ordinary add of a feat the character can't take does nothing", not any(a["key"] == "Whirlwind Attack" for a in feat_cat()["abilities"]))
    st, d = write("POST", C + "/abilities", {"category": "FEAT", "name": "Whirlwind Attack", "gm": True, "slot": True})
    after = feat_cat()
    gm_row = next((a for a in after["abilities"] if a["key"] == "Whirlwind Attack"), None)
    check("a GM-granted feat is added despite its prerequisites", st == 200 and gm_row is not None and gm_row.get("gm") is True, (st, str(d)[:150]))
    check("with the slot option it costs the character no slot (one bonus slot is added)",
          (after["total"], after["remaining"], after.get("gmBonusSlots")) == (before["total"] + 1, before["remaining"], (before.get("gmBonusSlots") or 0) + 1),
          (before["total"], before["remaining"], after["total"], after["remaining"], after.get("gmBonusSlots")))
    st, d = write("POST", C + "/abilities", {"category": "FEAT", "name": "Whirlwind Attack", "gm": True, "slot": True})
    again = feat_cat()
    check("granting a feat the GM already gave adds nothing, and no extra slot",
          st == 200 and d.get("added") == "" and again.get("gmBonusSlots") == after.get("gmBonusSlots") and again["total"] == after["total"],
          (st, d.get("added"), again.get("gmBonusSlots"), after.get("gmBonusSlots")))
    notes = read(C + "/notes")[1]
    check("the GM note lists it for the sheet", any(n["name"] == "GM Granted Feats" and "Whirlwind Attack" in n["text"] for n in notes), notes)
    some_trait = read("/dataset/abilities", category="Traits", limit=1)[1]["items"][0]["key"]
    st, d = write("POST", C + "/abilities", {"category": "Traits", "name": some_trait, "gm": True})
    check("only feats can be flagged as GM-granted", st == 400, (st, d))
    st, sv = write("POST", C + "/save")
    saved_text = open(read(C)[1]["file"], encoding="utf-8", errors="replace").read()
    check("it is saved as PCGen's own GM award", "Add a Feat Ignoring Restrictions" in saved_text and "Whirlwind Attack" in saved_text and "+1 Bonus Feat" in saved_text)
    st, x = write("DELETE", C + "/abilities", {"category": "FEAT", "name": "Whirlwind Attack"})
    gone = feat_cat()
    check("a GM-granted feat can be taken back", st == 200 and not any(a["key"] == "Whirlwind Attack" for a in gone["abilities"]), (st, str(x)[:120]))
    check("taking it back clears the GM note", not any(n["name"] == "GM Granted Feats" for n in read(C + "/notes")[1]))
    check("the bonus slot stays until it is taken away", gone["remaining"] == before["remaining"] + 1 and gone.get("gmBonusSlots") == (before.get("gmBonusSlots") or 0) + 1, (gone["remaining"], gone.get("gmBonusSlots")))
    st, x = write("POST", C + "/gm/bonus-feats", {"count": 3})
    three = feat_cat()
    check("bonus feat slots can be set", st == 200 and three["total"] == before["total"] + 3 and three.get("gmBonusSlots") == 3, (st, three["total"], three.get("gmBonusSlots")))
    st, x = write("POST", C + "/gm/bonus-feats", {"count": 0})
    zero = feat_cat()
    check("and taken back to none", st == 200 and zero["total"] == before["total"] and zero.get("gmBonusSlots") == 0, (st, zero["total"], zero.get("gmBonusSlots")))
    check("a silly slot count is 400", write("POST", C + "/gm/bonus-feats", {"count": 500})[0] == 400)

    # ---- a language from the GM (PCGen's "Add Language" award) and the awards list
    lv = read(C + "/languages")[1]
    check("the language view says which languages a GM could give", len(lv.get("gmAvailable", [])) > 5
          and not set(lv["gmAvailable"]) & {l["name"] for l in lv["languages"]}, lv.get("gmAvailable", [])[:5])
    gift = lv["gmAvailable"][0]
    st, d = write("POST", C + "/gm/languages", {"name": gift})
    lv2 = read(C + "/languages")[1]
    check("a GM can give a language", st == 200 and any(l["name"] == gift and l.get("gm") for l in lv2["languages"]), (st, str(d)[:120]))
    check("giving it twice is 409", write("POST", C + "/gm/languages", {"name": gift})[0] == 409)
    check("an unknown language is 404", write("POST", C + "/gm/languages", {"name": "Zzzish"})[0] == 404)
    award_rows = {a["key"]: a for a in next(x for x in snap()["abilityCategories"] if x["key"] == "GM Awards")["abilities"]}
    check("the awards list shows what was given", award_rows.get("Add Language", {}).get("choices") == [gift], award_rows)
    st, d = write("DELETE", C + "/gm/languages", {"name": gift})
    check("and it can be taken back", st == 200 and not any(l["name"] == gift for l in read(C + "/languages")[1]["languages"]), (st, str(d)[:120]))
    check("taking back a language the GM did not give is 404", write("DELETE", C + "/gm/languages", {"name": gift})[0] == 404)
    st, d = write("POST", C + "/abilities", {"category": "GM Awards", "name": "+1 Hit Point"})
    row = next((a for a in next(x for x in snap()["abilityCategories"] if x["key"] == "GM Awards")["abilities"] if a["key"] == "+1 Hit Point"), None)
    check("any other award can be added from the awards list", st == 200 and row is not None and row.get("times") == 1, (st, row))
    st, d = write("DELETE", C + "/abilities", {"category": "GM Awards", "name": "+1 Hit Point"})
    check("and removed again", st == 200 and not any(a["key"] == "+1 Hit Point" for a in next(x for x in snap()["abilityCategories"] if x["key"] == "GM Awards")["abilities"]), st)
    write("POST", C + "/save")

    # ---- deities: catalog with alignment, search by domain, may-follow flag
    st, d = read("/dataset/deities", character=CID, limit=500)
    check("deity catalog carries alignment and whether the character may follow", st == 200 and d["total"] > 20 and all("alignment" in i and "qualified" in i for i in d["items"]), (st, str(d)[:200]))
    st, fire = read("/dataset/deities", character=CID, q="fire", limit=500)
    st2, name_only = read("/dataset/deities", q="fire", limit=500)
    check("a search also finds gods by domain (more hits than by name alone)", st == 200 and fire["total"] > name_only["total"], (fire["total"], name_only["total"]))
    st, one = read(C + "/info", kind="deity", name=d["items"][1]["key"])
    check("a deity's info says whether the character may follow them", st == 200 and "qualified" in one and one["sections"], str(one)[:200])
    st, onlyq = read("/dataset/deities", character=CID, qualified="true", limit=500)
    check("qualified=true keeps only deities the character may follow", st == 200 and all(i["qualified"] for i in onlyq["items"]) and onlyq["total"] <= d["total"], (st, onlyq["total"], d["total"]))

    # ---- domains and the extra domain slot
    st, d = read(C + "/domains")
    check("domains route lists taken, remaining and available", st == 200 and set(d) >= {"selected", "remaining", "available"}, d)
    check("the cleric has domains and the data offers more", st == 200 and len(d["selected"]) >= 1 and len(d["available"]) > 5, (st, str(d)[:200]))
    if st == 200 and d["available"]:
        st2, inf = read(C + "/domains/info", name=d["available"][0]["key"])
        check("a domain has a description with sections", st2 == 200 and inf["sections"], (st2, str(inf)[:200]))
    check("unknown domain is 404", read(C + "/domains/info", name="No Such Domain")[0] == 404)
    sp = read(C + "/spells")[1]
    check("spell levels carry the bonus (domain/school) slot", all("bonus" in x for x in sp["classes"][0]["levels"]), sp["classes"][0]["levels"][:2])
    known = sp["known"]
    check("domain spells are told apart from class spells", any(r.get("domain") for r in known) and any(not r.get("domain") for r in known), [r["spell"] for r in known if r.get("domain")][:5])
    check("a domain spell has its plain name", all("[" not in r["spell"] for r in known if r.get("domain")), [r["spell"] for r in known if r.get("domain")][:5])
    check("the known count leaves domain spells out", sum(x["knownNow"] for x in sp["classes"][0]["levels"]) == len([r for r in known if not r.get("domain")]), (sum(x["knownNow"] for x in sp["classes"][0]["levels"]), len([r for r in known if not r.get("domain")])))
    check("the view lists the character's metamagic feats (none for this cleric)", sp.get("metamagicFeats") == [], sp.get("metamagicFeats"))
    check("a cleric gets a +1 domain slot at spell level 1", next(x for x in sp["classes"][0]["levels"] if x["level"] == 1)["bonus"] == "+1", sp["classes"][0]["levels"][:3])

    # ---- levels (level-up raises an ability-score chooser)
    st, d = write("POST", C + "/levels", {"class": "Cleric"})
    check("level up raises a chooser", st == 202 and d["pendingChooser"]["choicesRequired"] == 1, d)
    st, d = settle((st, d), select=[0])
    check("level up completes", st == 200 and d["character"]["classes"] == [{"class": "Cleric", "level": 4}], d)
    check("level up spent no skill points yet", any(x["tab"] == "Skills" for x in d["character"]["todo"]))
    st, d = write("DELETE", C + "/levels")
    check("remove level", st == 200 and d["character"]["classes"] == [{"class": "Cleric", "level": 3}], d)
    check("remove too many levels -> 400", call("DELETE", C + "/levels", None, count=99)[0] == 400)
    check("unqualified/unknown class", call("POST", C + "/levels", {"class": "Nope"})[0] == 404)

    # ---- hit points per level: the die, the Constitution bonus, set and roll
    write("PUT", C + "/stats/CON", {"base": 14})  # +2
    lv = snap()["levels"]
    check("levels report their hit die and bonus", all(x.get("hitDie") == 8 and x["hpBonus"] == 2 for x in lv), lv[:1])
    check("gained = rolled + bonus (Constitution is included)", all(x["hpGained"] == x["hpRolled"] + x["hpBonus"] for x in lv))
    st, d = write("PUT", C + "/levels/2/hp", {"rolled": 5})
    row = d["character"]["levels"][1] if st == 200 else {}
    check("setting a roll updates the level", st == 200 and row.get("hpRolled") == 5 and row.get("hpGained") == 7, row)
    check("a d8 cannot roll 9", call("PUT", C + "/levels/2/hp", {"rolled": 9})[0] == 400)
    check("a roll of 0 is refused", call("PUT", C + "/levels/2/hp", {"rolled": 0})[0] == 400)
    check("an unknown level is 404", call("PUT", C + "/levels/9/hp", {"rolled": 3})[0] == 404)
    rolls = {write("POST", C + "/levels/2/hp/roll")[1]["rolled"] for _ in range(12)}
    check("rolling stays on the die and varies", rolls <= set(range(1, 9)) and len(rolls) > 1, sorted(rolls))
    write("PUT", C + "/stats/CON", {"base": 11})

    # ---- race / deity / alignment changes (restored afterwards)
    st, d = write("PATCH", C, {"race": "Dwarf"})
    st, d = settle((st, d))
    check("change race", st == 200 and d["character"]["race"] == "Dwarf", d)
    st, d = write("PATCH", C, {"race": "Human"})
    st, d = settle((st, d))
    check("restore race", st == 200 and d["character"]["race"] == "Human", d)
    st, d = write("PATCH", C, {"deity": "Iomedae", "alignment": "Lawful Good"})
    st, d = settle((st, d))
    check("change deity + alignment", st == 200 and d["character"]["deity"] == "Iomedae"
          and d["character"]["alignment"] == "Lawful Good", d)

    # ---- biography, notes, chronicle
    st, d = read(C + "/biography")
    check("biography view", st == 200 and d["heightUnit"] == "inches" and "catchPhrase" in d and d["region"] is not None, d)
    st, d = write("PATCH", C + "/biography", {"birthday": "4 Abadius", "catchPhrase": "Onward!", "eyeColor": "Green",
                                              "weight": 180, "height": 72})
    b = d.get("biography", {}) if st == 200 else {}
    check("biography edit", b.get("birthday") == "4 Abadius" and b.get("catchPhrase") == "Onward!"
          and b.get("eyeColor") == "Green" and b.get("weight") == 180 and b.get("height") == 72, b)
    check("biography edit survives a reread", read(C + "/biography")[1]["catchPhrase"] == "Onward!")
    st, notes = read(C + "/notes")
    check("built-in notes present", st == 200 and [n["name"] for n in notes][:2] == ["Bio", "Description"]
          and all(n["builtIn"] for n in notes), notes)
    st, d = write("POST", C + "/notes", {"name": "Session 1", "text": "Met the party."})
    mine = [n for n in d["notes"] if n["name"] == "Session 1"] if st == 200 else []
    check("add note", len(mine) == 1 and mine[0]["text"] == "Met the party." and not mine[0]["builtIn"], d)
    idx = mine[0]["index"] if mine else 0
    st, d = write("PATCH", C + f"/notes/{idx}", {"text": "Met the party at the inn."})
    check("edit note", st == 200 and d["notes"][idx]["text"] == "Met the party at the inn.", d)
    check("built-in note cannot be renamed", call("PATCH", C + "/notes/0", {"name": "X"})[0] == 409)
    check("built-in note cannot be deleted", call("DELETE", C + "/notes/0")[0] == 409)
    check("note index out of range -> 404", call("DELETE", C + "/notes/99")[0] == 404)
    st, d = write("PATCH", C + "/notes/0", {"text": "Bio text with unicode: caf\u00e9 \u2014 ok"})
    check("built-in note text edits", st == 200 and "caf\u00e9" in d["notes"][0]["text"], d)
    st, d = write("DELETE", C + f"/notes/{idx}")
    check("delete note", st == 200 and not any(n["name"] == "Session 1" for n in d["notes"]), d)
    st, d = write("POST", C + "/chronicle", {"campaign": "Kingmaker", "adventure": "Stolen Land", "xp": 300,
                                              "chronicle": "Cleared the stag lord's fort."})
    check("add chronicle entry", st == 200 and d["chronicle"][-1]["campaign"] == "Kingmaker"
          and d["chronicle"][-1]["xp"] == 300, d)
    st, d = write("PATCH", C + "/chronicle/0", {"date": "4711-03-02", "output": False})
    check("edit chronicle entry", st == 200 and d["chronicle"][0]["date"] == "4711-03-02"
          and d["chronicle"][0]["output"] is False, d)
    st, d = write("DELETE", C + "/chronicle/0")
    check("delete chronicle entry", st == 200 and d["chronicle"] == [], d)
    check("chronicle index out of range -> 404", call("DELETE", C + "/chronicle/5")[0] == 404)

    # ---- languages
    st, d = read(C + "/languages")
    check("languages view", st == 200 and any(x["name"] == "Common" for x in d["languages"]) and d["choosers"], d)
    learned = [x["name"] for x in d["languages"] if x["removable"]]
    check("languages have a removable learned one", bool(learned), d["languages"])
    check("remove automatic language -> 409", call("DELETE", C + "/languages", None, name="Common")[0] == 409)
    check("choosing with nothing left -> 409", call("POST", C + "/languages", {"chooser": 0, "add": ["Elven"]})[0] == 409)
    check("choosing from a bad chooser index -> 400", call("POST", C + "/languages", {"chooser": 99, "add": ["Elven"]})[0] == 400)
    check("choosing an unknown language -> 404", call("POST", C + "/languages", {"chooser": 0, "add": ["Klingon"]})[0] == 404)
    # Removing the language learned through skill points frees a pick in the "via Skill points" chooser.
    if learned:
        st, d = write("DELETE", C + "/languages", None, name=learned[0])
        check("remove learned language", st == 200
              and learned[0] not in [x["name"] for x in d["languages"]["languages"]], d)
        st, d = read(C + "/languages")
        skill_ch = next((c for c in d["choosers"] if "Skill" in c["name"]), {})
        check("removing frees a skill-language pick", skill_ch.get("remaining", 0) > 0, d["choosers"])
        if skill_ch.get("remaining", 0) > 0:
            pick = "Elven" if "Elven" in skill_ch["available"] else skill_ch["available"][0]
            st, d2 = write("POST", C + "/languages", {"chooser": skill_ch["index"], "add": [pick]})
            names = [x["name"] for x in d2["languages"]["languages"]] if st == 200 else []
            check("choose a language", st == 200 and pick in names, d2)
            check("no picks left afterwards -> 409", call("POST", C + "/languages",
                  {"chooser": skill_ch["index"], "add": ["Dwarven"]})[0] == 409)
            st, d3 = write("POST", C + "/languages", {"chooser": skill_ch["index"], "remove": [pick], "add": [learned[0]]})
            check("swap it back", st == 200 and learned[0] in [x["name"] for x in d3["languages"]["languages"]], d3)

    # ---- PDF export
    st, d = read(C + "/templates", kind="pdf")
    check("pdf templates listed", st == 200 and d["total"] > 5 and all(i["kind"] == "pdf" for i in d["items"]), d)
    tpl = "d20/fantasy/pdf/csheet_fantasy_std_blue.xslt"
    t0 = time.time()
    st, d = call("POST", C + "/export", {"template": tpl}, budget=PDF_BUDGET_MS)
    check("pdf export", st == 200 and isinstance(d, bytes) and d[:5] == b"%PDF-" and d.rstrip().endswith(b"%%EOF")
          and len(d) > 20000, (st, d[:60] if isinstance(d, bytes) else d))
    check("pdf export is fast enough (<15s)", time.time() - t0 < 15, f"{time.time() - t0:.1f}s")
    check("pdf with no template -> 400", call("POST", C + "/export")[0] == 400)
    check("unknown pdf template -> 404", call("POST", C + "/export", {"template": "nope/x.xslt"})[0] == 404)
    st, d = call("POST", C + "/export", {"format": "pdf"})
    check("default pdf sheet remembered after first export", st == 200 and d[:5] == b"%PDF-", (st, d[:80] if isinstance(d, bytes) else d))

    # ---- export reflects edits (and still works after all of the above)
    st, d = call("POST", C + "/export", None, template=str(PCGEN / TEMPLATES["plain"]))
    check("export after edits", st == 200 and "API Test" in d, d[:100] if isinstance(d, str) else d)

    # ---- new character, save, close, reopen
    st, d = write("POST", "/characters/new", {"name": "Fresh Face"})
    nid = d["character"]["id"] if st == 200 else None
    check("create character", st == 200 and d["character"]["name"] == "Fresh Face"
          and any(t["tab"] == "Summary" for t in d["character"]["todo"]), d)
    path = os.path.join(tempfile.mkdtemp(prefix="api-save-"), "fresh.pcg")
    st, d = write("POST", f"/characters/{nid}/save", None, path=path)
    check("save", st == 200 and d.get("saved") is True and os.path.getsize(path) > 500, d)
    st, d = write("POST", C + "/save")
    check("save with no path writes the character's own (temp) file", st == 200 and d.get("saved") is True, d)
    # Regression: funds used to be shared between all open characters (engine cached channels per variable, not per character).
    cleric_funds = snap()["funds"]
    write("PATCH", f"/characters/{nid}", {"funds": "777"})
    check("funds are per character", snap()["funds"] == cleric_funds and read(f"/characters/{nid}")[1]["funds"] == "777",
          (snap()["funds"], read(f"/characters/{nid}")[1]["funds"]))
    # Regression: buying anything on a brand-new character crashed (its funds are an Integer, not a BigDecimal).
    st, d = write("POST", f"/characters/{nid}/equipment/buy", {"item": "Dagger", "quantity": 1})
    check("buy on a brand-new character works", st == 200, (st, str(d)[:200]))
    # Price scheme: "Cashless" makes buying free, and each character keeps its own scheme.
    st, d = write("PUT", f"/characters/{nid}/equipment/scheme", {"scheme": "Cashless - Buy 0 Sell 0"})
    check("price scheme can be set", st == 200 and read(f"/characters/{nid}/equipment")[1]["buySellScheme"].startswith("Cashless"), (st, str(d)[:200]))
    write("PATCH", f"/characters/{nid}", {"funds": "5"})
    st, d = write("POST", f"/characters/{nid}/equipment/buy", {"item": "Greataxe", "quantity": 1})
    check("cashless buying costs nothing", st == 200 and read(f"/characters/{nid}")[1]["funds"] in ("5", "5.000"), (st, read(f"/characters/{nid}")[1]["funds"]))
    check("the other character keeps its own scheme", not read(C + "/equipment")[1]["buySellScheme"].startswith("Cashless"))
    check("unknown price scheme is 404", write("PUT", f"/characters/{nid}/equipment/scheme", {"scheme": "Free beer"})[0] == 404)
    st, d = read(f"/characters/{nid}/kits")
    check("kits route answers with available and applied lists", st == 200 and "available" in d and "applied" in d, (st, str(d)[:200]))
    # Which classes may this character take? Strength 3 cannot be a Barbarian-style prerequisite-free fighter,
    # but the filter must at least return a subset, and every kept class must be marked qualified.
    st, allc = read(f"/dataset/classes", character=nid, limit=500)
    st2, okc = read(f"/dataset/classes", character=nid, limit=500, qualified="true")
    check("class catalog marks who qualifies",
          st == 200 and all("qualified" in i for i in allc["items"]) and okc["total"] <= allc["total"]
          and all(i["qualified"] for i in okc["items"]), (st, allc["total"], okc["total"]))
    st, d = read(f"/characters/{nid}/info", kind="class", name="Wizard")
    check("class info says whether the character qualifies", st == 200 and "qualified" in d, str(d)[:200])
    st, d = read(f"/characters/{nid}/info", kind="race", name="Dwarf")
    check("race info lists the racial traits, ability changes first",
          st == 200 and d["sections"] and d["sections"][0]["label"].startswith("+2"), str(d)[:300])
    check("close", write("DELETE", f"/characters/{nid}")[0] == 200)
    st, d = write("POST", "/characters", path=path)
    check("reopen saved character", st == 200 and d["name"] == "Fresh Face", d)
    check("health lists open characters", set(read("/health")[1]["characters"]) >= {CID, "fresh"})

    # ---- spell levels follow the class: a wizard gains levels as it levels up and reaches 9th-level spells
    st, d = write("POST", "/characters/new", {"name": "Test Wizard", "id": "wiz"})
    wid = d["character"]["id"] if st == 200 else "wiz"
    W = f"/characters/{wid}"
    settle(write("PATCH", W, {"race": "Human"}))
    write("PUT", W + "/stats/INT", {"base": 20})

    def wizard_levels():
        info = read(W + "/spells")[1]["classes"]
        cls = next((c for c in info if c["class"] == "Wizard"), None)
        return cls, [x["level"] for x in cls["levels"] if x["usable"]] if cls else []

    # The very first level asks "are your abilities set as you'd like them?"; declining changes nothing.
    for k in ("STR", "DEX", "CON", "WIS", "CHA"):
        write("PUT", W + f"/stats/{k}", {"base": 10})
    st, d = write("POST", W + "/levels", {"class": "Wizard"})
    check("the first level asks a yes/no question", st == 202 and "abilities" in d["pendingConfirm"]["message"].lower(), d)
    check("other calls wait while it is open", call("GET", W)[0] == 409)
    check("the question shows in /health", read("/health")[1]["pendingConfirm"] == d["pendingConfirm"]["id"])
    st, d2 = call("POST", "/confirms/" + d["pendingConfirm"]["id"], {"ok": False})
    check("answering no adds no level", st == 200 and d2["character"]["classes"] == [], d2)
    settle(write("POST", W + "/levels", {"class": "Wizard"}))
    cls, usable = wizard_levels()
    check("a level-1 wizard can use spell levels 0 and 1 only", cls is not None and usable == [0, 1], usable)
    # A spellbook caster has no "spells known" table, so it may hold spells it can't cast yet.
    check("a wizard has no fixed spells-known table", cls is not None and all(x["known"] == 0 for x in cls["levels"]), cls)
    st, d = write("POST", W + "/spells/known", {"class": "Wizard", "level": "3", "spell": "Fireball"})
    held = [(x["spell"], x["level"]) for x in read(W + "/spells")[1]["known"]]
    check("a level-1 wizard can scribe a 3rd-level spell", st == 200 and ("Fireball", "3") in held, (st, held))
    write("DELETE", W + "/spells/known", {"class": "Wizard", "level": "3", "spell": "Fireball"})
    # Preparing spells: a wizard prepares from what it knows into a named list, and the day's slots count them.
    check("a wizard is a prepared caster", cls is not None and cls.get("prepares") is True, cls)
    check("a spontaneous caster would not be (class flag present)", "prepares" in (cls or {}))
    cantrip = next((r["spell"] for r in read(W + "/spells", available="true", **{"class": "Wizard", "limit": 100000})[1]["available"]
                    if r["level"] == "0"), None)
    write("POST", W + "/spells/known", {"class": "Wizard", "level": "0", "spell": cantrip})
    check("a new list can be made", write("POST", W + "/spellbooks", {"name": "Prepared"})[0] == 200)
    check("an empty list shows up in the list names", "Prepared" in read(W + "/spells")[1]["spellbooks"])
    st, d = write("POST", W + "/spells/prepared", {"class": "Wizard", "level": "0", "spell": cantrip, "list": "Prepared"})
    sp = read(W + "/spells")[1]
    check("a known spell can be prepared into a list", st == 200 and any(r["spell"] == cantrip and r["list"] == "Prepared" and r["count"] == 1 for r in sp["prepared"]), (st, sp["prepared"]))
    check("the list header is not mistaken for a spell", all(r["spell"] for r in sp["prepared"]), sp["prepared"])
    lv0 = next(x for x in next(c for c in sp["classes"] if c["class"] == "Wizard")["levels"] if x["level"] == 0)
    check("the day's slots count what is prepared", lv0["prepared"] == 1 and lv0["perDay"] >= 1, lv0)
    write("POST", W + "/spells/prepared", {"class": "Wizard", "level": "0", "spell": cantrip, "list": "Prepared"})
    check("preparing it again adds a copy", read(W + "/spells")[1]["prepared"][0]["count"] == 2)
    write("DELETE", W + "/spells/prepared", {"class": "Wizard", "level": "0", "spell": cantrip, "list": "Prepared"})
    write("DELETE", W + "/spells/prepared", {"class": "Wizard", "level": "0", "spell": cantrip, "list": "Prepared"})
    check("un-preparing removes the copies", not [r for r in read(W + "/spells")[1]["prepared"] if r["spell"]], read(W + "/spells")[1]["prepared"])
    st, d = write("POST", W + "/spells/prepared", {"class": "Wizard", "level": "0", "spell": cantrip, "list": "Prepared", "metamagic": ["Empower Spell"]})
    check("metamagic the character has no feat for is refused", st == 400 and "does not have the metamagic feat" in str(d), (st, d))
    check("nothing was prepared by the refused request", not [r for r in read(W + "/spells")[1]["prepared"] if r["spell"]])
    check("a spell that is not known cannot be prepared", write("POST", W + "/spells/prepared", {"class": "Wizard", "level": "0", "spell": "Not A Spell", "list": "Prepared"})[0] == 404)
    write("DELETE", W + "/spells/known", {"class": "Wizard", "level": "0", "spell": cantrip})
    for _ in range(16):
        settle(write("POST", W + "/levels", {"class": "Wizard"}))
    cls, usable = wizard_levels()
    check("a level-17 wizard can use spell levels 0 to 9", usable == list(range(10)), usable)
    st, d = read(W + "/spells", available="true", **{"class": "Wizard", "limit": 100000})
    levels_in_list = sorted({int(r["level"]) for r in d.get("available", [])}) if st == 200 else []
    check("the wizard's available spells include 9th level", 9 in levels_in_list and len(d["available"]) > 200, levels_in_list)
    check("the engine's slots report per-day numbers", cls is not None and cls["levels"][9]["perDay"] > 0, cls and cls["levels"][9])
    write("DELETE", W)

    # ---- hardening: who may call the sidecar, where files may be read and written, and how requests queue
    st, d = call("GET", "/health", _headers={"Host": "evil.example"})
    check("a foreign Host header is refused (DNS rebinding)", st == 403, (st, d))
    st, d = call("POST", "/shutdown", _headers={"Origin": "http://evil.example"})
    check("a request from another website cannot shut the engine down", st == 403, (st, d))
    check("and the engine is still up afterwards", read("/health")[0] == 200)
    check("a browser-reported cross-site request is refused",
          call("GET", "/health", _headers={"Sec-Fetch-Site": "cross-site"})[0] == 403)
    check("the UI's own origin is accepted", call("GET", "/health", _headers={"Origin": "http://127.0.0.1:5173"})[0] == 200)
    check("a malformed query string is the caller's error (400)", call("GET", "/characters?x=%zz")[0] == 400)

    own_dir = str(PCGEN / "outputsheets")
    st, d = call("POST", C + "/export", {"template": str(PCGEN / "build.gradle")})
    check("a template outside the output sheets folder is refused", st == 403, (st, str(d)[:80]))
    st, d = call("POST", C + "/export", {"template": "../build.gradle"})
    check("so is one reached with ../", st == 403, (st, str(d)[:80]))
    check("a missing template inside the folder is a plain 404",
          call("POST", C + "/export", {"template": "d20/fantasy/text/nope.TXT"})[0] == 404)
    check("a real template still works", call("POST", C + "/export", {"template": str(PCGEN / TEMPLATES["plain"])})[0] == 200)

    before = snap()
    st, d = call("POST", C + "/save", {"path": os.path.join(tempfile.gettempdir(), "no_such_folder_xyz", "x.pcg")})
    check("saving into a missing folder is refused", st == 400, (st, d))
    check("saving to a non-.pcg name is refused", call("POST", C + "/save", {"path": os.path.join(tempfile.gettempdir(), "x.txt")})[0] == 400)
    check("a refused save leaves the character's file alone", snap()["file"] == before["file"], (before["file"], snap()["file"]))

    name_before = snap()["name"]
    st, d = call("PATCH", C, {"name": "Should Not Stick", "race": "Not A Real Race"})
    check("a patch with one bad value is refused", st == 404, (st, d))
    check("and none of its other changes were applied", snap()["name"] == name_before, snap()["name"])
    st, d = call("PATCH", C, {"name": "Should Not Stick Either", "funds": "lots"})
    check("a bad number is refused before anything changes", st == 400 and snap()["name"] == name_before, (st, snap()["name"]))

    # A slow engine call must not block health, and other engine calls wait their turn instead of failing.
    outcome = {}

    def slow_export():
        t0 = time.time()
        outcome["export"] = call("POST", C + "/export", {"template": "d20/fantasy/pdf/csheet_fantasy_std_blue.xslt"})[0]
        outcome["export_s"] = time.time() - t0

    worker_thread = threading.Thread(target=slow_export)
    worker_thread.start()
    time.sleep(0.5)
    t0 = time.time()
    st_health = call("GET", "/health")[0]
    health_s = time.time() - t0
    st_read = call("GET", C)[0]  # waits for the export, then answers
    worker_thread.join()
    check("health answers at once while an export runs", st_health == 200 and health_s < 1.0, f"{st_health} in {health_s:.2f}s")
    check("an engine read during the export waits and succeeds (no 409)", st_read == 200, st_read)
    check("and the export itself completed", outcome.get("export") == 200, outcome)

    # ---- no operation left hanging
    check("no chooser pending at the end", read("/health")[1]["pendingChooser"] is None)


def main():
    proc = start_sidecar()
    try:
        run_checks()
    except Exception as e:
        check("test run completed", False, repr(e))
    finally:
        try:
            call("POST", "/shutdown")
            proc.wait(30)
        except Exception:
            proc.kill()

    bad = [r for r in results if not r[1]]
    for name, ok, detail in results:
        if not ok:
            print(f"FAIL  {name}: {detail}")
    over = [(l, ms, b) for l, ms, b in timings if ms > b]
    slowest = sorted(timings, key=lambda t: -t[1])[:3]
    print(f"{len(results) - len(bad)}/{len(results)} checks passed")
    print("slowest requests: " + "; ".join(f"{l} {ms}ms" for l, ms, _ in slowest))
    for l, ms, b in over:
        print(f"SLOW  {l}: {ms}ms (budget {b}ms)")
    return 1 if bad or over else 0


if __name__ == "__main__":
    sys.exit(main())
