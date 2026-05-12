require("dotenv").config();

const { Anthropic } = require("@anthropic-ai/sdk");
const { OpenAI } = require("openai");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const geminiModelName =
  process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash";
const geminiGenAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = geminiGenAI.getGenerativeModel({
  model: geminiModelName,
  generationConfig: { maxOutputTokens: 512 },
});

const GEMINI_GROUNDING =
  process.env.GEMINI_GROUNDING === "true" ||
  process.env.GEMINI_GROUNDING === "1";

let openaiClient;
function getOpenAIClient() {
  if (!OPENAI_API_KEY) return null;
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
  return openaiClient;
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
  try {
    const useGrounding = GEMINI_GROUNDING;
    const request = useGrounding
      ? {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          tools: [{ googleSearchRetrieval: {} }],
        }
      : prompt;

    const result = await geminiModel.generateContent(request);
    const text = result.response.text();
    const sources = extractGeminiSources(result);
    return { text, sources };
  } catch (err) {
    console.error("Gemini API error:", err.message || err);
    return { text: null, sources: [] };
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
};
