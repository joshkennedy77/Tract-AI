const POSITIVE_WORDS = [
  "recommend",
  "great",
  "excellent",
  "best",
  "top",
  "leading",
  "popular",
  "trusted",
  "reliable",
  "innovative",
];

const NEGATIVE_WORDS = [
  "avoid",
  "poor",
  "bad",
  "worst",
  "unreliable",
  "complaints",
  "issues",
  "problems",
  "disappointing",
  "overpriced",
];

const TRIGGER_PATTERNS = [
  /compared to/gi,
  /also consider/gi,
  /similar to/gi,
  /alternative/gi,
  /competitor/gi,
  /instead/gi,
  /versus/gi,
  /\bvs\.?\b/gi,
];

const COMPETITOR_STOP = new Set(
  [
    "The",
    "A",
    "An",
    "And",
    "Or",
    "But",
    "In",
    "On",
    "At",
    "To",
    "For",
    "Of",
    "Is",
    "Are",
    "Was",
    "Were",
    "It",
    "Its",
    "They",
    "Them",
    "Their",
    "We",
    "Our",
    "You",
    "Your",
    "This",
    "That",
    "These",
    "Those",
    "If",
    "As",
    "So",
    "When",
    "Where",
    "While",
    "With",
    "From",
    "By",
    "About",
    "There",
    "Here",
    "Many",
    "Some",
    "Most",
    "Other",
    "Another",
    "Each",
    "Every",
    "Either",
    "Neither",
    "Both",
    "One",
    "Two",
    "Also",
    "Only",
    "Just",
    "Even",
    "Still",
    "Yet",
    "However",
    "Although",
    "Because",
    "Since",
    "Until",
    "Unless",
    "Though",
    "Whether",
    "Including",
    "Based",
    "Using",
    "Overall",
    "Additionally",
    "Furthermore",
    "Alternatively",
    "Similarly",
    "Compared",
    "Consider",
    "Considered",
    "Considering",
    "Several",
    "Various",
    "Certain",
    "Different",
    "Same",
    "Similar",
    "Better",
    "Worse",
    "New",
    "Old",
    "Major",
    "Minor",
    "Main",
    "Primary",
    "Secondary",
    "Online",
    "Offline",
    "Local",
    "Global",
    "I",
  ].map((w) => w.toLowerCase())
);

const COMPETITOR_PHRASE_EXCLUDE = new Set([
  "alternative",
  "alternatives",
  "competitor",
  "competitors",
  "instead",
  "versus",
  "similar",
  "vs",
  "compared",
  "compared to",
  "similar to",
  "also consider",
  "consider",
]);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWordBoundaryMatch(text, word) {
  const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, "i");
  return re.test(text);
}

function sentimentFor(text) {
  const hasNegative = NEGATIVE_WORDS.some((w) => hasWordBoundaryMatch(text, w));
  const hasPositive = POSITIVE_WORDS.some((w) => hasWordBoundaryMatch(text, w));
  if (hasNegative) return "negative";
  if (hasPositive) return "positive";
  return "neutral";
}

const PROPER_NOUN_CHUNK = /\b([A-Z][a-zA-Z0-9]*(?:\s+[A-Z][a-zA-Z0-9]*)*)\b/g;

function extractNearTriggers(response, brand) {
  const found = [];
  const seen = new Set();
  const brandLower = brand.trim().toLowerCase();

  for (const re of TRIGGER_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(response)) !== null) {
      const start = Math.max(0, m.index - 120);
      const end = Math.min(
        response.length,
        m.index + m[0].length + 120
      );
      const window = response.slice(start, end);

      PROPER_NOUN_CHUNK.lastIndex = 0;
      let nm;
      while ((nm = PROPER_NOUN_CHUNK.exec(window)) !== null) {
        const phrase = nm[1].trim();
        if (!phrase) continue;
        const key = phrase.toLowerCase();
        if (key === brandLower) continue;
        if (COMPETITOR_PHRASE_EXCLUDE.has(key)) continue;
        const firstToken = phrase.split(/\s+/)[0];
        if (COMPETITOR_STOP.has(firstToken.toLowerCase())) continue;
        if (phrase.length < 2) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(phrase);
        if (found.length >= 5) return found;
      }
    }
  }

  return found;
}

function analyzeResponse(brand, response) {
  const text = response == null ? "" : String(response);
  const brandTrim = brand == null ? "" : String(brand).trim();
  const brandLower = brandTrim.toLowerCase();

  const brand_mentioned =
    brandLower.length > 0 && text.toLowerCase().includes(brandLower);

  const sentiment = sentimentFor(text);

  const competitors_mentioned =
    brandTrim.length > 0 ? extractNearTriggers(text, brandTrim) : [];

  return {
    brand_mentioned,
    sentiment,
    competitors_mentioned,
  };
}

module.exports = { analyzeResponse };
