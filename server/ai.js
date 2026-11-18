"use strict";
/* Camera features: ingredient scanner + meal recognition (vision provider chosen in server/vision.js, key stays on the server) and USDA nutrition lookup.
   Photos are processed in memory only: never written to disk or logged. */
const { get, run } = require("./db");
const { HttpError } = require("./core");
const vision = require("./vision");
const { ScanError } = vision;
const FDC = () => (process.env.FDC_BASE_URL || "https://api.nal.usda.gov").replace(/\/$/, "");
const DAILY = () => Math.max(1, parseInt(process.env.SCAN_DAILY_LIMIT, 10) || 20);   // photos per user per day

const SYS_SCAN = `You identify food ingredients visible in kitchen photos. Rules: list only distinct ingredients you can actually see; never guess the contents of closed or opaque containers; use common English ingredient names (singular, lower case, no quantities in the name); list each ingredient once even if it appears in several photos; do not infer quantity by weight; "count" is the number of visible discrete items or null; "confidence" is high, medium or low based only on visual evidence; give up to 2 "alternatives" when similar-looking ingredients are possible (e.g. parsley/coriander, lemon/lime). Reply with JSON only: {"ingredients":[{"name":"","category":"vegetable|fruit|meat|seafood|dairy|grain|legume|herb|spice|pantry|other","confidence":"","count":null,"alternatives":[],"image":0}]} where "image" is the 0-based index of the photo where it is clearest. If nothing edible is visible return {"ingredients":[]}.`;
const SYS_MEAL = `You identify a prepared meal in photos for a nutrition tool. Rules: name the dish and list its visible components separately (e.g. grilled chicken, cooked rice, salad, sauce). Use the dish's common name; keep a traditional name if you know it. "description" is one or two plain sentences about what the dish appears to be and how it looks, based only on what is visible; do not claim flavours, origin or recipe details you cannot see. "ingredients" lists ONLY ingredients that are visibly identifiable (never guess hidden ones such as oil, butter, sugar, spices or the contents of sauces, fillings or stews). NEVER give calories, nutrients, grams or portion weights. Say prep method only if visible (grilled, fried, boiled, baked, raw...) else null. Mark hidden=true for anything whose recipe, oil, sugar or sauce content a photo cannot reveal. "confidence" is high, medium or low from visual evidence only; use low when you are unsure instead of guessing. Give up to 3 alternative dish names when the dish is ambiguous. "questions" are at most 3 short questions whose answers would materially change the nutrition (e.g. dressing used? deep-fried or oven-baked?). Reply with JSON only: {"meal":{"name":"","cuisine":null,"confidence":"","alternatives":[]},"description":"","ingredients":[],"components":[{"name":"","category":"","prep":null,"confidence":"","hidden":false,"image":0}],"questions":[]}. If no food is visible return {"meal":null,"description":"","ingredients":[],"components":[],"questions":[]}.`;

const MAGIC = { "image/jpeg": [0xff, 0xd8, 0xff], "image/png": [0x89, 0x50, 0x4e, 0x47], "image/webp": [0x52, 0x49, 0x46, 0x46] };
const MAX_B64 = 2000000;   // about 1.5 MB per photo; the browser shrinks photos to 1280 px before sending
const s60 = (x) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 60) : null);
const OK = ["high", "medium", "low"], RANK = { low: 0, medium: 1, high: 2 };
const tidy = (x, n) => String(x == null ? "" : x).replace(/\s+/g, " ").replace(/^[\s\-•*·,.;:]+|[\s,.;:]+$/g, "").slice(0, n);
const keyOf = (x) => { const w = tidy(x, 80).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); return w.length > 3 && /ies$/.test(w) ? w.slice(0, -3) + "y" : w.length > 3 && /(oes|ches|shes|sses)$/.test(w) ? w.slice(0, -2) : w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w; };

function checkImages(b, max) {
  const imgs = Array.isArray(b.images) ? b.images : [];
  if (imgs.length < 1) throw new ScanError(400, "invalid_image", "No photo was received.");
  if (imgs.length > max) throw new ScanError(400, "too_many_images", "Too many photos (max " + max + ").");
  for (const i of imgs) {
    if (!i || typeof i !== "object") throw new ScanError(400, "invalid_image", "That is not a valid photo.");
    const m = MAGIC[i.mime];
    if (!m) throw new ScanError(400, "unsupported_format", "Use JPEG, PNG or WebP photos.");
    if (typeof i.data !== "string" || i.data.length < 64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(i.data)) throw new ScanError(400, "invalid_image", "That is not a valid photo.");
    if (i.data.length > MAX_B64) throw new ScanError(400, "image_too_large", "That photo is too large.");
    const head = Buffer.from(i.data.slice(0, 16), "base64");
    if (!m.every((v, k) => head[k] === v) || (i.mime === "image/webp" && head.subarray(8, 12).toString("latin1") !== "WEBP")) throw new ScanError(400, "invalid_image", "That file is not a real photo of the type it claims.");
  }
  return imgs;
}
function quota(userId, n) {
  const day = new Date().toISOString().slice(0, 10), row = get("SELECT n FROM scan_quota WHERE user_id=? AND day=?", userId, day);
  if ((row ? row.n : 0) + n > DAILY()) throw new ScanError(429, "quota_exceeded", "Daily photo limit reached.");
  run("INSERT INTO scan_quota(user_id,day,n) VALUES(?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET n=n+?", userId, day, n, n);
  return day;
}
const refund = (userId, day, n) => { try { run("UPDATE scan_quota SET n=MAX(0,n-?) WHERE user_id=? AND day=?", n, userId, day); } catch (e) { /* ignore */ } };
/* Anything unexpected becomes a clear JSON error, never a silent success. */
const guard = async (fn) => { try { return await fn(); } catch (e) { if (e instanceof HttpError) throw e; console.error("[ai] unexpected:", e && e.stack || e); throw new ScanError(502, "analysis_failed", "The analysis failed."); } };
/* Photos only count against the daily limit when the provider actually answered. */
async function metered(u, n, fn) {
  const day = quota(u.id, n);
  try { return await guard(fn); } catch (e) { refund(u.id, day, n); throw e; }
}
const confOf = (c) => (OK.includes(c) ? c : "low");
const imgIdx = (v, n) => (Number.isInteger(v) && v >= 0 && v < n ? v : 0);

/* Merge duplicates (same name after trimming, case, accents and plural): keep the best confidence, the largest count, every alternative and every photo it appeared in. */
function mergeIngredients(raw, nImgs) {
  const out = new Map();
  for (const x of (Array.isArray(raw) ? raw : []).slice(0, 80)) {
    if (!x || typeof x.name !== "string") continue;
    const name = tidy(x.name, 60).toLowerCase(), k = keyOf(name); if (!k) continue;
    const alts = (Array.isArray(x.alternatives) ? x.alternatives : []).filter((a) => typeof a === "string").map((a) => tidy(a, 60).toLowerCase()).filter((a) => a && keyOf(a) !== k);
    const cur = { name, category: tidy(x.category || "other", 20).toLowerCase() || "other", confidence: confOf(x.confidence), count: Number.isInteger(x.count) && x.count > 0 && x.count < 100 ? x.count : null, alternatives: alts, images: [imgIdx(x.image, nImgs)] };
    const old = out.get(k);
    if (!old) { out.set(k, cur); continue; }
    if (RANK[cur.confidence] > RANK[old.confidence]) old.confidence = cur.confidence;
    if (cur.count) old.count = Math.max(old.count || 0, cur.count);
    old.alternatives = [...new Set([...old.alternatives, ...cur.alternatives])];
    old.images = [...new Set([...old.images, ...cur.images])];
  }
  return [...out.values()].slice(0, 40).map((x) => Object.assign(x, { alternatives: x.alternatives.slice(0, 2), image: x.images[0] }));
}

const A = {};
A["scan-ingredients"] = (u, b) => {
  const imgs = checkImages(b, 5);
  if (!vision.configured()) throw new ScanError(503, "not_configured", "Photo analysis is not configured on this server.");
  return metered(u, imgs.length, async () => {
    const j = await vision.complete(SYS_SCAN, imgs, "Identify the ingredients in these " + imgs.length + " photo(s). Photo indexes start at 0.");
    return { ingredients: mergeIngredients(j.ingredients, imgs.length), images_analyzed: imgs.length, model: vision.modelName() };
  });
};
A["analyze-meal"] = (u, b) => {
  const imgs = checkImages(b, 3);
  if (!vision.configured()) throw new ScanError(503, "not_configured", "Photo analysis is not configured on this server.");
  return metered(u, imgs.length, async () => {
    const j = await vision.complete(SYS_MEAL, imgs, "Identify this meal and its components.");
    const seen = new Set(), comps = [];
    for (const c of (Array.isArray(j.components) ? j.components : []).slice(0, 24)) {
      if (!c || typeof c.name !== "string") continue; const name = tidy(c.name, 60), k = keyOf(name); if (!k || seen.has(k)) continue; seen.add(k);
      comps.push({ name, category: s60(c.category), prep: s60(c.prep), confidence: confOf(c.confidence), hidden: c.hidden === true, image: imgIdx(c.image, imgs.length) });
    }
    const jm = j.meal && typeof j.meal === "object" ? j.meal : null, mname = jm && typeof jm.name === "string" ? tidy(jm.name, 80) : "";
    const meal = mname ? { name: mname, cuisine: s60(jm.cuisine), confidence: confOf(jm.confidence), alternatives: (Array.isArray(jm.alternatives) ? jm.alternatives : []).filter((a) => typeof a === "string").map((a) => tidy(a, 80)).filter((a) => a && keyOf(a) !== keyOf(mname)).slice(0, 3) } : null;
    const ing = [], ik = new Set(); for (const x of (Array.isArray(j.ingredients) ? j.ingredients : [])) { if (typeof x !== "string") continue; const n = tidy(x, 60).toLowerCase(), k = keyOf(n); if (k && !ik.has(k)) { ik.add(k); ing.push(n); } }
    return { meal, description: typeof j.description === "string" ? tidy(j.description, 400) : "", ingredients: ing.slice(0, 20), components: comps.slice(0, 12),
      questions: (Array.isArray(j.questions) ? j.questions : []).filter((x) => typeof x === "string").slice(0, 3).map((x) => tidy(x, 140)), images_analyzed: imgs.length, model: vision.modelName() };
  });
};
const NUM = { 208: "kcal", 203: "protein", 205: "carbs", 204: "fat", 606: "satfat", 291: "fiber", 269: "sugar", 307: "sodium" };
A["nutrition-lookup"] = async (u, b) => {
  const query = typeof b.query === "string" ? b.query.trim().slice(0, 80) : ""; if (query.length < 2) throw new HttpError(400, "bad_query");
  if (!process.env.FDC_API_KEY) throw new HttpError(503, "not_configured");
  return guard(async () => {
    const url = new URL(FDC() + "/fdc/v1/foods/search"); url.searchParams.set("query", query); url.searchParams.set("pageSize", "5"); url.searchParams.set("dataType", "Foundation,SR Legacy,Survey (FNDDS)");
    const r = await fetch(url, { headers: { "X-Api-Key": process.env.FDC_API_KEY }, signal: AbortSignal.timeout(15000) }); if (r.status === 429) throw new HttpError(429, "provider_rate_limit"); if (!r.ok) throw new HttpError(502, "provider_error");
    const j = await r.json();
    const candidates = (j.foods || []).map((f) => { const per100 = { kcal: null, protein: null, carbs: null, fat: null, satfat: null, fiber: null, sugar: null, sodium: null };
      for (const n of f.foodNutrients || []) { const k = NUM[String(n.nutrientNumber)]; if (k && typeof n.value === "number" && (k !== "kcal" || n.unitName === "KCAL")) per100[k] = n.value; }
      return { source: "USDA FoodData Central", fdcId: f.fdcId, description: String(f.description || "").slice(0, 120), dataType: f.dataType, per100 }; });
    return { candidates, retrieved: new Date().toISOString().slice(0, 10) };
  });
};
module.exports = { A, configured: vision.configured };
