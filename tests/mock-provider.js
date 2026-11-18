"use strict";
/* Stand-in for a vision provider, used only by tests/scan-e2e.py. Usage: node tests/mock-provider.js <port>
   Switch behaviour while running: GET /__mode/<ok|empty|prose|401|500|hang|none|meal-low>. Keys accepted: good-key. */
const http = require("node:http");
let mode = "ok", calls = 0, lastImages = 0;
const ING = { ingredients: [
  { name: "Tomatoes", category: "vegetable", confidence: "medium", count: 5, alternatives: ["cherry tomato"], image: 0 },
  { name: "tomato", category: "vegetable", confidence: "high", count: 6, alternatives: [], image: 1 },
  { name: "Red Onion", category: "vegetable", confidence: "high", count: 2, alternatives: ["shallot"], image: 1 },
  { name: "Za'atar leaf", category: "herb", confidence: "low", count: null, alternatives: [], image: 0 } ] };
const MEAL = { meal: { name: "Chicken and rice", cuisine: "Algerian", confidence: "medium", alternatives: ["Chicken pilaf", "Mandi"] }, description: "Pieces of roasted chicken on a bed of yellow rice with a few green herbs.",
  ingredients: ["chicken", "rice", "parsley"], components: [{ name: "roasted chicken", category: "meat", prep: "roasted", confidence: "high", hidden: false, image: 0 }, { name: "yellow rice", category: "grain", prep: "boiled", confidence: "high", hidden: true, image: 0 }], questions: ["Was the rice cooked in oil or butter?"] };
const out = (res, st, b) => { res.writeHead(st, { "content-type": "application/json" }); res.end(typeof b === "string" ? b : JSON.stringify(b)); };
http.createServer((req, res) => {
  const m = /^\/__mode\/([\w-]+)$/.exec(req.url); if (m) { mode = m[1]; return out(res, 200, { mode, calls, lastImages }); }
  const ch = []; req.on("data", (c) => ch.push(c)); req.on("end", () => {
    calls++; let b = {}; try { b = JSON.parse(Buffer.concat(ch).toString()); } catch (e) { /* ignore */ }
    lastImages = ((b.messages && b.messages[0] && b.messages[0].content) || []).filter((c) => c.type === "image").length;
    if (req.headers["x-api-key"] !== "good-key") return out(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    const meal = String(b.system || "").includes("prepared meal"), wrap = (t) => ({ type: "message", content: t === null ? [] : [{ type: "text", text: t }], stop_reason: "end_turn" });
    switch (mode) {
      case "ok": return out(res, 200, wrap(JSON.stringify(meal ? MEAL : ING)));
      case "meal-low": return out(res, 200, wrap(JSON.stringify(meal ? Object.assign({}, MEAL, { meal: Object.assign({}, MEAL.meal, { confidence: "low" }) }) : ING)));
      case "none": return out(res, 200, wrap(meal ? '{"meal":null,"description":"","ingredients":[],"components":[],"questions":[]}' : '{"ingredients":[]}'));
      case "empty": return out(res, 200, wrap(null));
      case "prose": return out(res, 200, wrap("Sorry, I cannot do that in JSON."));
      case "401": return out(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      case "500": return out(res, 500, { type: "error", error: { type: "api_error", message: "boom" } });
      case "hang": return;
      default: return out(res, 200, wrap("{}"));
    }
  });
}).listen(parseInt(process.argv[2], 10) || 4010, "127.0.0.1", () => console.log("mock provider ready"));
