"""Browser test of both scanners (real Chromium, real server, MOCK vision provider).
Run: python3 tests/scan-e2e.py      (needs: pip install playwright && playwright install chromium; Node >= 22.13)
Proves the pages, uploads, error messages and corrections work end to end. It does not prove a real provider recognises food."""
import os, sys, time, json, socket, subprocess, tempfile, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FX = lambda f: os.path.join(ROOT, "tests", "fixtures", f)
passed = failed = 0
def ok(cond, name, extra=""):
    global passed, failed
    if cond: passed += 1; print("  ok   " + name)
    else: failed += 1; print("  FAIL " + name + ("  -> " + str(extra) if extra else ""))
def free():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p
def wait(url):
    for _ in range(80):
        try: urllib.request.urlopen(url, timeout=1); return
        except Exception: time.sleep(0.15)
    raise RuntimeError("did not start: " + url)
procs = []
def spawn(cmd, env=None):
    e = {k: v for k, v in os.environ.items() if not k.startswith(("ANTHROPIC", "VISION", "SCAN_"))}; e.update(env or {})
    p = subprocess.Popen(cmd, env=e, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=ROOT); procs.append(p); return p
def server(extra):
    port = free(); spawn(["node", "server/index.js"], dict({"PORT": str(port), "DATA_DIR": tempfile.mkdtemp(), "SCAN_DAILY_LIMIT": "200"}, **extra)); wait("http://127.0.0.1:%d/health" % port); return "http://127.0.0.1:%d" % port

mport = free(); spawn(["node", "tests/mock-provider.js", str(mport)]); time.sleep(0.6)
mode = lambda m: urllib.request.urlopen("http://127.0.0.1:%d/__mode/%s" % (mport, m)).read()
GOOD = {"ANTHROPIC_API_KEY": "good-key", "ANTHROPIC_BASE_URL": "http://127.0.0.1:%d" % mport}
errors = []

sessions = {}   # one test account per server (the site rate-limits signups per IP), reused through saved cookies
def open_page(pw, base, user, route):
    b = pw.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
    ctx = b.new_context(permissions=["camera"], storage_state=sessions.get(base)); page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e))); page.on("console", lambda m: m.type == "error" and "favicon" not in m.text and "ERR_NAME_NOT_RESOLVED" not in m.text and "ERR_INTERNET_DISCONNECTED" not in m.text and "status of 4" not in m.text and "status of 5" not in m.text and errors.append(m.text))
    if base not in sessions:
        r = ctx.request.post(base + "/api/auth/signup", headers={"X-SC": "1", "Content-Type": "application/json"}, data=json.dumps({"username": "tester", "email": "tester@example.com", "password": "password123"}))
        assert r.ok, r.text(); sessions[base] = ctx.storage_state()
    page.goto(base + "/#/" + route); page.wait_for_selector(".sn", timeout=8000); return b, page

def msg(page): 
    try: page.wait_for_selector(".sn-msg", timeout=8000); return page.inner_text(".sn-msg")
    except Exception: return ""
def chips(page): return [c.inner_text().split("\n")[0].strip().lower() for c in page.query_selector_all(".sn-chip b")]

with sync_playwright() as pw:
    base = server(GOOD)
    print("\n[A] Ingredient scanner: two photos, normal flow")
    mode("ok"); b, page = open_page(pw, base, "ana", "scan")
    page.set_input_files("#sn-file", [FX("tomatoes.jpg"), FX("onions.png")]); page.wait_for_selector(".sn-thumbs figure")
    ok(len(page.query_selector_all(".sn-thumbs figure")) == 2, "two thumbnails shown (multi-image upload preserved)")
    page.click("#sn-an"); page.wait_for_selector("#sn-go", timeout=10000)
    names = chips(page); ok(len(names) == 3 and "red onion" in " ".join(names), "review shows 3 merged ingredients, no duplicate tomato", names)
    ok(sum("tomato" in n for n in names) == 1, "tomato appears once")
    ok("za'atar leaf" in page.inner_text(".sn-chips").lower() and "Not in our database" in page.inner_text(".sn-chips"), "unknown ingredient is kept and flagged for correction", page.inner_text(".sn-chips")[:200])
    ok(int(json.loads(mode("ok"))["lastImages"]) == 2, "provider received both photos")
    print("\n[B] Ingredient scanner: correcting results")
    page.once("dialog", lambda d: d.accept("garlic")); page.click("[data-ed='2']"); page.wait_for_timeout(300)
    ok("garlic" in " ".join(chips(page)), "edit (Change) replaces an ingredient", chips(page))
    n0 = len(chips(page)); page.click("[data-del='0']"); page.wait_for_timeout(200); ok(len(chips(page)) == n0 - 1, "remove works")
    page.fill("#sn-in", "lemon"); page.click("#sn-addb"); page.wait_for_timeout(200); ok("lemon" in " ".join(chips(page)), "manual add works")
    page.fill("#sn-in", "lemon"); page.click("#sn-addb"); page.wait_for_timeout(200); ok(chips(page).count("lemon") == 1, "typing the same ingredient twice does not duplicate")
    page.click("#sn-go"); page.wait_for_selector(".sn-rc, .sn-small", timeout=5000); ok(True, "continue to recipes still works")
    b.close()

    print("\n[C] Ingredient scanner: bad uploads are refused in the browser with a clear message")
    b, page = open_page(pw, base, "bob", "scan")
    page.set_input_files("#sn-file", {"name": "fake.jpg", "mimeType": "image/jpeg", "buffer": open(FX("notes.txt"), "rb").read()}); page.wait_for_timeout(500)
    ok("JPEG, PNG or WebP" in msg(page) and not page.query_selector(".sn-thumbs"), "text file renamed .jpg is rejected", msg(page))
    page.set_input_files("#sn-file", {"name": "x.gif", "mimeType": "image/gif", "buffer": b"GIF89a" + b"0" * 100}); page.wait_for_timeout(300)
    ok("JPEG, PNG or WebP" in msg(page) and not page.query_selector(".sn-thumbs"), "gif is rejected", msg(page))
    page.set_input_files("#sn-file", {"name": "huge.jpg", "mimeType": "image/jpeg", "buffer": open(FX("tomatoes.jpg"), "rb").read() + b"\0" * (10 * 1024 * 1024 + 10)}); page.wait_for_timeout(500)
    ok("10 MB" in msg(page) and not page.query_selector(".sn-thumbs"), "file over 10 MB is rejected", msg(page))
    page.set_input_files("#sn-file", [FX("tomatoes.jpg")] * 6); page.wait_for_timeout(1500)
    ok(len(page.query_selector_all(".sn-thumbs figure")) == 5 and "max 5" in msg(page), "6th photo refused, 5 kept", len(page.query_selector_all(".sn-thumbs figure")))
    b.close()

    print("\n[D] Ingredient scanner: provider problems show meaningful messages and keep the photos for a retry")
    for m, needle in [("401", "refused this site's access key"), ("500", "AI service had a problem"), ("empty", "empty answer"), ("prose", "could not read")]:
        mode(m); b, page = open_page(pw, base, "u" + m, "scan"); page.set_input_files("#sn-file", [FX("tomatoes.jpg")]); page.wait_for_selector(".sn-thumbs figure"); page.click("#sn-an")
        t = msg(page); ok(needle in t, "provider '%s' -> %s" % (m, needle), t); ok(page.query_selector(".sn-thumbs figure") is not None, "  photos kept so the user can retry"); b.close()
    mode("none"); b, page = open_page(pw, base, "unone", "scan"); page.set_input_files("#sn-file", [FX("tomatoes.jpg")]); page.wait_for_selector(".sn-thumbs figure"); page.click("#sn-an")
    ok("No ingredients were recognised" in msg(page), "nothing recognised -> honest message, manual add offered", msg(page)); b.close()

    print("\n[E] Server without credentials / with slow provider")
    base2 = server({})
    b, page = open_page(pw, base2, "nokey", "scan"); page.set_input_files("#sn-file", [FX("tomatoes.jpg")]); page.wait_for_selector(".sn-thumbs figure"); page.click("#sn-an")
    ok("not switched on" in msg(page), "missing API key -> 'not switched on' message", msg(page)); b.close()
    base3 = server(dict(GOOD, VISION_TIMEOUT_MS="900")); mode("hang")
    b, page = open_page(pw, base3, "slow", "scan"); page.set_input_files("#sn-file", [FX("tomatoes.jpg")]); page.wait_for_selector(".sn-thumbs figure"); page.click("#sn-an")
    ok("took too long" in msg(page), "provider timeout -> 'took too long' message", msg(page)); b.close()

    print("\n[F] AI Food scanner")
    mode("ok"); b, page = open_page(pw, base, "chef", "food")
    page.set_input_files("#fs-file", FX("plate.webp")); page.wait_for_selector(".sn-thumbs figure"); page.click("#fs-an"); page.wait_for_selector("#fs-go", timeout=10000)
    body = page.inner_text(".sn")
    ok(page.input_value("#fs-mn") == "Chicken and rice", "dish name filled in", page.input_value("#fs-mn"))
    ok("roasted chicken on a bed of yellow rice" in body, "description shown")
    ok("Visible ingredients" in body and "parsley" in body, "visible ingredients shown")
    ok("Chicken pilaf" in body and "Other possibilities" in body, "alternative dishes shown (uncertainty is not hidden)")
    ok("medium" in body, "AI confidence shown")
    ok(len(page.query_selector_all("[data-nm]")) == 2, "components listed and editable")
    page.fill("[data-nm='0']", "grilled chicken"); page.fill("#fs-mn", "Chicken rice"); page.click("#fs-go"); page.wait_for_selector(".sn-rc", timeout=8000)
    ok("grilled chicken" in page.inner_text(".sn") and "Chicken rice" in page.inner_text("h1"), "user corrections carry into the result")
    b.close()
    mode("meal-low"); b, page = open_page(pw, base, "chef2", "food"); page.set_input_files("#fs-file", FX("plate.webp")); page.wait_for_selector(".sn-thumbs figure"); page.click("#fs-an"); page.wait_for_selector("#fs-go", timeout=10000)
    ok("not sure about this dish" in page.inner_text(".sn"), "low confidence shows a warning", page.inner_text(".sn")[:200]); b.close()
    mode("none"); b, page = open_page(pw, base, "chef3", "food"); page.set_input_files("#fs-file", FX("plate.webp")); page.wait_for_selector(".sn-thumbs figure"); page.click("#fs-an")
    ok("No food was recognised" in msg(page), "no food in photo -> honest message", msg(page)); b.close()
    for m, needle in [("401", "refused this site's access key"), ("500", "AI service had a problem"), ("empty", "empty answer")]:
        mode(m); b, page = open_page(pw, base, "f" + m, "food"); page.set_input_files("#fs-file", FX("plate.webp")); page.wait_for_selector(".sn-thumbs figure"); page.click("#fs-an")
        t = msg(page); ok(needle in t, "food, provider '%s' -> %s" % (m, needle), t); b.close()
    b, page = open_page(pw, base2, "foodnokey", "food"); page.set_input_files("#fs-file", FX("plate.webp")); page.wait_for_selector(".sn-thumbs figure"); page.click("#fs-an")
    ok("not switched on" in msg(page), "food: missing API key -> clear message", msg(page)); b.close()
    b, page = open_page(pw, base, "foodbad", "food"); page.set_input_files("#fs-file", {"name": "fake.jpg", "mimeType": "image/jpeg", "buffer": open(FX("notes.txt"), "rb").read()}); page.wait_for_timeout(500)
    ok("JPEG, PNG or WebP" in msg(page), "food: fake image rejected", msg(page)); b.close()

    print("\n[G] Camera capture (Chromium fake camera)")
    mode("ok"); b, page = open_page(pw, base, "cam", "scan"); page.click("#sn-cam"); page.wait_for_selector("#sn-v", timeout=5000); [page.wait_for_timeout(250) for _ in range(40) if not page.evaluate("() => document.querySelector('#sn-v').videoWidth > 0")]   # poll: the site's CSP forbids string eval, so no wait_for_function
    page.click("#sn-cap"); page.wait_for_selector(".sn-thumbs figure", timeout=5000); ok(True, "camera opens and a captured photo appears as a thumbnail")
    page.click("#sn-an"); page.wait_for_selector("#sn-go", timeout=10000); ok(len(chips(page)) == 3, "captured photo analysed", chips(page)); b.close()

ok(not errors, "no JavaScript errors or console errors during the whole run", errors[:3])
for p in procs: p.kill()
print("\n%d passed, %d failed" % (passed, failed)); sys.exit(1 if failed else 0)
