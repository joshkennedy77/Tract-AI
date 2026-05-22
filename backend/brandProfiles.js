/**
 * Per-company brand profiles: { domains[], facts } per brand name.
 *
 * Used by /api/scan to:
 *   - resolve owned domains for GEO scoring
 *   - feed verified brand facts into the AEO judge accuracy check
 */

const supabase = require("./supabaseClient.js");
const { normalizeBrandDomains, normalizeDomain } = require("./geo.js");

function profileKey(s) {
  return String(s || "").trim().toLowerCase();
}

async function getProfilesForCompany(companyId) {
  if (!companyId) return new Map();
  const { data, error } = await supabase
    .from("brand_profiles")
    .select("brand, domains, facts")
    .eq("company_id", companyId);
  if (error) {
    console.error("brand_profiles read error:", error.message);
    return new Map();
  }
  const out = new Map();
  for (const row of data || []) {
    const k = profileKey(row.brand);
    if (!k) continue;
    out.set(k, {
      brand: row.brand,
      domains: Array.isArray(row.domains) ? row.domains : [],
      facts: String(row.facts || ""),
    });
  }
  return out;
}

/**
 * Merge persisted profiles with anything posted on the scan request body.
 * Request-body values win (lets users tweak per-scan without saving).
 */
function resolveProfilesForBrands(brands, dbProfiles, requestProfiles) {
  const result = new Map();
  const inbound = new Map();
  const overrides = Array.isArray(requestProfiles) ? requestProfiles : [];
  for (const p of overrides) {
    const k = profileKey(p?.brand);
    if (!k) continue;
    inbound.set(k, {
      brand: String(p.brand || "").trim(),
      domains: Array.isArray(p.domains) ? p.domains : [],
      facts: String(p.facts || ""),
    });
  }
  for (const brand of brands) {
    const k = profileKey(brand);
    const base = dbProfiles?.get(k) || { brand, domains: [], facts: "" };
    const over = inbound.get(k) || {};
    const merged = {
      brand,
      domains:
        Array.isArray(over.domains) && over.domains.length > 0
          ? over.domains
          : base.domains,
      facts:
        typeof over.facts === "string" && over.facts.trim() !== ""
          ? over.facts
          : base.facts,
    };
    merged.domains = normalizeBrandDomains(brand, merged.domains);
    result.set(k, merged);
  }
  return result;
}

async function upsertProfilesForCompany(companyId, createdBy, profiles) {
  if (!companyId) return { ok: true, written: 0 };
  const rows = [];
  for (const p of profiles.values()) {
    const domains = Array.isArray(p.domains)
      ? [...new Set(p.domains.map((d) => normalizeDomain(d)).filter(Boolean))]
      : [];
    const facts = String(p.facts || "").trim();
    if (domains.length === 0 && !facts) continue;
    rows.push({
      company_id: companyId,
      brand: p.brand,
      domains,
      facts,
      updated_by: createdBy || null,
      updated_at: new Date().toISOString(),
    });
  }
  if (rows.length === 0) return { ok: true, written: 0 };
  const { error } = await supabase
    .from("brand_profiles")
    .upsert(rows, { onConflict: "company_id,brand" });
  if (error) {
    console.error("brand_profiles upsert error:", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, written: rows.length };
}

module.exports = {
  profileKey,
  getProfilesForCompany,
  resolveProfilesForBrands,
  upsertProfilesForCompany,
};
