const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const TEMPLATES_FILE = path.join(DATA_DIR, "prompt-templates.json");

/** Stable enum used by the AEO judge to group prompts. */
const INTENTS = [
  "informational",
  "comparison",
  "reputation",
  "recommendation",
  "alternatives",
  "best_of",
  "other",
];

const DEFAULT_TEMPLATES = [
  { text: "What is {{brand}} and what do they do? Short answer please.", intent: "informational" },
  { text: "Is {{brand}} a good option compared to competitors? Short answer please.", intent: "comparison" },
  { text: "What are people saying about {{brand}}? Short answer please.", intent: "reputation" },
  { text: "Would you recommend {{brand}}? Why or why not? Short answer please.", intent: "recommendation" },
  { text: "What are the best alternatives to {{brand}}? Short answer please.", intent: "alternatives" },
];

const MAX_PROMPTS = 20;
const MAX_TEMPLATE_LEN = 4000;

function normalizeIntent(v) {
  const s = String(v || "").trim().toLowerCase();
  return INTENTS.includes(s) ? s : "other";
}

/** Accepts: ["string", ...] or [{ text, intent }, ...]. Returns tagged objects or null. */
function normalizeTagged(arr) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const raw of arr) {
    let text;
    let intent;
    if (typeof raw === "string") {
      text = raw.trim();
      intent = "other";
    } else if (raw && typeof raw === "object") {
      text = String(raw.text ?? "").trim();
      intent = normalizeIntent(raw.intent);
    } else {
      continue;
    }
    if (!text) continue;
    if (text.length > MAX_TEMPLATE_LEN) return null;
    if (!text.includes("{{brand}}")) return null;
    out.push({ text, intent });
  }
  if (out.length === 0 || out.length > MAX_PROMPTS) return null;
  return out;
}

function readTemplatesFromFile() {
  try {
    const raw = fs.readFileSync(TEMPLATES_FILE, "utf8");
    const j = JSON.parse(raw);
    return normalizeTagged(j?.templates);
  } catch {
    return null;
  }
}

function getPromptTemplatesTagged() {
  return readTemplatesFromFile() || DEFAULT_TEMPLATES.slice();
}

function getPromptTemplates() {
  return getPromptTemplatesTagged().map((t) => t.text);
}

function getPromptsTagged(brand) {
  const b = String(brand || "").trim();
  return getPromptTemplatesTagged().map((t) => ({
    text: t.text.replaceAll("{{brand}}", b),
    intent: t.intent,
  }));
}

function getPrompts(brand) {
  return getPromptsTagged(brand).map((p) => p.text);
}

function setPromptTemplates(templates) {
  const incoming = normalizeTagged(templates);
  if (!incoming) {
    return {
      ok: false,
      error: `Invalid templates: need 1–${MAX_PROMPTS} non-empty entries, each ≤ ${MAX_TEMPLATE_LEN} chars and containing the literal {{brand}}.`,
    };
  }

  const incomingWasStrings =
    Array.isArray(templates) && templates.every((x) => typeof x === "string");
  let merged = incoming;
  if (incomingWasStrings) {
    const prior = readTemplatesFromFile() || [];
    merged = incoming.map((t, i) => ({
      text: t.text,
      intent: prior[i]?.intent ? normalizeIntent(prior[i].intent) : "other",
    }));
  }

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = JSON.stringify({ templates: merged }, null, 2);
    const tmp = `${TEMPLATES_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, payload, "utf8");
    fs.renameSync(tmp, TEMPLATES_FILE);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = {
  INTENTS,
  getPrompts,
  getPromptsTagged,
  getPromptTemplates,
  getPromptTemplatesTagged,
  setPromptTemplates,
};
