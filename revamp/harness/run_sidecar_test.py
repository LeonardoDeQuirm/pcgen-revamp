"""Sidecar test: for each sample character, start a sidecar, drive it over HTTP, and check
its exports against the same baselines the CLI harness uses.

Usage: python harness/run_sidecar_test.py
Needs: `gradlew qbuild` in pcgen/ and `powershell sidecar/build.ps1` first.

Per character it checks: health, open, list, export (x2, must match baseline), 404/400
error handling, a 409 when opening a character with different sources, close, shutdown.
"""
import json, re, subprocess, sys, tempfile, threading, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from run_harness import BASELINE, DEFAULT_JDK, PCGEN, ROOT, TEMPLATES, all_chars, normalize, same

BASE_PORT = 8800


def without_gm_marks(text):
    """The export route keeps a "GM Granted Feats" note in step with the character's GM awards and the sheet marks those
    feats "(GM)". The CLI baselines know nothing of either, so leave them out of the comparison."""
    text = re.sub(r"\n[ \t]*<note>\s*<name>GM Granted Feats</name>.*?</note>\n?(?:[ \t]*\n)?", "\n", text, flags=re.S)
    return text.replace(" (GM)</name>", "</name>")


def call(port, method, route, **params):
    url = f"http://127.0.0.1:{port}{route}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method=method, data=b"" if method == "POST" else None)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            # read_text() for baselines uses universal newlines, so match that here
            return r.status, r.read().decode("utf-8", errors="replace").replace(chr(13)+chr(10), chr(10)).replace(chr(13), chr(10))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace").replace(chr(13)+chr(10), chr(10)).replace(chr(13), chr(10))


def check_choosers(port, cid, template, check):
    """Drives the chooser bridge with the Cleric's Spell Focus feat (it asks for a school)."""
    base = f"/characters/{cid}"

    def spell_focus():
        _, body = call(port, "POST", base + "/export", template=str(template))
        return [l.strip() for l in body.splitlines() if l.strip().startswith("Spell Focus")]

    def start(verb):
        st, body = call(port, verb, base + "/abilities", category="FEAT", name="Spell Focus")
        return st, json.loads(body)

    check(spell_focus() == ["Spell Focus (Enchantment)"], f"chooser setup: {spell_focus()}")

    # Remove: engine asks which school to drop. While it waits, other operations get 409.
    st, d = start("DELETE")
    check(st == 202 and "pendingChooser" in d, f"remove should raise a chooser, got {st}")
    if st != 202:
        return
    ch = d["pendingChooser"]
    check([o["name"] for o in ch["alreadySelected"]] == ["Enchantment"], "remove chooser should list Enchantment")
    check(call(port, "GET", "/characters")[0] == 409, "engine call during a pending chooser should be 409")
    check(json.loads(call(port, "GET", "/health")[1])["pendingChooser"] == ch["id"], "health should show chooser")
    check(call(port, "POST", "/choosers/nope", select="0")[0] == 404, "wrong chooser id should be 404")

    # Cancel leaves the character unchanged.
    st, body = call(port, "POST", "/choosers/" + ch["id"], cancel="1")
    check(st == 200 and spell_focus() == ["Spell Focus (Enchantment)"], f"cancel should change nothing: {spell_focus()}")

    # A bad index fails cleanly and does not wedge the worker.
    st, d = start("DELETE")
    st2, body = call(port, "POST", "/choosers/" + d["pendingChooser"]["id"], deselect="99")
    check(st2 == 200 and "out of range" in body, f"bad index should be reported: {st2} {body[:120]}")
    check(call(port, "GET", "/characters")[0] == 200, "worker wedged after bad chooser answer")

    # Real removal, then re-add choosing Evocation by name.
    st, d = start("DELETE")
    st2, _ = call(port, "POST", "/choosers/" + d["pendingChooser"]["id"], deselect="0")
    check(st2 == 200 and spell_focus() == [], f"remove should work: {spell_focus()}")
    st, d = start("POST")
    check(st == 202, f"add should raise a chooser, got {st}")
    if st == 202:
        ch = d["pendingChooser"]
        idx = [o["index"] for o in ch["options"] if o["name"] == "Evocation"]
        check(bool(idx) and ch["choicesRequired"] == 1, "add chooser should offer Evocation and need 1 choice")
        call(port, "POST", "/choosers/" + ch["id"], select=str(idx[0]) if idx else "0")
    check(spell_focus() == ["Spell Focus (Evocation)"], f"re-add with Evocation: {spell_focus()}")

    # Put the character back so later checks (and a rerun against this process) see the original.
    st, d = start("DELETE")
    call(port, "POST", "/choosers/" + d["pendingChooser"]["id"], deselect="0")
    st, d = start("POST")
    ch = d["pendingChooser"]
    call(port, "POST", "/choosers/" + ch["id"], select=str([o["index"] for o in ch["options"] if o["name"] == "Enchantment"][0]))
    check(spell_focus() == ["Spell Focus (Enchantment)"], f"restore: {spell_focus()}")


def test_character(idx, char, others):
    port, problems = BASE_PORT + idx, []
    settings = Path(tempfile.mkdtemp(prefix="sidecar-settings-"))

    def check(cond, msg):
        if not cond:
            problems.append(msg)

    cmd = [str(DEFAULT_JDK / "bin" / "java.exe"), "-cp", "revamp/sidecar/build;build/libs/*",
           "pcgen.sidecar.Sidecar", "--settings-dir", str(settings),
           "--from-character", str(char), "--port", str(port)]
    proc = subprocess.Popen(cmd, cwd=PCGEN, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    ready = threading.Event()

    def watch():  # keep draining stdout so the child never blocks on a full pipe
        for line in proc.stdout:
            if line.startswith("READY"):
                ready.set()
    threading.Thread(target=watch, daemon=True).start()
    try:
        if not ready.wait(180):
            return char.stem, ["sidecar never reported READY"]
        st, body = call(port, "GET", "/health")
        check(st == 200 and json.loads(body)["status"] == "ok", f"health: {st} {body[:100]}")

        st, body = call(port, "POST", "/characters", path=str(char))
        cid = char.stem
        check(st == 200 and json.loads(body).get("id") == cid, f"open: {st} {body[:200]}")
        st, body = call(port, "GET", "/characters")
        check(st == 200 and [c["id"] for c in json.loads(body)] == [cid], f"list: {st} {body[:200]}")
        st, _ = call(port, "POST", "/characters", path=str(char))
        check(st == 409, f"re-open same character should be 409, got {st}")

        for tname, tpath in TEMPLATES.items():
            base = (BASELINE / f"{char.stem}.{tname}.out").read_text(encoding="utf-8", errors="replace")
            for attempt in (1, 2):
                st, body = call(port, "POST", f"/characters/{cid}/export", template=str(PCGEN / tpath))
                body = without_gm_marks(body)
                check(st == 200 and same(char.stem, normalize(body), base), f"export {tname} #{attempt}: status {st}, "
                      f"{'matches' if same(char.stem, normalize(body), base) else 'DIFFERS from'} baseline")

        check(call(port, "GET", "/characters/nope")[0] == 404, "unknown id should be 404")
        check(call(port, "POST", "/characters")[0] == 400, "missing path should be 400")
        check(call(port, "POST", f"/characters/{cid}/export")[0] == 400, "missing template should be 400")
        check(call(port, "GET", "/no/such/route")[0] == 404, "unknown route should be 404")

        if char.stem == "pf_Cleric":
            check_choosers(port, cid, PCGEN / TEMPLATES["plain"], check)

        # A character that needs a book this sidecar did not load is refused (409); one whose books are all loaded
        # opens (the sidecar may load extra books), so close those again.
        refused = False
        for other in others:
            st, body = call(port, "POST", "/characters", path=str(other))
            if st == 409:
                refused = True
                break
            if st == 200:
                call(port, "DELETE", f"/characters/{json.loads(body)['id']}")
        if not refused:
            problems.append("no other sample character produced a 409 for mismatched sources")

        st, _ = call(port, "DELETE", f"/characters/{cid}")
        check(st == 200, f"close: {st}")
        check(json.loads(call(port, "GET", "/health")[1])["characters"] == [], "character still open after close")
        check(call(port, "POST", "/shutdown")[0] == 200, "shutdown request failed")
        try:
            proc.wait(30)
        except subprocess.TimeoutExpired:
            problems.append("process did not exit after /shutdown")
    except Exception as e:  # report instead of crashing the whole run
        problems.append(f"exception: {e!r}")
    finally:
        if proc.poll() is None:
            proc.kill()
    return char.stem, problems


def main():
    # The generated corpus is for the export harness; these sidecar checks use the sample characters (and Clarent).
    chars = [c for c in all_chars() if not c.stem.startswith("corpus_")]
    with ThreadPoolExecutor(len(chars)) as ex:
        results = list(ex.map(lambda a: test_character(a[0], a[1], [c for c in chars if c != a[1]]),
                              enumerate(chars)))
    bad = 0
    for name, problems in results:
        if problems:
            bad += 1
            print(f"FAIL  {name}")
            for p in problems:
                print(f"      - {p}")
        else:
            print(f"PASS  {name}")
    print(f"{len(results) - bad}/{len(results)} sidecars ok")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
