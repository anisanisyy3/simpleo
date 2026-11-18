"use strict";
/* Scanner backend tests. Starts the real server (server/index.js) against a MOCK vision provider on localhost.
   Run: node tests/scan-test.js     (needs Node >= 22.13, no network, no API key)
   This proves our request building, validation, error mapping and result cleaning. It does NOT prove that a real provider recognises food:
   that needs a live key (see docs/RAILWAY.md "First live check"). */
const http = require("node:http"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { spawn } = require("node:child_process");
const FX = (f) => path.join(__dirname, "fixtures", f), b64 = (f) => fs.readFileSync(FX(f)).toString("base64");
const IMG = { jpg: { mime: "image/jpeg", data: b64("tomatoes.jpg") }, png: { mime: "image/png", data: b64("onions.png") }, webp: { mime: "image/webp", data: b64("plate.webp") } };

let pass = 0, fail = 0; const failures = [];
const ok = (cond, name, extra) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; failures.push(name); console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- mock provider (speaks both the Anthropic and the OpenAI-compatible shapes) ---------- */
const mock = { mode: "ok", last: null, calls: 0 };
const anthropicText = (t) => ({ id: "msg_1", type: "message", role: "assistant", content: t === null ? [] : [{ type: "text", text: t }], stop_reason: "end_turn" });
const ING = { ingredients: [
  { name: "Tomatoes", category: "vegetable", confidence: "medium", count: 5, alternatives: ["cherry tomato", "tomatoes"], image: 0 },
  { name: " tomato ", category: "vegetable", confidence: "high", count: 6, alternatives: [], image: 1 },
  { name: "Red Onion", category: "vegetable", confidence: "high", count: 2, alternatives: ["shallot"], image: 1 },
  { name: "", category: "other", confidence: "high" }, { name: 42 }, null,
  { name: "Parsley", category: "herb", confidence: "weird", count: -3, alternatives: ["coriander", "parsley"], image: 99 } ] };
const MEAL = { meal: { name: "Chicken and rice", cuisine: "Algerian", confidence: "medium", alternatives: ["Chicken pilaf", "chicken and rice", "Biryani", "Mandi"] },
  description: "Pieces of roasted chicken on a bed of yellow rice with a few green herbs.", ingredients: ["chicken", "Rice", "rice", "parsley"],
  components: [{ name: "roasted chicken", category: "meat", prep: "roasted", confidence: "high", hidden: false, image: 0 }, { name: "Rice", category: "grain", prep: null, confidence: "high", hidden: true, image: 0 }, { name: "rice", category: "grain", confidence: "low" }],
  questions: ["Was the rice cooked in oil or butter?"] };

function reply(res, status, body) { const s = typeof body === "string" ? body : JSON.stringify(body); res.writeHead(status, { "content-type": "application/json" }); res.end(s); }
const mockServer = http.createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
    mock.calls++; let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch (e) { /* ignore */ }
    mock.last = { url: req.url, headers: req.headers, body };
    const isMeal = JSON.stringify(body.system || (body.messages && body.messages[0] && body.messages[0].content) || "").includes("prepared meal");
    const payload = isMeal ? MEAL : ING, text = JSON.stringify(payload);
    const isGem = /^\/v1beta\/models\/[^/]+:generateContent$/.test(req.url);
    if (isGem) {
      const gtext = JSON.stringify(JSON.stringify(body.systemInstruction || "").includes("prepared meal") ? MEAL : ING), gres = (t) => ({ candidates: t === null ? [] : [{ content: { role: "model", parts: [{ thought: true, text: "thinking..." }, { text: t }] }, finishReason: "STOP" }] });
      if (req.headers["x-goog-api-key"] !== "AQ.gem-key") return reply(res, 400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } });
      if (req.url.includes("bad%20model")) return reply(res, 400, { error: { code: 400, message: "* GenerateContentRequest.model: unexpected model name format\n", status: "INVALID_ARGUMENT" } });
      const gt = gtext;
      if (mock.mode === "empty") return reply(res, 200, gres(null));
      if (mock.mode === "blocked") return reply(res, 200, { promptFeedback: { blockReason: "SAFETY" } });
      if (mock.mode === "truncated") return reply(res, 200, { candidates: [{ content: { parts: [{ text: '{"ingredients":[{"name":"to' }] }, finishReason: "MAX_TOKENS" }] });
      if (mock.mode === "500") return reply(res, 500, { error: { code: 500, message: "internal", status: "INTERNAL" } });
      return reply(res, 200, gres(gt));
    }
    const openai = req.url.endsWith("/chat/completions");
    const wrap = (t) => (openai ? { choices: [{ message: { role: "assistant", content: t }, finish_reason: "stop" }] } : anthropicText(t));
    if (!openai && req.headers["x-api-key"] !== "good-key") return reply(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    if (openai && req.headers.authorization !== "Bearer oa-key") return reply(res, 401, { error: { message: "bad key" } });
    switch (mock.mode) {
      case "ok": return reply(res, 200, wrap(text));
      case "fenced": return reply(res, 200, wrap("```json\n" + text + "\n```"));
      case "chatty": return reply(res, 200, wrap("Sure! Here is the result:\n" + text + "\nHope that helps."));
      case "empty": return reply(res, 200, wrap(null));
      case "blank": return reply(res, 200, wrap("   "));
      case "prose": return reply(res, 200, wrap("I can see some vegetables but I will not answer in JSON."));
      case "truncated": return reply(res, 200, Object.assign(wrap('{"ingredients":[{"name":"tom'), { stop_reason: "max_tokens" }));
      case "none": return reply(res, 200, wrap(isMeal ? '{"meal":null,"description":"","ingredients":[],"components":[],"questions":[]}' : '{"ingredients":[]}'));
      case "401": return reply(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      case "404": return reply(res, 404, { type: "error", error: { type: "not_found_error", message: "model: nope" } });
      case "429": return reply(res, 429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } });
      case "500": return reply(res, 500, { type: "error", error: { type: "api_error", message: "boom" } });
      case "529": return reply(res, 529, { type: "error", error: { type: "overloaded_error", message: "overloaded" } });
      case "400img": return reply(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Could not process image" } });
      case "html": return reply(res, 200, "<html>gateway</html>");
      case "hang": return; // never answers: provider timeout
      default: return reply(res, 200, wrap(text));
    }
  });
});

/* ---------- server under test ---------- */
const free = () => new Promise((r) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
async function startServer(env) {
  const port = await free(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-test-"));
  const clean = Object.assign({}, process.env); for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "SCAN_MODEL", "VISION_PROVIDER", "VISION_API_KEY", "VISION_BASE_URL", "VISION_MODEL", "VISION_TIMEOUT_MS", "SCAN_DAILY_LIMIT", "FDC_API_KEY"]) delete clean[k];
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], { env: Object.assign(clean, { PORT: String(port), DATA_DIR: dir }, env), stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; proc.stdout.on("data", (d) => (log += d)); proc.stderr.on("data", (d) => (log += d));
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch (e) { /* not up yet */ } await sleep(100); }
  const inst = { base, log: () => log, stop: () => new Promise((r) => { proc.once("exit", r); proc.kill(); }), cookie: "" };
  const su = await fetch(base + "/api/auth/signup", { method: "POST", headers: { "content-type": "application/json", "x-sc": "1" }, body: JSON.stringify({ username: "tester", email: "t@example.com", password: "password123" }) });
  inst.cookie = (su.headers.getSetCookie()[0] || "").split(";")[0];
  inst.post = async (ep, body, cookie) => { const r = await fetch(base + "/api/ai/" + ep, { method: "POST", headers: { "content-type": "application/json", "x-sc": "1", cookie: cookie === undefined ? inst.cookie : cookie }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch (e) { /* none */ } return { status: r.status, body: j }; };
  return inst;
}
const code = (r) => r.body && r.body.error && r.body.error.code;

(async () => {
  await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
  const MOCK = "http://127.0.0.1:" + mockServer.address().port;
  const GOOD = { ANTHROPIC_API_KEY: "good-key", ANTHROPIC_BASE_URL: MOCK, SCAN_DAILY_LIMIT: "100" };

  console.log("\n[1] Missing credentials");
  let s = await startServer({});
  ok(/Photo analysis is OFF/.test(s.log()), "startup log says photo analysis is OFF");
  let cfg = await (await fetch(s.base + "/config.js")).text(); ok(/"ai":false/.test(cfg), "config.js reports features.ai=false");
  let r = await s.post("scan-ingredients", { images: [IMG.jpg] }); ok(r.status === 503 && code(r) === "not_configured", "ingredients: 503 not_configured", JSON.stringify(r));
  r = await s.post("analyze-meal", { images: [IMG.jpg] }); ok(r.status === 503 && code(r) === "not_configured", "meal: 503 not_configured");
  r = await s.post("scan-ingredients", { images: [IMG.jpg] }, ""); ok(r.status === 401, "not logged in: 401");
  await s.stop();

  console.log("\n[2] Invalid credentials (provider answers 401)");
  s = await startServer({ ANTHROPIC_API_KEY: "wrong-key", ANTHROPIC_BASE_URL: MOCK, SCAN_DAILY_LIMIT: "100" });
  r = await s.post("scan-ingredients", { images: [IMG.jpg] }); ok(r.status === 502 && code(r) === "provider_auth", "ingredients: provider_auth", JSON.stringify(r));
  r = await s.post("analyze-meal", { images: [IMG.jpg] }); ok(r.status === 502 && code(r) === "provider_auth", "meal: provider_auth");
  ok(!JSON.stringify(r.body).includes("wrong-key") && !s.log().includes("wrong-key"), "API key never appears in the response or the log");
  await s.stop();

  console.log("\n[3] Normal results (anthropic provider)");
  s = await startServer(GOOD); mock.mode = "ok";
  ok(/provider=anthropic model=claude-haiku-5-5/.test(s.log()), "startup log shows provider and default model");
  cfg = await (await fetch(s.base + "/config.js")).text(); ok(/"ai":true/.test(cfg) && !cfg.includes("good-key"), "config.js reports features.ai=true and does not contain the key");
  r = await s.post("scan-ingredients", { images: [IMG.jpg, IMG.png] });
  ok(r.status === 200, "ingredients: 200", JSON.stringify(r));
  const names = (r.body.ingredients || []).map((x) => x.name);
  ok(JSON.stringify(names) === JSON.stringify(["tomatoes", "red onion", "parsley"]) || JSON.stringify(names) === JSON.stringify(["tomato", "red onion", "parsley"]) || (names.length === 3 && names.includes("red onion") && names.includes("parsley")), "duplicates merged, junk entries dropped", JSON.stringify(names));
  const tom = (r.body.ingredients || []).find((x) => /^tomato/.test(x.name)) || {};
  ok(tom.confidence === "high" && tom.count === 6 && JSON.stringify(tom.images) === "[0,1]", "merge keeps best confidence, max count, all photos", JSON.stringify(tom));
  ok(!(tom.alternatives || []).some((a) => /^tomatoes?$/.test(a)), "alternative equal to the name is removed");
  const par = (r.body.ingredients || []).find((x) => x.name === "parsley") || {};
  ok(par.confidence === "low" && par.count === null && par.image === 0 && !par.alternatives.includes("parsley"), "bad confidence/count/image index sanitised", JSON.stringify(par));
  ok(r.body.images_analyzed === 2, "images_analyzed = 2");
  const sent = mock.last.body.messages[0].content.filter((c) => c.type === "image");
  ok(sent.length === 2 && sent[0].source.media_type === "image/jpeg" && sent[1].source.media_type === "image/png" && sent[0].source.data === IMG.jpg.data, "both photos reached the provider unchanged");
  ok(mock.last.headers["x-api-key"] === "good-key" && mock.last.url === "/v1/messages", "provider got the key in a server-side header on /v1/messages");
  ok(!JSON.stringify(r.body).includes("good-key"), "key not in response");

  r = await s.post("scan-ingredients", { images: [IMG.webp] }); ok(r.status === 200, "webp upload accepted");
  r = await s.post("analyze-meal", { images: [IMG.jpg] });
  ok(r.status === 200 && r.body.meal && r.body.meal.name === "Chicken and rice", "meal: dish identified", JSON.stringify(r.body));
  ok(r.body.description && /chicken/i.test(r.body.description), "meal: description returned");
  ok(JSON.stringify(r.body.ingredients) === '["chicken","rice","parsley"]', "meal: visible ingredients deduplicated", JSON.stringify(r.body.ingredients));
  ok(r.body.components.length === 2 && r.body.components[1].hidden === true, "meal: components deduplicated, hidden flag kept", JSON.stringify(r.body.components));
  ok(r.body.meal.alternatives.length === 3 && !r.body.meal.alternatives.some((a) => /^chicken and rice$/i.test(a)), "meal: alternatives cleaned (no echo of the main name, max 3)", JSON.stringify(r.body.meal.alternatives));
  ok(r.body.meal.confidence === "medium", "meal: uncertainty preserved (confidence medium)");
  ok(/never give calories|NEVER give calories/i.test(mock.last.body.system) && /never guess hidden/i.test(mock.last.body.system), "meal prompt forbids invented nutrition and invented hidden ingredients");

  console.log("\n[4] Model output formats");
  for (const [mode, label] of [["fenced", "JSON inside ```json fences"], ["chatty", "JSON surrounded by chatter"]]) { mock.mode = mode; r = await s.post("scan-ingredients", { images: [IMG.jpg] }); ok(r.status === 200 && r.body.ingredients.length === 3, "parses " + label, JSON.stringify(r)); }
  mock.mode = "none"; r = await s.post("scan-ingredients", { images: [IMG.jpg] }); ok(r.status === 200 && Array.isArray(r.body.ingredients) && r.body.ingredients.length === 0, "nothing recognised -> 200 with an honest empty list (not an error, not fake items)");
  r = await s.post("analyze-meal", { images: [IMG.jpg] }); ok(r.status === 200 && r.body.meal === null && r.body.components.length === 0, "no food visible -> meal:null, no components");

  console.log("\n[5] Empty / unreadable provider responses");
  for (const [mode, c] of [["empty", "empty_response"], ["blank", "empty_response"], ["prose", "bad_response"], ["truncated", "bad_response"], ["html", "bad_response"]]) {
    mock.mode = mode; r = await s.post("scan-ingredients", { images: [IMG.jpg] }); ok(r.status === 502 && code(r) === c, "ingredients, provider sends " + mode + " -> " + c, JSON.stringify(r));
  }
  mock.mode = "empty"; r = await s.post("analyze-meal", { images: [IMG.jpg] }); ok(r.status === 502 && code(r) === "empty_response", "meal, empty provider answer -> empty_response");

  console.log("\n[6] Provider errors");
  for (const [mode, st, c] of [["401", 502, "provider_auth"], ["404", 502, "provider_model"], ["429", 503, "provider_rate_limit"], ["500", 502, "provider_error"], ["529", 502, "provider_error"], ["400img", 422, "image_rejected"]]) {
    mock.mode = mode; r = await s.post("scan-ingredients", { images: [IMG.jpg] }); ok(r.status === st && code(r) === c, "provider HTTP " + mode + " -> " + st + " " + c, JSON.stringify(r));
  }
  ok(!/internal|stack/i.test(JSON.stringify(r.body)), "no internals leaked in error JSON");
  await s.stop();

  console.log("\n[7] Provider timeout and unreachable provider");
  s = await startServer(Object.assign({}, GOOD, { VISION_TIMEOUT_MS: "800" })); mock.mode = "hang";
  const t0 = Date.now(); r = await s.post("scan-ingredients", { images: [IMG.jpg] });
  ok(r.status === 504 && code(r) === "provider_timeout" && Date.now() - t0 < 4000, "hung provider -> 504 provider_timeout after the configured limit", JSON.stringify(r) + " " + (Date.now() - t0) + "ms");
  await s.stop();
  s = await startServer({ ANTHROPIC_API_KEY: "good-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:1", SCAN_DAILY_LIMIT: "100" });
  r = await s.post("analyze-meal", { images: [IMG.jpg] }); ok(r.status === 502 && code(r) === "provider_unreachable", "closed port -> provider_unreachable", JSON.stringify(r));
  await s.stop();

  console.log("\n[8] Invalid uploads");
  s = await startServer(GOOD); mock.mode = "ok"; const before = mock.calls;
  const bad = [
    ["no images", { images: [] }, "invalid_image"], ["images missing", {}, "invalid_image"], ["images not an array", { images: "x" }, "invalid_image"], ["null entry", { images: [null] }, "invalid_image"],
    ["gif", { images: [{ mime: "image/gif", data: IMG.jpg.data }] }, "unsupported_format"], ["svg", { images: [{ mime: "image/svg+xml", data: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64") }] }, "unsupported_format"],
    ["pdf mime", { images: [{ mime: "application/pdf", data: IMG.jpg.data }] }, "unsupported_format"],
    ["text pretending to be jpeg", { images: [{ mime: "image/jpeg", data: b64("notes.txt") }] }, "invalid_image"],
    ["png bytes labelled jpeg", { images: [{ mime: "image/jpeg", data: IMG.png.data }] }, "invalid_image"],
    ["jpeg bytes labelled webp", { images: [{ mime: "image/webp", data: IMG.jpg.data }] }, "invalid_image"],
    ["not base64", { images: [{ mime: "image/jpeg", data: "////!!!not base64!!!" + "A".repeat(80) }] }, "invalid_image"], ["data URL instead of base64", { images: [{ mime: "image/jpeg", data: "data:image/jpeg;base64," + IMG.jpg.data }] }, "invalid_image"],
    ["tiny stub", { images: [{ mime: "image/jpeg", data: "/9j/4A==" }] }, "invalid_image"],
    ["oversized photo", { images: [{ mime: "image/jpeg", data: IMG.jpg.data.slice(0, 40) + "A".repeat(2000100) }] }, "image_too_large"],
    ["6 ingredient photos", { images: Array(6).fill(IMG.jpg) }, "too_many_images"],
  ];
  for (const [label, body, c] of bad) { r = await s.post("scan-ingredients", body); ok(r.status === 400 && code(r) === c, "ingredients rejects " + label + " -> " + c, JSON.stringify(r.body).slice(0, 120)); }
  r = await s.post("analyze-meal", { images: Array(4).fill(IMG.jpg) }); ok(r.status === 400 && code(r) === "too_many_images", "meal rejects 4 photos");
  r = await s.post("analyze-meal", { images: [{ mime: "image/gif", data: IMG.jpg.data }] }); ok(r.status === 400 && code(r) === "unsupported_format", "meal rejects gif");
  ok(mock.calls === before, "no invalid upload ever reached the provider");
  const big = await fetch(s.base + "/api/ai/scan-ingredients", { method: "POST", headers: { "content-type": "application/json", "x-sc": "1", cookie: s.cookie }, body: JSON.stringify({ images: [{ mime: "image/jpeg", data: "A".repeat(15 * 1048576) }] }) }).then((x) => x.status, () => 0);
  ok(big === 413 || big === 0, "request body over 14 MB is refused (413 or connection closed)", String(big));
  r = await s.post("scan-ingredients", { images: [IMG.jpg] }); ok(r.status === 200, "server still healthy after all the bad uploads");
  await s.stop();

  console.log("\n[9] Daily limit and refunds");
  s = await startServer({ ANTHROPIC_API_KEY: "good-key", ANTHROPIC_BASE_URL: MOCK, SCAN_DAILY_LIMIT: "3" }); mock.mode = "500";
  for (let i = 0; i < 4; i++) r = await s.post("scan-ingredients", { images: [IMG.jpg, IMG.png] });
  ok(r.status === 502 && code(r) === "provider_error", "failed analyses are refunded: 4 failures of 2 photos did not use up a limit of 3", JSON.stringify(r));
  mock.mode = "ok"; r = await s.post("scan-ingredients", { images: [IMG.jpg, IMG.png] }); ok(r.status === 200, "2 photos succeed (2/3 used)");
  r = await s.post("scan-ingredients", { images: [IMG.jpg, IMG.png] }); ok(r.status === 429 && code(r) === "quota_exceeded", "next 2 photos exceed 3/day -> 429 quota_exceeded", JSON.stringify(r));
  r = await s.post("scan-ingredients", { images: [IMG.jpg] }); ok(r.status === 200, "1 more photo still fits (3/3)");
  await s.stop();

  console.log("\n[10] Provider-independent adapter (openai-compatible)");
  s = await startServer({ VISION_PROVIDER: "openai-compatible", VISION_BASE_URL: MOCK + "/v1", VISION_MODEL: "my-vision-model", VISION_API_KEY: "oa-key", SCAN_DAILY_LIMIT: "100" }); mock.mode = "ok";
  ok(/provider=openai-compatible model=my-vision-model/.test(s.log()), "startup log shows openai-compatible provider");
  r = await s.post("scan-ingredients", { images: [IMG.jpg, IMG.png] }); ok(r.status === 200 && r.body.ingredients.length === 3 && r.body.model === "my-vision-model", "ingredients via openai-compatible", JSON.stringify(r));
  ok(mock.last.url === "/v1/chat/completions" && mock.last.headers.authorization === "Bearer oa-key" && mock.last.body.model === "my-vision-model", "sent to /chat/completions with Bearer key and model");
  const parts = mock.last.body.messages[1].content; ok(parts.filter((p) => p.type === "image_url").length === 2 && /^data:image\/jpeg;base64,/.test(parts[1].image_url.url), "images sent as data: URLs");
  r = await s.post("analyze-meal", { images: [IMG.jpg] }); ok(r.status === 200 && r.body.meal.name === "Chicken and rice", "meal via openai-compatible");
  mock.mode = "empty"; r = await s.post("scan-ingredients", { images: [IMG.jpg] }); ok(code(r) === "empty_response", "openai-compatible empty answer -> empty_response");
  await s.stop();
  s = await startServer({ VISION_PROVIDER: "openai-compatible", VISION_BASE_URL: MOCK + "/v1", VISION_API_KEY: "oa-key" });
  r = await s.post("scan-ingredients", { images: [IMG.jpg] }); ok(r.status === 503 && code(r) === "not_configured", "openai-compatible without VISION_MODEL -> not_configured");
  await s.stop();
  s = await startServer({ VISION_PROVIDER: "nonsense", ANTHROPIC_API_KEY: "good-key" });
  r = await s.post("scan-ingredients", { images: [IMG.jpg] }); ok(r.status === 503 && code(r) === "not_configured" && /not supported/.test(s.log()), "unknown VISION_PROVIDER -> not_configured and a clear log line");
  await s.stop();
  s = await startServer({ ANTHROPIC_API_KEY: "good-key", ANTHROPIC_BASE_URL: MOCK, SCAN_MODEL: "legacy-model" }); mock.mode = "ok";
  r = await s.post("scan-ingredients", { images: [IMG.jpg] }); ok(r.status === 200 && mock.last.body.model === "legacy-model", "old SCAN_MODEL variable still honoured");
  await s.stop();

  console.log("\n[11] Native Gemini adapter (works with AQ. keys)");
  const GEM = { VISION_PROVIDER: "gemini", VISION_BASE_URL: MOCK, VISION_MODEL: "models/gemini-test-flash", VISION_API_KEY: "AQ.gem-key", SCAN_DAILY_LIMIT: "100" };
  s = await startServer(GEM); mock.mode = "ok";
  ok(/provider=gemini model=gemini-test-flash/.test(s.log()), "startup log shows gemini and strips a pasted 'models/' prefix");
  r = await s.post("scan-ingredients", { images: [IMG.jpg, IMG.png] }); ok(r.status === 200 && r.body.ingredients.length === 3 && r.body.images_analyzed === 2, "ingredients via native Gemini (thought parts ignored)", JSON.stringify(r));
  ok(mock.last.url === "/v1beta/models/gemini-test-flash:generateContent" && mock.last.headers["x-goog-api-key"] === "AQ.gem-key" && !mock.last.headers.authorization, "key sent in x-goog-api-key header, model in the URL");
  const gp = mock.last.body.contents[0].parts; ok(gp.filter((p) => p.inlineData).length === 2 && gp.find((p) => p.inlineData).inlineData.mimeType === "image/jpeg" && mock.last.body.generationConfig.responseMimeType === "application/json", "both photos sent as inlineData, JSON output requested");
  r = await s.post("analyze-meal", { images: [IMG.jpg] }); ok(r.status === 200 && r.body.meal.name === "Chicken and rice" && r.body.description, "meal via native Gemini");
  for (const [mode, c] of [["empty", "empty_response"], ["blocked", "empty_response"], ["truncated", "bad_response"], ["500", "provider_error"]]) { mock.mode = mode; r = await s.post("scan-ingredients", { images: [IMG.jpg] }); ok(code(r) === c, "gemini " + mode + " -> " + c, JSON.stringify(r)); }
  ok(!s.log().includes("AQ.gem-key"), "key never in the log");
  await s.stop();
  s = await startServer(Object.assign({}, GEM, { VISION_API_KEY: "AQ.wrong" })); mock.mode = "ok";
  r = await s.post("scan-ingredients", { images: [IMG.jpg] }); ok(r.status === 502 && code(r) === "provider_auth", "wrong key (Google answers 400 API_KEY_INVALID) -> provider_auth", JSON.stringify(r));
  await s.stop();
  s = await startServer(Object.assign({}, GEM, { VISION_MODEL: "bad model" }));
  r = await s.post("scan-ingredients", { images: [IMG.jpg] }); ok(r.status === 503 && code(r) === "not_configured" && /not fully configured/.test(s.log()), "model name with spaces (like the earlier mistake) is caught at startup, no call made");
  await s.stop();
  s = await startServer(Object.assign({}, GEM, { VISION_MODEL: "gemini-nonexistent" }));
  const srvCall = mock.calls; r = await s.post("scan-ingredients", { images: [IMG.jpg] }); ok(r.status === 200 || r.status === 502, "unknown but well-formed model name is passed to Google (their answer decides)");
  await s.stop();
  s = await startServer(Object.assign({}, GEM, { VISION_API_KEY: "", GEMINI_API_KEY: "AQ.gem-key" })); mock.mode = "ok";
  r = await s.post("scan-ingredients", { images: [IMG.jpg] }); ok(r.status === 200, "GEMINI_API_KEY also accepted as the key variable");
  await s.stop();

  mockServer.close();
  console.log("\n" + pass + " passed, " + fail + " failed"); if (fail) { console.log("Failed:\n - " + failures.join("\n - ")); process.exit(1); }
})().catch((e) => { console.error("test crashed:", e); process.exit(2); });
