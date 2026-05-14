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

async function fetchJson(url, options) {
  const res = await fetch(url, options);
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
      ? `No API at this URL (${res.status}). On Netlify, set environment variable VITE_API_URL to your hosted API origin (no trailing slash), then redeploy.`
      : body?.error || res.statusText || `HTTP ${res.status}`;
    throw new Error(
      typeof msg === "string" && msg.length > 400 ? `${msg.slice(0, 400)}…` : msg
    );
  }
  if (looksLikeHtml) {
    throw new Error(
      "Unexpected HTML response. Set VITE_API_URL to your API server and redeploy."
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

function renderVisibilityChart(mentionPct) {
  const w = 400;
  const h = 120;
  const pad = 12;
  const pts = [];
  for (let i = 0; i < 7; i++) {
    const v = Math.max(
      8,
      Math.min(92, mentionPct + Math.sin(i * 1.1) * 14 + (i - 3) * 2)
    );
    pts.push(v);
  }
  const n = pts.length - 1;
  const pathD = pts
    .map((v, i) => {
      const x = pad + (i / n) * (w - pad * 2);
      const y = pad + (1 - v / 100) * (h - pad * 2);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  const areaD = `${pathD} L ${(w - pad).toFixed(1)} ${h - pad} L ${pad} ${h - pad} Z`;
  return `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${areaD}" fill="url(#chartFill)" />
      <path d="${pathD}" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `;
}

/** Multi-line visibility-style chart when comparing brands (trend around each brand's mention %). */
function renderVisibilityMultiBrand(brandComparison, overallMention) {
  const rows = (brandComparison || []).filter((b) => b && b.brand);
  if (rows.length <= 1) {
    const m =
      rows[0]?.mentionRatePercent != null
        ? rows[0].mentionRatePercent
        : overallMention;
    return renderVisibilityChart(m);
  }

  const w = 400;
  const h = 160;
  const padL = 40;
  const padR = 12;
  const padT = 14;
  const padB = 12;
  const gw = w - padL - padR;
  const gh = h - padT - padB;
  const days = 7;
  const n = days - 1;

  function yForPct(pct) {
    return padT + (1 - Math.min(100, Math.max(0, pct)) / 100) * gh;
  }
  function xForDay(i) {
    return padL + (i / n) * gw;
  }

  let grid = "";
  for (const pct of [0, 25, 50, 75, 100]) {
    const y = yForPct(pct);
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${(w - padR).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-dasharray="3 4" stroke-width="1" />`;
    grid += `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#64748b">${pct}%</text>`;
  }

  let paths = "";
  rows.forEach((row, bi) => {
    const center = row.mentionRatePercent ?? 0;
    const hue = hashHue(row.brand);
    const stroke = `hsl(${hue} 70% 42%)`;
    const pts = [];
    for (let k = 0; k < days; k++) {
      const v = Math.max(
        4,
        Math.min(
          96,
          center + Math.sin(k * 1.05 + bi * 0.45) * 14 + (k - 3) * 2.5
        )
      );
      pts.push(v);
    }
    const d = pts
      .map((v, i) => {
        const x = xForDay(i);
        const y = yForPct(v);
        return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
    paths += `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`;
  });

  const legend = rows
    .map((row) => {
      const hue = hashHue(row.brand);
      const stroke = `hsl(${hue} 70% 42%)`;
      return `<span class="chart-legend-item"><span class="chart-legend-swatch" style="background:${stroke}"></span>${escapeHtml(row.brand)} (${row.mentionRatePercent}%)</span>`;
    })
    .join("");

  return `
    <p class="chart-caption muted">Illustrative trend around each brand's mention rate for this audit (not a historical time series).</p>
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="chart-svg-main" aria-hidden="true">
      ${grid}
      ${paths}
    </svg>
    <div class="chart-legend">${legend}</div>
  `;
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
};

export function mount(root) {
  root.innerHTML = `
    <div class="app">
      <header class="topbar">
        <a href="#view-overview" class="topbar-logo js-nav" data-view="overview" aria-label="Tract AI — Test Results">
          <span class="topbar-logo-mark">T</span>
          Tract AI
        </a>
        <div class="topbar-account" title="Wire to your workspace later">
          <span class="topbar-account-label">Accounts</span>
          <span class="topbar-account-value">tract.ai / demo</span>
        </div>
        <div class="topbar-search-wrap">
          <label class="topbar-search">
            <span class="muted" aria-hidden="true">🔍</span>
            <input type="search" placeholder="Search" autocomplete="off" />
          </label>
        </div>
        <div class="topbar-avatar" title="Profile" role="img" aria-label="User"></div>
      </header>

      <div class="shell">
        <aside class="sidebar" aria-label="Sidebar">
          <div class="side-section-label">General</div>
          <ul class="side-nav">
            <li><a href="#view-prompts" class="js-nav" data-view="prompts">${ICON.prompts} Prompts</a></li>
            <li>
              <a href="#view-brands" class="js-nav" data-view="brands">${ICON.brands} Run Audit <span class="badge" id="badge-brands">0</span></a>
            </li>
            <li><a href="#view-overview" class="js-nav is-active" data-view="overview">${ICON.overview} Test Results</a></li>
            <li><a href="#view-sources" class="js-nav" data-view="sources">${ICON.sources} Sources</a></li>
          </ul>
          <div class="side-section-label">Project</div>
          <ul class="side-nav">
            <li><a href="#view-tags" class="js-nav" data-view="tags">${ICON.tags} Tags</a></li>
          </ul>
        </aside>

        <div class="content">
          <p id="api-banner" class="banner banner-hidden" role="status"></p>

          <section id="view-overview" class="view" data-view-panel="overview">
            <div class="page-title-row">
              <h1 class="page-title">Test Results</h1>
              <div class="kpi-chips" id="ov-kpi-row">
                <span class="kpi-chip"><span class="dot ok"></span> Visibility: —</span>
                <span class="kpi-chip"><span class="dot warn"></span> Sentiment: —</span>
                <span class="kpi-chip"><span class="dot ok"></span> Position: —</span>
              </div>
            </div>
            <p id="audit-session-note" class="session-audit-note is-hidden"></p>

            <div id="brand-compare-wrap" class="panel-card brand-compare-wrap is-hidden">
              <h3 style="margin-top:0">Brand comparison</h3>
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
              <a href="#view-brands">Open Run Audit</a>
            </div>

            <div class="filter-row">
              <button type="button" class="filter-btn">Last 7 days ▾</button>
              <button type="button" class="filter-btn">All models ▾</button>
              <button type="button" class="filter-btn">All topics ▾</button>
            </div>

            <div class="metrics-row">
              <div class="metric-card">
                <h3>Brand presence</h3>
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
                <h3>Coverage</h3>
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
                <h3>Competitor signals</h3>
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
                <h3>Sources</h3>
                <div class="metric-sources-inner">
                  <div class="metric-sources-col">
                    <div class="metric-block-label metric-label-with-help">
                      Total sources cited
                      <span
                        class="metric-help"
                        title="Sum of URLs or citations returned with each model answer (Perplexity search results, Gemini grounding links, OpenAI URL annotations when present)."
                        aria-label="Help: total sources cited"
                        role="img"
                        >?</span>
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
                      Sources when brand mentioned
                      <span
                        class="metric-help"
                        title="Same count, but only for answers where the audited brand was detected in the model reply."
                        aria-label="Help: sources when brand mentioned"
                        role="img"
                        >?</span>
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

            <div class="ai-strip">
              <span>✨ Summary uses your <strong>latest audit</strong> in this browser when present; otherwise stored <code>scans</code> from the database.</span>
              <a href="#view-prompts">View prompts</a>
            </div>

            <div class="bottom-grid">
              <div class="panel-card chart-panel-card">
                <h3>Visibility &amp; sentiment</h3>
                <div class="chart-tabs" id="chart-tabs" role="tablist">
                  <button type="button" class="chart-tab is-on" data-chart="visibility" role="tab" aria-selected="true">Visibility</button>
                  <button type="button" class="chart-tab" data-chart="sentiment" role="tab" aria-selected="false">Sentiment</button>
                  <button type="button" class="chart-tab" disabled data-chart="position" role="tab">Position</button>
                </div>
                <div id="chart-pane-visibility" class="chart-pane" data-chart-pane="visibility">
                  <div class="chart-area" id="chart-visibility"></div>
                </div>
                <div id="chart-pane-sentiment" class="chart-pane is-hidden" data-chart-pane="sentiment">
                  <div class="chart-area chart-area-sentiment" id="chart-sentiment"></div>
                </div>
              </div>
              <div class="panel-card">
                <div class="leader-head">
                  <h3 style="margin:0">Leaderboard</h3>
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
            <h2 class="subview-title">Sources</h2>
            <p class="subview-lead">Connect docs and URLs your models should consider — coming soon.</p>
            <div class="placeholder-card">No sources configured yet.</div>
          </section>

          <section id="view-brands" class="view is-hidden" data-view-panel="brands">
            <h2 class="subview-title">Run Audit</h2>
            <p class="subview-lead">Run every configured prompt (see <strong>Prompts</strong>) against each selected model. Results appear under <strong>Test Results</strong> in this browser; they are not written to Supabase unless the API has <code>PERSIST_SCANS=true</code>.</p>
            <div class="form-card">
              <div class="field">
                <label for="brand">Brand 1</label>
                <input id="brand" type="text" placeholder="e.g. Nike" autocomplete="off" />
                <p class="field-hint muted">At least one brand required, up to four for a comparison run. <span class="test-brand-row"><button type="button" class="linkish" id="btn-nike">Nike</button></span></p>
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
            <h3 class="subview-title" style="font-size:1rem;margin-top:1.5rem">Recent activity</h3>
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

          <section id="view-tags" class="view is-hidden" data-view-panel="tags">
            <h2 class="subview-title">Tags</h2>
            <p class="subview-lead">Group scans and reports by campaign or product line — coming soon.</p>
            <div class="placeholder-card">No tags yet.</div>
          </section>

          <p class="footer-mini">Tract AI · run <code>npm run api</code> for live data</p>
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
  };

  const views = ["overview", "prompts", "sources", "brands", "tags"];

  function showView(name) {
    views.forEach((v) => {
      const panel = root.querySelector(`[data-view-panel="${v}"]`);
      const link = root.querySelector(`.js-nav[data-view="${v}"]`);
      if (panel) panel.classList.toggle("is-hidden", v !== name);
      if (link) link.classList.toggle("is-active", v === name);
    });
    if (name === "prompts") {
      loadPromptTemplatesEditor();
      refreshPrompts();
    } else if (name === "brands") {
      refreshPrompts();
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

  const hash = (location.hash || "").replace("#view-", "");
  if (views.includes(hash)) showView(hash);
  else showView("overview");

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

  /** Holds the latest scan in this tab so Recent activity always has full `response` text even if sessionStorage quota fails. */
  let latestAuditMemory = null;

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
      const rowBrand = r.brand || brandsOrder[0] || "(unknown)";
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

    const orderedKeys = [
      ...brandsOrder.filter((b) => perBrand[b]),
      ...Object.keys(perBrand).filter((b) => !brandsOrder.includes(b)),
    ];

    const brandComparison = orderedKeys.map((b) => {
      const pb = perBrand[b];
      return {
        brand: b,
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
      enginesUsed: Object.entries(byEngine)
        .sort((a, b) => b[1] - a[1])
        .map(([engine, count]) => ({ engine, count })),
      engineMentionRates,
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
    el.ovKpiRow.innerHTML = `
      <span class="kpi-chip"><span class="dot ok"></span> Visibility: ${visScore}/6</span>
      <span class="kpi-chip"><span class="dot ${sentScore >= 3 ? "ok" : "warn"}"></span> Sentiment: ${sumS ? `${positive}/${sumS}` : "—"}</span>
      <span class="kpi-chip"><span class="dot ok"></span> Position: ${posScore}/6</span>
    `;

    const bc = s.brandComparison || [];

    el.chartVisibility.innerHTML = renderVisibilityMultiBrand(bc, mention);
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
          .map((row) => {
            const sent = escapeHtml(row.dominantSentiment || "—");
            const cls = sentimentClass(
              String(row.dominantSentiment || "").toLowerCase()
            );
            return `<tr>
              <td><strong>${escapeHtml(row.brand)}</strong></td>
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
  }

  async function loadStats() {
    const audit = readLatestAudit();
    if (audit?.results?.length) {
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

  root.querySelector("#btn-nike").addEventListener("click", () => {
    el.brand.value = "Nike";
    refreshPrompts();
  });

  root.querySelector("#btn-refresh-lb").addEventListener("click", () => {
    refreshAll();
  });

  root.querySelector("#chart-tabs")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".chart-tab[data-chart]");
    if (!btn || btn.disabled) return;
    const tab = btn.getAttribute("data-chart");
    root.querySelectorAll("#chart-tabs .chart-tab").forEach((b) => {
      const on = b.getAttribute("data-chart") === tab;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    root.querySelectorAll(".chart-panel-card .chart-pane").forEach((p) => {
      p.classList.toggle(
        "is-hidden",
        p.getAttribute("data-chart-pane") !== tab
      );
    });
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

    try {
      const out = await fetchJson(apiUrl("/api/scan"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brands, engines }),
      });
      writeLatestAudit(out);
      const label =
        out.brands && out.brands.length > 1
          ? `${out.brands.length} brands (${out.brands.join(", ")})`
          : out.brands[0];
      el.scanStatus.textContent = out.persisted
        ? `Finished: saved ${out.saved} of ${out.total} rows for ${label}.`
        : `Finished: ${out.total} rows for ${label} (not saved — viewable in Test Results in this browser).`;
      if (out.persisted && out.saved < out.total) {
        const hint =
          Array.isArray(out.saveErrors) && out.saveErrors.length > 0
            ? out.saveErrors.join(" · ")
            : "Check API logs and Supabase.";
        showBanner(`Some rows failed: ${hint}`, "warn");
      }
      await refreshAll();
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

  refreshPrompts();
  refreshAll();
}
