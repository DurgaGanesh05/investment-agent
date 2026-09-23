/**
 * Research Integrity – Canonical Financial-Number Normalization & Matching
 * (B4.3.2.1)
 *
 * Pure, deterministic utility.  No HTTP, no filesystem, no environment access,
 * no LangGraph, no Groq calls, no company-specific hardcoding.
 *
 * Public API:
 *   buildVerifiedFacts(financialData, financialMetrics)  → VerifiedFact[]
 *   normalizeFinancialString(text)                       → number | null
 *   matchesVerifiedValue(candidate, canonicalValue, factType) → boolean
 *   isNonFinancialNumber(text)                           → boolean
 *   extractFinancialCandidates(text)                     → ExtractedCandidate[]
 *   validateFinancialCandidates(candidatesOrText, facts) → FinancialValidationResult
 */

// ---------------------------------------------------------------------------
// Fact-type definitions
// ---------------------------------------------------------------------------

/**
 * Maps field names to their fact-type categories.
 * Fact types determine format compatibility and tolerance during matching.
 */
const FACT_TYPE_MAP = {
  // currency – large-magnitude dollar values
  price: "currency",
  marketCap: "currency",
  revenue: "currency",
  netIncome: "currency",
  totalAssets: "currency",
  totalLiabilities: "currency",
  cashAndEquivalents: "currency",
  // perShare – small-magnitude dollar values
  eps: "perShare",
  // ratio – decimal proportions (0–1 range, or percentage form)
  netProfitMargin: "ratio",
  returnOnAssets: "ratio",
  liabilityToAssetRatio: "ratio",
  cashToLiabilityRatio: "ratio",
  // multiple – valuation multiples
  peRatio: "multiple",
};

const VALID_FACT_TYPES = new Set(["currency", "perShare", "ratio", "multiple"]);

/**
 * Checks whether candidate text notation is semantically compatible with the factType.
 *
 * Rules:
 *  - "percentage" (%) notation: only valid for "ratio"
 *  - "multiplier" (x/×) notation: only valid for "multiple" and "ratio"
 *  - "scaled" (billion/million/trillion etc.) notation: only valid for "currency"
 *  - "dollar" ($) notation: only valid for "currency" and "perShare"
 */
const isFormatCompatibleWithFactType = (text, factType) => {
  if (typeof text !== "string") return true;
  let s = text.trim();
  if (!s) return false;

  const isDollar = s.startsWith("$");
  if (isDollar) s = s.slice(1).trim();

  const isUsd = /^USD\s+/i.test(s);
  if (isUsd) s = s.replace(/^USD\s+/i, "").trim();

  s = s.replace(/,/g, "");

  const isPct = s.endsWith("%");
  const isMult = /[x×]$/i.test(s);
  const isScaled = /^([+-]?\d+(?:\.\d+)?)\s*(trillion|tn|t|billion|bn|b|million|mil|mn|m)$/i.test(s);

  if (isPct) {
    return factType === "ratio";
  }

  if (isMult) {
    return factType === "multiple" || factType === "ratio";
  }

  if (isScaled) {
    return factType === "currency";
  }

  if (isDollar || isUsd) {
    return factType === "currency" || factType === "perShare";
  }

  // Plain numeric string (no currency $, USD prefix, scale suffix, %, or multiplier x)
  return true;
};

// ---------------------------------------------------------------------------
// Non-financial number detection
// ---------------------------------------------------------------------------

/**
 * Patterns that identify contextual / non-financial numbers which should NOT
 * be treated as unsupported financial claims.
 */
const YEAR_PATTERN = /^(?:FY\s*)?(?:19|20)\d{2}(?:[–\-\/](?:(?:19|20)?\d{2}))?$/i;

/**
 * Returns true when `text` looks like a non-financial contextual number
 * (e.g. fiscal-year labels) that must NOT be validated against verified facts.
 */
export const isNonFinancialNumber = (text) => {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return YEAR_PATTERN.test(trimmed);
};

// ---------------------------------------------------------------------------
// Normalization helpers (pure)
// ---------------------------------------------------------------------------

const SCALE_SUFFIXES = {
  t: 1e12,
  tn: 1e12,
  trillion: 1e12,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  m: 1e6,
  mn: 1e6,
  mil: 1e6,
  million: 1e6,
};

/**
 * Attempts to parse a human-readable financial string into a canonical number.
 *
 * Recognised formats:
 *   "$416.161 billion"  → 416161000000
 *   "416.161B"          → 416161000000
 *   "$416161000000"     → 416161000000
 *   "416161000000"      → 416161000000
 *   "26.92%"            → 0.2692
 *   "45.36x" / "45.36×" → 45.36
 *   "$7.49"             → 7.49
 *
 * Returns `null` when the string cannot be meaningfully interpreted as a
 * single financial number.
 */
export const normalizeFinancialString = (text) => {
  if (typeof text !== "string") return null;

  let s = text.trim();
  if (!s) return null;

  // Strip leading dollar sign or USD prefix
  if (s.startsWith("$")) {
    s = s.slice(1).trim();
  } else if (/^USD\s+/i.test(s)) {
    s = s.replace(/^USD\s+/i, "").trim();
  }

  // Strip commas used as thousands separators
  s = s.replace(/,/g, "");

  // Percentage → divide by 100
  if (s.endsWith("%")) {
    const num = Number(s.slice(0, -1).trim());
    return Number.isFinite(num) ? num / 100 : null;
  }

  // Multiplier suffix: "x" or "×"
  if (/[x×]$/i.test(s)) {
    const num = Number(s.slice(0, -1).trim());
    return Number.isFinite(num) ? num : null;
  }

  // Scale suffix: billion, million, trillion (and abbreviations)
  // e.g. "416.161 billion", "416.161B", "3.0T"
  const scaleMatch = s.match(
    /^([+-]?\d+(?:\.\d+)?)\s*(trillion|tn|t|billion|bn|b|million|mil|mn|m)$/i
  );
  if (scaleMatch) {
    const base = Number(scaleMatch[1]);
    const suffix = scaleMatch[2].toLowerCase();
    const multiplier = SCALE_SUFFIXES[suffix];
    if (Number.isFinite(base) && multiplier !== undefined) {
      return base * multiplier;
    }
    return null;
  }

  // Plain number
  const num = Number(s);
  return Number.isFinite(num) ? num : null;
};

// ---------------------------------------------------------------------------
// Tolerance calculation (precision-aware, NOT blanket ±1%)
// ---------------------------------------------------------------------------

/**
 * Computes a controlled tolerance appropriate for matching `candidate` against
 * `canonical` for the given `factType`.
 *
 * Rules:
 *  1. Exact unit conversions (e.g. 416161000000 === $416161000000) must match
 *     exactly (tolerance = 0).
 *  2. Rounded human-readable representations (e.g. "$416.161 billion") use a
 *     tolerance derived from the _displayed precision_ of the candidate.
 *  3. Fact type determines which notation formats are valid and eligible for
 *     tolerance scaling.
 *
 * The approach: if `candidate` was produced by scaling (billion/million/trillion
 * suffix or by percentage), we derive a half-unit-of-last-place tolerance from
 * the original text's decimal places. Otherwise tolerance is zero (exact match).
 *
 * @param {string} originalText  - the raw text that was parsed
 * @param {number} candidate     - the parsed numeric value
 * @param {number} canonical     - the verified canonical value
 * @param {string} factType      - one of "currency", "perShare", "ratio", "multiple"
 * @returns {number} absolute tolerance
 */
const computeTolerance = (originalText, candidate, canonical, factType) => {
  if (typeof originalText !== "string") return 0;

  let s = originalText.trim();
  if (s.startsWith("$")) s = s.slice(1).trim();
  if (/^USD\s+/i.test(s)) s = s.replace(/^USD\s+/i, "").trim();
  s = s.replace(/,/g, "");

  // Percentage form: tolerance comes from displayed decimal places of the percentage
  if (s.endsWith("%")) {
    if (factType !== "ratio") return 0;
    const pctStr = s.slice(0, -1).trim();
    return halfUnitOfLastPlace(pctStr) / 100;
  }

  // Multiplier suffix
  if (/[x×]$/i.test(s)) {
    if (factType !== "multiple" && factType !== "ratio") return 0;
    const numStr = s.slice(0, -1).trim();
    return halfUnitOfLastPlace(numStr);
  }

  // Scale suffix
  const scaleMatch = s.match(
    /^([+-]?\d+(?:\.\d+)?)\s*(trillion|tn|t|billion|bn|b|million|mil|mn|m)$/i
  );
  if (scaleMatch) {
    if (factType !== "currency") return 0;
    const baseStr = scaleMatch[1];
    const suffix = scaleMatch[2].toLowerCase();
    const multiplier = SCALE_SUFFIXES[suffix];
    if (multiplier !== undefined) {
      return halfUnitOfLastPlace(baseStr) * multiplier;
    }
  }

  // No scaling involved → exact match required
  return 0;
};

/**
 * Returns half a unit of the last decimal place of the numeric string.
 *
 * Examples:
 *   "416.161"  → 0.0005   (3 decimal places → half of 0.001)
 *   "416"      → 0.5      (0 decimal places → half of 1)
 *   "26.92"    → 0.005
 */
const halfUnitOfLastPlace = (numStr) => {
  const dotIndex = numStr.indexOf(".");
  if (dotIndex === -1) {
    return 0.5;
  }
  const decimals = numStr.length - dotIndex - 1;
  return 0.5 * Math.pow(10, -decimals);
};

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Determines whether a candidate value (parsed from LLM prose) matches a
 * canonical verified value for the given fact type.
 *
 * @param {number|string} candidate     - the candidate value (number or raw text)
 * @param {number}        canonicalValue - the verified canonical number
 * @param {string}        factType       - "currency" | "perShare" | "ratio" | "multiple"
 * @returns {boolean}
 */
export const matchesVerifiedValue = (candidate, canonicalValue, factType) => {
  if (canonicalValue === null || canonicalValue === undefined) return false;
  if (!Number.isFinite(canonicalValue)) return false;
  if (!VALID_FACT_TYPES.has(factType)) return false;

  let candidateNum;
  let originalText = null;

  if (typeof candidate === "string") {
    originalText = candidate;
    if (!isFormatCompatibleWithFactType(originalText, factType)) {
      return false;
    }
    candidateNum = normalizeFinancialString(candidate);
  } else if (typeof candidate === "number") {
    candidateNum = Number.isFinite(candidate) ? candidate : null;
  } else {
    return false;
  }

  if (candidateNum === null) return false;

  // Special case: both are zero
  if (candidateNum === 0 && canonicalValue === 0) return true;

  const tolerance = originalText !== null
    ? computeTolerance(originalText, candidateNum, canonicalValue, factType)
    : 0;

  return Math.abs(candidateNum - canonicalValue) <= tolerance;
};

// ---------------------------------------------------------------------------
// Verified-facts builder
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} VerifiedFact
 * @property {string} field          - field name (e.g. "revenue", "peRatio")
 * @property {string} factType       - "currency" | "perShare" | "ratio" | "multiple"
 * @property {number} canonicalValue - the verified numeric value
 */

/**
 * Builds a canonical set of verified facts from financialData and
 * financialMetrics.  Only fields with finite numeric values are included.
 *
 * @param {object|null|undefined} financialData    - normalised financial data
 * @param {object|null|undefined} financialMetrics - derived financial metrics
 * @returns {VerifiedFact[]}
 */
export const buildVerifiedFacts = (financialData, financialMetrics) => {
  /** @type {VerifiedFact[]} */
  const facts = [];

  const addFact = (field, value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    const factType = FACT_TYPE_MAP[field];
    if (!factType) return;
    facts.push({ field, factType, canonicalValue: value });
  };

  // --- From financialData ---
  if (financialData && typeof financialData === "object") {
    const market = financialData.market;
    if (market && typeof market === "object") {
      addFact("price", market.price);
      addFact("marketCap", market.marketCap);
    }

    const financials = financialData.financials;
    if (financials && typeof financials === "object") {
      addFact("revenue", financials.revenue);
      addFact("netIncome", financials.netIncome);
      addFact("eps", financials.eps);
      addFact("totalAssets", financials.totalAssets);
      addFact("totalLiabilities", financials.totalLiabilities);
      addFact("cashAndEquivalents", financials.cashAndEquivalents);
    }
  }

  // --- From financialMetrics ---
  if (financialMetrics && typeof financialMetrics === "object") {
    addFact("netProfitMargin", financialMetrics.netProfitMargin);
    addFact("returnOnAssets", financialMetrics.returnOnAssets);
    addFact("liabilityToAssetRatio", financialMetrics.liabilityToAssetRatio);
    addFact("cashToLiabilityRatio", financialMetrics.cashToLiabilityRatio);
    addFact("peRatio", financialMetrics.peRatio);
  }

  return facts;
};

// ---------------------------------------------------------------------------
// Candidate extraction (B4.3.2.2)
// ---------------------------------------------------------------------------

/**
 * Patterns for extracting financial candidates with explicit notation.
 * Order matters for overlap disambiguation (e.g. dollar_scaled tested before plain dollar).
 */
const CANDIDATE_PATTERNS = [
  {
    inferredNotation: "currency_code_scaled",
    regex: /\bUSD\s+(?:\d+(?:\.\d+)?)\s*(?:trillion|tn|t|billion|bn|b|million|mil|mn|m)\b/gi,
  },
  {
    inferredNotation: "currency_code",
    regex: /\bUSD\s+(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\b/gi,
  },
  {
    inferredNotation: "dollar_scaled",
    regex: /(?:(?:\$\d+(?:\.\d+)?)|(?:\b\d+(?:\.\d+)?))\s*(?:trillion|tn|t|billion|bn|b|million|mil|mn|m)\b/gi,
  },
  {
    inferredNotation: "dollar",
    regex: /\$\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:[eE][+-]?\d+)?|\$\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
  },
  {
    inferredNotation: "percentage",
    regex: /(?:[+-]?\d+(?:\.\d+)?|\b\d+(?:\.\d+)?)\s*%/g,
  },
  {
    inferredNotation: "multiplier",
    regex: /\b\d+(?:\.\d+)?\s*[x×](?![a-zA-Z0-9])/gi,
  },
];

/**
 * Extracts conservatively recognizable financial-looking numeric expressions from
 * arbitrary research text.
 *
 * Recognised forms:
 *   - "dollar_scaled": $416.161 billion, $416.161B, $3.47T, 30.74 million, $30.74 million
 *   - "dollar": $7.49, $227.48, $416,161,000,000
 *   - "percentage": 26.92%, 30.69%, 27%, -5.4%
 *   - "multiplier": 30.3711x, 30.37x, 45.36×
 *
 * Ignores: plain small integers, years, year ranges, quarter/section labels, plain decimals.
 *
 * @param {string|null|undefined} text
 * @returns {Array<{ rawText: string, normalizedValue: number, inferredNotation: string, startIndex: number, endIndex: number }>}
 */
export const extractFinancialCandidates = (text) => {
  if (typeof text !== "string" || !text.trim()) {
    return [];
  }

  const matches = [];

  for (const { inferredNotation, regex } of CANDIDATE_PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const rawText = match[0];
      const startIndex = match.index;
      const endIndex = startIndex + rawText.length;
      const normalizedValue = normalizeFinancialString(rawText);

      if (normalizedValue !== null && Number.isFinite(normalizedValue)) {
        matches.push({
          rawText,
          normalizedValue,
          inferredNotation,
          startIndex,
          endIndex,
        });
      }
    }
  }

  // Deduplicate overlapping matches by prioritizing longer matches and earlier start positions
  matches.sort((a, b) => {
    if (a.startIndex !== b.startIndex) {
      return a.startIndex - b.startIndex;
    }
    return (b.endIndex - b.startIndex) - (a.endIndex - a.startIndex);
  });

  const accepted = [];
  for (const candidate of matches) {
    const overlaps = accepted.some(
      (existing) =>
        candidate.startIndex < existing.endIndex &&
        candidate.endIndex > existing.startIndex
    );
    if (!overlaps) {
      accepted.push(candidate);
    }
  }

  // Sort final accepted candidates strictly by startIndex ascending
  accepted.sort((a, b) => a.startIndex - b.startIndex);

  return accepted;
};

// ---------------------------------------------------------------------------
// Candidate verification (B4.3.2.3)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SupportedCandidateMatch
 * @property {ExtractedCandidate} candidate
 * @property {{ field: string, factType: string, canonicalValue: number }} matchedFact
 */

/**
 * @typedef {Object} UnsupportedCandidateMatch
 * @property {ExtractedCandidate} candidate
 * @property {string} reason
 */

/**
 * @typedef {Object} FinancialValidationResult
 * @property {boolean} valid
 * @property {SupportedCandidateMatch[]} supported
 * @property {UnsupportedCandidateMatch[]} unsupported
 * @property {number} totalCandidates
 */

// ---------------------------------------------------------------------------
// Directional benchmarking detection
// ---------------------------------------------------------------------------

const DIRECTIONAL_BENCHMARK_PATTERN = new RegExp(
  "\\b(" +
    // Directional action / scenario verbs followed by optional noun phrase + preposition/target
    "(?:ris(?:e|ing)|grow(?:ing)?|climb(?:ing)?|fall(?:ing)?|drop(?:ping)?|pressur(?:e|ing)|push(?:ing)?|lift(?:ing)?|expand(?:ing)?|sustain(?:ing)?)\\s+(?:[a-z0-9_\\-\\.]+\\s+)*(?:to|beyond|above|below|near)|" +
    // Future / modal projection constructions (e.g. will exceed, could rise beyond, expected to fall below, set to reach)
    "(?:will|could|may|can|should|would|expect(?:ed)?\\s+to|project(?:ed)?\\s+to|set\\s+to)\\s+(?:[a-z0-9_\\-\\.]+\\s+)*(?:reach|exceed|surpass|hit|target|rise|fall|grow|climb|drop|push|lift|expand|sustain)?\\s*(?:to|beyond|above|below|near)?" +
  ")\\b",
  "i"
);

export const isDirectionalProjectionContext = (sourceText, startIndex) => {
  if (typeof sourceText !== "string" || typeof startIndex !== "number" || startIndex <= 0) {
    return false;
  }
  const contextBefore = sourceText.slice(Math.max(0, startIndex - 45), startIndex);
  return DIRECTIONAL_BENCHMARK_PATTERN.test(contextBefore);
};

/**
 * Verifies extracted financial candidates against canonical verified facts.
 * Pure, deterministic utility isolated from LangGraph workflow logic.
 *
 * @param {string | ExtractedCandidate[] | null | undefined} candidatesOrText
 * @param {VerifiedFact[] | null | undefined} verifiedFacts
 * @returns {FinancialValidationResult}
 */
export const validateFinancialCandidates = (candidatesOrText, verifiedFacts) => {
  let candidates = [];
  let sourceText = null;

  if (typeof candidatesOrText === "string") {
    sourceText = candidatesOrText;
    candidates = extractFinancialCandidates(sourceText);
  } else if (Array.isArray(candidatesOrText)) {
    candidates = candidatesOrText;
  }

  const facts = Array.isArray(verifiedFacts) ? verifiedFacts : [];

  const supported = [];
  const unsupported = [];

  for (const item of candidates) {
    if (!item) continue;
    let candidate = null;
    if (typeof item === "string") {
      candidate = { rawText: item };
    } else if (typeof item === "object" && typeof item.rawText === "string") {
      candidate = item;
    } else {
      continue;
    }

    // Directional projection benchmark check
    const textToInspect = sourceText || (typeof candidate.sourceText === "string" ? candidate.sourceText : null);
    const startIdx = typeof candidate.startIndex === "number" ? candidate.startIndex : null;

    if (textToInspect !== null && startIdx !== null && isDirectionalProjectionContext(textToInspect, startIdx)) {
      unsupported.push({
        candidate,
        reason: "directional_projection_claim",
      });
      continue;
    }

    let matchedFact = null;
    for (const fact of facts) {
      if (!fact || typeof fact.canonicalValue !== "number" || typeof fact.factType !== "string") {
        continue;
      }

      if (matchesVerifiedValue(candidate.rawText, fact.canonicalValue, fact.factType)) {
        matchedFact = {
          field: fact.field,
          factType: fact.factType,
          canonicalValue: fact.canonicalValue,
        };
        break;
      }
    }

    if (matchedFact !== null) {
      supported.push({ candidate, matchedFact });
    } else {
      unsupported.push({
        candidate,
        reason: facts.length === 0 ? "no_verified_facts_available" : "unsupported_numeric_claim",
      });
    }
  }

  const totalCandidates = supported.length + unsupported.length;

  return {
    valid: unsupported.length === 0,
    supported,
    unsupported,
    totalCandidates,
  };
};
