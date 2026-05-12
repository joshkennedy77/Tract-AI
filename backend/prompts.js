const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const TEMPLATES_FILE = path.join(DATA_DIR, "prompt-templates.json");

/** Default templates use `{{brand}}` — substituted when running audits. */
const DEFAULT_TEMPLATES = [
  "What is {{brand}} and what do they do? Short answer please.",
  "Is {{brand}} a good option compared to competitors? Short answer please.",
  "What are people saying about {{brand}}? Short answer please.",
  "Would you recommend {{brand}}? Why or why not? Short answer please.",
  "What are the best alternatives to {{brand}}? Short answer please.",
];

const MAX_PROMPTS = 20;
const MAX_TEMPLATE_LEN = 4000;

function normalizeTemplates(arr) {
  if (!Array.isArray(arr)) return null;
  const out = arr.map((s) => String(s).trim()).filter(Boolean);
  if (out.length === 0 || out.length > MAX_PROMPTS) return null;
  for (const s of out) {
    if (s.length > MAX_TEMPLATE_LEN) return null;
    if (!s.includes("{{brand}}")) return null;
  }
  return out;
}

function readTemplatesFromFile() {
  try {
    const raw = fs.readFileSync(TEMPLATES_FILE, "utf8");
    const j = JSON.parse(raw);
    const t = normalizeTemplates(j?.templates);
    return t;
  } catch {
    return null;
  }
}

/** Raw template strings (each must contain `{{brand}}`). */
function getPromptTemplates() {
  return readTemplatesFromFile() || DEFAULT_TEMPLATES.slice();
}

/** Resolved prompts for a given brand (used by scan + preview API). */
function getPrompts(brand) {
  const b = String(brand || "").trim();
  const templates = getPromptTemplates();
  return templates.map((t) => t.replaceAll("{{brand}}", b));
}

/**
 * @param {unknown} templates
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function setPromptTemplates(templates) {
  const normalized = normalizeTemplates(templates);
  if (!normalized) {
    return {
      ok: false,
      error: `Invalid templates: need 1–${MAX_PROMPTS} non-empty strings, each ≤ ${MAX_TEMPLATE_LEN} chars and containing the literal {{brand}}.`,
    };
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = JSON.stringify({ templates: normalized }, null, 2);
    const tmp = `${TEMPLATES_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, payload, "utf8");
    fs.renameSync(tmp, TEMPLATES_FILE);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = {
  getPrompts,
  getPromptTemplates,
  setPromptTemplates,
};
