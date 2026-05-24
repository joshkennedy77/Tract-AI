import { supabase, currentAccessToken } from "./supabase.js";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Netlify / production: set `VITE_API_URL` (e.g. https://your-api.railway.app) in build env. Local dev: omit — Vite proxies `/api` to port 3001. */
const API_BASE = String(import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

function apiUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (!API_BASE) return p;
  return `${API_BASE}${p}`;
}

async function fetchJson(url, options = {}) {
  const token = await currentAccessToken();
  const headers = new Headers(options.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  const looksLikeHtml =
    /^\s*</.test(text || "") &&
    (text.includes("<!DOCTYPE") || text.includes("<html"));
  let body = null;
  if (!looksLikeHtml) {
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { error: text?.slice(0, 200) || "Invalid JSON" };
    }
  }
  if (!res.ok) {
    const msg = looksLikeHtml
      ? API_BASE
        ? `No API at this URL (${res.status}). Check VITE_API_URL and redeploy.`
        : `No API at this URL (${res.status}). Run \`npm run api\` (port 3001), open the app at http://localhost:3000 (not 3001), and free port 3000 if Vite cannot start.`
      : body?.error || res.statusText || `HTTP ${res.status}`;
    throw new Error(
      typeof msg === "string" && msg.length > 400 ? `${msg.slice(0, 400)}…` : msg
    );
  }
  if (looksLikeHtml) {
    throw new Error(
      API_BASE
        ? "Unexpected HTML response. Check VITE_API_URL and redeploy."
        : "Unexpected HTML from /api — use http://localhost:3000 with `npm run dev` and `npm run api` on 3001 (do not open the Vite URL if it moved to port 3001)."
    );
  }
  return body;
}

function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escapeHtml(String(iso));
  return escapeHtml(d.toLocaleString());
}

function formatCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "—";
  return v.toLocaleString();
}

/** Match row.brand to an entry in the audit brand list (case-insensitive). */
function resolveBrandName(raw, brandsOrder) {
  const order = Array.isArray(brandsOrder) ? brandsOrder : [];
  const s = String(raw ?? "").trim();
  if (!s) return order[0] || "(unknown)";
  const lower = s.toLowerCase();
  const hit = order.find((b) => String(b).toLowerCase() === lower);
  return hit || s;
}

/** Unique brand names in first-seen order from scan rows. */
function brandsFromRowsOrdered(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const b = String(r.brand || "").trim();
    if (!b) continue;
    const k = b.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  return out;
}

/** Audit brand order first, then any extra names found in rows. */
function mergeBrandsOrder(hint, rows) {
  const fromRows = brandsFromRowsOrdered(rows);
  const out = [];
  const seen = new Set();
  for (const b of hint || []) {
    const t = String(b || "").trim();
    if (!t) continue;
    const match =
      fromRows.find((r) => r.toLowerCase() === t.toLowerCase()) || t;
    const k = match.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(match);
  }
  for (const b of fromRows) {
    const k = b.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  return out;
}

function emptyPerBrandStats() {
  return {
    total: 0,
    mentions: 0,
    positive: 0,
    negative: 0,
    neutral: 0,
    competitors: 0,
  };
}

function sentimentClass(s) {
  if (s === "positive") return "pill pill-pos";
  if (s === "negative") return "pill pill-neg";
  return "pill pill-neu";
}

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h) % 360;
}

function brandInitials(name) {
  const p = String(name || "").trim().split(/\s+/);
  if (p.length >= 2) return (p[0][0] + p[1][0]).toUpperCase().slice(0, 2);
  return String(name || "?").slice(0, 2).toUpperCase();
}

/** Distinct-hue palette cycled per row so each brand is easy to tell apart
 *  at a glance. Pairs are [from, to] used as a left-to-right gradient. */
const VISIBILITY_BAR_PALETTE = [
  ["#2563eb", "#3b82f6"], // blue
  ["#16a34a", "#22c55e"], // green
  ["#d97706", "#f59e0b"], // amber
  ["#dc2626", "#ef4444"], // red
  ["#7c3aed", "#a855f7"], // purple
  ["#0d9488", "#14b8a6"], // teal
  ["#db2777", "#ec4899"], // pink
  ["#0284c7", "#0ea5e9"], // sky
];

/** Solid swatch color for a row index, mirroring VISIBILITY_BAR_PALETTE
 *  so the Brand comparison table matches the Visibility bars. */
function brandSwatchColor(index) {
  const pair = VISIBILITY_BAR_PALETTE[index % VISIBILITY_BAR_PALETTE.length];
  return pair[1];
}

/** Horizontal bars from real mention-rate % (not a synthetic time series). */
function renderVisibilityBarRows(barRows) {
  return barRows
    .map((row, i) => {
      const pct = Math.min(100, Math.max(0, Number(row.pct) || 0));
      const label = escapeHtml(row.label || "—");
      const meta = row.meta ? escapeHtml(row.meta) : "";
      const width = pct > 0 ? Math.max(pct, 4) : 0;
      const tip = pct >= 14 ? `${pct}%` : "";
      const [from, to] = VISIBILITY_BAR_PALETTE[i % VISIBILITY_BAR_PALETTE.length];
      const style = `width:${width}%;--bar-from:${from};--bar-to:${to}`;
      return `<div class="visibility-bar-row">
        <span class="visibility-bar-label" title="${label}">${label}</span>
        <div class="visibility-bar-track" role="img" aria-label="${label}: ${pct}% visibility">
          <div class="visibility-bar-fill" style="${style}"><span class="visibility-bar-tip">${tip}</span></div>
        </div>
        <span class="visibility-bar-value" title="${meta}">${pct}%${meta ? ` <span class="muted">· ${meta}</span>` : ""}</span>
      </div>`;
    })
    .join("");
}

/** Visibility chart: per-brand rates when comparing brands; otherwise per AI platform. */
function renderVisibilityChart(stats) {
  const brandComparison = (stats?.brandComparison || []).filter((b) => b && b.brand);
  const engineMentionRates = (stats?.engineMentionRates || []).filter(
    (e) => e && e.engine
  );
  const overallMention = stats?.mentionRatePercent ?? 0;

  if (brandComparison.length > 1) {
    const order = stats?.brandsOrder || brandComparison.map((b) => b.brand);
    const byKey = new Map(
      brandComparison.map((b) => [String(b.brand).toLowerCase(), b])
    );
    const sorted = [];
    const seen = new Set();
    for (const name of order) {
      const row = byKey.get(String(name).toLowerCase());
      if (!row || seen.has(String(row.brand).toLowerCase())) continue;
      seen.add(String(row.brand).toLowerCase());
      sorted.push(row);
    }
    for (const row of brandComparison) {
      const k = String(row.brand).toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        sorted.push(row);
      }
    }
    return `
      <p class="chart-caption muted">Brand visibility: share of model answers that mentioned each brand in this dataset.</p>
      <div class="visibility-bars">
        ${renderVisibilityBarRows(
          sorted.map((b) => ({
            label: b.brand,
            pct: b.mentionRatePercent ?? 0,
            meta: `${b.count ?? 0} answers`,
          }))
        )}
      </div>
    `;
  }

  if (engineMentionRates.length > 0) {
    const sorted = engineMentionRates
      .slice()
      .sort(
        (a, b) => (b.mentionRatePercent ?? 0) - (a.mentionRatePercent ?? 0)
      );
    const brandLabel =
      brandComparison.length === 1 ? brandComparison[0].brand : null;
    const caption = brandLabel
      ? `Visibility for <strong>${escapeHtml(brandLabel)}</strong>: share of answers per AI platform that mentioned the brand.`
      : "Visibility by AI platform: share of answers that mentioned the audited brand.";
    return `
      <p class="chart-caption muted">${caption}</p>
      <div class="visibility-bars">
        ${renderVisibilityBarRows(
          sorted.map((e) => ({
            label: e.engine,
            pct: e.mentionRatePercent ?? 0,
            meta: `${e.total ?? 0} answers`,
          }))
        )}
      </div>
    `;
  }

  if (brandComparison.length === 1) {
    const b = brandComparison[0];
    return `
      <p class="chart-caption muted">Overall brand mention rate for this dataset.</p>
      <div class="visibility-bars">
        ${renderVisibilityBarRows([
          {
            label: b.brand,
            pct: b.mentionRatePercent ?? overallMention,
            meta: `${b.count ?? 0} answers`,
          },
        ])}
      </div>
    `;
  }

  if (overallMention > 0 || stats?.totalScans > 0) {
    return `
      <p class="chart-caption muted">Overall brand mention rate across all stored answers.</p>
      <div class="visibility-bars">
        ${renderVisibilityBarRows([
          {
            label: "Overall",
            pct: overallMention,
            meta: `${stats?.rowsBrandMentioned ?? 0} / ${stats?.totalScans ?? 0} rows`,
          },
        ])}
      </div>
    `;
  }

  return `<p class="muted chart-caption">No visibility data yet. Run an audit to see mention rates.</p>`;
}

/** Stacked horizontal bars: share of positive / neutral / negative answers per brand. */
function renderSentimentByBrandChart(brandComparison, sentimentCounts) {
  let rows = (brandComparison || []).filter((b) => b && b.brand);
  if (rows.length === 0 && sentimentCounts) {
    const p = sentimentCounts.positive || 0;
    const neg = sentimentCounts.negative || 0;
    const u = sentimentCounts.neutral || 0;
    const t = p + neg + u;
    if (t > 0) {
      rows = [
        {
          brand: "All stored scans",
          positive: p,
          negative: neg,
          neutral: u,
        },
      ];
    }
  }

  if (rows.length === 0) {
    return `<p class="muted chart-caption">No sentiment data yet. Run an audit to see a breakdown.</p>`;
  }

  return `
    <p class="chart-caption muted">Share of answers by sentiment label (per audited brand for comparison runs).</p>
    <div class="sentiment-bars">
      ${rows
        .map((row) => {
          const p = row.positive || 0;
          const neg = row.negative || 0;
          const u = row.neutral || 0;
          const t = p + neg + u;
          if (t === 0) {
            return `<div class="sentiment-bar-row"><span class="sentiment-bar-label">${escapeHtml(row.brand)}</span><span class="muted">No sentiment labels</span></div>`;
          }
          const pp = Math.round((p / t) * 1000) / 10;
          const pu = Math.round((u / t) * 1000) / 10;
          const pn = Math.round((neg / t) * 1000) / 10;
          return `<div class="sentiment-bar-row">
            <span class="sentiment-bar-label" title="${escapeHtml(row.brand)}">${escapeHtml(row.brand)}</span>
            <div class="sentiment-bar-track" role="img" aria-label="Sentiment for ${escapeHtml(row.brand)}: ${pp}% positive, ${pu}% neutral, ${pn}% negative">
              <div class="sentiment-seg sentiment-seg-pos" style="width:${pp}%"><span class="sentiment-seg-tip">${pp >= 12 ? `${pp}%` : ""}</span></div>
              <div class="sentiment-seg sentiment-seg-neu" style="width:${pu}%"><span class="sentiment-seg-tip">${pu >= 12 ? `${pu}%` : ""}</span></div>
              <div class="sentiment-seg sentiment-seg-neg" style="width:${pn}%"><span class="sentiment-seg-tip">${pn >= 12 ? `${pn}%` : ""}</span></div>
            </div>
            <span class="sentiment-bar-meta muted" title="positive / neutral / negative counts">${p} · ${u} · ${neg}</span>
          </div>`;
        })
        .join("")}
    </div>
    <div class="sentiment-legend-row">
      <span class="sentiment-legend"><span class="swatch sentiment-seg-pos"></span> Positive</span>
      <span class="sentiment-legend"><span class="swatch sentiment-seg-neu"></span> Neutral</span>
      <span class="sentiment-legend"><span class="swatch sentiment-seg-neg"></span> Negative</span>
    </div>
  `;
}

const ICON = {
  overview: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>`,
  prompts: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>`,
  sources: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10"/></svg>`,
  brands: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`,
  tags: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.5" fill="currentColor" stroke="none"/></svg>`,
  recommendations: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>`,
  home: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
  team: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  tract: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M15 9h.01M9 13h.01M15 13h.01M9 17h.01M15 17h.01"/></svg>`,
};

export function mount(root) {
  root.innerHTML = `
    <div class="app">
      <div id="auth-gate" class="auth-gate" aria-live="polite">
        <div class="auth-card" role="dialog" aria-labelledby="auth-title">
          <div class="auth-logo"><span class="topbar-logo-mark">T</span> Tract</div>

          <div id="auth-loading" class="auth-loading">Checking session…</div>

          <div id="auth-signin-mode" class="is-hidden">
            <h1 id="auth-title" class="auth-title">Sign in</h1>
            <p class="auth-sub">Use the email a Tract admin invited you with.</p>
            <form id="auth-signin-form" class="auth-form">
              <label class="auth-field">
                <span>Email</span>
                <input type="email" id="auth-email" autocomplete="email" required />
              </label>
              <label class="auth-field">
                <span>Password</span>
                <input type="password" id="auth-password" autocomplete="current-password" required />
              </label>
              <button type="submit" class="btn-primary" id="auth-submit">Sign in</button>
            </form>
            <p class="auth-footer">
              <button type="button" class="linkish" id="auth-forgot-link">Forgot your password?</button>
            </p>
          </div>

          <div id="auth-forgot-mode" class="is-hidden">
            <h1 class="auth-title">Reset password</h1>
            <p class="auth-sub">Enter your account email and we'll send you a link to choose a new one.</p>
            <form id="auth-forgot-form" class="auth-form">
              <label class="auth-field">
                <span>Email</span>
                <input type="email" id="auth-forgot-email" autocomplete="email" required />
              </label>
              <button type="submit" class="btn-primary" id="auth-forgot-submit">Send reset link</button>
            </form>
            <p id="auth-forgot-status" class="auth-info is-hidden" role="status"></p>
            <p class="auth-footer">
              <button type="button" class="linkish" id="auth-forgot-back">Back to sign in</button>
            </p>
          </div>

          <div id="auth-recover-mode" class="is-hidden">
            <h1 class="auth-title">Set a new password</h1>
            <p class="auth-sub">You arrived from a password reset email. Choose a new password to finish signing in.</p>
            <form id="auth-recover-form" class="auth-form">
              <label class="auth-field">
                <span>New password</span>
                <input type="password" id="auth-recover-password" autocomplete="new-password" minlength="8" required />
              </label>
              <label class="auth-field">
                <span>Confirm new password</span>
                <input type="password" id="auth-recover-password-2" autocomplete="new-password" minlength="8" required />
              </label>
              <button type="submit" class="btn-primary" id="auth-recover-submit">Update password</button>
            </form>
            <p id="auth-recover-status" class="auth-info is-hidden" role="status"></p>
          </div>

          <div id="auth-nocompany-mode" class="is-hidden">
            <h1 class="auth-title">No company yet</h1>
            <p>You're signed in as <strong id="auth-nocompany-email">—</strong>, but you don't belong to a company yet.</p>
            <p class="muted">Ask a Tract admin or your company admin to add you, then refresh.</p>
            <button type="button" class="btn-ghost" id="btn-signout-empty">Sign out</button>
          </div>

          <p id="auth-error" class="auth-error is-hidden" role="alert"></p>
        </div>
      </div>

      <header class="topbar">
        <a href="#view-home" class="topbar-logo js-nav" data-view="home" aria-label="Tract — Home">
          <span class="topbar-logo-mark">T</span>
          Tract
        </a>
        <div class="topbar-account" id="topbar-account" title="Signed-in account">
          <span class="topbar-account-label">Company</span>
          <span class="topbar-account-value" id="topbar-company">—</span>
        </div>
        <div class="topbar-search-wrap">
          <label class="topbar-search">
            <span class="muted" aria-hidden="true">🔍</span>
            <input type="search" placeholder="Search" autocomplete="off" />
          </label>
        </div>
        <div class="topbar-user" id="topbar-user">
          <span class="topbar-user-email" id="topbar-email">—</span>
          <button type="button" class="btn-ghost btn-sm" id="btn-signout">Sign out</button>
        </div>
      </header>

      <div class="shell">
        <aside class="sidebar" aria-label="Sidebar">
          <div class="side-section-label">General</div>
          <ul class="side-nav">
            <li><a href="#view-home" class="js-nav is-active" data-view="home">${ICON.home} Home</a></li>
            <li><a href="#view-prompts" class="js-nav" data-view="prompts">${ICON.prompts} Prompts</a></li>
            <li>
              <a href="#view-brands" class="js-nav" data-view="brands">${ICON.brands} Run Audit <span class="badge" id="badge-brands">0</span></a>
            </li>
            <li><a href="#view-overview" class="js-nav" data-view="overview">${ICON.overview} Test Results</a></li>
            <li><a href="#view-recommendations" class="js-nav" data-view="recommendations">${ICON.recommendations} Recommendations <span class="badge" id="badge-recs">0</span></a></li>
            <li><a href="#view-sources" class="js-nav" data-view="sources">${ICON.sources} Sources</a></li>
          </ul>
          <div class="side-section-label">Project</div>
          <ul class="side-nav">
            <li><a href="#view-tags" class="js-nav" data-view="tags">${ICON.tags} Tags</a></li>
          </ul>
          <div id="side-admin-label" class="side-section-label is-hidden">Admin</div>
          <ul class="side-nav">
            <li id="nav-team-li" class="is-hidden">
              <a href="#view-team" class="js-nav" data-view="team">${ICON.team} Team</a>
            </li>
          </ul>
          <div id="side-tract-label" class="side-section-label is-hidden">Tract</div>
          <ul class="side-nav">
            <li id="nav-tract-admin-li" class="is-hidden">
              <a href="#view-tract-admin" class="js-nav" data-view="tract-admin">${ICON.tract} Companies</a>
            </li>
          </ul>
        </aside>

        <div class="content">
          <p id="api-banner" class="banner banner-hidden" role="status"></p>

          <section id="view-home" class="view" data-view-panel="home">
            <div class="page-title-row">
              <h1 class="page-title">Home</h1>
            </div>
            <p class="home-tagline">How AI sees your brand. How you improve it.</p>
            <p class="subview-lead home-lead">
              Audits you have run appear here as studies. Click a card to open <strong>Test Results</strong> for that run. Login will land here later.
            </p>
            <div class="home-actions">
              <a href="#view-brands" id="btn-home-new-audit" class="btn-primary js-nav" data-view="brands">Run new audit</a>
            </div>
            <div id="home-study-grid" class="study-card-grid" role="list"></div>
          </section>

          <section id="view-overview" class="view is-hidden" data-view-panel="overview">
            <div class="page-title-row">
              <div class="page-title-head">
                <h1 class="page-title">Test Results</h1>
                <a href="#view-home" class="btn-ghost js-nav" data-view="home">All studies</a>
              </div>
              <div class="kpi-chips" id="ov-kpi-row">
                <span class="kpi-chip"><span class="dot ok"></span> Visibility: —</span>
                <span class="kpi-chip"><span class="dot warn"></span> Sentiment: —</span>
                <span class="kpi-chip"><span class="dot ok"></span> Position: —</span>
              </div>
            </div>
            <p id="audit-session-note" class="session-audit-note is-hidden"></p>

            <div id="brand-compare-wrap" class="panel-card brand-compare-wrap is-hidden">
              <h3 style="margin-top:0">Brand comparison <span class="help-dot" tabindex="0" role="img" aria-label="What this table shows" title="Side-by-side metrics for every brand in this audit: how many answers we collected, how often the brand was mentioned, how often competitors appeared with it, and the dominant sentiment.">?</span></h3>
              <p class="field-hint muted" style="margin-top:0">Metrics from your latest audit in this browser, split by audited brand.</p>
              <div class="table-wrap">
                <table class="data-table brand-compare-table">
                  <thead>
                    <tr>
                      <th>Brand</th>
                      <th>Answers</th>
                      <th>Visibility</th>
                      <th>w/ competitors</th>
                      <th>Sentiment</th>
                    </tr>
                  </thead>
                  <tbody id="brand-compare-body"></tbody>
                </table>
              </div>
            </div>

            <div class="alert-banner">
              Audits are shown in Test Results after each run. By default rows are <strong>not</strong> saved to Supabase; set <code>PERSIST_SCANS=true</code> on the API to store them.
              <a href="#view-brands" class="js-nav" data-view="brands">Open Run Audit</a>
            </div>

            <div class="filter-row">
              <button type="button" class="filter-btn">Last 7 days ▾</button>
              <button type="button" class="filter-btn">All models ▾</button>
              <button type="button" class="filter-btn">All topics ▾</button>
            </div>

            <div class="metrics-row">
              <div class="metric-card">
                <h3>Brand presence <span class="help-dot" tabindex="0" role="img" aria-label="What 'Brand presence' shows" title="Visibility = % of AI answers that mentioned your brand. Answers scanned = total model replies analysed across this audit (every brand × prompt × engine).">?</span></h3>
                <div class="metric-split">
                  <div class="metric-block ring-wrap">
                    <div>
                      <div class="metric-block-label">Visibility</div>
                      <div class="metric-block-value" id="ov-vis-pct">—</div>
                      <div class="metric-trend down" id="ov-vis-trend">—</div>
                    </div>
                    <div class="mini-ring" id="ov-vis-ring" style="--ring-pct: 0"></div>
                  </div>
                  <div class="metric-block">
                    <div class="metric-block-label">Answers scanned</div>
                    <div class="metric-block-value" id="ov-answers">—</div>
                    <div class="metric-trend up" id="ov-answers-trend">rows in DB</div>
                  </div>
                </div>
              </div>
              <div class="metric-card">
                <h3>Coverage <span class="help-dot" tabindex="0" role="img" aria-label="What 'Coverage' shows" title="Scan batches = number of distinct audit runs that contributed to this view. Brands tracked = number of unique brand names recorded across all audits.">?</span></h3>
                <div class="metric-split">
                  <div class="metric-block">
                    <div class="metric-block-label">Scan batches</div>
                    <div class="metric-block-value" id="ov-cite-total">—</div>
                    <div class="metric-trend up" id="ov-cite-trend">unique runs</div>
                  </div>
                  <div class="metric-block">
                    <div class="metric-block-label">Brands tracked</div>
                    <div class="metric-block-value" id="ov-cite-brand">—</div>
                    <div class="metric-trend up" id="ov-cite-brand-trend">distinct names</div>
                  </div>
                </div>
              </div>
              <div class="metric-card">
                <h3>Competitor signals <span class="help-dot" tabindex="0" role="img" aria-label="What 'Competitor signals' shows" title="Rows w/ competitors = % of AI answers that named at least one competitor alongside your brand. Top brand = the brand with the highest visibility in this audit.">?</span></h3>
                <div class="metric-split">
                  <div class="metric-block">
                    <div class="metric-block-label">Rows w/ competitors</div>
                    <div class="metric-block-value" id="ov-share">—</div>
                    <div class="metric-trend" id="ov-share-note">of all rows</div>
                  </div>
                  <div class="metric-block">
                    <div class="metric-block-label">Top brand</div>
                    <div class="metric-block-value" id="ov-position" style="font-size:1.1rem">—</div>
                    <div class="metric-trend" id="ov-position-note">by volume</div>
                  </div>
                </div>
              </div>
              <div class="metric-card metric-card-sources">
                <h3>Sources <span class="help-dot" tabindex="0" role="img" aria-label="What 'Sources' shows" title="Total sources cited = sum of URLs returned alongside each AI answer. The second column narrows that to answers where your brand was actually mentioned, so you can tell whether the AI tends to cite sources specifically when discussing your brand.">?</span></h3>
                <div class="metric-sources-inner">
                  <div class="metric-sources-col">
                    <div class="metric-block-label metric-label-with-help">
                      Total sources <span class="metric-label-tail">cited <span
                        class="metric-help"
                        title="Sum of URLs or citations returned with each model answer (Perplexity search results, Gemini grounding links, OpenAI URL annotations when present)."
                        aria-label="Help: total sources cited"
                        role="img"
                      >?</span></span>
                    </div>
                    <div class="metric-sources-value-row">
                      <span class="metric-block-value metric-sources-main" id="ov-src-total">—</span>
                      <span class="metric-src-pill metric-trend up" id="ov-src-total-pill">—</span>
                    </div>
                    <div class="metric-trend up" id="ov-src-total-sub">per answer</div>
                  </div>
                  <div class="metric-sources-divider" aria-hidden="true"></div>
                  <div class="metric-sources-col">
                    <div class="metric-block-label metric-label-with-help">
                      Sources when brand <span class="metric-label-tail">mentioned <span
                        class="metric-help"
                        title="Same count, but only for answers where the audited brand was detected in the model reply."
                        aria-label="Help: sources when brand mentioned"
                        role="img"
                      >?</span></span>
                    </div>
                    <div class="metric-sources-value-row">
                      <span class="metric-block-value metric-sources-main" id="ov-src-mention">—</span>
                      <span class="metric-src-pill metric-trend up" id="ov-src-mention-pill">—</span>
                    </div>
                    <div class="metric-trend up" id="ov-src-mention-sub">mention rows</div>
                  </div>
                </div>
              </div>
            </div>

            <div class="score-brand-filter" id="score-brand-filter">
              <label for="score-brand-select"><strong>Show AEO &amp; GEO for:</strong> <span class="help-dot" tabindex="0" role="img" aria-label="What this selector does" title="Filters the AEO, GEO, and Tract score cards below to a single brand. 'All brands (pooled)' averages across every brand in this audit.">?</span></label>
              <select id="score-brand-select"></select>
            </div>

            <div class="score-cards-row">
              <div class="panel-card aeo-card" id="aeo-card">
                <h3 id="aeo-card-title">AEO score</h3>
                <p class="score-explain">
                  <strong>AEO = Answer Engine Optimization.</strong>
                  When an AI assistant answers a question about your brand,
                  does it actually <em>recommend</em> you, how high up does
                  it list you, and is what it says about you correct?
                  Higher is better.
                </p>
                <div id="aeo-card-body" class="aeo-card-body">
                  <p class="muted">No AEO judgements yet — run a scan.</p>
                </div>
              </div>
              <div class="panel-card geo-card" id="geo-card">
                <h3 id="geo-card-title">GEO score</h3>
                <p class="score-explain">
                  <strong>GEO = Generative Engine Optimization.</strong>
                  When an AI links to its sources, how often is your own
                  website cited, and how trustworthy are the sites it
                  pulls from? Higher is better.
                </p>
                <div id="geo-card-body" class="geo-card-body">
                  <p class="muted">No citation data yet.</p>
                </div>
              </div>
              <div class="panel-card tract-score-card" id="tract-score-card">
                <div class="tract-score-head">
                  <h3>Tract score <span class="help-dot" tabindex="0" role="img" aria-label="What the Tract score means" title="Tract score: 0–100. A weighted blend of your AEO score (55%) and GEO score (45%). One number that summarises how well your brand performs in AI answers overall.">?</span></h3>
                  <p class="score-explain">
                    One number that combines AEO and GEO so you can track how
                    your brand is doing in AI answers overall.
                    <span class="muted">(AEO 55% · GEO 45%)</span>
                  </p>
                </div>
                <div class="tract-score-body">
                  <div class="tract-score-number" id="tract-score-number">—</div>
                  <div class="tract-score-meta" id="tract-score-meta">No data yet.</div>
                </div>
              </div>
            </div>

            <div class="ai-strip">
              <span>✨ Summary uses your <strong>latest audit</strong> in this browser when present; otherwise stored <code>scans</code> from the database.</span>
              <a href="#view-prompts" class="js-nav" data-view="prompts">View prompts</a>
            </div>

            <div class="bottom-grid">
              <div class="chart-stack">
                <div class="panel-card chart-panel-card">
                  <h3>Visibility <span class="help-dot" tabindex="0" role="img" aria-label="What 'Visibility' shows" title="Visibility: % of AI answers that mentioned each brand. Higher means the brand shows up more often in AI responses.">?</span></h3>
                  <div class="chart-area" id="chart-visibility"></div>
                </div>
                <div class="panel-card chart-panel-card">
                  <h3>Sentiment <span class="help-dot" tabindex="0" role="img" aria-label="What 'Sentiment' shows" title="Sentiment: split of positive / neutral / negative tone in the AI answers that mentioned each brand.">?</span></h3>
                  <div class="chart-area chart-area-sentiment" id="chart-sentiment"></div>
                </div>
              </div>
              <div class="panel-card">
                <div class="leader-head">
                  <h3 style="margin:0">Leaderboard <span class="help-dot" tabindex="0" role="img" aria-label="What the Leaderboard shows" title="Brands ranked by visibility (the % of AI answers that mentioned them). Volume is the raw count of answers we have for each brand, and Sentiment is the dominant tone of those mentions.">?</span></h3>
                  <div class="leader-actions">
                    <button type="button" class="btn-ghost" id="btn-refresh-lb">Refresh</button>
                    <a href="#view-brands" class="btn-ghost js-nav" data-view="brands" style="text-decoration:none;display:inline-block">Run scan</a>
                  </div>
                </div>
                <table class="lb-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Brand</th>
                      <th>Visibility</th>
                      <th>Sentiment</th>
                      <th>Volume</th>
                    </tr>
                  </thead>
                  <tbody id="leaderboard-body"></tbody>
                </table>
              </div>
            </div>
          </section>

          <section id="view-prompts" class="view is-hidden" data-view-panel="prompts">
            <h2 class="subview-title">Prompts</h2>
            <p class="subview-lead">Templates are saved on the server in <code>backend/data/prompt-templates.json</code>. Each line must include the placeholder <code>{{brand}}</code> (replaced with the Run Audit brand when you scan).</p>
            <div class="form-card">
              <p id="prompt-templates-status" class="status-line muted" role="status"></p>
              <div id="prompt-templates-editor" class="prompt-templates-editor"></div>
              <div class="prompt-editor-actions">
                <button type="button" class="btn-primary" id="btn-save-templates">Save prompts</button>
                <button type="button" class="btn-ghost" id="btn-reload-templates">Reload from server</button>
              </div>
            </div>
            <h3 class="subview-title" style="font-size:1rem;margin-top:1.5rem">Preview</h3>
            <p class="field-hint muted">Resolved text for the brand on <strong>Run Audit</strong> (type a brand there first).</p>
            <div class="form-card">
              <ol id="prompt-list" class="prompt-list muted"></ol>
            </div>
          </section>

          <section id="view-sources" class="view is-hidden" data-view-panel="sources">
            <h2 class="subview-title">Recent activity</h2>
            <p class="subview-lead">The most recent scans your team has run. Latest audit details are summarised below; full data appears under <strong>Test Results</strong>.</p>
            <p class="field-hint muted" id="recent-activity-hint" style="margin-top:0;margin-bottom:0.5rem"></p>
            <div class="table-wrap">
              <table class="data-table" id="scans-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Brand</th>
                    <th>Engine</th>
                    <th>Mention</th>
                    <th>Sentiment</th>
                    <th>Prompt</th>
                    <th>Response</th>
                    <th>Sources</th>
                  </tr>
                </thead>
                <tbody id="scans-body"></tbody>
              </table>
            </div>
          </section>

          <section id="view-brands" class="view is-hidden" data-view-panel="brands">
            <h2 class="subview-title">Run Audit</h2>
            <p class="subview-lead">Run every configured prompt (see <strong>Prompts</strong>) against each selected model. Results appear under <strong>Test Results</strong> in this browser; they are not written to Supabase unless the API has <code>PERSIST_SCANS=true</code>.</p>
            <div class="form-card">
              <div class="field">
                <label for="brand">Brand 1</label>
                <input id="brand" type="text" placeholder="e.g. Nike" autocomplete="off" />
                <p class="field-hint muted">At least one brand required, up to four for a comparison run.</p>
              </div>
              <div class="field">
                <label for="brand-2">Brand 2 <span class="muted">(optional)</span></label>
                <input id="brand-2" type="text" placeholder="Competitor or alternate" autocomplete="off" />
              </div>
              <div class="field">
                <label for="brand-3">Brand 3 <span class="muted">(optional)</span></label>
                <input id="brand-3" type="text" placeholder="Optional" autocomplete="off" />
              </div>
              <div class="field">
                <label for="brand-4">Brand 4 <span class="muted">(optional)</span></label>
                <input id="brand-4" type="text" placeholder="Optional" autocomplete="off" />
              </div>
              <p class="field-hint muted">Press <kbd>Enter</kbd> in Brand 1 or use Run scan. Duplicate names (ignoring case) are skipped.</p>

              <details class="brand-profiles-details" id="brand-profiles-details">
                <summary>Brand profiles <span class="muted">(domains &amp; facts — improves GEO + AEO accuracy)</span></summary>
                <div class="brand-profiles-grid" id="brand-profiles-grid">
                  <div class="brand-profile-row" data-profile-row="1">
                    <p class="field-hint muted" style="margin:0">For <strong id="brand-profile-label-1">Brand 1</strong>:</p>
                    <div class="field">
                      <label for="brand-domains-1">Owned domains <span class="muted">(comma-separated)</span></label>
                      <input id="brand-domains-1" type="text" placeholder="acme.com, acme.io" autocomplete="off" />
                    </div>
                    <div class="field">
                      <label for="brand-facts-1">Verified facts <span class="muted">(optional)</span></label>
                      <textarea id="brand-facts-1" rows="2" placeholder="Headquartered in… Founded in… Products…"></textarea>
                    </div>
                  </div>
                  <div class="brand-profile-row" data-profile-row="2">
                    <p class="field-hint muted" style="margin:0">For <strong id="brand-profile-label-2">Brand 2</strong>:</p>
                    <div class="field">
                      <label for="brand-domains-2">Owned domains</label>
                      <input id="brand-domains-2" type="text" placeholder="comma-separated" autocomplete="off" />
                    </div>
                    <div class="field">
                      <label for="brand-facts-2">Verified facts</label>
                      <textarea id="brand-facts-2" rows="2"></textarea>
                    </div>
                  </div>
                  <div class="brand-profile-row" data-profile-row="3">
                    <p class="field-hint muted" style="margin:0">For <strong id="brand-profile-label-3">Brand 3</strong>:</p>
                    <div class="field">
                      <label for="brand-domains-3">Owned domains</label>
                      <input id="brand-domains-3" type="text" placeholder="comma-separated" autocomplete="off" />
                    </div>
                    <div class="field">
                      <label for="brand-facts-3">Verified facts</label>
                      <textarea id="brand-facts-3" rows="2"></textarea>
                    </div>
                  </div>
                  <div class="brand-profile-row" data-profile-row="4">
                    <p class="field-hint muted" style="margin:0">For <strong id="brand-profile-label-4">Brand 4</strong>:</p>
                    <div class="field">
                      <label for="brand-domains-4">Owned domains</label>
                      <input id="brand-domains-4" type="text" placeholder="comma-separated" autocomplete="off" />
                    </div>
                    <div class="field">
                      <label for="brand-facts-4">Verified facts</label>
                      <textarea id="brand-facts-4" rows="2"></textarea>
                    </div>
                  </div>
                </div>
                <p class="field-hint muted">Saved per company. Empty domains fall back to a guess like <code>{{brand}}.com</code>.</p>
              </details>

              <fieldset class="engines-field">
                <legend>Engines</legend>
                <label class="check"><input type="checkbox" name="engine" value="anthropic" checked /> Claude</label>
                <label class="check"><input type="checkbox" name="engine" value="openai" checked /> OpenAI</label>
                <label class="check"><input type="checkbox" name="engine" value="gemini" checked /> Gemini</label>
                <label class="check"><input type="checkbox" name="engine" value="perplexity" checked /> Perplexity</label>
              </fieldset>
              <button type="button" class="btn-primary" id="btn-scan">Run scan</button>
              <p id="scan-status" class="status-line muted"></p>
            </div>
          </section>

          <section id="view-recommendations" class="view is-hidden" data-view-panel="recommendations">
            <div class="page-title-row">
              <h1 class="page-title">Recommendations</h1>
            </div>
            <p class="subview-lead" id="recs-lead">
              Actionable steps to improve <strong id="recs-brand-label">Brand 1</strong>'s AEO and GEO scores from your latest audit.
            </p>
            <div class="recs-summary panel-card" id="recs-summary">
              <div class="recs-summary-scores">
                <span class="recs-pill recs-pill-tract">Tract <strong id="recs-tract-score">—</strong></span>
                <span class="recs-pill recs-pill-aeo">AEO <strong id="recs-aeo-score">—</strong></span>
                <span class="recs-pill recs-pill-geo">GEO <strong id="recs-geo-score">—</strong></span>
              </div>
            </div>
            <div id="recs-list" class="recs-list" role="list">
              <p class="muted">Loading recommendations…</p>
            </div>
          </section>

          <section id="view-tags" class="view is-hidden" data-view-panel="tags">
            <h2 class="subview-title">Tags</h2>
            <p class="subview-lead">Group scans and reports by campaign or product line — coming soon.</p>
            <div class="placeholder-card">No tags yet.</div>
          </section>

          <section id="view-tract-admin" class="view is-hidden" data-view-panel="tract-admin">
            <div class="page-title-row">
              <h1 class="page-title">Companies</h1>
            </div>
            <p class="subview-lead">Tract-internal view. Provision new enterprise customers and manage existing ones.</p>

            <div class="panel-card team-invite-card">
              <h3 style="margin-top:0">Create a new company</h3>
              <form id="tract-create-form" class="tract-create-form">
                <input type="text" id="tract-create-name" placeholder="Company name" autocomplete="off" required />
                <input type="email" id="tract-create-email" placeholder="First admin email" autocomplete="off" required />
                <button type="submit" class="btn-primary" id="tract-create-btn">Create</button>
              </form>
              <p id="tract-create-status" class="field-hint muted"></p>
            </div>

            <div class="panel-card">
              <h3 style="margin-top:0">All companies</h3>
              <div class="table-wrap">
                <table class="data-table tract-companies-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Plan</th>
                      <th>Members</th>
                      <th>Scans</th>
                      <th>Last activity</th>
                      <th>Status</th>
                      <th style="text-align:right">Actions</th>
                    </tr>
                  </thead>
                  <tbody id="tract-companies-body">
                    <tr><td colspan="7" class="muted">Loading…</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <section id="view-team" class="view is-hidden" data-view-panel="team">
            <div class="page-title-row">
              <h1 class="page-title">Team</h1>
            </div>
            <p class="subview-lead">Manage the people in your company. Employees can run audits and see all results; admins can additionally invite and remove members.</p>

            <div class="panel-card team-invite-card">
              <h3 style="margin-top:0">Invite an employee</h3>
              <form id="team-invite-form" class="team-invite-form">
                <input
                  type="email"
                  id="team-invite-email"
                  placeholder="name@company.com"
                  autocomplete="off"
                  required
                />
                <button type="submit" class="btn-primary" id="team-invite-btn">Send invite</button>
              </form>
              <p id="team-invite-status" class="field-hint muted"></p>
            </div>

            <div class="panel-card">
              <h3 style="margin-top:0">Members</h3>
              <div class="table-wrap">
                <table class="data-table team-table">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Joined</th>
                      <th style="text-align:right">Actions</th>
                    </tr>
                  </thead>
                  <tbody id="team-members-body">
                    <tr><td colspan="4" class="muted">Loading…</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  `;

  const el = {
    banner: root.querySelector("#api-banner"),
    ovKpiRow: root.querySelector("#ov-kpi-row"),
    ovVisPct: root.querySelector("#ov-vis-pct"),
    ovVisTrend: root.querySelector("#ov-vis-trend"),
    ovVisRing: root.querySelector("#ov-vis-ring"),
    ovAnswers: root.querySelector("#ov-answers"),
    ovAnswersTrend: root.querySelector("#ov-answers-trend"),
    ovCiteTotal: root.querySelector("#ov-cite-total"),
    ovCiteTrend: root.querySelector("#ov-cite-trend"),
    ovCiteBrand: root.querySelector("#ov-cite-brand"),
    ovCiteBrandTrend: root.querySelector("#ov-cite-brand-trend"),
    ovShare: root.querySelector("#ov-share"),
    ovShareNote: root.querySelector("#ov-share-note"),
    ovPosition: root.querySelector("#ov-position"),
    ovPositionNote: root.querySelector("#ov-position-note"),
    ovSrcTotal: root.querySelector("#ov-src-total"),
    ovSrcTotalPill: root.querySelector("#ov-src-total-pill"),
    ovSrcTotalSub: root.querySelector("#ov-src-total-sub"),
    ovSrcMention: root.querySelector("#ov-src-mention"),
    ovSrcMentionPill: root.querySelector("#ov-src-mention-pill"),
    ovSrcMentionSub: root.querySelector("#ov-src-mention-sub"),
    chartVisibility: root.querySelector("#chart-visibility"),
    leaderboardBody: root.querySelector("#leaderboard-body"),
    badgeBrands: root.querySelector("#badge-brands"),
    brand: root.querySelector("#brand"),
    btnScan: root.querySelector("#btn-scan"),
    scanStatus: root.querySelector("#scan-status"),
    promptList: root.querySelector("#prompt-list"),
    scansBody: root.querySelector("#scans-body"),
    auditSessionNote: root.querySelector("#audit-session-note"),
    recentActivityHint: root.querySelector("#recent-activity-hint"),
    recsList: root.querySelector("#recs-list"),
    recsBrandLabel: root.querySelector("#recs-brand-label"),
    recsTractScore: root.querySelector("#recs-tract-score"),
    recsAeoScore: root.querySelector("#recs-aeo-score"),
    recsGeoScore: root.querySelector("#recs-geo-score"),
    badgeRecs: root.querySelector("#badge-recs"),
    scoreBrandFilter: root.querySelector("#score-brand-filter"),
    scoreBrandSelect: root.querySelector("#score-brand-select"),
    tractScoreNumber: root.querySelector("#tract-score-number"),
    tractScoreMeta: root.querySelector("#tract-score-meta"),
    aeoCardTitle: root.querySelector("#aeo-card-title"),
    aeoCardBody: root.querySelector("#aeo-card-body"),
    geoCardTitle: root.querySelector("#geo-card-title"),
    geoCardBody: root.querySelector("#geo-card-body"),
  };

  /** Last stats payload — used so the brand-filter dropdown can re-render
   *  the score cards without re-fetching. */
  let currentStats = null;
  let currentScoreBrand = "__all__";

  /** Last `/api/scans` payload; used when opening a Supabase-backed study card. */
  let homeScansCache = [];
  /** Holds the latest or focused scan in this tab (see readLatestAudit). */
  let latestAuditMemory = null;

  const views = ["home", "overview", "recommendations", "prompts", "sources", "brands", "tags", "team", "tract-admin"];

  function showView(name) {
    views.forEach((v) => {
      const panel = root.querySelector(`[data-view-panel="${v}"]`);
      const link = root.querySelector(`.js-nav[data-view="${v}"]`);
      if (panel) panel.classList.toggle("is-hidden", v !== name);
      if (link) link.classList.toggle("is-active", v === name);
    });
    if (name === "home") {
      renderHomeStudies();
    } else if (name === "prompts") {
      loadPromptTemplatesEditor();
      refreshPrompts();
    } else if (name === "brands") {
      refreshPrompts();
      loadBrandProfilesIntoForm().then(refreshProfileLabels);
    } else if (name === "recommendations") {
      loadRecommendations();
    } else if (name === "team") {
      loadTeamMembers();
    } else if (name === "tract-admin") {
      loadTractCompanies();
    }
  }

  root.querySelectorAll(".js-nav").forEach((a) => {
    a.addEventListener("click", (ev) => {
      const v = a.getAttribute("data-view");
      if (!v) return;
      ev.preventDefault();
      showView(v);
      history.replaceState(null, "", `#view-${v}`);
    });
  });

  function syncViewFromHash() {
    const raw = (location.hash || "").replace(/^#\/?/, "");
    const name = raw.replace(/^view-/, "").split("/")[0];
    if (views.includes(name)) showView(name);
    else showView("home");
  }

  window.addEventListener("hashchange", syncViewFromHash);

  let promptTimer = null;
  let scanRunning = false;

  function showBanner(message, kind) {
    el.banner.textContent = message;
    el.banner.classList.remove("banner-hidden", "banner-warn", "banner-err");
    if (kind === "warn") el.banner.classList.add("banner-warn");
    else if (kind === "err") el.banner.classList.add("banner-err");
    if (!message) el.banner.classList.add("banner-hidden");
  }

  function leaderboardRow(idx, brand, count, mentionRatePct, sentimentLabel) {
    const hue = hashHue(brand);
    return `<tr>
      <td>${idx + 1}</td>
      <td>
        <div class="lb-brand">
          <span class="lb-avatar" style="background:hsl(${hue} 65% 42%)">${escapeHtml(brandInitials(brand))}</span>
          <span>${escapeHtml(brand)}</span>
        </div>
      </td>
      <td><strong>${mentionRatePct}%</strong></td>
      <td>${escapeHtml(sentimentLabel)}</td>
      <td class="muted">${count}</td>
    </tr>`;
  }

  const AUDIT_STORAGE_KEY = "tract:last-audit";
  const AUDIT_LIBRARY_KEY = "tract:audit-library";
  const MAX_LIBRARY_STUDIES = 12;

  function readAuditLibrary() {
    try {
      const raw = sessionStorage.getItem(AUDIT_LIBRARY_KEY);
      if (!raw) return {};
      const o = JSON.parse(raw);
      return o && typeof o === "object" ? o : {};
    } catch {
      return {};
    }
  }

  function writeAuditLibrary(lib) {
    const entries = Object.entries(lib).sort(
      (a, b) => (b[1].at || 0) - (a[1].at || 0)
    );
    const trimmed = Object.fromEntries(entries.slice(0, MAX_LIBRARY_STUDIES));
    try {
      sessionStorage.setItem(AUDIT_LIBRARY_KEY, JSON.stringify(trimmed));
    } catch (e) {
      console.warn("writeAuditLibrary:", e);
    }
  }

  function saveAuditToLibrary(snapshot) {
    const cid = snapshot.comparison_id;
    if (!cid) return;
    const lib = readAuditLibrary();
    lib[cid] = snapshot;
    writeAuditLibrary(lib);
  }

  function buildAuditSnapshotFromDbRows(rows, meta = {}) {
    const sorted = [...rows].sort(
      (a, b) =>
        new Date(b.created_at || 0).getTime() -
        new Date(a.created_at || 0).getTime()
    );
    const t0 = sorted[0]?.created_at
      ? new Date(sorted[0].created_at).getTime()
      : Date.now();
    const brands = mergeBrandsOrder(meta.brands || [], sorted);
    const comparisonId =
      meta.comparison_id ||
      sorted.find((r) => r.comparison_id)?.comparison_id ||
      null;
    const scanIds = [
      ...new Set(
        sorted.map((r) => r.scan_id).filter((id) => id != null && id !== "")
      ),
    ];
    const engines = [...new Set(sorted.map((r) => r.engine).filter(Boolean))];
    const results = sorted.map((row) => ({
      brand: row.brand,
      scan_id: row.scan_id || meta.scan_id,
      engine: row.engine,
      prompt: row.prompt,
      intent: row.intent || "other",
      response:
        row.response != null && String(row.response).trim() !== ""
          ? String(row.response)
          : "",
      analysis: {
        brand_mentioned: !!row.brand_mentioned,
        sentiment: row.sentiment,
        competitors_mentioned: Array.isArray(row.competitors_mentioned)
          ? row.competitors_mentioned
          : [],
      },
      source_count:
        row.source_count != null && row.source_count !== ""
          ? Math.max(0, Number(row.source_count) || 0)
          : 0,
      aeo_score: row.aeo_score == null ? null : Number(row.aeo_score),
      aeo_analysis: row.aeo_analysis || {},
      geo_score: row.geo_score == null ? null : Number(row.geo_score),
      geo_analysis: row.geo_analysis || {},
    }));
    return {
      at: t0,
      brands,
      brand: brands[0],
      comparison_id: comparisonId,
      scan_ids: scanIds.length ? scanIds : meta.scan_id ? [meta.scan_id] : [],
      scan_id: scanIds[0] || meta.scan_id,
      persisted: true,
      fromDb: true,
      engines,
      results,
    };
  }

  function applyFocusedAudit(audit) {
    if (!audit?.results?.length) return;
    latestAuditMemory = audit;
    try {
      sessionStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(audit));
    } catch (e) {
      console.warn("applyFocusedAudit:", e);
    }
  }

  async function renderHomeStudies() {
    const grid = root.querySelector("#home-study-grid");
    if (!grid) return;

    let lib = readAuditLibrary();
    if (Object.keys(lib).length === 0) {
      try {
        const raw = sessionStorage.getItem(AUDIT_STORAGE_KEY);
        if (raw) {
          const o = JSON.parse(raw);
          if (o?.comparison_id && Array.isArray(o.results) && o.results.length) {
            saveAuditToLibrary(o);
            lib = readAuditLibrary();
          }
        }
      } catch {
        /* ignore */
      }
    }

    const browserStudies = Object.values(lib).sort(
      (a, b) => (b.at || 0) - (a.at || 0)
    );

    let dbGroups = [];
    try {
      const { scans } = await fetchJson(apiUrl("/api/scans?limit=200"));
      homeScansCache = Array.isArray(scans) ? scans : [];
      const byGroup = {};
      for (const r of homeScansCache) {
        const cid =
          r.comparison_id != null && String(r.comparison_id).trim() !== ""
            ? String(r.comparison_id)
            : "";
        const sid = r.scan_id != null ? String(r.scan_id) : "";
        const gid = cid || (sid ? `scan:${sid}` : "");
        if (!gid) continue;
        if (!byGroup[gid]) byGroup[gid] = [];
        byGroup[gid].push(r);
      }
      dbGroups = Object.entries(byGroup)
        .map(([group_id, rows]) => {
          const comparison_id = rows[0]?.comparison_id || null;
          const scan_id = rows[0]?.scan_id != null ? String(rows[0].scan_id) : "";
          return {
            group_id,
            comparison_id,
            scan_id,
            rows,
            at: Math.max(
              0,
              ...rows.map((x) =>
                x.created_at ? new Date(x.created_at).getTime() : 0
              )
            ),
            brands: mergeBrandsOrder([], rows),
          };
        })
        .sort((a, b) => b.at - a.at)
        .slice(0, 24);
    } catch {
      homeScansCache = [];
    }

    if (browserStudies.length === 0 && dbGroups.length === 0) {
      grid.innerHTML = `<div class="study-empty muted">No audits yet. Run an audit from <strong>Run Audit</strong>, then return here.</div>`;
      return;
    }

    const parts = [];
    for (const a of browserStudies) {
      const brands =
        a.brands?.length > 0 ? a.brands.join(", ") : a.brand || "Study";
      const when = a.at ? new Date(a.at).toLocaleString() : "—";
      const n = a.results?.length || 0;
      const cid = escapeHtml(String(a.comparison_id || ""));
      parts.push(`<button type="button" class="study-card js-open-study" data-origin="library" data-comparison-id="${cid}" role="listitem">
      <h3 class="study-card-title">${escapeHtml(brands)}</h3>
      <p class="study-card-meta">${escapeHtml(when)}<br />${n} answers</p>
      <span class="study-card-badge">This browser</span>
    </button>`);
    }

    for (const g of dbGroups) {
      const when = g.at ? new Date(g.at).toLocaleString() : "—";
      const brands =
        g.brands.length > 0 ? g.brands.join(", ") : "Stored scan";
      const sid = escapeHtml(g.scan_id);
      const cid = g.comparison_id ? escapeHtml(String(g.comparison_id)) : "";
      const sidShort = escapeHtml(g.scan_id.slice(0, 8));
      parts.push(`<button type="button" class="study-card js-open-study" data-origin="db" data-scan-id="${sid}"${cid ? ` data-comparison-id="${cid}"` : ""} role="listitem">
      <h3 class="study-card-title">${escapeHtml(brands)}</h3>
      <p class="study-card-meta">${escapeHtml(when)}<br />${g.rows.length} stored rows</p>
      <span class="study-card-badge is-db">Supabase · ${sidShort}…</span>
    </button>`);
    }

    grid.innerHTML = parts.join("");
  }

  root.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".js-open-study");
    if (!btn) return;
    const origin = btn.getAttribute("data-origin");
    if (origin === "library") {
      const id = btn.getAttribute("data-comparison-id");
      if (!id) return;
      const audit = readAuditLibrary()[id];
      if (!audit?.results?.length) return;
      applyFocusedAudit(audit);
      showView("overview");
      history.replaceState(null, "", "#view-overview");
      void refreshAll();
      return;
    }
    if (origin === "db") {
      const comparisonId = btn.getAttribute("data-comparison-id");
      const scanId = btn.getAttribute("data-scan-id");
      let rows = [];
      if (comparisonId) {
        rows = (homeScansCache || []).filter(
          (r) => String(r.comparison_id || "") === comparisonId
        );
      } else if (scanId) {
        rows = (homeScansCache || []).filter(
          (r) => String(r.scan_id || "") === scanId
        );
      }
      if (!rows.length) return;
      const audit = buildAuditSnapshotFromDbRows(rows, {
        scan_id: scanId,
        comparison_id: comparisonId || null,
        brands: mergeBrandsOrder([], rows),
      });
      applyFocusedAudit(audit);
      showView("overview");
      history.replaceState(null, "", "#view-overview");
      void refreshAll();
    }
  });

  function readLatestAudit() {
    if (latestAuditMemory?.results?.length) return latestAuditMemory;
    try {
      const raw = sessionStorage.getItem(AUDIT_STORAGE_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || !Array.isArray(o.results) || o.results.length === 0) return null;
      latestAuditMemory = o;
      return o;
    } catch {
      return null;
    }
  }

  function writeLatestAudit(out) {
    const brands =
      Array.isArray(out.brands) && out.brands.length > 0
        ? out.brands
        : out.brand
          ? [out.brand]
          : [];
    const resultsThin = (out.results || []).map((r) => {
      const sc =
        r.source_count != null && r.source_count !== ""
          ? Math.max(0, Number(r.source_count) || 0)
          : Array.isArray(r.sources)
            ? r.sources.length
            : 0;
      const { sources: _urls, ...rest } = r;
      return { ...rest, source_count: sc };
    });
    const snapshot = {
      at: Date.now(),
      brands,
      brand: out.brand ?? brands[0],
      comparison_id: out.comparison_id,
      scan_ids: out.scan_ids,
      scan_id: out.scan_id,
      persisted: !!out.persisted,
      engines: out.engines,
      results: resultsThin,
    };
    latestAuditMemory = snapshot;
    try {
      sessionStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(snapshot));
    } catch (e) {
      console.warn(
        "writeLatestAudit: sessionStorage failed (responses kept for this tab until refresh):",
        e
      );
    }
    saveAuditToLibrary(snapshot);
  }

  function dominantSentiment(pb) {
    const p = pb.positive || 0;
    const n = pb.negative || 0;
    const u = pb.neutral || 0;
    if (p + n + u === 0) return "—";
    if (p >= n && p >= u) return "Positive";
    if (n >= p && n >= u) return "Negative";
    return "Neutral";
  }

  // -----------------------------------------------------------------------
  // AEO / GEO aggregation (frontend mirror of backend helpers in server.js)
  // Used so session-only audits get the same stat shape as DB-backed ones.
  // -----------------------------------------------------------------------

  function avgRounded(nums) {
    const arr = nums.filter((n) => Number.isFinite(n));
    if (arr.length === 0) return null;
    return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  }

  function buildAeoStatsForGroup(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return {
        n: 0, judged: 0, score: null,
        mix: { recommended: 0, mentioned: 0, negative: 0, omitted: 0 },
        avgAccuracy: null, byEngine: [], byIntent: [], trend: [],
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
      const s = Number(r.aeo_score);
      if (a && Object.keys(a).length > 0) judged += 1;
      const rec = String(a.recommendation || "omitted").toLowerCase();
      if (mix[rec] != null) mix[rec] += 1;
      if (Number.isFinite(s)) scores.push(s);
      if (Number.isFinite(Number(a.accuracy_score))) accs.push(Number(a.accuracy_score));
      const eng = r.engine || "(unknown)";
      if (!byEngineMap.has(eng)) byEngineMap.set(eng, []);
      if (Number.isFinite(s)) byEngineMap.get(eng).push(s);
      const it = r.intent || "other";
      if (!byIntentMap.has(it)) byIntentMap.set(it, []);
      if (Number.isFinite(s)) byIntentMap.get(it).push(s);
      const day =
        r.created_at && typeof r.created_at === "string"
          ? r.created_at.slice(0, 10)
          : null;
      if (day) {
        if (!dayMap.has(day)) dayMap.set(day, []);
        if (Number.isFinite(s)) dayMap.get(day).push(s);
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
        n: 0, scored: 0, score: null,
        ownDomainRate: 0, anyCitationRate: 0, avgAuthority: null,
        byEngine: [], byIntent: [], trend: [],
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
      const s = Number(r.geo_score);
      if (Number.isFinite(s)) { scores.push(s); scored += 1; }
      if (a.own_domain_cited) ownN += 1;
      if ((a.citation_count || 0) > 0) anyN += 1;
      if (Number.isFinite(Number(a.avg_authority))) auths.push(Number(a.avg_authority));
      const eng = r.engine || "(unknown)";
      if (!byEngineMap.has(eng)) byEngineMap.set(eng, []);
      if (Number.isFinite(s)) byEngineMap.get(eng).push(s);
      const it = r.intent || "other";
      if (!byIntentMap.has(it)) byIntentMap.set(it, []);
      if (Number.isFinite(s)) byIntentMap.get(it).push(s);
      const day =
        r.created_at && typeof r.created_at === "string"
          ? r.created_at.slice(0, 10)
          : null;
      if (day) {
        if (!dayMap.has(day)) dayMap.set(day, []);
        if (Number.isFinite(s)) dayMap.get(day).push(s);
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

  function computeTractScore(aeoScore, geoScore) {
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

  /** Build rows in the shape buildAeo/GeoStatsForGroup expects, from an audit. */
  function rowsFromAudit(audit) {
    const at = audit?.at || Date.now();
    const iso = new Date(at).toISOString();
    return (audit.results || []).map((r) => ({
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

  function statsFromAudit(audit) {
    const brandsOrder =
      Array.isArray(audit.brands) && audit.brands.length > 0
        ? audit.brands
        : audit.brand
          ? [audit.brand]
          : [];
    const results = audit.results || [];
    const n = results.length;
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
    const perBrand = {};
    function ensurePB(b) {
      const key = b || "(unknown)";
      if (!perBrand[key]) {
        perBrand[key] = {
          total: 0,
          mentions: 0,
          positive: 0,
          negative: 0,
          neutral: 0,
          competitors: 0,
        };
      }
      return perBrand[key];
    }

    for (const r of results) {
      const analysis = r.analysis || {};
      const rowBrand = resolveBrandName(r.brand, brandsOrder);
      const pb = ensurePB(rowBrand);
      pb.total += 1;

      const bm = !!analysis.brand_mentioned;
      if (bm) {
        mentions += 1;
        pb.mentions += 1;
      }
      byBrand[rowBrand] = (byBrand[rowBrand] || 0) + 1;
      if (rowBrand && rowBrand !== "(unknown)") brandNames.add(rowBrand);

      const e = r.engine || "(unknown)";
      byEngine[e] = (byEngine[e] || 0) + 1;
      if (!engineMention[e]) engineMention[e] = { total: 0, mentions: 0 };
      engineMention[e].total += 1;
      if (bm) engineMention[e].mentions += 1;

      const s = analysis.sentiment;
      if (s === "positive" || s === "negative" || s === "neutral") {
        sentimentCounts[s] += 1;
        pb[s] += 1;
      }

      const comp = analysis.competitors_mentioned;
      if (Array.isArray(comp) && comp.length > 0) {
        rowsWithCompetitors += 1;
        pb.competitors += 1;
      }

      const srcCount =
        r.source_count != null && r.source_count !== ""
          ? Math.max(0, Number(r.source_count) || 0)
          : Array.isArray(r.sources)
            ? r.sources.length
            : 0;
      totalSourcesCited += srcCount;
      if (bm) sourcesWhenBrandMentioned += srcCount;

      if (r.scan_id) scanIds.add(r.scan_id);
    }

    const engineMentionRates = Object.entries(engineMention)
      .map(([engine, { total, mentions: m }]) => ({
        engine,
        total,
        mentionRatePercent: total === 0 ? 0 : Math.round((m / total) * 100),
      }))
      .sort((a, b) => b.total - a.total);

    const orderedKeys = mergeBrandsOrder(brandsOrder, results);

    const brandComparison = orderedKeys.map((b) => {
      const key = resolveBrandName(b, brandsOrder);
      const pb = perBrand[key] || emptyPerBrandStats();
      return {
        brand: key,
        count: pb.total,
        mentionRatePercent:
          pb.total === 0 ? 0 : Math.round((pb.mentions / pb.total) * 100),
        competitorSignalPercent:
          pb.total === 0
            ? 0
            : Math.round((pb.competitors / pb.total) * 100),
        positive: pb.positive,
        negative: pb.negative,
        neutral: pb.neutral,
        dominantSentiment: dominantSentiment(pb),
      };
    });

    const topBrands = brandComparison
      .slice()
      .sort((a, b) => b.mentionRatePercent - a.mentionRatePercent)
      .map((x) => ({
        brand: x.brand,
        count: x.count,
        mentionRatePercent: x.mentionRatePercent,
        dominantSentiment: x.dominantSentiment,
      }));

    const scoreRows = rowsFromAudit(audit);
    const aeoOverall = buildAeoStatsForGroup(scoreRows);
    const aeoPerBrand = aggregatePerBrand(scoreRows, buildAeoStatsForGroup);
    const geoOverall = buildGeoStatsForGroup(scoreRows);
    const geoPerBrand = aggregatePerBrand(scoreRows, buildGeoStatsForGroup);
    const tractOverall = computeTractScore(aeoOverall.score, geoOverall.score);
    const tractPerBrand = {};
    for (const brand of Object.keys(aeoPerBrand)) {
      tractPerBrand[brand] = computeTractScore(
        aeoPerBrand[brand]?.score,
        geoPerBrand[brand]?.score
      );
    }

    return {
      totalScans: n,
      uniqueScanBatches: scanIds.size || (n ? 1 : 0),
      uniqueBrandsTracked: brandNames.size,
      rowsBrandMentioned: mentions,
      totalSourcesCited,
      sourcesWhenBrandMentioned,
      avgSourcesPerAnswer:
        n === 0 ? 0 : Math.round((totalSourcesCited / n) * 10) / 10,
      mentionRatePercent:
        n === 0 ? 0 : Math.round((mentions / n) * 100),
      competitorSignalPercent:
        n === 0 ? 0 : Math.round((rowsWithCompetitors / n) * 100),
      sentimentCounts,
      topBrands,
      brandComparison,
      brandsOrder: orderedKeys.map((b) => resolveBrandName(b, brandsOrder)),
      enginesUsed: Object.entries(byEngine)
        .sort((a, b) => b[1] - a[1])
        .map(([engine, count]) => ({ engine, count })),
      engineMentionRates,
      aeo: { overall: aeoOverall, byBrand: aeoPerBrand },
      geo: { overall: geoOverall, byBrand: geoPerBrand },
      tractScore: { overall: tractOverall, byBrand: tractPerBrand },
    };
  }

  function auditRowsForTable(audit) {
    const whenIso = audit.at
      ? new Date(audit.at).toISOString()
      : new Date().toISOString();
    return (audit.results || []).map((r) => {
      const analysis = r.analysis || {};
      const text =
        r.response != null && String(r.response).trim() !== ""
          ? String(r.response)
          : r.preview != null
            ? String(r.preview)
            : "";
      const rowBrand =
        r.brand || (Array.isArray(audit.brands) ? audit.brands[0] : "") || "";
      return {
        created_at: whenIso,
        brand: rowBrand,
        engine: r.engine,
        prompt: r.prompt,
        response: text,
        brand_mentioned: analysis.brand_mentioned,
        sentiment: analysis.sentiment,
        source_count:
          r.source_count != null && r.source_count !== ""
            ? Math.max(0, Number(r.source_count) || 0)
            : Array.isArray(r.sources)
              ? r.sources.length
              : 0,
      };
    });
  }

  // -----------------------------------------------------------------------
  // Score card renderers (Tract / AEO / GEO)
  // -----------------------------------------------------------------------

  function intentLabel(it) {
    const map = {
      informational: "Informational",
      comparison: "Comparison",
      reputation: "Reputation",
      recommendation: "Recommendation",
      alternatives: "Alternatives",
      best_of: "Best-of",
      other: "Other",
    };
    return map[it] || it || "—";
  }

  const ENGINE_HELP = {
    "openai": "OpenAI — ChatGPT-class model (GPT-4o-mini) asked about your brand. Web search is forced on, so it returns citations.",
    "claude": "Claude — Anthropic's assistant, asked about your brand with the web_search tool enabled so it returns citations.",
    "gemini": "Gemini — Google's assistant, asked about your brand with Google Search grounding enabled so it returns citations.",
    "perplexity": "Perplexity — a search-grounded answer engine. Always returns the sources it cites.",
  };
  const INTENT_HELP = {
    informational: "Informational — basic 'What is X?' questions about the brand.",
    comparison: "Comparison — 'Is X a good option vs competitors?' style questions.",
    reputation: "Reputation — 'What are people saying about X?' style questions.",
    recommendation: "Recommendation — direct 'Would you recommend X?' questions.",
    alternatives: "Alternatives — 'What are the best alternatives to X?' questions.",
    best_of: "Best-of — 'What's the best X?' shopping-style questions.",
    other: "Other — prompts that don't fall into a specific intent.",
  };
  const RECOMMENDATION_HELP = {
    recommended: "Recommended — the AI explicitly recommended or endorsed your brand in its answer.",
    mentioned: "Mentioned — your brand was named or listed but not actively recommended.",
    negative: "Negative — the AI spoke critically about your brand or flagged concerns.",
    omitted: "Omitted — your brand name didn't appear in the answer at all.",
  };

  function helpIcon(text, label) {
    if (!text) return "";
    const safe = escapeHtml(text);
    const aria = escapeHtml(label || `Help: ${String(text).slice(0, 60)}`);
    return `<span class="help-dot" tabindex="0" role="img" aria-label="${aria}" title="${safe}">?</span>`;
  }

  function engineHelp(name) {
    const key = String(name || "").toLowerCase();
    return ENGINE_HELP[key] || `${name} — one of the AI models we asked about your brand.`;
  }

  function intentHelp(it) {
    return INTENT_HELP[String(it || "").toLowerCase()] || INTENT_HELP.other;
  }

  function recommendationPill(rec, n, total) {
    const pct = total > 0 ? Math.round((n / total) * 100) : 0;
    const cls =
      rec === "recommended" ? "pill pill-pos"
      : rec === "negative" ? "pill pill-neg"
      : rec === "omitted" ? "pill pill-neu"
      : "pill pill-neu";
    return `<span class="${cls}" title="${pct}% of judged rows">${escapeHtml(rec)} · ${n}${helpIcon(RECOMMENDATION_HELP[rec], `What "${rec}" means`)}</span>`;
  }

  function renderAeoTrend(trend) {
    if (!Array.isArray(trend) || trend.length === 0) {
      return `<p class="muted">Trend over time will appear once you have audits from two or more days.</p>`;
    }
    if (trend.length === 1) {
      const t = trend[0];
      return `<p class="muted">Single day so far (<strong>${escapeHtml(t.day)}</strong> · ${t.score ?? "—"}). Re-run the audit later to build a trend.</p>`;
    }
    const max = 100;
    const w = 320;
    const h = 60;
    const pad = 4;
    const pts = trend.map((t, i) => {
      const x = pad + (i * (w - pad * 2)) / Math.max(1, trend.length - 1);
      const v = Number.isFinite(Number(t.score)) ? Number(t.score) : 0;
      const y = h - pad - (v / max) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const poly = pts.join(" ");
    const last = trend[trend.length - 1];
    return `<div class="aeo-trend">
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="AEO trend">
        <polyline fill="none" stroke="currentColor" stroke-width="2" points="${poly}" />
      </svg>
      <span class="muted">${trend.length} days · latest ${escapeHtml(last.day)} ${last.score ?? "—"}</span>
    </div>`;
  }

  function renderAeoBreakdown(title, items, keyName, helpText) {
    if (!Array.isArray(items) || items.length === 0) return "";
    const rows = items
      .map((it, i) => {
        const label =
          keyName === "intent" ? intentLabel(it.intent) : it[keyName];
        const raw = Number(it.score);
        const hasScore = Number.isFinite(raw);
        const pct = hasScore ? Math.max(0, Math.min(100, Math.round(raw))) : 0;
        const fillWidth = hasScore ? (pct > 0 ? Math.max(pct, 2) : 0) : 0;
        const value = hasScore ? String(pct) : "—";
        const [from, to] =
          VISIBILITY_BAR_PALETTE[i % VISIBILITY_BAR_PALETTE.length];
        const rowStyle = `--row-from:${from};--row-to:${to}`;
        const rowHelp =
          keyName === "intent" ? intentHelp(it.intent) : engineHelp(it.engine);
        return `<div class="score-line-row" role="img" aria-label="${escapeHtml(label || "—")} score ${value}" style="${rowStyle}">
          <span class="score-line-label" title="${escapeHtml(label || "—")}">${escapeHtml(label || "—")}${helpIcon(rowHelp, `What ${label} means`)}</span>
          <div class="score-line-track">
            <div class="score-line-fill" style="width:${fillWidth}%"></div>
          </div>
          <span class="score-line-value">${value}</span>
          <span class="score-line-meta muted">${it.n} rows</span>
        </div>`;
      })
      .join("");
    return `<div class="aeo-block">
      <h4>${escapeHtml(title)}${helpIcon(helpText, `What "${title}" shows`)}</h4>
      <div class="score-line-list">${rows}</div>
    </div>`;
  }

  /** SVG ring (0–100). Uses currentColor so each card's --card-accent paints it. */
  function renderScoreRing(score, sublabel) {
    const pct =
      Number.isFinite(Number(score))
        ? Math.max(0, Math.min(100, Math.round(Number(score))))
        : 0;
    const hasScore = Number.isFinite(Number(score));
    const r = 50;
    const c = 2 * Math.PI * r;
    const dash = (pct / 100) * c;
    const display = hasScore ? String(pct) : "—";
    return `<div class="score-ring" role="img" aria-label="Score ${display} of 100">
      <svg viewBox="0 0 120 120">
        <circle class="score-ring-track" cx="60" cy="60" r="${r}" fill="none" stroke-width="12" />
        <circle class="score-ring-arc" cx="60" cy="60" r="${r}" fill="none" stroke-width="12"
          stroke-linecap="round"
          stroke-dasharray="${dash.toFixed(2)} ${c.toFixed(2)}"
          transform="rotate(-90 60 60)" />
        <text x="60" y="58" class="score-ring-number" text-anchor="middle" dominant-baseline="middle">${display}</text>
        <text x="60" y="82" class="score-ring-sub" text-anchor="middle">/ 100</text>
      </svg>
      ${sublabel ? `<div class="score-ring-caption muted">${sublabel}</div>` : ""}
    </div>`;
  }

  function renderAeoCard(stats, brandLabel) {
    const aeoTitleHtml = `AEO score · ${escapeHtml(brandLabel)}${helpIcon(
      "AEO (Answer Engine Optimization) score: 0–100. Combines whether the AI recommended your brand (40 pts), where it ranked it (20 pts), how it was mentioned (15 pts), and whether the facts were correct (25 pts).",
      "What the AEO score means"
    )}`;
    if (!stats || stats.n === 0 || stats.judged === 0) {
      el.aeoCardTitle.innerHTML = aeoTitleHtml;
      el.aeoCardBody.innerHTML = `<p class="muted">No AEO judgements yet — run a scan with <code>OPENAI_API_KEY</code> set.</p>`;
      return;
    }
    const total = stats.judged || stats.n;
    el.aeoCardTitle.innerHTML = aeoTitleHtml;
    el.aeoCardBody.innerHTML = `
      <div class="aeo-headline">
        ${renderScoreRing(stats.score, `${stats.judged} judged`)}
        <div class="aeo-score-meta">
          <div><strong>${stats.judged}</strong> judged of ${stats.n} answers</div>
          <p class="aeo-headline-help muted">
            The ring shows the average AEO score (0–100) across every answer
            we judged for this brand.
          </p>
        </div>
      </div>
      <div class="aeo-mix-wrap">
        <h4 class="aeo-mix-title">Recommendation mix${helpIcon(
          "How the AI treated your brand across all judged answers. Hover any pill to see what that label means.",
          "What 'Recommendation mix' shows"
        )}</h4>
        <div class="aeo-mix">
          ${recommendationPill("recommended", stats.mix.recommended || 0, total)}
          ${recommendationPill("mentioned",   stats.mix.mentioned   || 0, total)}
          ${recommendationPill("negative",    stats.mix.negative    || 0, total)}
          ${recommendationPill("omitted",     stats.mix.omitted     || 0, total)}
        </div>
      </div>
      <div class="aeo-breakdown-row">
        ${renderAeoBreakdown(
          "By engine",
          stats.byEngine,
          "engine",
          "Average AEO score broken down by which AI tool answered (ChatGPT, Claude, Gemini, etc.)."
        )}
        ${renderAeoBreakdown(
          "By intent",
          stats.byIntent,
          "intent",
          "Average AEO score by what kind of question was asked — e.g. comparisons, recommendations, reputation."
        )}
      </div>
      <div class="aeo-block">
        <h4>Trend over time${helpIcon(
          "Average AEO score charted day by day. We bucket scans by the day they ran. With just one day of data you'll see a single point; re-run later to build a real line.",
          "What 'Trend over time' shows"
        )}</h4>
        ${renderAeoTrend(stats.trend)}
      </div>
    `;
  }

  function renderGeoCard(stats, brandLabel) {
    const geoTitleHtml = `GEO score · ${escapeHtml(brandLabel)}${helpIcon(
      "GEO (Generative Engine Optimization) score: 0–100. Combines whether the AI cited your own domain (30 pts), whether it cited any source (25 pts), how trustworthy those sources are (25 pts), and whether it recommended you while citing sources (20 pts).",
      "What the GEO score means"
    )}`;
    if (!stats || stats.n === 0) {
      el.geoCardTitle.innerHTML = geoTitleHtml;
      el.geoCardBody.innerHTML = `<p class="muted">No citation data yet.</p>`;
      return;
    }
    el.geoCardTitle.innerHTML = geoTitleHtml;
    el.geoCardBody.innerHTML = `
      <div class="aeo-headline">
        ${renderScoreRing(stats.score, `${stats.scored} scored`)}
        <div class="aeo-score-meta">
          <div><strong>${stats.scored}</strong> scored of ${stats.n} answers</div>
          <p class="aeo-headline-help muted">
            The ring shows the average GEO score (0–100) across every answer
            we scored for this brand.
          </p>
        </div>
      </div>
      <div class="aeo-mix-wrap">
        <h4 class="aeo-mix-title">Citation mix${helpIcon(
          "How often the AI's answers included citations, and how often those citations pointed to your own website.",
          "What 'Citation mix' shows"
        )}</h4>
        <div class="aeo-mix">
          <span class="pill pill-pos">own domain · ${stats.ownDomainRate}%${helpIcon(
            "Share of all answers where the AI cited a page on your own website (matched against the brand profile's domains).",
            "What 'own domain' means"
          )}</span>
          <span class="pill pill-neu">any citation · ${stats.anyCitationRate}%${helpIcon(
            "Share of all answers that included at least one citation, regardless of which website it pointed to.",
            "What 'any citation' means"
          )}</span>
        </div>
      </div>
      <div class="aeo-breakdown-row">
        ${renderAeoBreakdown(
          "By engine",
          stats.byEngine,
          "engine",
          "Average GEO score broken down by which AI tool answered."
        )}
        ${renderAeoBreakdown(
          "By intent",
          stats.byIntent,
          "intent",
          "Average GEO score by the kind of question being asked."
        )}
      </div>
      <div class="aeo-block">
        <h4>Trend over time${helpIcon(
          "Average GEO score charted day by day. Citation behaviour varies a lot between engines, so use this for direction (trending up vs. down), not exact week-over-week comparisons.",
          "What 'Trend over time' shows"
        )}</h4>
        ${renderAeoTrend(stats.trend)}
      </div>
    `;
  }

  function renderTractScoreCard(score, brandLabel, aeoStats, geoStats) {
    el.tractScoreNumber.textContent = score == null ? "—" : String(score);
    const parts = [];
    if (aeoStats?.score != null) parts.push(`AEO ${aeoStats.score}`);
    if (geoStats?.score != null) parts.push(`GEO ${geoStats.score}`);
    el.tractScoreMeta.innerHTML = parts.length
      ? `<span>${brandLabel}</span> · <span class="muted">${parts.join(" · ")}</span>`
      : `<span class="muted">No scored answers yet — run a scan.</span>`;
  }

  function populateScoreBrandSelector(stats) {
    const sel = el.scoreBrandSelect;
    if (!sel) return;
    const brands = [
      ...new Set([
        ...(stats?.brandsOrder || []),
        ...Object.keys(stats?.aeo?.byBrand || {}),
        ...Object.keys(stats?.geo?.byBrand || {}),
      ]),
    ].filter(Boolean);
    const filterWrap = el.scoreBrandFilter;
    if (brands.length <= 1) {
      if (filterWrap) filterWrap.classList.add("is-hidden");
      sel.innerHTML = `<option value="__all__">All brands (pooled)</option>`;
      currentScoreBrand = "__all__";
      return;
    }
    if (filterWrap) filterWrap.classList.remove("is-hidden");
    const opts = [`<option value="__all__">All brands (pooled)</option>`].concat(
      brands.map(
        (b) =>
          `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`
      )
    );
    sel.innerHTML = opts.join("");
    if (
      currentScoreBrand !== "__all__" &&
      !brands.some((b) => b === currentScoreBrand)
    ) {
      currentScoreBrand = "__all__";
    }
    sel.value = currentScoreBrand;
  }

  function sliceScoreStatsForBrand(stats, brand) {
    if (!stats) return { aeo: null, geo: null, score: null, brandLabel: "—" };
    if (brand === "__all__" || !brand) {
      return {
        aeo: stats.aeo?.overall || null,
        geo: stats.geo?.overall || null,
        score: stats.tractScore?.overall ?? null,
        brandLabel: "All brands",
      };
    }
    return {
      aeo: stats.aeo?.byBrand?.[brand] || null,
      geo: stats.geo?.byBrand?.[brand] || null,
      score: stats.tractScore?.byBrand?.[brand] ?? null,
      brandLabel: brand,
    };
  }

  function renderScoreCardsForCurrentBrand() {
    if (!currentStats) return;
    const slice = sliceScoreStatsForBrand(currentStats, currentScoreBrand);
    renderTractScoreCard(slice.score, slice.brandLabel, slice.aeo, slice.geo);
    renderAeoCard(slice.aeo, slice.brandLabel);
    renderGeoCard(slice.geo, slice.brandLabel);
  }

  // -----------------------------------------------------------------------
  // Brand-profile form helpers (domains + facts per audited brand)
  // -----------------------------------------------------------------------

  function parseDomainsCsv(value) {
    return String(value || "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function getBrandProfilesFromForm() {
    const out = [];
    for (let i = 1; i <= 4; i++) {
      const brandInput = root.querySelector(
        i === 1 ? "#brand" : `#brand-${i}`
      );
      const brand = brandInput && String(brandInput.value || "").trim();
      if (!brand) continue;
      const domains = parseDomainsCsv(
        root.querySelector(`#brand-domains-${i}`)?.value || ""
      );
      const facts = String(
        root.querySelector(`#brand-facts-${i}`)?.value || ""
      ).trim();
      if (domains.length === 0 && !facts) continue;
      out.push({ brand, domains, facts });
    }
    return out;
  }

  function applyBrandProfilesToForm(profiles) {
    const byBrand = new Map();
    for (const p of profiles || []) {
      const k = String(p?.brand || "").trim().toLowerCase();
      if (k) byBrand.set(k, p);
    }
    for (let i = 1; i <= 4; i++) {
      const brandInput = root.querySelector(
        i === 1 ? "#brand" : `#brand-${i}`
      );
      const brand = brandInput && String(brandInput.value || "").trim();
      const p = brand ? byBrand.get(brand.toLowerCase()) : null;
      const dEl = root.querySelector(`#brand-domains-${i}`);
      const fEl = root.querySelector(`#brand-facts-${i}`);
      if (!p) {
        if (dEl) dEl.value = "";
        if (fEl) fEl.value = "";
        continue;
      }
      if (dEl) dEl.value = Array.isArray(p.domains) ? p.domains.join(", ") : "";
      if (fEl) fEl.value = String(p.facts || "");
    }
  }

  async function loadBrandProfilesIntoForm() {
    try {
      const out = await fetchJson(apiUrl("/api/brand-profiles"));
      applyBrandProfilesToForm(out?.brandProfiles || []);
    } catch {
      /* not signed in / no profiles — silent */
    }
  }

  function refreshProfileLabels() {
    for (let i = 1; i <= 4; i++) {
      const labelEl = root.querySelector(`#brand-profile-label-${i}`);
      const brandInput = root.querySelector(i === 1 ? "#brand" : `#brand-${i}`);
      const row = root.querySelector(`[data-profile-row="${i}"]`);
      const v = brandInput ? String(brandInput.value || "").trim() : "";
      if (labelEl) labelEl.textContent = v || `Brand ${i}`;
      if (row) row.classList.toggle("is-dim", !v);
    }
  }

  /** Wipes the in-tab audit + all Test Results visuals back to their
   *  pre-scan placeholders. Called when the user clicks "Run new audit"
   *  so the next scan replaces (rather than overlays) the previous one. */
  function resetTestResults() {
    latestAuditMemory = null;
    try {
      sessionStorage.removeItem(AUDIT_STORAGE_KEY);
    } catch (_) {
      /* ignore */
    }

    currentStats = null;
    currentScoreBrand = "__all__";

    if (el.auditSessionNote) el.auditSessionNote.classList.add("is-hidden");

    if (el.ovVisPct) el.ovVisPct.textContent = "—";
    if (el.ovVisTrend) {
      el.ovVisTrend.textContent = "";
      el.ovVisTrend.className = "metric-trend";
    }
    if (el.ovVisRing) el.ovVisRing.style.setProperty("--ring-pct", "0");
    if (el.ovAnswers) el.ovAnswers.textContent = "—";
    if (el.ovAnswersTrend) el.ovAnswersTrend.textContent = "no scan yet";
    if (el.ovCiteTotal) el.ovCiteTotal.textContent = "—";
    if (el.ovCiteTrend) el.ovCiteTrend.textContent = "";
    if (el.ovCiteBrand) el.ovCiteBrand.textContent = "—";
    if (el.ovCiteBrandTrend) el.ovCiteBrandTrend.textContent = "";
    if (el.ovShare) el.ovShare.textContent = "—";
    if (el.ovShareNote) el.ovShareNote.textContent = "";

    if (el.ovSrcTotal) el.ovSrcTotal.textContent = "—";
    if (el.ovSrcMention) el.ovSrcMention.textContent = "—";
    if (el.ovSrcTotalPill) {
      el.ovSrcTotalPill.textContent = "—";
      el.ovSrcTotalPill.className = "metric-src-pill is-muted";
    }
    if (el.ovSrcTotalSub) el.ovSrcTotalSub.textContent = "run a scan";
    if (el.ovSrcMentionPill) {
      el.ovSrcMentionPill.textContent = "—";
      el.ovSrcMentionPill.className = "metric-src-pill is-muted";
    }
    if (el.ovSrcMentionSub) el.ovSrcMentionSub.textContent = "—";

    if (el.ovPosition) el.ovPosition.textContent = "—";
    if (el.ovPositionNote) el.ovPositionNote.textContent = "run a scan";

    if (el.ovKpiRow) el.ovKpiRow.innerHTML = "";
    if (el.badgeBrands) el.badgeBrands.textContent = "0";
    if (el.badgeRecs) el.badgeRecs.textContent = "0";
    if (el.recsList)
      el.recsList.innerHTML = `<p class="muted">Run an audit to see recommendations for Brand 1.</p>`;

    if (el.tractScoreNumber) el.tractScoreNumber.textContent = "—";
    if (el.tractScoreMeta) el.tractScoreMeta.textContent = "No data yet.";
    if (el.aeoCardTitle) el.aeoCardTitle.textContent = "AEO score";
    if (el.aeoCardBody)
      el.aeoCardBody.innerHTML = `<p class="muted">No AEO judgements yet — run a scan.</p>`;
    if (el.geoCardTitle) el.geoCardTitle.textContent = "GEO score";
    if (el.geoCardBody)
      el.geoCardBody.innerHTML = `<p class="muted">No citation data yet.</p>`;
    if (el.scoreBrandFilter) el.scoreBrandFilter.classList.add("is-hidden");
    if (el.scoreBrandSelect) el.scoreBrandSelect.innerHTML = "";

    if (el.scansBody)
      el.scansBody.innerHTML = `<tr><td colspan="8" class="muted center">No rows yet.</td></tr>`;
    if (el.recentActivityHint) el.recentActivityHint.textContent = "";

    const compareWrap = root.querySelector("#brand-compare-wrap");
    const compareBody = root.querySelector("#brand-compare-body");
    if (compareBody)
      compareBody.innerHTML = `<tr><td colspan="5" class="center muted">No scans yet — run one from Run Audit.</td></tr>`;
    if (compareWrap) compareWrap.classList.add("is-hidden");

    if (el.chartVisibility) el.chartVisibility.innerHTML = "";
    const chartSent = root.querySelector("#chart-sentiment");
    if (chartSent) chartSent.innerHTML = "";

    if (el.leaderboardBody)
      el.leaderboardBody.innerHTML = `<tr><td colspan="5" class="center muted">No scans yet — run one from Run Audit.</td></tr>`;
  }

  function applyStatsPayload(s, source) {
    const total = s.totalScans || 0;
    const mention = s.mentionRatePercent ?? 0;
    const mentionRows = s.rowsBrandMentioned ?? 0;
    const batches = s.uniqueScanBatches ?? 0;
    const brandsN = s.uniqueBrandsTracked ?? 0;
    const compPct = s.competitorSignalPercent ?? 0;
    const { positive = 0, negative = 0, neutral = 0 } = s.sentimentCounts || {};
    const sumS = positive + negative + neutral;

    el.ovVisPct.textContent = `${mention}%`;
    el.ovVisTrend.textContent =
      total === 0 ? "—" : mention >= 50 ? "↑ vs baseline" : "↓ tune prompts";
    el.ovVisTrend.className =
      "metric-trend " + (mention >= 50 ? "up" : "down");
    el.ovVisRing.style.setProperty("--ring-pct", String(Math.min(100, mention)));

    el.ovAnswers.textContent = String(total);
    el.ovAnswersTrend.textContent =
      source === "session" ? "this run (not saved)" : "stored answers";

    el.ovCiteTotal.textContent = String(batches);
    el.ovCiteTrend.textContent =
      source === "session" && brandsN > 1
        ? "one batch per brand"
        : source === "session"
          ? "one batch"
          : "scan_id groups";
    el.ovCiteBrand.textContent = String(brandsN);
    el.ovCiteBrandTrend.textContent = "distinct brands";

    el.ovShare.textContent = `${compPct}%`;
    el.ovShareNote.textContent = "competitor phrases";

    const totalSrc = s.totalSourcesCited ?? 0;
    const srcMention = s.sourcesWhenBrandMentioned ?? 0;
    const avgAll = s.avgSourcesPerAnswer ?? 0;
    el.ovSrcTotal.textContent = formatCount(totalSrc);
    el.ovSrcMention.textContent = formatCount(srcMention);
    if (total === 0) {
      el.ovSrcTotalPill.textContent = "—";
      el.ovSrcTotalPill.className = "metric-src-pill is-muted";
      el.ovSrcTotalSub.textContent = "run a scan";
      el.ovSrcMentionPill.textContent = "—";
      el.ovSrcMentionPill.className = "metric-src-pill is-muted";
      el.ovSrcMentionSub.textContent = "—";
    } else {
      el.ovSrcTotalPill.textContent = `avg ${avgAll}`;
      el.ovSrcTotalPill.className = "metric-src-pill metric-trend up";
      el.ovSrcTotalSub.textContent =
        source === "session" ? "this audit" : "stored rows";
      if (mentionRows > 0) {
        const avgM =
          Math.round((srcMention / mentionRows) * 10) / 10;
        el.ovSrcMentionPill.textContent = `avg ${avgM}`;
        el.ovSrcMentionPill.className = "metric-src-pill metric-trend up";
        el.ovSrcMentionSub.textContent = `${mentionRows} mention answers`;
      } else {
        el.ovSrcMentionPill.textContent = "—";
        el.ovSrcMentionPill.className = "metric-src-pill is-muted";
        el.ovSrcMentionSub.textContent = "no mentions yet";
      }
    }

    const top = (s.topBrands || [])[0];
    el.ovPosition.textContent = top ? top.brand : "—";
    el.ovPositionNote.textContent = top
      ? brandsN > 1
        ? `highest visibility (${top.mentionRatePercent ?? "—"}%)`
        : `${top.count} rows`
      : "run a scan";

    const visScore = Math.min(6, Math.max(0, Math.round((mention / 100) * 6)));
    const sentScore =
      sumS === 0 ? 0 : Math.min(6, Math.round((positive / sumS) * 6));
    const posScore = Math.min(6, brandsN);
    const aeoChip =
      s.aeo?.overall?.score != null
        ? `<span class="kpi-chip"><span class="dot ok"></span> AEO: ${s.aeo.overall.score}/100</span>`
        : "";
    const geoChip =
      s.geo?.overall?.score != null
        ? `<span class="kpi-chip"><span class="dot ok"></span> GEO: ${s.geo.overall.score}/100</span>`
        : "";
    const tractChip =
      s.tractScore?.overall != null
        ? `<span class="kpi-chip"><span class="dot ok"></span> Tract: ${s.tractScore.overall}/100</span>`
        : "";
    el.ovKpiRow.innerHTML = `
      <span class="kpi-chip"><span class="dot ok"></span> Visibility: ${visScore}/6</span>
      <span class="kpi-chip"><span class="dot ${sentScore >= 3 ? "ok" : "warn"}"></span> Sentiment: ${sumS ? `${positive}/${sumS}` : "—"}</span>
      <span class="kpi-chip"><span class="dot ok"></span> Position: ${posScore}/6</span>
      ${tractChip}${aeoChip}${geoChip}
    `;

    const bc = s.brandComparison || [];

    el.chartVisibility.innerHTML = renderVisibilityChart(s);
    const chartSent = root.querySelector("#chart-sentiment");
    if (chartSent) {
      chartSent.innerHTML = renderSentimentByBrandChart(bc, s.sentimentCounts);
    }

    const compareWrap = root.querySelector("#brand-compare-wrap");
    const compareBody = root.querySelector("#brand-compare-body");
    if (compareWrap && compareBody) {
      if (bc.length > 1) {
        compareWrap.classList.remove("is-hidden");
        compareBody.innerHTML = bc
          .map((row, i) => {
            const sent = escapeHtml(row.dominantSentiment || "—");
            const cls = sentimentClass(
              String(row.dominantSentiment || "").toLowerCase()
            );
            const swatch = brandSwatchColor(i);
            return `<tr>
              <td>
                <span class="brand-cell">
                  <span class="brand-swatch" style="background:${swatch}" aria-hidden="true"></span>
                  <strong>${escapeHtml(row.brand)}</strong>
                </span>
              </td>
              <td>${row.count}</td>
              <td><strong>${row.mentionRatePercent}%</strong></td>
              <td>${row.competitorSignalPercent}%</td>
              <td><span class="${cls}">${sent}</span></td>
            </tr>`;
          })
          .join("");
      } else {
        compareWrap.classList.add("is-hidden");
        compareBody.innerHTML = "";
      }
    }

    const brands = s.topBrands || [];
    const maxC = Math.max(1, ...brands.map((b) => b.count));
    el.leaderboardBody.innerHTML = brands.length
      ? brands
          .map((b, i) => {
            const vis =
              b.mentionRatePercent != null
                ? b.mentionRatePercent
                : Math.min(98, Math.round(35 + (b.count / maxC) * 55));
            const sentimentLabel =
              b.dominantSentiment ||
              ["Strong", "Mixed", "Watch"][Math.abs(hashHue(b.brand)) % 3];
            return leaderboardRow(
              i,
              b.brand,
              b.count,
              vis,
              sentimentLabel
            );
          })
          .join("")
      : `<tr><td colspan="5" class="center muted">No scans yet — run one from Run Audit.</td></tr>`;

    el.badgeBrands.textContent = String(brandsN);

    // Score cards (Tract / AEO / GEO) — driven by the brand selector.
    currentStats = s;
    populateScoreBrandSelector(s);
    renderScoreCardsForCurrentBrand();
  }

  async function loadStats() {
    const audit = readLatestAudit();
    if (audit?.results?.length) {
      if (audit.fromDb) {
        if (el.auditSessionNote) el.auditSessionNote.classList.add("is-hidden");
        applyStatsPayload(statsFromAudit(audit), "db");
        showBanner("", "");
        return;
      }
      if (el.auditSessionNote) {
        const nb =
          Array.isArray(audit.brands) && audit.brands.length > 0
            ? audit.brands.length
            : audit.brand
              ? 1
              : 0;
        el.auditSessionNote.textContent =
          nb > 1
            ? `Showing your latest comparison audit (${nb} brands) from this browser only. Rows are not saved unless the API has PERSIST_SCANS=true.`
            : "Showing your latest audit from this browser only. Rows are not saved unless the API has PERSIST_SCANS=true.";
        el.auditSessionNote.classList.remove("is-hidden");
      }
      applyStatsPayload(statsFromAudit(audit), "session");
      showBanner("", "");
      return;
    }
    if (el.auditSessionNote) el.auditSessionNote.classList.add("is-hidden");
    try {
      const s = await fetchJson(apiUrl("/api/stats"));
      applyStatsPayload(s, "db");
      showBanner("", "");
    } catch (e) {
      showBanner(
        `Cannot load dashboard (is the API running on port 3001?). ${e.message}`,
        "err"
      );
    }
  }

  function renderScanRows(rows) {
    if (!rows || rows.length === 0) {
      el.scansBody.innerHTML = `<tr><td colspan="8" class="muted center">No rows yet.</td></tr>`;
      return;
    }
    el.scansBody.innerHTML = rows
      .map((row) => {
        const t = formatTime(row.created_at || row.inserted_at);
        const pr = escapeHtml((row.prompt || "").slice(0, 72));
        const mention = row.brand_mentioned ? "Yes" : "No";
        const sent = escapeHtml(row.sentiment || "—");
        const srcN =
          row.source_count != null && row.source_count !== ""
            ? Math.max(0, Number(row.source_count) || 0)
            : 0;
        const respRaw = String(row.response ?? row.preview ?? "").trim();
        const respInner = respRaw
          ? `<div class="response-cell-inner">${escapeHtml(respRaw)}</div>`
          : `<span class="muted">—</span>`;
        return `<tr>
            <td class="nowrap">${t}</td>
            <td>${escapeHtml(row.brand || "")}</td>
            <td>${escapeHtml(row.engine || "")}</td>
            <td>${mention}</td>
            <td><span class="${sentimentClass(row.sentiment)}">${sent}</span></td>
            <td class="prompt-cell" title="${escapeHtml(row.prompt || "")}">${pr}${(row.prompt || "").length > 72 ? "…" : ""}</td>
            <td class="response-cell">${respInner}</td>
            <td class="nowrap center">${srcN}</td>
          </tr>`;
      })
      .join("");
  }

  function renderRecommendationCard(rec) {
    const areaLabel =
      rec.area === "aeo" ? "AEO" : rec.area === "geo" ? "GEO" : "Overview";
    const actions = (rec.actions || [])
      .map((a) => `<li>${escapeHtml(a)}</li>`)
      .join("");
    return `<article class="rec-card rec-severity-${escapeHtml(rec.severity)}" role="listitem">
      <div class="rec-card-head">
        <span class="rec-area rec-area-${escapeHtml(rec.area)}">${escapeHtml(areaLabel)}</span>
        <span class="rec-severity">${escapeHtml(rec.severity)}</span>
      </div>
      <h3 class="rec-title">${escapeHtml(rec.title)}</h3>
      <p class="rec-evidence muted">${escapeHtml(rec.evidence)}</p>
      <ul class="rec-actions">${actions}</ul>
    </article>`;
  }

  async function loadRecommendations() {
    if (!el.recsList) return;
    el.recsList.innerHTML = `<p class="muted">Loading recommendations…</p>`;

    const audit = readLatestAudit();
    const payload = {};
    if (audit?.results?.length) {
      payload.brands =
        Array.isArray(audit.brands) && audit.brands.length
          ? audit.brands
          : audit.brand
            ? [audit.brand]
            : [];
      payload.results = audit.results;
      payload.at = audit.at;
      payload.brand = payload.brands[0] || audit.brand;
    }

    try {
      const out = await fetchJson(apiUrl("/api/recommendations"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const brand = out?.brand || payload.brand || "Brand 1";
      if (el.recsBrandLabel) el.recsBrandLabel.textContent = brand;

      const tract = out?.tractScore;
      const aeo = out?.aeo?.score;
      const geo = out?.geo?.score;
      if (el.recsTractScore)
        el.recsTractScore.textContent =
          tract == null ? "—" : `${tract}/100`;
      if (el.recsAeoScore)
        el.recsAeoScore.textContent = aeo == null ? "—" : `${aeo}/100`;
      if (el.recsGeoScore)
        el.recsGeoScore.textContent = geo == null ? "—" : `${geo}/100`;

      const recs = Array.isArray(out?.recommendations) ? out.recommendations : [];
      if (el.badgeRecs) el.badgeRecs.textContent = String(recs.length);

      if (recs.length === 0) {
        el.recsList.innerHTML = `<p class="muted">${escapeHtml(out?.message || "No recommendations yet — run an audit with Brand 1 filled in.")}</p>`;
        return;
      }

      el.recsList.innerHTML = recs.map(renderRecommendationCard).join("");
    } catch (e) {
      el.recsList.innerHTML = `<p class="muted">Could not load recommendations: ${escapeHtml(e.message)}</p>`;
      if (el.badgeRecs) el.badgeRecs.textContent = "0";
    }
  }

  async function loadScans() {
    const audit = readLatestAudit();
    if (audit?.results?.length) {
      if (el.recentActivityHint) {
        const nb =
          Array.isArray(audit.brands) && audit.brands.length > 0
            ? audit.brands.length
            : 1;
        el.recentActivityHint.textContent =
          nb > 1
            ? `Latest audit: ${nb} brands (${audit.brands.join(", ")}). Same data as Test Results. Not written to Supabase unless PERSIST_SCANS=true.`
            : "Latest audit in this browser (same data as Test Results). Not written to Supabase unless PERSIST_SCANS=true.";
      }
      renderScanRows(auditRowsForTable(audit));
      return;
    }
    if (el.recentActivityHint) el.recentActivityHint.textContent = "";
    try {
      const { scans } = await fetchJson(apiUrl("/api/scans?limit=40"));
      renderScanRows(scans);
    } catch (e) {
      el.scansBody.innerHTML = `<tr><td colspan="8" class="center err">${escapeHtml(e.message)}</td></tr>`;
    }
  }

  async function loadPromptTemplatesEditor() {
    const editor = root.querySelector("#prompt-templates-editor");
    const status = root.querySelector("#prompt-templates-status");
    if (!editor) return;
    if (status) status.textContent = "";
    editor.innerHTML = `<p class="muted">Loading templates…</p>`;
    try {
      const { templates } = await fetchJson(apiUrl("/api/prompt-templates"));
      editor.innerHTML = (templates || [])
        .map(
          (t, i) => `
        <div class="field prompt-template-field">
          <label for="prompt-tmpl-${i}">Prompt ${i + 1}</label>
          <textarea id="prompt-tmpl-${i}" class="prompt-template-input" rows="3">${escapeHtml(t)}</textarea>
        </div>`
        )
        .join("");
    } catch (e) {
      editor.innerHTML = `<p class="err">${escapeHtml(e.message)}</p>`;
    }
  }

  async function refreshPrompts() {
    const brand = el.brand.value.trim();
    if (!brand) {
      el.promptList.innerHTML = `<li class="muted">Enter a brand on <strong>Run Audit</strong> to preview prompts here.</li>`;
      return;
    }
    try {
      const { prompts } = await fetchJson(
        apiUrl(`/api/prompts?brand=${encodeURIComponent(brand)}`)
      );
      el.promptList.innerHTML = (prompts || [])
        .map((p) => `<li>${escapeHtml(p)}</li>`)
        .join("");
    } catch (e) {
      el.promptList.innerHTML = `<li class="err">${escapeHtml(e.message)}</li>`;
    }
  }

  async function refreshAll() {
    await loadStats();
    await loadScans();
  }

  root.querySelector("#btn-save-templates").addEventListener("click", async () => {
    const status = root.querySelector("#prompt-templates-status");
    const areas = root.querySelectorAll(".prompt-template-input");
    const templates = [...areas].map((a) => a.value);
    if (templates.length === 0) {
      if (status) status.textContent = "Nothing to save — reload the Prompts page.";
      return;
    }
    if (status) status.textContent = "Saving…";
    showBanner("", "");
    try {
      await fetchJson(apiUrl("/api/prompt-templates"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templates }),
      });
      if (status) status.textContent = "Saved to server.";
      await loadPromptTemplatesEditor();
      await refreshPrompts();
    } catch (e) {
      if (status) status.textContent = "";
      showBanner(`Save failed: ${e.message}`, "err");
    }
  });

  root.querySelector("#btn-reload-templates").addEventListener("click", async () => {
    await loadPromptTemplatesEditor();
    await refreshPrompts();
  });

  el.brand.addEventListener("input", () => {
    clearTimeout(promptTimer);
    promptTimer = setTimeout(refreshPrompts, 280);
  });

  root.querySelector("#btn-refresh-lb").addEventListener("click", () => {
    refreshAll();
  });

  function getBrandsFromRunAuditForm() {
    const ids = ["#brand", "#brand-2", "#brand-3", "#brand-4"];
    const seen = new Set();
    const out = [];
    for (const id of ids) {
      const input = root.querySelector(id);
      const v = input && String(input.value || "").trim();
      if (!v) continue;
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
    return out;
  }

  async function runScanFromUi() {
    if (scanRunning) return;
    const brands = getBrandsFromRunAuditForm();
    if (brands.length === 0) {
      el.scanStatus.textContent = "Enter at least one brand (Brand 1 is required).";
      return;
    }
    const engines = [...root.querySelectorAll('input[name="engine"]:checked')].map(
      (x) => x.value
    );
    if (engines.length === 0) {
      el.scanStatus.textContent = "Select at least one engine.";
      return;
    }

    scanRunning = true;
    el.btnScan.disabled = true;
    el.scanStatus.textContent = "Running scan… this may take a few minutes.";
    showBanner("", "");

    const brandProfiles = getBrandProfilesFromForm();
    try {
      const out = await fetchJson(apiUrl("/api/scan"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brands, engines, brandProfiles }),
      });
      writeLatestAudit(out);
      if (Array.isArray(out.brandProfiles)) {
        applyBrandProfilesToForm(out.brandProfiles);
      }
      const label =
        out.brands && out.brands.length > 1
          ? `${out.brands.length} brands (${out.brands.join(", ")})`
          : out.brands[0];
      const extras = [];
      if (out.judged != null) extras.push(`${out.judged} AEO-judged`);
      if (out.geoScored != null) extras.push(`${out.geoScored} GEO-scored`);
      const extraStr = extras.length ? ` · ${extras.join(", ")}` : "";
      el.scanStatus.textContent = out.persisted
        ? `Finished: saved ${out.saved} of ${out.total} rows for ${label}${extraStr}.`
        : `Finished: ${out.total} rows for ${label}${extraStr} (not saved — viewable in Test Results in this browser).`;
      if (out.persisted && out.saved < out.total) {
        const hint =
          Array.isArray(out.saveErrors) && out.saveErrors.length > 0
            ? out.saveErrors.join(" · ")
            : "Check API logs and Supabase.";
        showBanner(`Some rows failed: ${hint}`, "warn");
      }
      if (Array.isArray(out.engineErrors) && out.engineErrors.length > 0) {
        showBanner(
          `Some engines returned errors: ${out.engineErrors.join(" · ")}`,
          "warn"
        );
      }
      await refreshAll();
      void loadRecommendations();
    } catch (e) {
      el.scanStatus.textContent = "";
      showBanner(`Scan failed: ${e.message}`, "err");
    } finally {
      scanRunning = false;
      el.btnScan.disabled = false;
    }
  }

  el.btnScan.addEventListener("click", runScanFromUi);
  el.brand.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      runScanFromUi();
    }
  });

  root
    .querySelector("#btn-home-new-audit")
    ?.addEventListener("click", () => {
      resetTestResults();
    });

  el.scoreBrandSelect?.addEventListener("change", (ev) => {
    currentScoreBrand = String(ev.target.value || "__all__");
    renderScoreCardsForCurrentBrand();
  });

  for (let i = 1; i <= 4; i++) {
    const id = i === 1 ? "#brand" : `#brand-${i}`;
    root.querySelector(id)?.addEventListener("input", refreshProfileLabels);
  }
  refreshProfileLabels();

  // ------- Auth bootstrap -------
  const gate = root.querySelector("#auth-gate");
  const gateLoading = root.querySelector("#auth-loading");
  const gateSignin = root.querySelector("#auth-signin-mode");
  const gateForgot = root.querySelector("#auth-forgot-mode");
  const gateRecover = root.querySelector("#auth-recover-mode");
  const gateNoCompany = root.querySelector("#auth-nocompany-mode");
  const gateError = root.querySelector("#auth-error");

  function showGateMode(mode) {
    gateLoading.classList.toggle("is-hidden", mode !== "loading");
    gateSignin.classList.toggle("is-hidden", mode !== "signin");
    gateForgot.classList.toggle("is-hidden", mode !== "forgot");
    gateRecover.classList.toggle("is-hidden", mode !== "recover");
    gateNoCompany.classList.toggle("is-hidden", mode !== "no-company");
    gate.classList.remove("is-hidden");
  }

  function setGateError(msg) {
    if (!msg) {
      gateError.classList.add("is-hidden");
      gateError.textContent = "";
      return;
    }
    gateError.textContent = msg;
    gateError.classList.remove("is-hidden");
  }

  let currentUser = null;

  function revealAdminNav(isAdmin) {
    root
      .querySelector("#side-admin-label")
      .classList.toggle("is-hidden", !isAdmin);
    root
      .querySelector("#nav-team-li")
      .classList.toggle("is-hidden", !isAdmin);
  }

  function paintTopbarUser(user) {
    const emailEl = root.querySelector("#topbar-email");
    const companyEl = root.querySelector("#topbar-company");
    if (emailEl) emailEl.textContent = user?.email || "";
    if (companyEl) {
      companyEl.textContent = user?.tract_role
        ? `Tract · ${user.tract_role}`
        : user?.company_id
          ? "Your company"
          : "—";
    }
    revealAdminNav(user?.company_role === "admin");
    revealTractNav(!!user?.tract_role);
  }

  function revealTractNav(isStaff) {
    root
      .querySelector("#side-tract-label")
      .classList.toggle("is-hidden", !isStaff);
    root
      .querySelector("#nav-tract-admin-li")
      .classList.toggle("is-hidden", !isStaff);
  }

  // ------- Team view (PR-2) -------
  function renderTeamRow(member) {
    const email = escapeHtml(member.email || "—");
    const role = member.role === "admin" ? "admin" : "employee";
    const joined = formatTime(member.joined_at);
    const isSelf =
      currentUser && member.user_id && member.user_id === currentUser.id;
    const promoteLabel = role === "admin" ? "Make employee" : "Make admin";
    const promoteRole = role === "admin" ? "employee" : "admin";
    return `<tr data-member-id="${escapeHtml(member.id)}">
      <td>${email}${isSelf ? ' <span class="muted">(you)</span>' : ""}</td>
      <td><span class="role-pill role-${role}">${role}</span></td>
      <td>${joined}</td>
      <td style="text-align:right">
        <button type="button" class="btn-ghost btn-sm js-team-role" data-role="${promoteRole}">${promoteLabel}</button>
        <button type="button" class="btn-ghost btn-sm js-team-remove"${isSelf ? ' disabled title="You can\'t remove yourself"' : ""}>Remove</button>
      </td>
    </tr>`;
  }

  async function loadTeamMembers() {
    const body = root.querySelector("#team-members-body");
    if (!body) return;
    body.innerHTML = `<tr><td colspan="4" class="muted">Loading…</td></tr>`;
    try {
      const out = await fetchJson(apiUrl("/api/company/members"));
      const members = Array.isArray(out?.members) ? out.members : [];
      if (members.length === 0) {
        body.innerHTML = `<tr><td colspan="4" class="muted">No members yet.</td></tr>`;
        return;
      }
      body.innerHTML = members.map(renderTeamRow).join("");
    } catch (e) {
      body.innerHTML = `<tr><td colspan="4" class="muted">Failed to load: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  async function doInvite(ev) {
    ev.preventDefault();
    const input = root.querySelector("#team-invite-email");
    const status = root.querySelector("#team-invite-status");
    const btn = root.querySelector("#team-invite-btn");
    const email = (input.value || "").trim();
    if (!email) return;
    status.textContent = "Sending invite…";
    btn.disabled = true;
    try {
      const out = await fetchJson(apiUrl("/api/company/employees"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      status.textContent = out.invitedFresh
        ? `Invite sent to ${email}.`
        : `${email} already had an account — added to your company.`;
      input.value = "";
      loadTeamMembers();
    } catch (e) {
      status.textContent = `Failed: ${e.message}`;
    } finally {
      btn.disabled = false;
    }
  }

  async function handleTeamClick(ev) {
    const tr = ev.target.closest("tr[data-member-id]");
    if (!tr) return;
    const memberId = tr.getAttribute("data-member-id");

    if (ev.target.classList.contains("js-team-role")) {
      const newRole = ev.target.getAttribute("data-role");
      ev.target.disabled = true;
      try {
        await fetchJson(apiUrl(`/api/company/members/${memberId}`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: newRole }),
        });
        loadTeamMembers();
      } catch (e) {
        ev.target.disabled = false;
        showBanner(`Role change failed: ${e.message}`, "err");
      }
      return;
    }

    if (ev.target.classList.contains("js-team-remove")) {
      if (!confirm("Remove this member from the company?")) return;
      ev.target.disabled = true;
      try {
        await fetchJson(apiUrl(`/api/company/members/${memberId}`), {
          method: "DELETE",
        });
        loadTeamMembers();
      } catch (e) {
        ev.target.disabled = false;
        showBanner(`Remove failed: ${e.message}`, "err");
      }
    }
  }

  root.querySelector("#team-invite-form").addEventListener("submit", doInvite);
  root
    .querySelector("#team-members-body")
    .addEventListener("click", handleTeamClick);

  // ------- Tract-admin view (PR-3) -------
  function renderTractCompanyRow(c) {
    const isDeactivated = !!c.deactivated_at;
    const statusPill = isDeactivated
      ? '<span class="role-pill role-employee">Deactivated</span>'
      : '<span class="role-pill role-admin">Active</span>';
    const last = c.last_activity ? formatTime(c.last_activity) : "—";
    const toggleLabel = isDeactivated ? "Reactivate" : "Deactivate";
    const toggleAction = isDeactivated ? "reactivate" : "deactivate";
    return `<tr data-company-id="${escapeHtml(c.id)}">
      <td>${escapeHtml(c.name)}<br><span class="muted" style="font-size:11px">${escapeHtml(c.slug || "—")}</span></td>
      <td>${escapeHtml(c.plan || "—")}</td>
      <td>${formatCount(c.member_count)}</td>
      <td>${formatCount(c.scan_count)}</td>
      <td>${last}</td>
      <td>${statusPill}</td>
      <td style="text-align:right">
        <button type="button" class="btn-ghost btn-sm js-tract-add-admin">Add admin</button>
        <button type="button" class="btn-ghost btn-sm js-tract-toggle" data-action="${toggleAction}">${toggleLabel}</button>
      </td>
    </tr>`;
  }

  async function loadTractCompanies() {
    const body = root.querySelector("#tract-companies-body");
    if (!body) return;
    body.innerHTML = `<tr><td colspan="7" class="muted">Loading…</td></tr>`;
    try {
      const out = await fetchJson(apiUrl("/api/internal/companies"));
      const companies = Array.isArray(out?.companies) ? out.companies : [];
      if (companies.length === 0) {
        body.innerHTML = `<tr><td colspan="7" class="muted">No companies yet.</td></tr>`;
        return;
      }
      body.innerHTML = companies.map(renderTractCompanyRow).join("");
    } catch (e) {
      body.innerHTML = `<tr><td colspan="7" class="muted">Failed to load: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  async function doCreateCompany(ev) {
    ev.preventDefault();
    const nameEl = root.querySelector("#tract-create-name");
    const emailEl = root.querySelector("#tract-create-email");
    const status = root.querySelector("#tract-create-status");
    const btn = root.querySelector("#tract-create-btn");
    const name = (nameEl.value || "").trim();
    const adminEmail = (emailEl.value || "").trim();
    if (!name || !adminEmail) return;
    status.textContent = "Creating…";
    btn.disabled = true;
    try {
      const out = await fetchJson(apiUrl("/api/internal/companies"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, adminEmail }),
      });
      status.textContent = out.invitedFresh
        ? `Created "${out.company.name}". Invite sent to ${adminEmail}.`
        : `Created "${out.company.name}". ${adminEmail} already had an account — added as admin.`;
      nameEl.value = "";
      emailEl.value = "";
      loadTractCompanies();
    } catch (e) {
      status.textContent = `Failed: ${e.message}`;
    } finally {
      btn.disabled = false;
    }
  }

  async function handleTractRowClick(ev) {
    const tr = ev.target.closest("tr[data-company-id]");
    if (!tr) return;
    const companyId = tr.getAttribute("data-company-id");

    if (ev.target.classList.contains("js-tract-add-admin")) {
      const email = prompt("Admin email to add:");
      if (!email) return;
      ev.target.disabled = true;
      try {
        const out = await fetchJson(
          apiUrl(`/api/internal/companies/${companyId}/admins`),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: email.trim() }),
          }
        );
        const note = out.alreadyAdmin
          ? "Already an admin."
          : out.promoted
            ? "Promoted existing member to admin."
            : out.invitedFresh
              ? "Invite sent."
              : "Existing account added as admin.";
        showBanner(note, "");
        loadTractCompanies();
      } catch (e) {
        showBanner(`Add admin failed: ${e.message}`, "err");
      } finally {
        ev.target.disabled = false;
      }
      return;
    }

    if (ev.target.classList.contains("js-tract-toggle")) {
      const action = ev.target.getAttribute("data-action");
      if (
        action === "deactivate" &&
        !confirm("Deactivate this company? Members keep their accounts but the company is marked inactive.")
      )
        return;
      ev.target.disabled = true;
      try {
        await fetchJson(
          apiUrl(`/api/internal/companies/${companyId}/${action}`),
          { method: "POST" }
        );
        loadTractCompanies();
      } catch (e) {
        ev.target.disabled = false;
        showBanner(`${action} failed: ${e.message}`, "err");
      }
    }
  }

  root
    .querySelector("#tract-create-form")
    .addEventListener("submit", doCreateCompany);
  root
    .querySelector("#tract-companies-body")
    .addEventListener("click", handleTractRowClick);

  async function doSignOut() {
    try {
      await supabase.auth.signOut();
    } finally {
      location.reload();
    }
  }

  root
    .querySelector("#auth-signin-form")
    .addEventListener("submit", async (ev) => {
      ev.preventDefault();
      setGateError("");
      const email = root.querySelector("#auth-email").value.trim();
      const password = root.querySelector("#auth-password").value;
      const btn = root.querySelector("#auth-submit");
      btn.disabled = true;
      const prevLabel = btn.textContent;
      btn.textContent = "Signing in…";
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      btn.disabled = false;
      btn.textContent = prevLabel;
      if (error) {
        setGateError(error.message);
        return;
      }
      // Re-run mount cleanly after sign-in.
      location.reload();
    });

  // ---- Forgot password flow ----
  const forgotStatus = root.querySelector("#auth-forgot-status");
  function setForgotStatus(msg, kind) {
    if (!msg) {
      forgotStatus.classList.add("is-hidden");
      forgotStatus.textContent = "";
      forgotStatus.classList.remove("auth-info-ok", "auth-info-err");
      return;
    }
    forgotStatus.textContent = msg;
    forgotStatus.classList.remove("is-hidden", "auth-info-ok", "auth-info-err");
    if (kind === "ok") forgotStatus.classList.add("auth-info-ok");
    else if (kind === "err") forgotStatus.classList.add("auth-info-err");
  }

  root.querySelector("#auth-forgot-link").addEventListener("click", () => {
    setGateError("");
    setForgotStatus("");
    const prefill = root.querySelector("#auth-email")?.value?.trim() || "";
    if (prefill) root.querySelector("#auth-forgot-email").value = prefill;
    showGateMode("forgot");
  });

  root.querySelector("#auth-forgot-back").addEventListener("click", () => {
    setGateError("");
    setForgotStatus("");
    showGateMode("signin");
  });

  root
    .querySelector("#auth-forgot-form")
    .addEventListener("submit", async (ev) => {
      ev.preventDefault();
      setGateError("");
      setForgotStatus("");
      const email = root.querySelector("#auth-forgot-email").value.trim();
      if (!email) return;
      const btn = root.querySelector("#auth-forgot-submit");
      btn.disabled = true;
      const prevLabel = btn.textContent;
      btn.textContent = "Sending…";
      // After clicking the reset link in the email, Supabase will redirect
      // here with a recovery token in the URL hash. `detectSessionInUrl`
      // (in supabase.js) consumes it and fires PASSWORD_RECOVERY below.
      const redirectTo = `${window.location.origin}${window.location.pathname}`;
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo,
      });
      btn.disabled = false;
      btn.textContent = prevLabel;
      if (error) {
        setForgotStatus(error.message, "err");
        return;
      }
      setForgotStatus(
        `If an account exists for ${email}, a reset link is on its way. Check your inbox (and spam).`,
        "ok",
      );
    });

  // ---- Recovery flow (user clicks reset link in email) ----
  const recoverStatus = root.querySelector("#auth-recover-status");
  function setRecoverStatus(msg, kind) {
    if (!msg) {
      recoverStatus.classList.add("is-hidden");
      recoverStatus.textContent = "";
      recoverStatus.classList.remove("auth-info-ok", "auth-info-err");
      return;
    }
    recoverStatus.textContent = msg;
    recoverStatus.classList.remove(
      "is-hidden",
      "auth-info-ok",
      "auth-info-err",
    );
    if (kind === "ok") recoverStatus.classList.add("auth-info-ok");
    else if (kind === "err") recoverStatus.classList.add("auth-info-err");
  }

  let recoveryActive = false;

  supabase.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") {
      recoveryActive = true;
      setGateError("");
      setRecoverStatus("");
      showGateMode("recover");
    }
  });

  root
    .querySelector("#auth-recover-form")
    .addEventListener("submit", async (ev) => {
      ev.preventDefault();
      setRecoverStatus("");
      const pw1 = root.querySelector("#auth-recover-password").value;
      const pw2 = root.querySelector("#auth-recover-password-2").value;
      if (pw1.length < 8) {
        setRecoverStatus("Password must be at least 8 characters.", "err");
        return;
      }
      if (pw1 !== pw2) {
        setRecoverStatus("Passwords don't match.", "err");
        return;
      }
      const btn = root.querySelector("#auth-recover-submit");
      btn.disabled = true;
      const prevLabel = btn.textContent;
      btn.textContent = "Updating…";
      const { error } = await supabase.auth.updateUser({ password: pw1 });
      btn.disabled = false;
      btn.textContent = prevLabel;
      if (error) {
        setRecoverStatus(error.message, "err");
        return;
      }
      setRecoverStatus(
        "Password updated. Signing you in…",
        "ok",
      );
      // Clear any recovery tokens that may still be in the URL.
      try {
        history.replaceState(null, "", window.location.pathname);
      } catch (_) {}
      setTimeout(() => location.reload(), 600);
    });

  root.querySelector("#btn-signout").addEventListener("click", doSignOut);
  root
    .querySelector("#btn-signout-empty")
    .addEventListener("click", doSignOut);

  function isRecoveryUrl() {
    const hash = window.location.hash || "";
    const search = window.location.search || "";
    return (
      hash.includes("type=recovery") ||
      search.includes("type=recovery") ||
      recoveryActive
    );
  }

  async function bootstrap() {
    // If the user landed via the password reset email, stay on the
    // "set a new password" screen instead of dropping them into the app.
    if (isRecoveryUrl()) {
      recoveryActive = true;
      showGateMode("recover");
      return;
    }

    showGateMode("loading");
    let session = null;
    try {
      const { data } = await supabase.auth.getSession();
      session = data?.session || null;
    } catch (e) {
      setGateError(`Auth error: ${e.message || e}`);
      showGateMode("signin");
      return;
    }

    if (!session) {
      showGateMode("signin");
      return;
    }

    let me;
    try {
      me = await fetchJson(apiUrl("/api/auth/me"));
    } catch (e) {
      // Token invalid or API unreachable — fall back to sign-in.
      setGateError(`Could not verify session: ${e.message || e}`);
      showGateMode("signin");
      return;
    }

    const user = me?.user;
    if (!user?.company_id) {
      root.querySelector("#auth-nocompany-email").textContent =
        user?.email || "—";
      showGateMode("no-company");
      return;
    }

    currentUser = user;
    paintTopbarUser(user);
    gate.classList.add("is-hidden");
    syncViewFromHash();
    refreshPrompts();
    void loadPromptTemplatesEditor();
    refreshAll();
  }

  bootstrap();
}
