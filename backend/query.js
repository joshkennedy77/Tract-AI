const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { Anthropic } = require("@anthropic-ai/sdk");
const { OpenAI } = require("openai");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;

/** Default must be a model available to new Google AI Studio keys (2.0-flash 404s). */
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const GEMINI_GROUNDING =
  process.env.GEMINI_GROUNDING === "true" ||
  process.env.GEMINI_GROUNDING === "1";

let openaiClient;
function getOpenAIClient() {
  if (!OPENAI_API_KEY) return null;
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
  return openaiClient;
}

function getGeminiModelId() {
  const fromEnv = process.env.GEMINI_MODEL?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_GEMINI_MODEL;
}

/** Recreate model when GEMINI_MODEL env changes (avoids stale cache after code deploy). */
let geminiModelCached = null;
let geminiModelCachedId = null;

function getGeminiModel() {
  const key = GEMINI_API_KEY?.trim();
  if (!key) return null;

  const modelId = getGeminiModelId();
  if (!geminiModelCached || geminiModelCachedId !== modelId) {
    const genAI = new GoogleGenerativeAI(key);
    geminiModelCached = genAI.getGenerativeModel({
      model: modelId,
      generationConfig: { maxOutputTokens: 512 },
    });
    geminiModelCachedId = modelId;
    console.log(`Gemini: using model ${modelId}`);
  }
  return geminiModelCached;
}

function anthropicText(message) {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Normalize URLs / citation objects from various provider payloads. */
function normalizeSourceList(raw) {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    if (typeof item === "string") {
      const s = item.trim();
      if (s) out.push(s);
    } else if (item && typeof item === "object") {
      const u = String(item.url || item.uri || item.link || "").trim();
      if (u) out.push(u);
    }
  }
  return [...new Set(out)];
}

function extractGeminiSources(result) {
  const cand = result?.response?.candidates?.[0];
  const chunks = cand?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) return [];
  const urls = [];
  for (const ch of chunks) {
    const uri = ch?.web?.uri;
    if (uri) urls.push(String(uri));
  }
  return [...new Set(urls)];
}

function extractGeminiText(result) {
  const res = result?.response;
  if (!res) return null;

  if (typeof res.text === "function") {
    try {
      const t = res.text();
      if (t != null) {
        const s = String(t).trim();
        if (s) return s;
      }
    } catch {
      /* fall through to parts */
    }
  }

  const candidates = res.candidates;
  if (!Array.isArray(candidates)) return null;

  for (const cand of candidates) {
    const parts = cand?.content?.parts;
    if (!Array.isArray(parts)) continue;
    const chunks = [];
    for (const p of parts) {
      if (p && typeof p.text === "string" && p.text) chunks.push(p.text);
    }
    const joined = chunks.join("").trim();
    if (joined) return joined;
  }

  return null;
}

function geminiFail(message) {
  return { text: null, sources: [], error: message };
}

async function queryAnthropic(prompt) {
  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });
    return { text: anthropicText(message), sources: [] };
  } catch (err) {
    console.error("Anthropic API error:", err.message || err);
    return { text: null, sources: [] };
  }
}

async function queryOpenAI(prompt) {
  try {
    const openai = getOpenAIClient();
    if (!openai) {
      console.error("OpenAI API error: OPENAI_API_KEY is not set");
      return { text: null, sources: [] };
    }
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });
    const text = completion.choices[0]?.message?.content;
    if (text == null) {
      console.error("OpenAI API error: missing message content in response");
      return { text: null, sources: [] };
    }
    const annotations = completion.choices[0]?.message?.annotations;
    const fromAnn = [];
    if (Array.isArray(annotations)) {
      for (const a of annotations) {
        const u = a?.url_citation?.url || a?.url;
        if (u) fromAnn.push(String(u));
      }
    }
    const sources = [...new Set(fromAnn)];
    return { text, sources };
  } catch (err) {
    console.error("OpenAI API error:", err.message || err);
    return { text: null, sources: [] };
  }
}

async function queryGemini(prompt) {
  const userText = String(prompt ?? "");
  try {
    const model = getGeminiModel();
    if (!model) {
      const msg = "GEMINI_API_KEY is not set";
      console.error("Gemini API error:", msg);
      return geminiFail(msg);
    }

    let result;
    if (GEMINI_GROUNDING) {
      result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: userText }] }],
        tools: [{ googleSearchRetrieval: {} }],
      });
    } else {
      // Same as SDK docs: pass the prompt string directly (matches OpenAI user message).
      result = await model.generateContent(userText);
    }

    const text = extractGeminiText(result);
    const sources = extractGeminiSources(result);

    if (text == null) {
      const fr = result?.response?.candidates?.[0]?.finishReason;
      const msg =
        fr != null ? `empty response (finishReason: ${fr})` : "empty response";
      console.error("Gemini API error:", msg);
      return geminiFail(msg);
    }

    return { text, sources };
  } catch (err) {
    const msg = err.message || String(err);
    console.error("Gemini API error:", msg);
    return geminiFail(msg);
  }
}

async function queryPerplexity(prompt) {
  try {
    const { data } = await axios.post(
      "https://api.perplexity.ai/chat/completions",
      {
        model: "llama-3.1-sonar-small-128k-online",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 512,
      },
      {
        headers: {
          Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    const text = data.choices?.[0]?.message?.content;
    if (text == null) {
      console.error(
        "Perplexity API error: missing message content in response"
      );
      return { text: null, sources: [] };
    }
    const fromTop = normalizeSourceList(data.citations);
    const fromChoice = normalizeSourceList(
      data.choices?.[0]?.citations ?? data.choices?.[0]?.message?.citations
    );
    const fromSearch = normalizeSourceList(data.search_results);
    const sources = [...new Set([...fromTop, ...fromChoice, ...fromSearch])];
    return { text, sources };
  } catch (err) {
    const fromBody = err.response?.data;
    const detail = fromBody
      ? `${err.message} — ${JSON.stringify(fromBody)}`
      : err.message || String(err);
    console.error("Perplexity API error:", detail);
    return { text: null, sources: [] };
  }
}

module.exports = {
  queryAnthropic,
  queryOpenAI,
  queryGemini,
  queryPerplexity,
  getGeminiModelId,
  DEFAULT_GEMINI_MODEL,
};
