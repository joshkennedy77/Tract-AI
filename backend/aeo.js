/**
 * Tract AEO (Answer Engine Optimization) scoring.
 *
 * computeAeoScore() composite (0–100):
 *   recommendation 40 + position 20 + mention_type 15 + accuracy 25.
 */

const RECOMMENDATIONS = ["recommended", "mentioned", "negative", "omitted"];
const MENTION_TYPES = ["primary", "list_item", "comparison", "footnote", "none"];

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function normalizeAeoAnalysis(raw) {
  const a = raw && typeof raw === "object" ? raw : {};
  const rec = String(a.recommendation || "").toLowerCase();
  const recommendation = RECOMMENDATIONS.includes(rec) ? rec : "omitted";

  let position = a.position == null ? null : Number(a.position);
  if (!Number.isFinite(position) || position < 1) position = null;
  if (position != null) position = Math.min(position, 20);

  const mt = String(a.mention_type || "").toLowerCase();
  const mention_type = MENTION_TYPES.includes(mt) ? mt : "none";

  const accuracy_score = Math.round(clamp(a.accuracy_score, 0, 100));

  const flags = Array.isArray(a.accuracy_flags) ? a.accuracy_flags : [];
  const accuracy_flags = flags
    .map((f) => String(f || "").trim())
    .filter(Boolean)
    .slice(0, 5);

  return {
    recommendation,
    position,
    mention_type,
    accuracy_score,
    accuracy_flags,
  };
}

function recommendationPoints(rec) {
  switch (rec) {
    case "recommended": return 40;
    case "mentioned":   return 22;
    case "negative":    return 10;
    default:            return 0;
  }
}

function positionPoints(pos) {
  if (pos == null) return 8;
  if (pos <= 1) return 20;
  if (pos === 2) return 14;
  if (pos === 3) return 10;
  if (pos <= 5) return 6;
  return 3;
}

function mentionTypePoints(t) {
  switch (t) {
    case "primary":     return 15;
    case "list_item":   return 10;
    case "comparison":  return 8;
    case "footnote":    return 4;
    default:            return 0;
  }
}

function computeAeoScore(analysis) {
  if (!analysis || analysis.recommendation === "omitted") return 0;
  const rec = recommendationPoints(analysis.recommendation);
  const pos = positionPoints(analysis.position);
  const mt = mentionTypePoints(analysis.mention_type);
  const acc = Math.round((clamp(analysis.accuracy_score, 0, 100) / 100) * 25);
  return Math.max(0, Math.min(100, rec + pos + mt + acc));
}

module.exports = {
  RECOMMENDATIONS,
  MENTION_TYPES,
  normalizeAeoAnalysis,
  computeAeoScore,
};
