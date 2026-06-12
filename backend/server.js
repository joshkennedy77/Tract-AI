const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

if (!process.env.SUPABASE_URL?.trim()) {
  console.warn("Trak API: SUPABASE_URL is missing from .env");
} else if (process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
  console.log(
    "Trak API: Supabase client will use service_role (RLS bypass on server — OK for path A)."
  );
} else if (process.env.SUPABASE_ANON_KEY?.trim()) {
  console.warn(
    "Trak API: SUPABASE_SERVICE_ROLE_KEY not set — using anon only. With RLS on, inserts often fail. Add service_role from Supabase → Project Settings → API."
  );
} else {
  console.warn("Trak API: No Supabase keys found in .env");
}

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");

const {
  getPrompts,
  getPromptsTagged,
  getPromptTemplates,
  setPromptTemplates,
} = require("./prompts.js");
const {
  queryAnthropic,
  queryOpenAI,
  queryGemini,
  queryPerplexity,
  getGeminiModelId,
} = require("./query.js");
const { analyzeResponse } = require("./analyze.js");
const { saveResult } = require("./save.js");
const supabase = require("./supabaseClient.js");
const { judge: aeoJudge } = require("./judge.js");
const { computeAeoScore } = require("./aeo.js");
const { analyzeGeo } = require("./geo.js");
const {
  getProfilesForCompany,
  resolveProfilesForBrands,
  upsertProfilesForCompany,
} = require("./brandProfiles.js");
const {
  requireUser,
  requireCompany,
  requireCompanyAdmin,
  requireTractStaff,
} = require("./middleware/auth.js");
const { generateRecommendations } = require("./recommendations.js");

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

/** URL / citation list from query.js `{ sources }` (Perplexity, Gemini grounding, OpenAI annotations, etc.). */
function engineSources(raw) {
  if (raw != null && typeof raw === "object" && Array.isArray(raw.sources)) {
    return raw.sources
      .map((s) => String(s == null ? "" : s).trim())
      .filter(Boolean);
  }
  return [];
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

/** Comma-separated production origins, e.g. https://your-app.vercel.app */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    if (hostname === "localhost" || hostname === "127.0.0.1") return true;
    if (hostname.endsWith(".vercel.app")) return true;
  } catch {
    return false;
  }
  return false;
}

const app = express();
app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedCorsOrigin(origin)) return callback(null, true);
      callback(null, false);
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "trak-api" });
});

app.get("/api/auth/me", requireUser, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      company_id: req.user.company_id,
      company_role: req.user.company_role,
      tract_role: req.user.tract_role,
    },
  });
});

app.get("/api/prompts", requireUser, (req, res) => {
  const brand = String(req.query.brand || "").trim();
  if (!brand) {
    return res.status(400).json({ error: "Query parameter brand is required." });
  }
  res.json({ brand, prompts: getPrompts(brand) });
});

app.get("/api/prompt-templates", requireUser, (_req, res) => {
  res.json({ templates: getPromptTemplates() });
});

app.put("/api/prompt-templates", requireUser, (req, res) => {
  const result = setPromptTemplates(req.body?.templates);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  res.json({ ok: true, templates: getPromptTemplates() });
});

app.get("/api/scans", requireUser, requireCompany, async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 40));
  const { data, error } = await supabase
    .from("scans")
    .select("*")
    .eq("company_id", req.user.company_id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("List scans error:", error.message);
    return res.status(500).json({ error: error.message });
  }
  res.json({ scans: filterIgnoredBrands(data || []) });
});

// AEO/GEO aggregation helpers (also mirrored client-side for session-only
// audits). Average / breakdown logic lives in one place so /api/stats and
// statsFromAudit() return identical shapes.

function avgRounded(nums) {
  const arr = nums.filter((n) => Number.isFinite(n));
  if (arr.length === 0) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function buildAeoStatsForGroup(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      n: 0,
      judged: 0,
      score: null,
      mix: { recommended: 0, mentioned: 0, negative: 0, omitted: 0 },
      avgAccuracy: null,
      byEngine: [],
      byIntent: [],
      trend: [],
    };
  }
  const scores = [];
  const accs = [];
  const mix = { recommended: 0, mentioned: 0, negative: 0, omitted: 0 };
  let judged = 0;
  const byEngineMap = new Map();
  const byIntentMap = new Map();
  const dayMap = new Map();
  for (const r of rows) {
    const a = r.aeo_analysis || {};
    const s = r.aeo_score;
    const hasAeo = a && Object.keys(a).length > 0;
    if (hasAeo) judged += 1;
    const rec = String(a.recommendation || "omitted").toLowerCase();
    if (mix[rec] != null) mix[rec] += 1;
    if (Number.isFinite(s)) scores.push(Number(s));
    if (Number.isFinite(Number(a.accuracy_score))) accs.push(Number(a.accuracy_score));

    const eng = r.engine || "(unknown)";
    if (!byEngineMap.has(eng)) byEngineMap.set(eng, []);
    if (Number.isFinite(s)) byEngineMap.get(eng).push(Number(s));

    const it = r.intent || "other";
    if (!byIntentMap.has(it)) byIntentMap.set(it, []);
    if (Number.isFinite(s)) byIntentMap.get(it).push(Number(s));

    const day =
      r.created_at && typeof r.created_at === "string"
        ? r.created_at.slice(0, 10)
        : null;
    if (day) {
      if (!dayMap.has(day)) dayMap.set(day, []);
      if (Number.isFinite(s)) dayMap.get(day).push(Number(s));
    }
  }
  const byEngine = [...byEngineMap.entries()]
    .map(([engine, arr]) => ({ engine, n: arr.length, score: avgRounded(arr) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const byIntent = [...byIntentMap.entries()]
    .map(([intent, arr]) => ({ intent, n: arr.length, score: avgRounded(arr) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const trend = [...dayMap.entries()]
    .map(([day, arr]) => ({ day, n: arr.length, score: avgRounded(arr) }))
    .sort((a, b) => a.day.localeCompare(b.day));
  return {
    n: rows.length,
    judged,
    score: avgRounded(scores),
    mix,
    avgAccuracy: avgRounded(accs),
    byEngine,
    byIntent,
    trend,
  };
}

function buildGeoStatsForGroup(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      n: 0,
      scored: 0,
      score: null,
      ownDomainRate: 0,
      anyCitationRate: 0,
      avgAuthority: null,
      byEngine: [],
      byIntent: [],
      trend: [],
    };
  }
  const scores = [];
  const auths = [];
  let scored = 0;
  let ownN = 0;
  let anyN = 0;
  const byEngineMap = new Map();
  const byIntentMap = new Map();
  const dayMap = new Map();
  for (const r of rows) {
    const a = r.geo_analysis || {};
    const s = r.geo_score;
    if (Number.isFinite(s)) {
      scores.push(Number(s));
      scored += 1;
    }
    if (a.own_domain_cited) ownN += 1;
    if ((a.citation_count || 0) > 0) anyN += 1;
    if (Number.isFinite(Number(a.avg_authority))) auths.push(Number(a.avg_authority));

    const eng = r.engine || "(unknown)";
    if (!byEngineMap.has(eng)) byEngineMap.set(eng, []);
    if (Number.isFinite(s)) byEngineMap.get(eng).push(Number(s));

    const it = r.intent || "other";
    if (!byIntentMap.has(it)) byIntentMap.set(it, []);
    if (Number.isFinite(s)) byIntentMap.get(it).push(Number(s));

    const day =
      r.created_at && typeof r.created_at === "string"
        ? r.created_at.slice(0, 10)
        : null;
    if (day) {
      if (!dayMap.has(day)) dayMap.set(day, []);
      if (Number.isFinite(s)) dayMap.get(day).push(Number(s));
    }
  }
  const byEngine = [...byEngineMap.entries()]
    .map(([engine, arr]) => ({ engine, n: arr.length, score: avgRounded(arr) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const byIntent = [...byIntentMap.entries()]
    .map(([intent, arr]) => ({ intent, n: arr.length, score: avgRounded(arr) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const trend = [...dayMap.entries()]
    .map(([day, arr]) => ({ day, n: arr.length, score: avgRounded(arr) }))
    .sort((a, b) => a.day.localeCompare(b.day));
  return {
    n: rows.length,
    scored,
    score: avgRounded(scores),
    ownDomainRate: rows.length === 0 ? 0 : Math.round((ownN / rows.length) * 100),
    anyCitationRate: rows.length === 0 ? 0 : Math.round((anyN / rows.length) * 100),
    avgAuthority: avgRounded(auths),
    byEngine,
    byIntent,
    trend,
  };
}

function computeTrakScore(aeoScore, geoScore) {
  const aeoOk = Number.isFinite(Number(aeoScore));
  const geoOk = Number.isFinite(Number(geoScore));
  if (!aeoOk && !geoOk) return null;
  if (aeoOk && !geoOk) return Math.round(Number(aeoScore));
  if (!aeoOk && geoOk) return Math.round(Number(geoScore));
  return Math.round(Number(aeoScore) * 0.55 + Number(geoScore) * 0.45);
}

function aggregatePerBrand(rows, builder) {
  const byBrand = new Map();
  for (const r of rows) {
    const b = String(r.brand || "(unknown)");
    if (!byBrand.has(b)) byBrand.set(b, []);
    byBrand.get(b).push(r);
  }
  const out = {};
  for (const [brand, group] of byBrand.entries()) {
    out[brand] = builder(group);
  }
  return out;
}

app.get("/api/stats", requireUser, requireCompany, async (req, res) => {
  const { data, error } = await supabase
    .from("scans")
    .select(
      "brand, sentiment, brand_mentioned, engine, scan_id, competitors_mentioned, source_count, intent, aeo_score, aeo_analysis, geo_score, geo_analysis, created_at"
    )
    .eq("company_id", req.user.company_id);

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
  let totalSourcesCited = 0;
  let sourcesWhenBrandMentioned = 0;
  const engineSources = {};

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

    const sc =
      row.source_count != null && row.source_count !== ""
        ? Number(row.source_count)
        : NaN;
    const srcN = Number.isFinite(sc) && sc >= 0 ? sc : 0;
    totalSourcesCited += srcN;
    if (row.brand_mentioned) sourcesWhenBrandMentioned += srcN;

    if (!engineSources[e]) {
      engineSources[e] = {
        answers: 0,
        totalSources: 0,
        sourcesWhenMentioned: 0,
        mentionRows: 0,
      };
    }
    engineSources[e].answers += 1;
    engineSources[e].totalSources += srcN;
    if (row.brand_mentioned) {
      engineSources[e].mentionRows += 1;
      engineSources[e].sourcesWhenMentioned += srcN;
    }

    const comp = row.competitors_mentioned;
    if (Array.isArray(comp) && comp.length > 0) rowsWithCompetitors += 1;
  }

  const perBrandStats = {};
  const brandsOrder = [];
  const brandsOrderSeen = new Set();
  for (const row of rows) {
    const raw = String(row.brand || "").trim();
    if (raw) {
      const k = raw.toLowerCase();
      if (!brandsOrderSeen.has(k)) {
        brandsOrderSeen.add(k);
        brandsOrder.push(raw);
      }
    }
    const b = raw || "(unknown)";
    if (!perBrandStats[b]) perBrandStats[b] = { total: 0, mentions: 0 };
    perBrandStats[b].total += 1;
    if (row.brand_mentioned) perBrandStats[b].mentions += 1;
  }
  const brandComparison = brandsOrder
    .concat(
      Object.keys(perBrandStats).filter(
        (b) => !brandsOrder.some((x) => x.toLowerCase() === b.toLowerCase())
      )
    )
    .map((brand) => {
      const pb = perBrandStats[brand] || { total: 0, mentions: 0 };
      return {
        brand,
        count: pb.total,
        mentionRatePercent:
          pb.total === 0 ? 0 : Math.round((pb.mentions / pb.total) * 100),
      };
    });

  const engineMentionRates = Object.entries(engineMention)
    .map(([engine, { total, mentions: m }]) => ({
      engine,
      total,
      mentionRatePercent:
        total === 0 ? 0 : Math.round((m / total) * 100),
    }))
    .sort((a, b) => b.total - a.total);

  const sourcesByEngine = Object.entries(engineSources)
    .map(([engine, es]) => ({
      engine,
      answers: es.answers,
      totalSources: es.totalSources,
      sourcesWhenMentioned: es.sourcesWhenMentioned,
      mentionRows: es.mentionRows,
      avgSourcesPerAnswer:
        es.answers === 0
          ? 0
          : Math.round((es.totalSources / es.answers) * 10) / 10,
      avgSourcesWhenMentioned:
        es.mentionRows === 0
          ? 0
          : Math.round((es.sourcesWhenMentioned / es.mentionRows) * 10) / 10,
    }))
    .sort((a, b) => b.totalSources - a.totalSources);

  const aeoOverall = buildAeoStatsForGroup(rows);
  const aeoPerBrand = aggregatePerBrand(rows, buildAeoStatsForGroup);
  const geoOverall = buildGeoStatsForGroup(rows);
  const geoPerBrand = aggregatePerBrand(rows, buildGeoStatsForGroup);
  const trakOverall = computeTrakScore(aeoOverall.score, geoOverall.score);
  const trakPerBrand = {};
  for (const brand of Object.keys(aeoPerBrand)) {
    trakPerBrand[brand] = computeTrakScore(
      aeoPerBrand[brand]?.score,
      geoPerBrand[brand]?.score
    );
  }

  res.json({
    totalScans: rows.length,
    uniqueScanBatches: scanIds.size,
    uniqueBrandsTracked: brandNames.size,
    rowsBrandMentioned: mentions,
    totalSourcesCited,
    sourcesWhenBrandMentioned,
    avgSourcesPerAnswer:
      rows.length === 0
        ? 0
        : Math.round((totalSourcesCited / rows.length) * 10) / 10,
    mentionRatePercent:
      rows.length === 0 ? 0 : Math.round((mentions / rows.length) * 100),
    competitorSignalPercent:
      rows.length === 0
        ? 0
        : Math.round((rowsWithCompetitors / rows.length) * 100),
    sentimentCounts,
    topBrands: brandComparison
      .slice()
      .sort((a, b) => b.mentionRatePercent - a.mentionRatePercent)
      .slice(0, 5)
      .map((x) => ({
        brand: x.brand,
        count: x.count,
        mentionRatePercent: x.mentionRatePercent,
      })),
    brandsOrder,
    enginesUsed: Object.entries(byEngine)
      .sort((a, b) => b[1] - a[1])
      .map(([engine, count]) => ({ engine, count })),
    engineMentionRates,
    brandComparison,
    sourcesByEngine,
    aeo: { overall: aeoOverall, byBrand: aeoPerBrand },
    geo: { overall: geoOverall, byBrand: geoPerBrand },
    trakScore: { overall: trakOverall, byBrand: trakPerBrand },
  });
});

function pickPrimaryBrand(brandsOrder, queryBrand) {
  const q = String(queryBrand || "").trim();
  if (q) return q;
  const order = Array.isArray(brandsOrder) ? brandsOrder : [];
  return order[0] || "";
}

function sessionResultsToScoreRows(results, brandsOrder, at) {
  const iso = at ? new Date(at).toISOString() : new Date().toISOString();
  return (results || []).map((r) => ({
    brand: r.brand,
    engine: r.engine,
    intent: r.intent || "other",
    aeo_score: r.aeo_score,
    aeo_analysis: r.aeo_analysis || {},
    geo_score: r.geo_score,
    geo_analysis: r.geo_analysis || {},
    created_at: iso,
  }));
}

function buildRecommendationsPayload(rows, brand, profile, aeoPerBrand, geoPerBrand, trakPerBrand) {
  const brandKey = Object.keys(aeoPerBrand).find(
    (b) => b.toLowerCase() === brand.toLowerCase()
  ) || brand;
  const brandRows = rows.filter(
    (r) => String(r.brand || "").toLowerCase() === brand.toLowerCase()
  );
  const aeo = aeoPerBrand[brandKey] || aeoPerBrand[brand] || {};
  const geo = geoPerBrand[brandKey] || geoPerBrand[brand] || {};
  const trakScore = trakPerBrand[brandKey] ?? trakPerBrand[brand] ?? null;

  const competitorInsights = [];
  for (const comp of Object.keys(aeoPerBrand)) {
    if (comp.toLowerCase() === brand.toLowerCase()) continue;
    const ca = aeoPerBrand[comp]?.score;
    const cg = geoPerBrand[comp]?.score;
    const myAeo = aeo.score;
    const myGeo = geo.score;
    if (Number.isFinite(ca) && Number.isFinite(myAeo) && ca - myAeo >= 15) {
      competitorInsights.push({
        competitor: comp,
        metric: "AEO",
        theirs: ca,
        yours: myAeo,
      });
    }
    if (Number.isFinite(cg) && Number.isFinite(myGeo) && cg - myGeo >= 15) {
      competitorInsights.push({
        competitor: comp,
        metric: "GEO",
        theirs: cg,
        yours: myGeo,
      });
    }
  }

  const recommendations = generateRecommendations({
    brand,
    rows: brandRows,
    profile,
    aeo,
    geo,
    trakScore,
    competitorInsights,
  });

  return {
    brand,
    trakScore,
    aeo: { score: aeo.score ?? null, judged: aeo.judged ?? 0, mix: aeo.mix },
    geo: {
      score: geo.score ?? null,
      ownDomainRate: geo.ownDomainRate ?? 0,
      anyCitationRate: geo.anyCitationRate ?? 0,
      avgAuthority: geo.avgAuthority ?? null,
    },
    recommendations,
  };
}

app.post("/api/recommendations", requireUser, requireCompany, async (req, res) => {
  try {
    const body = req.body || {};
    const brandsOrder = Array.isArray(body.brands) && body.brands.length
      ? body.brands.map((b) => String(b || "").trim()).filter(Boolean)
      : body.brand
        ? [String(body.brand).trim()]
        : [];

    if (Array.isArray(body.results) && body.results.length > 0) {
      const brand = pickPrimaryBrand(brandsOrder, body.brand || req.query?.brand);
      if (!brand) {
        return res.json({
          brand: null,
          recommendations: [],
          message: "No brand specified.",
        });
      }
      const rows = sessionResultsToScoreRows(body.results, brandsOrder, body.at);
      const aeoPerBrand = aggregatePerBrand(rows, buildAeoStatsForGroup);
      const geoPerBrand = aggregatePerBrand(rows, buildGeoStatsForGroup);
      const trakPerBrand = {};
      for (const b of Object.keys(aeoPerBrand)) {
        trakPerBrand[b] = computeTrakScore(
          aeoPerBrand[b]?.score,
          geoPerBrand[b]?.score
        );
      }
      let profile = { domains: [], facts: "" };
      try {
        const profiles = await getProfilesForCompany(req.user.company_id);
        const hit = profiles?.get?.(brand.toLowerCase());
        if (hit) {
          profile = {
            domains: Array.isArray(hit.domains) ? hit.domains : [],
            facts: String(hit.facts || ""),
          };
        }
      } catch (_) {
        /* brand_profiles table optional */
      }
      return res.json(
        buildRecommendationsPayload(
          rows,
          brand,
          profile,
          aeoPerBrand,
          geoPerBrand,
          trakPerBrand
        )
      );
    }

    const { data, error } = await supabase
      .from("scans")
      .select(
        "brand, engine, intent, aeo_score, aeo_analysis, geo_score, geo_analysis, created_at"
      )
      .eq("company_id", req.user.company_id);

    if (error) {
      console.error("Recommendations error:", error.message);
      return res.status(500).json({ error: error.message });
    }

    const rows = filterIgnoredBrands(data || []);
    const order = [];
    const seen = new Set();
    for (const row of rows) {
      const b = String(row.brand || "").trim();
      if (!b) continue;
      const k = b.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        order.push(b);
      }
    }

    const brand = pickPrimaryBrand(order, req.query?.brand || body.brand);
    if (!brand) {
      return res.json({
        brand: null,
        recommendations: [],
        message: "Run an audit with Brand 1 filled in, then return here.",
      });
    }

    const aeoPerBrand = aggregatePerBrand(rows, buildAeoStatsForGroup);
    const geoPerBrand = aggregatePerBrand(rows, buildGeoStatsForGroup);
    const trakPerBrand = {};
    for (const b of Object.keys(aeoPerBrand)) {
      trakPerBrand[b] = computeTrakScore(
        aeoPerBrand[b]?.score,
        geoPerBrand[b]?.score
      );
    }

    let profile = { domains: [], facts: "" };
    try {
      const profiles = await getProfilesForCompany(req.user.company_id);
      const hit = profiles?.get?.(brand.toLowerCase());
      if (hit) {
        profile = {
          domains: Array.isArray(hit.domains) ? hit.domains : [],
          facts: String(hit.facts || ""),
        };
      }
    } catch (_) {
      /* brand_profiles table optional */
    }

    res.json(
      buildRecommendationsPayload(
        rows,
        brand,
        profile,
        aeoPerBrand,
        geoPerBrand,
        trakPerBrand
      )
    );
  } catch (e) {
    console.error("Recommendations:", e);
    res.status(500).json({ error: e.message || "Recommendations failed" });
  }
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

app.post("/api/scan", requireUser, requireCompany, async (req, res) => {
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

  // Brand profiles: persisted facts + domains, optionally overridden by request.
  const dbProfiles = await getProfilesForCompany(req.user.company_id);
  const profiles = resolveProfilesForBrands(
    brandsList,
    dbProfiles,
    req.body?.brandProfiles
  );

  for (const brand of brandsList) {
    const profile = profiles.get(String(brand).toLowerCase()) || {
      domains: [],
      facts: "",
    };
    const prompts = getPromptsTagged(brand);
    const scanRunId = crypto.randomUUID();
    scanIds.push(scanRunId);

    for (const { text: prompt, intent } of prompts) {
      // Engines run concurrently per prompt — they're independent third-party
      // calls. Promise.all preserves input order so the results array stays
      // deterministic (brand → prompt → engine).
      const perEngine = await Promise.all(
        engines.map(async (key) => {
          const { label, fn } = ENGINE_FNS[key];
          const raw = await fn(prompt);
          const responseText = engineResponseText(raw);
          const engineError =
            raw != null && typeof raw === "object" && raw.error
              ? String(raw.error)
              : undefined;
          const sources = engineSources(raw);
          const source_count = sources.length;
          const analysis = analyzeResponse(brand, responseText);
          const responseFull = responseText
            ? responseText
            : engineError
              ? `[${label} error] ${engineError.slice(0, 400)}`
              : "(No response)";

          // AEO judge: only run when we got a real answer (saves cost on
          // engine errors). Pass verified brand facts so accuracy_score can
          // ground in them rather than the model's own priors.
          let aeoAnalysis = null;
          let aeoScore = null;
          let aeoError = null;
          if (responseText && responseText.trim()) {
            const judged = await aeoJudge({
              brand,
              intent,
              engine: label,
              prompt,
              response: responseText,
              brandFacts: profile.facts,
            });
            aeoAnalysis = judged.analysis;
            aeoError = judged.error;
            aeoScore = computeAeoScore(aeoAnalysis);
          }

          // GEO: cheap, deterministic — always run (uses engine sources +
          // AEO recommendation signal when available).
          const geo = analyzeGeo({
            sources,
            brandDomains: profile.domains,
            brandMentioned: analysis.brand_mentioned,
            aeoAnalysis,
          });
          const geoAnalysis = geo.analysis;
          const geoScore = geo.score;

          let save = { ok: true };
          if (PERSIST_SCANS) {
            save = await saveResult({
              scan_id: scanRunId,
              comparison_id: comparisonId,
              company_id: req.user.company_id,
              created_by: req.user.id,
              brand,
              engine: label,
              prompt,
              response: responseFull,
              brand_mentioned: analysis.brand_mentioned,
              sentiment: analysis.sentiment,
              competitors_mentioned: analysis.competitors_mentioned,
              sources,
              source_count,
              intent,
              aeo_analysis: aeoAnalysis,
              aeo_score: aeoScore,
              aeo_error: aeoError,
              geo_analysis: geoAnalysis,
              geo_score: geoScore,
            });
          }

          return {
            brand,
            scan_id: scanRunId,
            comparison_id: comparisonId,
            engine: label,
            prompt,
            intent,
            response: responseFull,
            source_count,
            sources,
            ok: save.ok,
            persisted: PERSIST_SCANS,
            saveError: save.ok ? undefined : save.error,
            engineError,
            analysis,
            aeo_analysis: aeoAnalysis,
            aeo_score: aeoScore,
            aeo_error: aeoError,
            geo_analysis: geoAnalysis,
            geo_score: geoScore,
            preview: (responseText || responseFull).slice(0, 320),
          };
        })
      );
      results.push(...perEngine);
    }
  }

  // Persist any new brand profile data the user typed in the form (only when
  // scans are also being persisted — keeps dry-run mode side-effect free).
  if (PERSIST_SCANS) {
    await upsertProfilesForCompany(req.user.company_id, req.user.id, profiles);
  }

  const saved = PERSIST_SCANS ? results.filter((r) => r.ok).length : 0;
  const saveErrors = PERSIST_SCANS
    ? [
        ...new Set(
          results.filter((r) => !r.ok && r.saveError).map((r) => r.saveError)
        ),
      ].slice(0, 5)
    : [];

  const engineErrors = [
    ...new Set(
      results
        .filter((r) => r.engineError)
        .map((r) => `${r.engine}: ${r.engineError}`)
    ),
  ].slice(0, 5);

  const judged = results.filter((r) => r.aeo_analysis).length;
  const geoScored = results.filter((r) => r.geo_score != null).length;

  const brandProfilesPayload = [...profiles.values()].map((p) => ({
    brand: p.brand,
    domains: p.domains,
    facts: p.facts,
  }));

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
    judged,
    geoScored,
    saveErrors,
    engineErrors,
    brandProfiles: brandProfilesPayload,
    results,
  });
});

// ---------------------------------------------------------------------------
// Brand profiles (domains + verified facts) — GET/PUT
// ---------------------------------------------------------------------------

app.get(
  "/api/brand-profiles",
  requireUser,
  requireCompany,
  async (req, res) => {
    const profiles = await getProfilesForCompany(req.user.company_id);
    const payload = [...profiles.values()].map((p) => ({
      brand: p.brand,
      domains: Array.isArray(p.domains) ? p.domains : [],
      facts: String(p.facts || ""),
    }));
    res.json({ brandProfiles: payload });
  }
);

app.put(
  "/api/brand-profiles",
  requireUser,
  requireCompany,
  async (req, res) => {
    const incoming = Array.isArray(req.body?.brandProfiles)
      ? req.body.brandProfiles
      : [];
    const brands = incoming
      .map((p) => String(p?.brand || "").trim())
      .filter(Boolean);
    if (brands.length === 0) {
      return res.status(400).json({ error: "brandProfiles[] is required" });
    }
    const dbProfiles = await getProfilesForCompany(req.user.company_id);
    const merged = resolveProfilesForBrands(brands, dbProfiles, incoming);
    const out = await upsertProfilesForCompany(
      req.user.company_id,
      req.user.id,
      merged
    );
    if (!out.ok) return res.status(500).json({ error: out.error });
    const refreshed = await getProfilesForCompany(req.user.company_id);
    res.json({
      written: out.written,
      brandProfiles: [...refreshed.values()],
    });
  }
);

// ---------------------------------------------------------------------------
// Company-admin: Team management (PR-2)
// ---------------------------------------------------------------------------

app.get(
  "/api/company/members",
  requireUser,
  requireCompanyAdmin,
  async (req, res) => {
    const { data, error } = await supabase.rpc("company_member_emails", {
      p_company_id: req.user.company_id,
    });
    if (error) {
      console.error("List members error:", error.message);
      return res.status(500).json({ error: error.message });
    }
    res.json({ members: data || [] });
  }
);

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

app.post(
  "/api/company/employees",
  requireUser,
  requireCompanyAdmin,
  async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "Valid email required." });
    }

    // 1. Try the invite path (creates new auth.users row + sends invite email).
    let userId = null;
    let invitedFresh = false;
    const inviteRes = await supabase.auth.admin.inviteUserByEmail(email, {
      data: { company_id: req.user.company_id, invited_by: req.user.id },
    });

    if (!inviteRes.error) {
      userId = inviteRes.data?.user?.id || null;
      invitedFresh = true;
    } else {
      const msg = (inviteRes.error.message || "").toLowerCase();
      const alreadyRegistered =
        msg.includes("already") ||
        inviteRes.error.code === "email_exists" ||
        inviteRes.error.status === 422;
      if (!alreadyRegistered) {
        console.error("Invite error:", inviteRes.error.message);
        return res.status(500).json({ error: inviteRes.error.message });
      }
      const { data: existing, error: lookupErr } = await supabase.rpc(
        "find_user_by_email",
        { p_email: email }
      );
      if (lookupErr) {
        return res.status(500).json({ error: lookupErr.message });
      }
      userId = existing?.[0]?.id || null;
      if (!userId) {
        return res
          .status(500)
          .json({ error: "Email is registered but user lookup failed." });
      }
    }

    // 2. Refuse duplicate membership in this company.
    const { data: existingMember } = await supabase
      .from("company_members")
      .select("id")
      .eq("company_id", req.user.company_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (existingMember) {
      return res
        .status(409)
        .json({ error: "Already a member of this company." });
    }

    const { data: member, error: insertErr } = await supabase
      .from("company_members")
      .insert({
        company_id: req.user.company_id,
        user_id: userId,
        role: "employee",
        invited_by: req.user.id,
      })
      .select("id, user_id, role, joined_at, invited_by")
      .single();
    if (insertErr) {
      return res.status(500).json({ error: insertErr.message });
    }

    res.json({
      member: { ...member, email },
      invitedFresh,
    });
  }
);

app.patch(
  "/api/company/members/:id",
  requireUser,
  requireCompanyAdmin,
  async (req, res) => {
    const memberId = String(req.params.id || "");
    const newRole = String(req.body?.role || "");
    if (!["admin", "employee"].includes(newRole)) {
      return res
        .status(400)
        .json({ error: "Role must be 'admin' or 'employee'." });
    }

    const { data: target, error: lookupErr } = await supabase
      .from("company_members")
      .select("id, user_id, role, company_id")
      .eq("id", memberId)
      .maybeSingle();
    if (lookupErr) return res.status(500).json({ error: lookupErr.message });
    if (!target || target.company_id !== req.user.company_id) {
      return res.status(404).json({ error: "Member not found." });
    }

    if (target.role === "admin" && newRole !== "admin") {
      const { count } = await supabase
        .from("company_members")
        .select("id", { count: "exact", head: true })
        .eq("company_id", req.user.company_id)
        .eq("role", "admin");
      if ((count || 0) <= 1) {
        return res
          .status(400)
          .json({ error: "Cannot demote the last admin." });
      }
    }

    const { data: updated, error: updateErr } = await supabase
      .from("company_members")
      .update({ role: newRole })
      .eq("id", memberId)
      .select("id, user_id, role")
      .single();
    if (updateErr) return res.status(500).json({ error: updateErr.message });
    res.json({ member: updated });
  }
);

app.delete(
  "/api/company/members/:id",
  requireUser,
  requireCompanyAdmin,
  async (req, res) => {
    const memberId = String(req.params.id || "");
    const { data: target, error: lookupErr } = await supabase
      .from("company_members")
      .select("id, user_id, role, company_id")
      .eq("id", memberId)
      .maybeSingle();
    if (lookupErr) return res.status(500).json({ error: lookupErr.message });
    if (!target || target.company_id !== req.user.company_id) {
      return res.status(404).json({ error: "Member not found." });
    }
    if (target.user_id === req.user.id) {
      return res.status(400).json({ error: "Cannot remove yourself." });
    }
    if (target.role === "admin") {
      const { count } = await supabase
        .from("company_members")
        .select("id", { count: "exact", head: true })
        .eq("company_id", req.user.company_id)
        .eq("role", "admin");
      if ((count || 0) <= 1) {
        return res
          .status(400)
          .json({ error: "Cannot remove the last admin." });
      }
    }
    const { error: delErr } = await supabase
      .from("company_members")
      .delete()
      .eq("id", memberId);
    if (delErr) return res.status(500).json({ error: delErr.message });
    res.json({ ok: true });
  }
);

// ---------------------------------------------------------------------------
// Trak internal: companies dashboard (PR-3)
// ---------------------------------------------------------------------------

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Invite-or-attach: returns { userId, invitedFresh } or { error }. */
async function inviteOrAttachByEmail(email, jwtMetadata) {
  const inviteRes = await supabase.auth.admin.inviteUserByEmail(email, {
    data: jwtMetadata,
  });
  if (!inviteRes.error) {
    return {
      userId: inviteRes.data?.user?.id || null,
      invitedFresh: true,
    };
  }
  const msg = (inviteRes.error.message || "").toLowerCase();
  const alreadyRegistered =
    msg.includes("already") ||
    inviteRes.error.code === "email_exists" ||
    inviteRes.error.status === 422;
  if (!alreadyRegistered) {
    return { error: inviteRes.error.message };
  }
  const { data: existing, error: lookupErr } = await supabase.rpc(
    "find_user_by_email",
    { p_email: email }
  );
  if (lookupErr) return { error: lookupErr.message };
  const userId = existing?.[0]?.id || null;
  if (!userId) return { error: "Email registered but lookup failed." };
  return { userId, invitedFresh: false };
}

app.get(
  "/api/internal/companies",
  requireUser,
  requireTractStaff,
  async (_req, res) => {
    const { data, error } = await supabase.rpc("tract_companies_overview");
    if (error) {
      console.error("Companies overview error:", error.message);
      return res.status(500).json({ error: error.message });
    }
    res.json({ companies: data || [] });
  }
);

app.post(
  "/api/internal/companies",
  requireUser,
  requireTractStaff,
  async (req, res) => {
    const name = String(req.body?.name || "").trim();
    const adminEmail = String(req.body?.adminEmail || "")
      .trim()
      .toLowerCase();
    if (!name) {
      return res.status(400).json({ error: "Company name required." });
    }
    if (!adminEmail || !EMAIL_RE.test(adminEmail)) {
      return res.status(400).json({ error: "Valid admin email required." });
    }

    const slug = slugify(name);
    const { data: company, error: cErr } = await supabase
      .from("companies")
      .insert({
        name,
        slug: slug || null,
        created_by: req.user.id,
      })
      .select("id, name, slug, plan, created_at")
      .single();
    if (cErr) {
      return res.status(500).json({ error: cErr.message });
    }

    const attach = await inviteOrAttachByEmail(adminEmail, {
      company_id: company.id,
      role: "admin",
      invited_by: req.user.id,
    });
    if (attach.error) {
      // Rollback so we don't leave an admin-less company behind.
      await supabase.from("companies").delete().eq("id", company.id);
      return res.status(500).json({ error: attach.error });
    }

    const { error: mErr } = await supabase.from("company_members").insert({
      company_id: company.id,
      user_id: attach.userId,
      role: "admin",
      invited_by: req.user.id,
    });
    if (mErr) {
      return res.status(500).json({
        error: `Company created but admin add failed: ${mErr.message}`,
        company,
      });
    }

    res.json({ company, invitedFresh: attach.invitedFresh });
  }
);

app.post(
  "/api/internal/companies/:id/admins",
  requireUser,
  requireTractStaff,
  async (req, res) => {
    const companyId = String(req.params.id || "");
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "Valid email required." });
    }

    const { data: company, error: cErr } = await supabase
      .from("companies")
      .select("id")
      .eq("id", companyId)
      .maybeSingle();
    if (cErr) return res.status(500).json({ error: cErr.message });
    if (!company) return res.status(404).json({ error: "Company not found." });

    const attach = await inviteOrAttachByEmail(email, {
      company_id: companyId,
      role: "admin",
      invited_by: req.user.id,
    });
    if (attach.error) return res.status(500).json({ error: attach.error });

    // If already a member, promote them to admin instead of inserting.
    const { data: existingMember } = await supabase
      .from("company_members")
      .select("id, role")
      .eq("company_id", companyId)
      .eq("user_id", attach.userId)
      .maybeSingle();

    if (existingMember) {
      if (existingMember.role === "admin") {
        return res.json({
          member: existingMember,
          invitedFresh: attach.invitedFresh,
          alreadyAdmin: true,
        });
      }
      const { data: updated, error: uErr } = await supabase
        .from("company_members")
        .update({ role: "admin" })
        .eq("id", existingMember.id)
        .select("id, user_id, role")
        .single();
      if (uErr) return res.status(500).json({ error: uErr.message });
      return res.json({
        member: updated,
        invitedFresh: attach.invitedFresh,
        promoted: true,
      });
    }

    const { data: member, error: insertErr } = await supabase
      .from("company_members")
      .insert({
        company_id: companyId,
        user_id: attach.userId,
        role: "admin",
        invited_by: req.user.id,
      })
      .select("id, user_id, role, joined_at")
      .single();
    if (insertErr) return res.status(500).json({ error: insertErr.message });

    res.json({ member, invitedFresh: attach.invitedFresh });
  }
);

app.post(
  "/api/internal/companies/:id/deactivate",
  requireUser,
  requireTractStaff,
  async (req, res) => {
    const companyId = String(req.params.id || "");
    const { data, error } = await supabase
      .from("companies")
      .update({ deactivated_at: new Date().toISOString() })
      .eq("id", companyId)
      .select("id, deactivated_at")
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ company: data });
  }
);

app.post(
  "/api/internal/companies/:id/reactivate",
  requireUser,
  requireTractStaff,
  async (req, res) => {
    const companyId = String(req.params.id || "");
    const { data, error } = await supabase
      .from("companies")
      .update({ deactivated_at: null })
      .eq("id", companyId)
      .select("id, deactivated_at")
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ company: data });
  }
);

const PORT = Number(process.env.PORT) || 3001;
const HOST =
  process.env.HOST ||
  (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const server = app.listen(PORT, HOST, () => {
  console.log(`Trak API listening at http://${HOST}:${PORT}`);
  console.log(
    `Persist scans to Supabase: ${PERSIST_SCANS ? "ON" : "OFF"} (set PERSIST_SCANS=true to save rows)`
  );
  console.log(
    `Prompt templates: ${path.join(__dirname, "data", "prompt-templates.json")} (or GET/PUT /api/prompt-templates)`
  );
  console.log(`Gemini model: ${getGeminiModelId()} (override with GEMINI_MODEL in .env)`);
});

server.requestTimeout = 15 * 60 * 1000;
server.headersTimeout = 15 * 60 * 1000;
