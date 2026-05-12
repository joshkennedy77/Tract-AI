const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

if (!process.env.SUPABASE_URL?.trim()) {
  console.warn("Tract API: SUPABASE_URL is missing from .env");
} else if (process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
  console.log(
    "Tract API: Supabase client will use service_role (RLS bypass on server — OK for path A)."
  );
} else if (process.env.SUPABASE_ANON_KEY?.trim()) {
  console.warn(
    "Tract API: SUPABASE_SERVICE_ROLE_KEY not set — using anon only. With RLS on, inserts often fail. Add service_role from Supabase → Project Settings → API."
  );
} else {
  console.warn("Tract API: No Supabase keys found in .env");
}

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");

const {
  getPrompts,
  getPromptTemplates,
  setPromptTemplates,
} = require("./prompts.js");
const {
  queryAnthropic,
  queryOpenAI,
  queryGemini,
  queryPerplexity,
} = require("./query.js");
const { analyzeResponse } = require("./analyze.js");
const { saveResult } = require("./save.js");
const supabase = require("./supabaseClient.js");

const ENGINE_FNS = {
  anthropic: { label: "Claude", fn: queryAnthropic },
  openai: { label: "OpenAI", fn: queryOpenAI },
  gemini: { label: "Gemini", fn: queryGemini },
  perplexity: { label: "Perplexity", fn: queryPerplexity },
};

/** Text from query.js `{ text }` objects or legacy plain strings. */
function engineResponseText(raw) {
  if (raw != null && typeof raw === "object" && "text" in raw) {
    return raw.text == null ? "" : String(raw.text);
  }
  return raw == null ? "" : String(raw);
}

/** Set `PERSIST_SCANS=true` in .env to write rows to Supabase. Default: off (dry run). */
const PERSIST_SCANS =
  process.env.PERSIST_SCANS === "true" || process.env.PERSIST_SCANS === "1";

/**
 * Brands to hide from dashboard stats and scan history (case-insensitive).
 * If STATS_IGNORE_BRANDS is unset, defaults to legacy demo names "apple" and "testbrand".
 * Set STATS_IGNORE_BRANDS= (empty) in .env to show every brand, or set a CSV to override.
 */
function ignoredBrandsSet() {
  const raw = process.env.STATS_IGNORE_BRANDS;
  const csv =
    raw === undefined ? "apple,testbrand" : String(raw);
  if (csv.trim() === "") return new Set();
  return new Set(
    csv
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function filterIgnoredBrands(rows) {
  const ignore = ignoredBrandsSet();
  if (ignore.size === 0) return rows;
  return rows.filter((row) => {
    const b = String(row.brand || "").trim().toLowerCase();
    return b && !ignore.has(b);
  });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "tract-api" });
});

app.get("/api/prompts", (req, res) => {
  const brand = String(req.query.brand || "").trim();
  if (!brand) {
    return res.status(400).json({ error: "Query parameter brand is required." });
  }
  res.json({ brand, prompts: getPrompts(brand) });
});

app.get("/api/prompt-templates", (_req, res) => {
  res.json({ templates: getPromptTemplates() });
});

app.put("/api/prompt-templates", (req, res) => {
  const result = setPromptTemplates(req.body?.templates);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  res.json({ ok: true, templates: getPromptTemplates() });
});

app.get("/api/scans", async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 40));
  const { data, error } = await supabase
    .from("scans")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("List scans error:", error.message);
    return res.status(500).json({ error: error.message });
  }
  res.json({ scans: filterIgnoredBrands(data || []) });
});

app.get("/api/stats", async (_req, res) => {
  const { data, error } = await supabase
    .from("scans")
    .select(
      "brand, sentiment, brand_mentioned, engine, scan_id, competitors_mentioned"
    );

  if (error) {
    console.error("Stats error:", error.message);
    return res.status(500).json({ error: error.message });
  }

  const rows = filterIgnoredBrands(data || []);
  let mentions = 0;
  const byBrand = {};
  const byEngine = {};
  const engineMention = {};
  const sentimentCounts = { positive: 0, negative: 0, neutral: 0 };
  const scanIds = new Set();
  const brandNames = new Set();
  let rowsWithCompetitors = 0;

  for (const row of rows) {
    if (row.brand_mentioned) mentions += 1;
    const b = row.brand || "(unknown)";
    byBrand[b] = (byBrand[b] || 0) + 1;
    if (row.brand && row.brand !== "(unknown)") brandNames.add(row.brand);

    const e = row.engine || "(unknown)";
    byEngine[e] = (byEngine[e] || 0) + 1;
    if (!engineMention[e]) {
      engineMention[e] = { total: 0, mentions: 0 };
    }
    engineMention[e].total += 1;
    if (row.brand_mentioned) engineMention[e].mentions += 1;

    const s = row.sentiment;
    if (s === "positive" || s === "negative" || s === "neutral") {
      sentimentCounts[s] += 1;
    }

    if (row.scan_id) scanIds.add(row.scan_id);

    const comp = row.competitors_mentioned;
    if (Array.isArray(comp) && comp.length > 0) rowsWithCompetitors += 1;
  }

  const engineMentionRates = Object.entries(engineMention)
    .map(([engine, { total, mentions: m }]) => ({
      engine,
      total,
      mentionRatePercent:
        total === 0 ? 0 : Math.round((m / total) * 100),
    }))
    .sort((a, b) => b.total - a.total);

  res.json({
    totalScans: rows.length,
    uniqueScanBatches: scanIds.size,
    uniqueBrandsTracked: brandNames.size,
    mentionRatePercent:
      rows.length === 0 ? 0 : Math.round((mentions / rows.length) * 100),
    competitorSignalPercent:
      rows.length === 0
        ? 0
        : Math.round((rowsWithCompetitors / rows.length) * 100),
    sentimentCounts,
    topBrands: Object.entries(byBrand)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([brand, count]) => ({ brand, count })),
    enginesUsed: Object.entries(byEngine)
      .sort((a, b) => b[1] - a[1])
      .map(([engine, count]) => ({ engine, count })),
    engineMentionRates,
  });
});

/** Up to 4 unique brands (case-insensitive dedupe, order preserved). */
function normalizeScanBrands(body) {
  const raw =
    Array.isArray(body?.brands) && body.brands.length > 0
      ? body.brands
      : body?.brand != null
        ? [body.brand]
        : [];
  const seen = new Set();
  const out = [];
  for (const x of raw) {
    const s = String(x || "").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 4) break;
  }
  return out;
}

app.post("/api/scan", async (req, res) => {
  const brandsList = normalizeScanBrands(req.body);
  if (brandsList.length === 0) {
    return res.status(400).json({
      error: "Provide at least one brand (brand or brands[]), up to 4 unique names.",
    });
  }

  let engines = req.body.engines;
  if (!Array.isArray(engines) || engines.length === 0) {
    engines = Object.keys(ENGINE_FNS);
  }
  engines = engines.filter((k) => Object.hasOwn(ENGINE_FNS, k));
  if (engines.length === 0) {
    return res.status(400).json({ error: "No valid engines selected." });
  }

  const comparisonId = crypto.randomUUID();
  const scanIds = [];
  const results = [];

  for (const brand of brandsList) {
    const prompts = getPrompts(brand);
    const scanRunId = crypto.randomUUID();
    scanIds.push(scanRunId);

    for (const prompt of prompts) {
      for (const key of engines) {
        const { label, fn } = ENGINE_FNS[key];
        const raw = await fn(prompt);
        const responseText = engineResponseText(raw);
        const analysis = analyzeResponse(brand, responseText);
        const responseFull = responseText || "(No response)";

        let save = { ok: true };
        if (PERSIST_SCANS) {
          save = await saveResult({
            scan_id: scanRunId,
            brand,
            engine: label,
            prompt,
            response: responseFull,
            brand_mentioned: analysis.brand_mentioned,
            sentiment: analysis.sentiment,
            competitors_mentioned: analysis.competitors_mentioned,
          });
        }

        results.push({
          brand,
          scan_id: scanRunId,
          comparison_id: comparisonId,
          engine: label,
          prompt,
          response: responseFull,
          ok: save.ok,
          persisted: PERSIST_SCANS,
          saveError: save.ok ? undefined : save.error,
          analysis,
          preview: responseText.slice(0, 320),
        });
      }
    }
  }

  const saved = PERSIST_SCANS ? results.filter((r) => r.ok).length : 0;
  const saveErrors = PERSIST_SCANS
    ? [
        ...new Set(
          results.filter((r) => !r.ok && r.saveError).map((r) => r.saveError)
        ),
      ].slice(0, 5)
    : [];

  res.json({
    brands: brandsList,
    brand: brandsList[0],
    comparison_id: comparisonId,
    scan_ids: scanIds,
    scan_id: scanIds[0],
    persisted: PERSIST_SCANS,
    engines: engines.map((k) => ENGINE_FNS[k].label),
    saved,
    total: results.length,
    saveErrors,
    results,
  });
});

const PORT = Number(process.env.PORT) || 3001;
const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`Tract API listening at http://127.0.0.1:${PORT}`);
  console.log(
    `Persist scans to Supabase: ${PERSIST_SCANS ? "ON" : "OFF"} (set PERSIST_SCANS=true to save rows)`
  );
  console.log(
    `Prompt templates: ${path.join(__dirname, "data", "prompt-templates.json")} (or GET/PUT /api/prompt-templates)`
  );
});

server.requestTimeout = 15 * 60 * 1000;
server.headersTimeout = 15 * 60 * 1000;
