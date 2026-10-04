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
  revenueGrowth: "ratio",
  netIncomeGrowth: "ratio",
  epsGrowth: "ratio",
  cashGrowth: "ratio",
  liabilityGrowth: "ratio",
  netProfitMarginChange: "ratio",
  returnOnAssetsChange: "ratio",
  liabilityToAssetRatioChange: "ratio",
  cashToLiabilityRatioChange: "ratio",
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

  const isPct = s.endsWith("%") || /percentage\s+points?$/i.test(s);
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
  if (s.endsWith("%") || /percentage\s+points?$/i.test(s)) {
    const numericText = s.endsWith("%") ? s.slice(0, -1) : s.replace(/percentage\s+points?$/i, "");
    const num = Number(numericText.trim());
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
  if (s.endsWith("%") || /percentage\s+points?$/i.test(s)) {
    if (factType !== "ratio") return 0;
    const pctStr = s.endsWith("%") ? s.slice(0, -1).trim() : s.replace(/percentage\s+points?$/i, "").trim();
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

  const addPeriodFact = (field, value, period) => {
    if (!period || period.periodType !== "Annual" || typeof period.fiscalDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(period.fiscalDate)) return;
    const date = new Date(`${period.fiscalDate}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== period.fiscalDate) return;
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    const factType = FACT_TYPE_MAP[field];
    if (!factType) return;
    facts.push({ field, factType, canonicalValue: value, fiscalDate: period.fiscalDate, periodType: period.periodType });
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
      for (const period of Array.isArray(financials.annualPeriods) ? financials.annualPeriods : []) {
        if (!period) continue;
        for (const field of ["revenue", "netIncome", "eps", "totalAssets", "totalLiabilities", "cashAndEquivalents"]) {
          addPeriodFact(field, period[field], period);
        }
      }
    }
  }

  // --- From financialMetrics ---
  if (financialMetrics && typeof financialMetrics === "object") {
    const current = financialMetrics.current ?? financialMetrics;
    addFact("netProfitMargin", current.netProfitMargin);
    addFact("returnOnAssets", current.returnOnAssets);
    addFact("liabilityToAssetRatio", current.liabilityToAssetRatio);
    addFact("cashToLiabilityRatio", current.cashToLiabilityRatio);
    addFact("peRatio", current.peRatio);
    for (const period of Array.isArray(financialMetrics.annual) ? financialMetrics.annual : []) {
      if (!period) continue;
      for (const field of ["revenueGrowth", "netIncomeGrowth", "epsGrowth", "cashGrowth", "liabilityGrowth", "netProfitMargin", "returnOnAssets", "liabilityToAssetRatio", "cashToLiabilityRatio", "netProfitMarginChange", "returnOnAssetsChange", "liabilityToAssetRatioChange", "cashToLiabilityRatioChange"]) {
        addPeriodFact(field, period[field], period);
      }
    }
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
    regex: /(?:[+-]?\d+(?:\.\d+)?|\b\d+(?:\.\d+)?)\s*(?:%|percentage\s+points?)/gi,
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

  // Explicit decimal ratio changes are financial claims; unrelated plain
  // decimals remain outside the existing extractor's conservative scope.
  const decimalChange = /(?:net\s+(?:profit\s+)?margin|return\s+on\s+assets|liability[-\s]+to[-\s]+asset\s+ratio|cash[-\s]+to[-\s]+liability\s+ratio)\s+change\s+(?:was|is|of)\s+([+-]?\d+\.\d+)(?![\d%])/gi;
  let changeMatch;
  while ((changeMatch = decimalChange.exec(text)) !== null) {
    const rawText = changeMatch[1];
    const startIndex = changeMatch.index + changeMatch[0].lastIndexOf(rawText);
    matches.push({ rawText, normalizedValue: Number(rawText), inferredNotation: "decimal_change", startIndex, endIndex: startIndex + rawText.length });
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

  // Keep historical context when callers use the candidate-array API. Dropping
  // a year during extraction must not turn a historical claim into a current one.
  return accepted.map((candidate) => ({ ...candidate, sourceText: text }));
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
    "(?:will|could|may|can|should|would|expect(?:ed)?\\s+to|project(?:ed)?\\s+to|set\\s+to|target(?:s|ed)?(?:\\s+to)?)\\s+(?:[a-z0-9_\\-\\.]+\\s+)*(?:reach|exceed|surpass|hit|target|rise|fall|grow|climb|drop|push|lift|expand|sustain)?\\s*(?:to|beyond|above|below|near)?" +
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

  const fieldHints = [
    ["revenueGrowth", /revenue\s+(?:grew|growth|increased|declined|fell|rose)/i],
    ["netIncomeGrowth", /(?:net\s+income|earnings)\s+(?:grew|growth|increased|declined|fell|rose)/i],
    ["epsGrowth", /eps\s+(?:grew|growth|increased|declined|fell|rose)/i],
    ["cashGrowth", /cash\s+(?:grew|growth|increased|declined|fell|rose)/i],
    ["liabilityGrowth", /liabilit(?:y|ies)\s+(?:grew|growth|increased|declined|fell|rose)/i],
    ["netProfitMarginChange", /net\s+(?:profit\s+)?margin\s+(?:improved|increased|declined|fell|rose|change)/i],
    ["returnOnAssetsChange", /return\s+on\s+assets\s+(?:improved|increased|declined|fell|rose|change)/i],
    ["liabilityToAssetRatioChange", /liabilit(?:y|ies)[-\s]+to[-\s]+asset\s+ratio\s+(?:improved|increased|declined|fell|rose|change)/i],
    ["cashToLiabilityRatioChange", /cash[-\s]+to[-\s]+liabilit(?:y|ies)\s+ratio\s+(?:improved|increased|declined|fell|rose|change)/i],
    ["netProfitMargin", /(?:net\s+(?:profit\s+)?margin|net\s+margin)\s+(?:was|is|stood)/i],
    ["returnOnAssets", /return\s+on\s+assets\s+(?:was|is|stood)/i],
    ["liabilityToAssetRatio", /liabilit(?:y|ies)[-\s]+to[-\s]+asset\s+ratio\s+(?:was|is|stood)/i],
    ["cashToLiabilityRatio", /cash[-\s]+to[-\s]+liabilit(?:y|ies)\s+ratio\s+(?:was|is|stood)/i],
    ["marketCap", /market\s+cap(?:italization)?/i], ["price", /share\s+price|stock\s+price/i],
    ["revenue", /revenue/i], ["netIncome", /net\s+income|earnings/i], ["eps", /\beps\b/i],
    ["cashAndEquivalents", /cash/i], ["totalLiabilities", /liabilit/i], ["totalAssets", /assets/i]
  ];
  // Bind periods to the individual sentence/JSON string, never a neighbouring
  // claim. A sentence containing multiple years is intentionally ambiguous.
  const claimContext = (text, index) => {
    if (typeof text !== "string" || typeof index !== "number") return text ?? "";
    const isBoundary = (position) => {
      const character = text[position];
      if (character === '"') return text[position - 1] !== "\\";
      return /[.!?;\n]/.test(character) && !(character === "." && /\d/.test(text[position - 1] ?? "") && /\d/.test(text[position + 1] ?? ""));
    };
    let left = index;
    let right = index;
    while (left > 0 && !isBoundary(left - 1)) left--;
    while (right < text.length && !isBoundary(right)) right++;
    return text.slice(left, right);
  };
  const claimYears = (text) => [...new Set((text ?? "").match(/\b(?:19|20)\d{2}\b/g) ?? [])];
  const hintedField = (text) => {
    const matches = fieldHints.filter(([, pattern]) => pattern.test(text ?? "")).map(([field]) => field);
    const primary = matches[0];
    const impliedRaw = {
      revenueGrowth: ["revenue"], netIncomeGrowth: ["netIncome"], epsGrowth: ["eps"],
      cashGrowth: ["cashAndEquivalents"], liabilityGrowth: ["totalLiabilities"],
      returnOnAssets: ["totalAssets"], liabilityToAssetRatio: ["totalAssets", "totalLiabilities"],
      cashToLiabilityRatio: ["cashAndEquivalents", "totalLiabilities"]
    };
    const allowed = new Set([primary, ...(impliedRaw[primary?.replace(/Change$/, "")] ?? [])]);
    // Multiple independent financial subjects in one unsplit claim are not
    // sufficient evidence to bind a number to a field confidently.
    return matches.every((field) => allowed.has(field)) ? primary ?? null : null;
  };
  const decrease = /\b(?:declined|decreased|fell|dropped|contracted)\b/i;
  const increase = /\b(?:grew|increased|rose|improved|expanded)\b/i;
  const isDerivedMovement = (field) => /(?:Growth|Change)$/.test(field ?? "");

  // Non-numeric historical direction claims still require a real, non-null
  // D2 change/growth metric. Do not let "zero candidates" accept them blindly.
  if (sourceText) {
    const trendPattern = /(?:return\s+on\s+assets|liability[-\s]+to[-\s]+asset\s+ratio|cash[-\s]+to[-\s]+liability\s+ratio|net\s+(?:profit\s+)?margin|revenue|net\s+income|eps|cash|liabilities)\s+(?:increased|declined|grew|rose|fell|improved)\s+(?:in\s+)?(?:fiscal\s+)?(?:19|20)\d{2}\b/gi;
    let trend;
    while ((trend = trendPattern.exec(sourceText)) !== null) {
      const context = claimContext(sourceText, trend.index);
      const years = claimYears(context);
      const field = hintedField(trend[0]);
      const eligible = facts.filter((fact) => fact && years.length === 1 && fact.periodType === "Annual" && fact.fiscalDate?.startsWith(`${years[0]}-`) && fact.field === field);
      const direction = decrease.test(trend[0]) ? -1 : 1;
      const matched = eligible.length === 1 && Number.isFinite(eligible[0].canonicalValue) && Math.sign(eligible[0].canonicalValue) === direction ? eligible[0] : null;
      const candidate = { rawText: trend[0], startIndex: trend.index, endIndex: trend.index + trend[0].length, inferredNotation: "historical_direction" };
      if (matched && !isDirectionalProjectionContext(sourceText, trend.index)) supported.push({ candidate, matchedFact: { ...matched } });
      else unsupported.push({ candidate, reason: "unsupported_historical_direction" });
    }
  }

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

    const claimText = claimContext(textToInspect, startIdx);
    const years = claimYears(claimText);
    const year = years.length === 1 ? years[0] : null;
    const explicitDates = [...new Set(claimText.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [])];
    const unsupportedPeriod = /\bQ[1-4]\b|\bquarter(?:ly)?\b/i.test(claimText);
    const field = hintedField(claimText);
    const movement = isDerivedMovement(field);
    const eligibleFacts = facts.filter((fact) => {
      if (!fact || years.length > 1 || explicitDates.length > 1 || unsupportedPeriod) return false;
      if (year) return fact.periodType === "Annual" && typeof fact.fiscalDate === "string" && fact.fiscalDate.startsWith(`${year}-`) && (explicitDates.length === 0 || fact.fiscalDate === explicitDates[0]) && field !== null && fact.field === field;
      // Unqualified current facts retain legacy matching, but growth/change
      // claims may not borrow a current ratio that happens to have the value.
      return !fact.fiscalDate && !movement;
    });

    if (textToInspect !== null && startIdx !== null && isDirectionalProjectionContext(textToInspect, startIdx)) {
      unsupported.push({
        candidate,
        reason: "directional_projection_claim",
      });
      continue;
    }

    let matchedFact = null;
    for (const fact of eligibleFacts) {
      if (!fact || typeof fact.canonicalValue !== "number" || typeof fact.factType !== "string") {
        continue;
      }

      let valueToMatch = candidate.rawText;
      if (/percentage\s+points?/i.test(valueToMatch) && !/Change$/.test(field ?? "")) continue;
      if (movement) {
        const negativeDirection = decrease.test(claimText);
        const positiveDirection = increase.test(claimText);
        if ((negativeDirection && fact.canonicalValue >= 0) || (positiveDirection && fact.canonicalValue <= 0)) continue;
        // "declined 2.8%" expresses the magnitude of an already-calculated
        // negative growth rate. This is notation conversion, not recalculation.
        if (negativeDirection && !/^[+-]/.test(valueToMatch)) valueToMatch = `-${valueToMatch}`;
      }
      if (matchesVerifiedValue(valueToMatch, fact.canonicalValue, fact.factType)) {
        matchedFact = {
            field: fact.field,
            factType: fact.factType,
            canonicalValue: fact.canonicalValue,
            ...(fact.fiscalDate && { fiscalDate: fact.fiscalDate, periodType: fact.periodType }),
        };
        break;
      }
    }

    if (matchedFact !== null) {
      supported.push({ candidate, matchedFact });
    } else {
      unsupported.push({
        candidate,
          reason: year && eligibleFacts.length === 0 ? "historical_period_not_available" : facts.length === 0 ? "no_verified_facts_available" : "unsupported_numeric_claim",
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
