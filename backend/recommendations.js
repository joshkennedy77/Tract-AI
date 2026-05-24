/**
 * Deterministic AEO / GEO recommendations for a single audited brand (Brand 1).
 */

const { AUTHORITY_SOCIAL } = require("./geo.js");

function pct(n, d) {
  if (!d) return 0;
  return Math.round((n / d) * 100);
}

function push(recs, item) {
  recs.push({
    id: item.id,
    area: item.area,
    severity: item.severity,
    title: item.title,
    evidence: item.evidence,
    actions: item.actions,
  });
}

function analyzeBrandRows(rows) {
  const n = rows.length;
  const mix = { recommended: 0, mentioned: 0, negative: 0, omitted: 0 };
  const mentionTypes = {};
  const positions = [];
  const accuracies = [];
  const accuracyFlags = [];
  const engines = new Map();
  const intents = new Map();
  let geoOwn = 0;
  let geoAny = 0;
  let geoRecommendedNoCite = 0;
  const hostCounts = new Map();
  let socialHosts = 0;
  let totalHosts = 0;
  let judged = 0;

  for (const r of rows) {
    const a = r.aeo_analysis || {};
    const g = r.geo_analysis || {};
    const eng = r.engine || "(unknown)";
    const intent = r.intent || "other";

    if (a && Object.keys(a).length > 0) judged += 1;
    const rec = String(a.recommendation || "omitted").toLowerCase();
    if (mix[rec] != null) mix[rec] += 1;

    const mt = String(a.mention_type || "none").toLowerCase();
    mentionTypes[mt] = (mentionTypes[mt] || 0) + 1;

    if (Number.isFinite(Number(a.position))) positions.push(Number(a.position));
    if (Number.isFinite(Number(a.accuracy_score))) accuracies.push(Number(a.accuracy_score));
    if (Array.isArray(a.accuracy_flags)) {
      for (const f of a.accuracy_flags) {
        const s = String(f || "").trim();
        if (s) accuracyFlags.push(s);
      }
    }

    if (!engines.has(eng)) engines.set(eng, { scores: [], mix: { recommended: 0, mentioned: 0, negative: 0, omitted: 0 } });
    const es = engines.get(eng);
    if (Number.isFinite(Number(r.aeo_score))) es.scores.push(Number(r.aeo_score));
    if (es.mix[rec] != null) es.mix[rec] += 1;

    if (!intents.has(intent)) intents.set(intent, []);
    if (Number.isFinite(Number(r.aeo_score))) intents.get(intent).push(Number(r.aeo_score));

    if (g.own_domain_cited) geoOwn += 1;
    if ((g.citation_count || 0) > 0) geoAny += 1;
    if (rec === "recommended" && (g.citation_count || 0) === 0) geoRecommendedNoCite += 1;

    for (const h of g.hosts || []) {
      const host = String(h || "").toLowerCase();
      if (!host) continue;
      hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
      totalHosts += 1;
      const root = host.split(".").slice(-2).join(".");
      if (AUTHORITY_SOCIAL.has(host) || AUTHORITY_SOCIAL.has(root)) socialHosts += 1;
    }
  }

  const avgPosition =
    positions.length === 0
      ? null
      : Math.round((positions.reduce((a, b) => a + b, 0) / positions.length) * 10) / 10;
  const avgAccuracy =
    accuracies.length === 0
      ? null
      : Math.round(accuracies.reduce((a, b) => a + b, 0) / accuracies.length);

  const topHosts = [...hostCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([host, count]) => ({ host, count }));

  return {
    n,
    judged,
    mix,
    mentionTypes,
    avgPosition,
    avgAccuracy,
    accuracyFlags: [...new Set(accuracyFlags)].slice(0, 8),
    engines,
    intents,
    geoOwnRate: pct(geoOwn, n),
    geoAnyRate: pct(geoAny, n),
    geoRecommendedNoCite,
    topHosts,
    socialHostShare: totalHosts === 0 ? 0 : Math.round((socialHosts / totalHosts) * 100),
  };
}

function competitorInsights(brand, allRows, aeoByBrand, geoByBrand) {
  const others = Object.keys(aeoByBrand).filter(
    (b) => b.toLowerCase() !== brand.toLowerCase()
  );
  if (others.length === 0) return [];

  const myAeo = aeoByBrand[brand]?.score;
  const myGeo = geoByBrand[brand]?.score;
  const out = [];

  for (const comp of others) {
    const ca = aeoByBrand[comp]?.score;
    const cg = geoByBrand[comp]?.score;
    if (Number.isFinite(ca) && Number.isFinite(myAeo) && ca - myAeo >= 15) {
      out.push({
        competitor: comp,
        metric: "AEO",
        theirs: ca,
        yours: myAeo,
      });
    }
    if (Number.isFinite(cg) && Number.isFinite(myGeo) && cg - myGeo >= 15) {
      out.push({
        competitor: comp,
        metric: "GEO",
        theirs: cg,
        yours: myGeo,
      });
    }
  }
  return out;
}

/**
 * @param {object} input
 * @param {string} input.brand
 * @param {object[]} input.rows — scan rows for this brand only
 * @param {object[]} [input.allRows] — all rows (for competitor context)
 * @param {object} [input.profile] — { domains, facts }
 * @param {object} [input.aeo] — per-brand AEO stats from buildAeoStatsForGroup
 * @param {object} [input.geo] — per-brand GEO stats
 * @param {number|null} [input.tractScore]
 */
function generateRecommendations(input) {
  const brand = String(input.brand || "").trim();
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const profile = input.profile || {};
  const aeo = input.aeo || {};
  const geo = input.geo || {};
  const tractScore = input.tractScore ?? null;
  const domains = Array.isArray(profile.domains) ? profile.domains : [];
  const domainLabel = domains.length ? domains.join(", ") : `${brand.toLowerCase().replace(/[^a-z0-9]+/g, "")}.com (guessed)`;

  const recs = [];
  const detail = analyzeBrandRows(rows);

  if (rows.length === 0) {
    push(recs, {
      id: "no-data",
      area: "tract",
      severity: "info",
      title: "Run an audit to get recommendations",
      evidence: `No scan data for ${brand || "your brand"} yet.`,
      actions: [
        "Go to Run Audit, enter your brand as Brand 1, and run a scan.",
        "Return here after the audit completes to see tailored AEO and GEO actions.",
      ],
    });
    return recs;
  }

  if (!domains.length && !String(profile.facts || "").trim()) {
    push(recs, {
      id: "profile-missing",
      area: "tract",
      severity: "info",
      title: "Add your brand profile for sharper advice",
      evidence: "Owned domains and verified facts are not set for this brand.",
      actions: [
        "On Run Audit, open Brand profiles and add your owned domains (e.g. nike.com).",
        "Add verified facts (headquarters, products, founding year) to improve accuracy scoring and GEO domain matching.",
      ],
    });
  }

  const omittedPct = pct(detail.mix.omitted, detail.judged || detail.n);
  if (detail.judged > 0 && omittedPct >= 30) {
    push(recs, {
      id: "aeo-omitted",
      area: "aeo",
      severity: omittedPct >= 50 ? "critical" : "warning",
      title: "AI often leaves your brand out of answers",
      evidence: `${detail.mix.omitted} of ${detail.judged} judged answers omitted ${brand} (${omittedPct}%).`,
      actions: [
        "Publish category-defining content: “best [category]”, comparison guides, and FAQ pages that name your brand clearly.",
        "Ensure Wikipedia, Crunchbase, and major directories list accurate brand information.",
        "Use schema.org Organization/Product markup on your site so crawlers can connect entities to your domain.",
      ],
    });
  }

  const mentionedOnly =
    detail.mix.mentioned + detail.mix.recommended > 0 &&
    detail.mix.mentioned >= detail.mix.recommended;
  if (detail.judged > 0 && mentionedOnly && detail.mix.recommended < detail.mix.mentioned) {
    push(recs, {
      id: "aeo-mentioned-not-recommended",
      area: "aeo",
      severity: "warning",
      title: "You are mentioned but rarely recommended",
      evidence: `Recommended: ${detail.mix.recommended}, mentioned only: ${detail.mix.mentioned} (of ${detail.judged} judged answers).`,
      actions: [
        "Collect third-party reviews and awards on G2, Capterra, or industry sites AI models cite.",
        "Publish customer case studies and outcome data on owned and earned channels.",
        "Target “best / top / vs” comparison prompts where assistants pick a clear winner.",
      ],
    });
  }

  if (detail.mix.negative > 0) {
    push(recs, {
      id: "aeo-negative",
      area: "aeo",
      severity: "critical",
      title: "Negative recommendation language detected",
      evidence: `${detail.mix.negative} answer(s) used negative framing about ${brand}.`,
      actions: [
        "Identify which prompts triggered negativity and check cited sources in Recent activity.",
        "Address factual complaints publicly; update inaccurate pages that models may be citing.",
        "Strengthen positive earned media and official responses to common criticisms.",
      ],
    });
  }

  if (detail.avgAccuracy != null && detail.avgAccuracy < 70) {
    push(recs, {
      id: "aeo-accuracy",
      area: "aeo",
      severity: "warning",
      title: "AI descriptions of your brand are often inaccurate",
      evidence: `Average factual accuracy score: ${detail.avgAccuracy} / 100.`,
      actions: [
        "Fill in verified facts on Run Audit → Brand profiles.",
        "Publish a canonical About page with consistent facts (founding, HQ, product lines).",
        ...(detail.accuracyFlags.length
          ? [`Review flagged issues: ${detail.accuracyFlags.join("; ")}.`]
          : ["Re-run the audit after updating facts to measure improvement."]),
      ],
    });
  }

  if (detail.avgPosition != null && detail.avgPosition > 3) {
    push(recs, {
      id: "aeo-position",
      area: "aeo",
      severity: "warning",
      title: "When listed, you appear below the top choices",
      evidence: `Average list position when mentioned: ${detail.avgPosition} (1 = first choice).`,
      actions: [
        "Aim for #1–2 placement in “best of” listicles on authoritative sites.",
        "Create side-by-side comparison pages that position your brand favorably with evidence.",
        "Pitch inclusion higher in round-up articles editors already publish in your category.",
      ],
    });
  }

  const footnoteN = detail.mentionTypes.footnote || 0;
  const primaryN = detail.mentionTypes.primary || 0;
  if (footnoteN > primaryN && footnoteN >= 2) {
    push(recs, {
      id: "aeo-footnote",
      area: "aeo",
      severity: "info",
      title: "Brand often appears only in footnotes or asides",
      evidence: `Footnote mentions: ${footnoteN}; primary mentions: ${primaryN}.`,
      actions: [
        "Publish definitive category content that positions your brand as the main answer, not a side note.",
        "Earn citations on pages structured as ranked lists rather than passing references.",
      ],
    });
  }

  const engineScores = [...detail.engines.entries()]
    .map(([engine, data]) => ({
      engine,
      score:
        data.scores.length === 0
          ? null
          : Math.round(data.scores.reduce((a, b) => a + b, 0) / data.scores.length),
    }))
    .filter((e) => e.score != null);
  if (engineScores.length >= 2) {
    const sorted = engineScores.slice().sort((a, b) => b.score - a.score);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (best.score - worst.score >= 20) {
      push(recs, {
        id: "aeo-engine-gap",
        area: "aeo",
        severity: "warning",
        title: `AEO varies widely by AI engine`,
        evidence: `${best.engine} scores ${best.score}/100 vs ${worst.engine} at ${worst.score}/100.`,
        actions: [
          `Study what sources ${best.engine} cites when recommending you; replicate that pattern for ${worst.engine}.`,
          "Enable web search / grounding on all engines in Run Audit to compare citation behavior fairly.",
          "Tune prompts per intent (comparison vs informational) on weaker engines.",
        ],
      });
    }
  }

  const intentScores = [...detail.intents.entries()]
    .map(([intent, scores]) => ({
      intent,
      score: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
      n: scores.length,
    }))
    .filter((i) => i.n >= 2);
  if (intentScores.length >= 2) {
    const sorted = intentScores.slice().sort((a, b) => b.score - a.score);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (best.score - worst.score >= 18) {
      push(recs, {
        id: "aeo-intent-gap",
        area: "aeo",
        severity: "info",
        title: `Weaker on “${worst.intent}” prompts`,
        evidence: `${best.intent}: ${best.score}/100 · ${worst.intent}: ${worst.score}/100.`,
        actions: [
          `Create content specifically for ${worst.intent} queries (e.g. comparison tables, alternatives pages).`,
          "Review prompt templates under Prompts and add category-specific variants.",
        ],
      });
    }
  }

  if (geo.ownDomainRate != null && geo.ownDomainRate < 25 && geo.anyCitationRate > 0) {
    push(recs, {
      id: "geo-own-domain",
      area: "geo",
      severity: geo.ownDomainRate === 0 ? "critical" : "warning",
      title: "Your website is rarely cited as a source",
      evidence: `Own domain cited in ${geo.ownDomainRate}% of answers (${domainLabel}). Citations appear in ${geo.anyCitationRate}% of answers overall.`,
      actions: [
        "Improve technical SEO: sitemap, robots.txt, Core Web Vitals, and indexable product/category pages.",
        "Add clear, citable facts on your site (specs, pricing, comparisons) that match common AI prompts.",
        "Build backlinks from authoritative publishers already cited in your audit.",
      ],
    });
  }

  if (geo.anyCitationRate > 30 && geo.ownDomainRate === 0) {
    push(recs, {
      id: "geo-cite-not-you",
      area: "geo",
      severity: "warning",
      title: "AI cites sources — but not your domain",
      evidence: `Citations in ${geo.anyCitationRate}% of answers; 0% cite ${domainLabel}.`,
      actions: [
        ...(detail.topHosts.length
          ? [
              `Prioritize presence on top cited hosts: ${detail.topHosts.map((h) => h.host).join(", ")}.`,
            ]
          : ["Identify top hosts in Recent activity and pursue coverage there."]),
        "Pitch guest articles or data studies to editorial sites models already trust.",
      ],
    });
  }

  if (geo.avgAuthority != null && geo.avgAuthority < 45) {
    push(recs, {
      id: "geo-low-authority",
      area: "geo",
      severity: "warning",
      title: "Cited sources skew low-authority",
      evidence: `Average source authority across answers: ${geo.avgAuthority} / 100.`,
      actions: [
        "Target coverage on major news, industry analysts, and .edu/.gov references.",
        "Reduce reliance on social threads alone; pair Reddit/forum buzz with journalistic citations.",
      ],
    });
  }

  if (detail.geoRecommendedNoCite >= 2) {
    push(recs, {
      id: "geo-recommend-no-cite",
      area: "geo",
      severity: "info",
      title: "Recommended without supporting citations",
      evidence: `${detail.geoRecommendedNoCite} answers recommend ${brand} but cite no sources.`,
      actions: [
        "Strengthen linkable proof points on your site so models can attach citations to recommendations.",
        "Earn third-party listicles that both recommend you and link to primary sources.",
      ],
    });
  }

  if (detail.socialHostShare >= 40 && detail.topHosts.length > 0) {
    push(recs, {
      id: "geo-social-heavy",
      area: "geo",
      severity: "info",
      title: "Citations lean on social platforms",
      evidence: `~${detail.socialHostShare}% of cited hosts are social (Reddit, X, YouTube, etc.).`,
      actions: [
        "Balance social discussion with press releases and trade publication coverage.",
        "Monitor brand mentions on social but invest in editorial SEO for durable citations.",
      ],
    });
  }

  const comps = input.competitorInsights || [];
  for (const c of comps.slice(0, 2)) {
    push(recs, {
      id: `comp-${c.competitor}-${c.metric}`.toLowerCase().replace(/\s+/g, "-"),
      area: "tract",
      severity: "info",
      title: `${c.competitor} leads on ${c.metric}`,
      evidence: `${c.competitor}: ${c.theirs}/100 vs ${brand}: ${c.yours}/100.`,
      actions: [
        `Compare ${c.competitor}'s cited sources and recommendation language in Recent activity.`,
        "Run a 2-brand comparison audit to see per-engine gaps side by side.",
      ],
    });
  }

  if (Number.isFinite(aeo.score) && aeo.score < 50 && !recs.some((r) => r.area === "aeo")) {
    push(recs, {
      id: "aeo-low-overall",
      area: "aeo",
      severity: "warning",
      title: "Overall AEO score has room to grow",
      evidence: `AEO score: ${aeo.score} / 100 (${aeo.judged || 0} judged answers).`,
      actions: [
        "Focus on earning “recommended” (not just “mentioned”) in comparison and best-of prompts.",
        "Improve factual accuracy and list position — the two fastest levers in your scoring model.",
      ],
    });
  }

  if (Number.isFinite(geo.score) && geo.score < 50 && !recs.some((r) => r.area === "geo")) {
    push(recs, {
      id: "geo-low-overall",
      area: "geo",
      severity: "warning",
      title: "Overall GEO score has room to grow",
      evidence: `GEO score: ${geo.score} / 100.`,
      actions: [
        "Get your owned domain cited in at least 25% of answers (worth 30% of GEO score).",
        "Increase citation rate and authority of sources that mention your brand.",
      ],
    });
  }

  if (recs.length === 0) {
    push(recs, {
      id: "all-good",
      area: "tract",
      severity: "info",
      title: "Strong baseline — keep monitoring",
      evidence: `AEO ${aeo.score ?? "—"}/100 · GEO ${geo.score ?? "—"}/100 · Tract ${tractScore ?? "—"}/100.`,
      actions: [
        "Re-run audits monthly to catch engine or intent drift.",
        "Expand prompt coverage in Prompts as your category evolves.",
      ],
    });
  }

  const order = { critical: 0, warning: 1, info: 2 };
  recs.sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      (a.area === "aeo" ? 0 : a.area === "geo" ? 1 : 2) -
        (b.area === "aeo" ? 0 : b.area === "geo" ? 1 : 2)
  );

  return recs;
}

module.exports = { generateRecommendations, analyzeBrandRows };
