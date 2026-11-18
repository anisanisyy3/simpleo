"use strict";
/* Vision provider adapter. server/ai.js talks only to complete(); everything provider-specific lives here.
   Photos are sent in memory and never stored or logged. API keys are read from environment variables and never leave the server.

   VISION_PROVIDER=anthropic          (default)  uses ANTHROPIC_API_KEY (or VISION_API_KEY), model VISION_MODEL / SCAN_MODEL
   VISION_PROVIDER=gemini                        Google's native Gemini API. Needs VISION_API_KEY (or GEMINI_API_KEY) and VISION_MODEL.
   VISION_PROVIDER=openai-compatible             any server that speaks POST {VISION_BASE_URL}/chat/completions with image_url parts
                                                 (a self-hosted vision model, or another provider you have verified yourself).
                                                 Needs VISION_BASE_URL and VISION_MODEL; VISION_API_KEY is optional (self-hosted servers often have none). */
const { HttpError } = require("./core");

/* An HttpError that also carries a stable machine-readable code. The frontend translates the code; the message is the English fallback. */
class ScanError extends HttpError {
  constructor(status, code, message) { super(status, message || code); this.code = code; }
}

const DEFAULT_MODEL = "claude-haiku-5-5";
const timeoutMs = () => Math.min(120000, Math.max(500, parseInt(process.env.VISION_TIMEOUT_MS, 10) || 45000));
const maxTokens = (dflt) => Math.min(16000, Math.max(500, parseInt(process.env.VISION_MAX_TOKENS, 10) || dflt));   // "thinking" models spend part of this budget before answering
const trimSlash = (u) => String(u || "").trim().replace(/\/+$/, "");
const validUrl = (u) => { try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:"; } catch (e) { return false; } };

function config() {
  const provider = String(process.env.VISION_PROVIDER || "anthropic").trim().toLowerCase();
  if (provider === "anthropic") {
    const base = trimSlash(process.env.VISION_BASE_URL || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com");
    return { provider, key: process.env.ANTHROPIC_API_KEY || process.env.VISION_API_KEY || "", base, model: process.env.VISION_MODEL || process.env.SCAN_MODEL || DEFAULT_MODEL, ready: !!(process.env.ANTHROPIC_API_KEY || process.env.VISION_API_KEY) && validUrl(base) };
  }
  if (provider === "gemini") {   // Google's native Gemini API; accepts the newer "AQ." keys as well as "AIza" keys
    const base = trimSlash(process.env.VISION_BASE_URL || "https://generativelanguage.googleapis.com"), model = String(process.env.VISION_MODEL || "").trim().replace(/^models\//, "");
    const key = process.env.VISION_API_KEY || process.env.GEMINI_API_KEY || "";
    return { provider, key, base, model, ready: !!key && !!model && /^[A-Za-z0-9._-]+$/.test(model) && validUrl(base) };
  }
  if (provider === "openai-compatible") {
    const base = trimSlash(process.env.VISION_BASE_URL), model = String(process.env.VISION_MODEL || "").trim();
    return { provider, key: process.env.VISION_API_KEY || "", base, model, ready: validUrl(base) && !!model };
  }
  return { provider, key: "", base: "", model: "", ready: false, unknown: true };
}
const configured = () => config().ready;
const modelName = () => config().model || null;

/* One line at startup so a wrong variable name is visible in the Railway logs (never prints the key itself). */
function describe() {
  const c = config();
  if (c.unknown) return "[vision] VISION_PROVIDER=\"" + c.provider + "\" is not supported (use anthropic, gemini or openai-compatible). Photo analysis is OFF.";
  if (!c.ready) return "[vision] provider=" + c.provider + " is not fully configured. Photo analysis is OFF. See docs/RAILWAY.md.";
  return "[vision] provider=" + c.provider + " model=" + c.model + " timeout=" + timeoutMs() + "ms";
}

const clip = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").slice(0, 200);

/* Map a non-2xx provider answer to a precise error. The body is only used for a server-side log line, never sent to the browser. */
async function failFromResponse(r, c) {
  let detail = ""; try { detail = clip(await r.text()); } catch (e) { /* ignore */ }
  console.error("[vision] " + c.provider + " answered HTTP " + r.status + (detail ? ": " + detail : ""));
  if (r.status === 401 || r.status === 403 || /API_KEY_INVALID|API key not valid|API key expired|UNAUTHENTICATED|ACCESS_TOKEN_TYPE_UNSUPPORTED|PERMISSION_DENIED/i.test(detail)) throw new ScanError(502, "provider_auth", "The AI service rejected the site's credentials.");
  if (r.status === 404 || /unexpected model name|model name format|model.{0,40}(not found|is not supported)/i.test(detail)) throw new ScanError(502, "provider_model", "The configured AI model or endpoint was not found.");
  if (r.status === 429) throw new ScanError(503, "provider_rate_limit", "The AI service is busy or over its limit. Try again shortly.");
  if (r.status === 400 || r.status === 413 || r.status === 422) {
    if (/image|media|base64/i.test(detail)) throw new ScanError(422, "image_rejected", "The AI service could not process one of the images.");
    throw new ScanError(502, "provider_error", "The AI service rejected the request.");
  }
  throw new ScanError(502, "provider_error", "The AI service returned an error.");
}

async function post(url, headers, body, c) {
  let r;
  try { r = await fetch(url, { method: "POST", signal: AbortSignal.timeout(timeoutMs()), headers: Object.assign({ "content-type": "application/json" }, headers), body: JSON.stringify(body) }); }
  catch (e) {
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) throw new ScanError(504, "provider_timeout", "The AI service took too long to answer.");
    console.error("[vision] could not reach " + c.provider + ": " + clip(e && (e.cause && e.cause.code || e.message)));
    throw new ScanError(502, "provider_unreachable", "Could not reach the AI service.");
  }
  if (!r.ok) await failFromResponse(r, c);
  try { return await r.json(); }   // the timeout signal also covers reading the body
  catch (e) {
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) throw new ScanError(504, "provider_timeout", "The AI service took too long to answer.");
    throw new ScanError(502, "bad_response", "The AI service sent an unreadable answer.");
  }
}

async function anthropic(c, system, imgs, prompt) {
  const j = await post(c.base + "/v1/messages", { "x-api-key": c.key, "anthropic-version": "2023-06-01" },
    { model: c.model, max_tokens: maxTokens(2000), system, messages: [{ role: "user", content: [...imgs.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })), { type: "text", text: prompt }] }] }, c);
  if (j && j.type === "error") throw new ScanError(502, "provider_error", "The AI service returned an error.");
  const txt = (Array.isArray(j && j.content) ? j.content : []).map((x) => (x && typeof x.text === "string" ? x.text : "")).join("");
  return { text: txt, truncated: j && j.stop_reason === "max_tokens" };
}

async function gemini(c, system, imgs, prompt) {
  const j = await post(c.base + "/v1beta/models/" + encodeURIComponent(c.model) + ":generateContent", { "x-goog-api-key": c.key },
    { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }, ...imgs.map((i) => ({ inlineData: { mimeType: i.mime, data: i.data } }))] }],
      generationConfig: { maxOutputTokens: maxTokens(8000), responseMimeType: "application/json" } }, c);   // temperature left at Google's default: Gemini 3 models are documented to work best that way   // the limit also covers the model's own "thinking"
  const cand = j && Array.isArray(j.candidates) ? j.candidates[0] : null, parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
  const txt = parts.filter((x) => x && typeof x.text === "string" && !x.thought).map((x) => x.text).join("");
  if (!txt.trim() && j && j.promptFeedback && j.promptFeedback.blockReason) console.error("[vision] gemini blocked the request: " + clip(j.promptFeedback.blockReason));
  return { text: txt, truncated: !!cand && cand.finishReason === "MAX_TOKENS" };
}

async function openaiCompatible(c, system, imgs, prompt) {
  const headers = c.key ? { authorization: "Bearer " + c.key } : {};
  const j = await post(c.base + "/chat/completions", headers,
    { model: c.model, max_tokens: maxTokens(4000), temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: [{ type: "text", text: prompt }, ...imgs.map((i) => ({ type: "image_url", image_url: { url: "data:" + i.mime + ";base64," + i.data } }))] }] }, c);
  const ch = j && Array.isArray(j.choices) ? j.choices[0] : null, m = ch && ch.message ? ch.message.content : "";
  const txt = typeof m === "string" ? m : Array.isArray(m) ? m.map((x) => (x && typeof x.text === "string" ? x.text : "")).join("") : "";
  return { text: txt, truncated: !!ch && ch.finish_reason === "length" };
}

/* Parse the model's JSON answer. Empty text and unparseable text are different failures and are reported differently. */
function parseJson(res) {
  let t = String(res.text || "").trim();
  if (!t) throw new ScanError(502, "empty_response", "The AI service sent an empty answer.");
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new ScanError(502, "bad_response", "The AI service sent an answer that was not structured data.");
  try { const o = JSON.parse(t.slice(a, b + 1)); if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("not an object"); return o; }
  catch (e) { throw new ScanError(502, "bad_response", res.truncated ? "The AI answer was cut off." : "The AI service sent an answer that could not be read."); }
}

/* complete({system, images:[{mime,data}], prompt}) -> parsed JSON object. Throws ScanError only. */
async function complete(system, imgs, prompt) {
  const c = config();
  if (!c.ready) throw new ScanError(503, "not_configured", "Photo analysis is not configured on this server.");
  const res = c.provider === "anthropic" ? await anthropic(c, system, imgs, prompt) : c.provider === "gemini" ? await gemini(c, system, imgs, prompt) : await openaiCompatible(c, system, imgs, prompt);
  return parseJson(res);
}

module.exports = { ScanError, complete, configured, modelName, describe, config };
