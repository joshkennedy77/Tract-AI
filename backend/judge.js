/**
 * Trak AEO judge: one OpenAI call per answer that returns structured JSON.
 * Fails open: on any error the caller gets a normalized "omitted" analysis
 * so the scan pipeline keeps going.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { OpenAI } = require("openai");
const { normalizeAeoAnalysis } = require("./aeo.js");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const JUDGE_MODEL = process.env.AEO_JUDGE_MODEL?.trim() || "gpt-4o-mini";

let cachedClient;
function getClient() {
  if (!OPENAI_API_KEY) return null;
  if (!cachedClient) cachedClient = new OpenAI({ apiKey: OPENAI_API_KEY });
  return cachedClient;
}

const SYSTEM_PROMPT = `You are an Answer Engine Optimization (AEO) judge.
You score one AI assistant response to a user prompt about a specific brand.

Return STRICT JSON only (no prose), matching this schema:
{
  "recommendation": "recommended" | "mentioned" | "negative" | "omitted",
  "position": integer 1..20 OR null,
  "mention_type": "primary" | "list_item" | "comparison" | "footnote" | "none",
  "accuracy_score": integer 0..100,
  "accuracy_flags": string[] (max 5 short notes; [] when none)
}

Definitions:
- recommendation: how the answer treats the brand.
  * "recommended" = explicitly recommends or endorses it
  * "mentioned"   = neutrally mentioned (named, described, listed) without endorsement
  * "negative"    = criticized, discouraged, or flagged as poor
  * "omitted"     = brand name does not appear in the answer at all
- position: rank if the brand is part of an ordered list (1 = first). null otherwise.
- mention_type:
  * "primary"     = the answer is principally about the brand
  * "list_item"   = one of several brands/options listed
  * "comparison"  = mentioned in a comparison or vs another brand
  * "footnote"    = brief aside or parenthetical
  * "none"        = not mentioned
- accuracy_score: 0–100, factual plausibility given the user's question. Penalize
  confident wrong claims; do not penalize hedging.
- accuracy_flags: short notes about suspicious claims.

Be concise and consistent. Only output the JSON object.`;

function buildUserPrompt({ brand, intent, engine, prompt, response, brandFacts }) {
  const safeResp = String(response ?? "").slice(0, 6000);
  const safePrompt = String(prompt ?? "").slice(0, 1200);
  const facts = String(brandFacts || "").trim().slice(0, 3000);
  const lines = [
    `Brand: ${brand}`,
    `Prompt intent: ${intent || "other"}`,
    `Engine that answered: ${engine}`,
    `User prompt: ${safePrompt}`,
  ];
  if (facts) {
    lines.push(
      "",
      "Verified brand facts (use these to score accuracy_score; flag contradictions):",
      facts
    );
  }
  lines.push(
    "Assistant response:",
    "```",
    safeResp,
    "```",
    "",
    "Return JSON only."
  );
  return lines.join("\n");
}

function isRetryable(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate") ||
    msg.includes("timeout") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("500")
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseJsonLoose(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  return null;
}

async function judgeOnce(client, payload) {
  const completion = await client.chat.completions.create({
    model: JUDGE_MODEL,
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: 350,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(payload) },
    ],
  });
  const text = completion.choices?.[0]?.message?.content ?? "";
  const parsed = parseJsonLoose(text);
  if (!parsed) throw new Error("AEO judge: unparseable JSON");
  return normalizeAeoAnalysis(parsed);
}

async function judge({
  brand,
  intent,
  engine,
  prompt,
  response,
  brandFacts,
}) {
  const fallback = normalizeAeoAnalysis(null);

  if (!String(response ?? "").trim()) {
    return {
      analysis: { ...fallback, accuracy_flags: ["empty response"] },
      error: null,
    };
  }

  const client = getClient();
  if (!client) {
    return { analysis: fallback, error: "OPENAI_API_KEY not set (AEO judge skipped)" };
  }

  const payload = { brand, intent, engine, prompt, response, brandFacts };
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const analysis = await judgeOnce(client, payload);
      return { analysis, error: null };
    } catch (err) {
      lastErr = err;
      if (attempt === 0 && isRetryable(err)) {
        await sleep(600 + Math.floor(Math.random() * 400));
        continue;
      }
      break;
    }
  }
  const msg = lastErr?.message || String(lastErr);
  console.error("AEO judge error:", msg);
  return { analysis: fallback, error: msg };
}

module.exports = { judge, JUDGE_MODEL };
