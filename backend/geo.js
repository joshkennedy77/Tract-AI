/**
 * Tract GEO (Generative Engine Optimization) scoring.
 *
 * computeGeoScore() composite (0–100):
 *   own-domain cited 30 + any citation 25 + avg authority 25 + cite+recommend 20.
 */

const AUTHORITY_HIGH = new Set([
  "wikipedia.org",
  "nytimes.com",
  "wsj.com",
  "bloomberg.com",
  "reuters.com",
  "forbes.com",
  "ft.com",
  "theverge.com",
  "techcrunch.com",
  "wired.com",
  "arstechnica.com",
  "cnbc.com",
  "bbc.com",
  "bbc.co.uk",
  "economist.com",
  "hbr.org",
  "harvard.edu",
  "mit.edu",
  "stanford.edu",
]);

const AUTHORITY_SOCIAL = new Set([
  "reddit.com",
  "x.com",
  "twitter.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "youtube.com",
  "medium.com",
  "quora.com",
  "linkedin.com",
]);

function hostFromUrl(raw) {
  if (!raw) return "";
  try {
    const s = String(raw).trim();
    const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const u = new URL(withScheme);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function normalizeDomain(d) {
  const s = String(d || "").trim().toLowerCase();
  if (!s) return "";
  return s.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
}

/** Last-resort guess: "Acme Co." → "acmeco.com". */
function guessBrandDomain(brand) {
  const slug = String(brand || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return slug ? `${slug}.com` : "";
}

function normalizeBrandDomains(brand, list) {
  const out = new Set();
  if (Array.isArray(list)) {
    for (const item of list) {
      const d = normalizeDomain(item);
      if (d) out.add(d);
    }
  }
  if (out.size === 0) {
    const guessed = guessBrandDomain(brand);
    if (guessed) out.add(guessed);
  }
  return [...out];
}

function hostMatchesOwned(host, ownedDomains) {
  if (!host) return false;
  return ownedDomains.some(
    (d) => host === d || host.endsWith(`.${d}`)
  );
}

function authorityScoreForHost(host, ownedDomains) {
  if (!host) return 0;
  if (hostMatchesOwned(host, ownedDomains)) return 95;
  if (/\.(gov|edu)$/i.test(host)) return 90;
  const root = host.split(".").slice(-2).join(".");
  if (AUTHORITY_HIGH.has(host) || AUTHORITY_HIGH.has(root)) return 85;
  if (AUTHORITY_SOCIAL.has(host) || AUTHORITY_SOCIAL.has(root)) return 35;
  return 55;
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * @param {object} input
 * @param {string[]} input.sources    URLs returned with the engine answer
 * @param {string[]} input.brandDomains Owned domains (already normalized)
 * @param {boolean} input.brandMentioned
 * @param {object}  [input.aeoAnalysis]  AEO judge output (used for "recommended")
 */
function analyzeGeo({ sources, brandDomains, brandMentioned, aeoAnalysis }) {
  const owned = Array.isArray(brandDomains) ? brandDomains : [];
  const urls = Array.isArray(sources) ? sources.filter(Boolean) : [];
  const hosts = [];
  const seenHosts = new Set();
  for (const u of urls) {
    const h = hostFromUrl(u);
    if (!h || seenHosts.has(h)) continue;
    seenHosts.add(h);
    hosts.push(h);
  }

  const citation_count = hosts.length;
  const ownDomainCited = hosts.some((h) => hostMatchesOwned(h, owned));
  const recommended =
    aeoAnalysis &&
    String(aeoAnalysis.recommendation || "").toLowerCase() === "recommended";

  const authorities = hosts.map((h) => authorityScoreForHost(h, owned));
  const avg_authority =
    authorities.length === 0
      ? 0
      : Math.round(
          authorities.reduce((acc, n) => acc + n, 0) / authorities.length
        );

  const analysis = {
    citation_count,
    own_domain_cited: ownDomainCited,
    hosts: hosts.slice(0, 25),
    avg_authority,
    brand_mentioned: !!brandMentioned,
    recommended: !!recommended,
  };

  const score = computeGeoScore(analysis);
  return { analysis, score };
}

function computeGeoScore(a) {
  if (!a) return 0;
  const ownPts = a.own_domain_cited ? 30 : 0;
  const anyCitePts = a.citation_count > 0 ? 25 : 0;
  const authPts = Math.round((clamp(a.avg_authority, 0, 100) / 100) * 25);
  const couplePts = a.citation_count > 0 && a.recommended ? 20 : 0;
  return Math.max(0, Math.min(100, ownPts + anyCitePts + authPts + couplePts));
}

module.exports = {
  AUTHORITY_HIGH,
  AUTHORITY_SOCIAL,
  hostFromUrl,
  normalizeDomain,
  normalizeBrandDomains,
  guessBrandDomain,
  authorityScoreForHost,
  analyzeGeo,
  computeGeoScore,
};
