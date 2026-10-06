// D4 Step 2 — external-research prompt-context reduction (tightened by the
// D4 max-reduction pass). The normalized externalResearch state (and its API
// contract) still carries up to 8 Tavily results with untruncated content.
// Only the PROMPT representation is reduced here: at most the first 3 results
// in the existing deterministic order, and each content snippet hard-capped
// at 300 characters. Truncation is prefix-only slicing — content is never
// summarized, invented, or reordered, and snippets already within the cap are
// preserved verbatim.
const MAX_PROMPT_EVIDENCE_RESULTS = 3;
const MAX_PROMPT_EVIDENCE_CONTENT_CHARS = 300;
// A sentence boundary earlier than this would discard most of the snippet
// budget, so below it the deterministic hard maximum is used instead.
const MIN_PROMPT_SENTENCE_CUT_CHARS = 150;

const truncateEvidenceContent = (content) => {
  if (content.length <= MAX_PROMPT_EVIDENCE_CONTENT_CHARS) {
    return content;
  }

  const window = content.slice(0, MAX_PROMPT_EVIDENCE_CONTENT_CHARS);
  const sentenceCut = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? ")
  );

  // Prefer ending on a complete sentence when that boundary still keeps a
  // useful amount of evidence; otherwise cut at the hard maximum.
  if (sentenceCut + 1 >= MIN_PROMPT_SENTENCE_CUT_CHARS) {
    return window.slice(0, sentenceCut + 1);
  }
  return window;
};

const formatExternalResearchContext = (externalResearch) => {
  if (!externalResearch || !Array.isArray(externalResearch.results) || externalResearch.results.length === 0) {
    return "";
  }

  const resultsFormatted = externalResearch.results
    .slice(0, MAX_PROMPT_EVIDENCE_RESULTS)
    .map(
      (r, i) => `[Result ${i + 1}]
Title: ${r.title}
URL: ${r.url}
Source Domain: ${r.domain}
Relevance Score: ${r.relevanceScore}
Content Snippet: ${truncateEvidenceContent(r.content)}`
    )
    .join("\n\n");

  return `
EXTERNAL RESEARCH EVIDENCE (UNVERIFIED QUALITATIVE CONTEXT):
The following external web research results are supplied as background qualitative evidence:
${resultsFormatted}

EXTERNAL RESEARCH INTEGRITY RULES:
- The external research evidence above is UNVERIFIED qualitative web content, NOT verified financial data.
- Do NOT use, extract, or cite financial numbers from EXTERNAL RESEARCH EVIDENCE as verified financial facts.
- Numerical financial claims in your response must be grounded ONLY in the VERIFIED FINANCIAL CONTEXT section.
- Use external research strictly for qualitative business context, market developments, and strategic drivers/risks.
- Source Domain is URL-derived provenance only, NOT a verified publisher or author identity.
- The current Tavily integration provides no verified publication date. Never invent, infer, or estimate an exact publication date or freshness date.
- Explicit temporal wording in the content, such as "yesterday", "this week", "in September 2026", "Q3 2026", "last month", or "announced on...", may be used only as qualitative freshness signals, NOT as proof of a publication date.
- If content has no clear temporal grounding, treat it as UNDATED. Undated evidence can be useful background, but is NOT a confirmed current event or catalyst merely because it appears in search results.
- Prefer explicitly time-grounded evidence when discussing current developments or catalysts.
- Never manufacture dates, event timing, or recency.
`.trim();
};

// D4 max-reduction pass — annual-period prompt cap. The normalized
// financialData/financialMetrics state keeps the provider's 5 annual periods;
// only the PROMPT representation is reduced to the newest 3, preserving each
// period's fiscalDate, periodType, and metric fields. No metrics are
// recomputed and no state is mutated.
const MAX_PROMPT_ANNUAL_PERIODS = 3;

const newestAnnualPeriods = (periods) => {
  if (!Array.isArray(periods) || periods.length <= MAX_PROMPT_ANNUAL_PERIODS) {
    return periods ?? [];
  }
  const indexed = periods.map((period, index) => ({ period, index, key: String(period?.fiscalDate ?? "") }));
  const newest = [...indexed]
    .sort((left, right) => right.key.localeCompare(left.key) || left.index - right.index)
    .slice(0, MAX_PROMPT_ANNUAL_PERIODS);
  // Re-emit the kept periods in their original relative order (newest-first
  // per the provider contract).
  return newest.sort((left, right) => left.index - right.index).map(({ period }) => period);
};

const formatVerifiedFinancialContext = (financialData, spacing = 2) => {
  if (!financialData || typeof financialData !== "object") {
    return JSON.stringify(financialData ?? null, null, spacing);
  }
  const financials = financialData.financials ?? {};
  return JSON.stringify(
    {
      ...financialData,
      financials: { ...financials, annualPeriods: newestAnnualPeriods(financials.annualPeriods) }
    },
    null,
    spacing
  );
};

/**
 * Serializes verified derived metrics for the financial prompts as
 * { current, annual } only (annual capped to the newest 3 periods).
 * calculateFinancialMetrics() also returns flat current-metric aliases for
 * API compatibility; those aliases duplicate `current` and must not enter
 * the LLM context. Flat-only inputs (legacy fixtures) are normalized into
 * the same shape so no metric is lost.
 */
const formatVerifiedDerivedMetrics = (financialMetrics, spacing = 2) => {
  if (!financialMetrics || typeof financialMetrics !== "object") {
    return JSON.stringify({ current: null, annual: [] }, null, spacing);
  }
  const current = financialMetrics.current ?? {
    netProfitMargin: financialMetrics.netProfitMargin ?? null,
    returnOnAssets: financialMetrics.returnOnAssets ?? null,
    liabilityToAssetRatio: financialMetrics.liabilityToAssetRatio ?? null,
    cashToLiabilityRatio: financialMetrics.cashToLiabilityRatio ?? null,
    peRatio: financialMetrics.peRatio ?? null
  };
  return JSON.stringify({ current, annual: newestAnnualPeriods(financialMetrics.annual ?? []) }, null, spacing);
};

// D4 deterministic canonical financial fact layer. Renders ALREADY-VERIFIED
// backend values as fixed-phrasing statements whose forms are known to bind
// in the D3 integrity matcher (field hints + single-year claim contexts):
//   - CURRENT facts are deliberately unattributed (no fiscal year anywhere in
//     the sentence) and match the current (fiscalDate-less) verified facts.
//   - ANNUAL facts carry exactly one fiscal year derived from fiscalDate and
//     match the annual period facts.
// Ratio values are rendered in percentage notation via ×100 with two
// decimals — lossless for D2's 4-decimal ratios (notation conversion only,
// no recalculation or re-rounding of the verified value). The P/E multiple
// has no D3 historical field hint, so it is rendered only as an unattributed
// current fact, exactly as supplied. Negative growth uses neutral wording.
// Null/unavailable metrics are omitted — nothing is fabricated. Fully
// deterministic: no Groq call, no new calculations.
export const formatCanonicalFinancialFacts = (financialData, financialMetrics) => {
  void financialData; // reserved for future currency/per-share fact rendering

  if (!financialMetrics || typeof financialMetrics !== "object") {
    return "";
  }

  const current = financialMetrics.current ?? {
    netProfitMargin: financialMetrics.netProfitMargin ?? null,
    returnOnAssets: financialMetrics.returnOnAssets ?? null,
    liabilityToAssetRatio: financialMetrics.liabilityToAssetRatio ?? null,
    cashToLiabilityRatio: financialMetrics.cashToLiabilityRatio ?? null,
    peRatio: financialMetrics.peRatio ?? null
  };

  const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
  const asPercent = (value) => `${(value * 100).toFixed(2)}%`;

  const currentLines = [];
  if (isFiniteNumber(current.netProfitMargin)) currentLines.push(`- Current net profit margin was ${asPercent(current.netProfitMargin)}.`);
  if (isFiniteNumber(current.returnOnAssets)) currentLines.push(`- Current return on assets was ${asPercent(current.returnOnAssets)}.`);
  if (isFiniteNumber(current.liabilityToAssetRatio)) currentLines.push(`- Current liability-to-asset ratio was ${asPercent(current.liabilityToAssetRatio)}.`);
  if (isFiniteNumber(current.cashToLiabilityRatio)) currentLines.push(`- Current cash-to-liability ratio was ${asPercent(current.cashToLiabilityRatio)}.`);
  if (isFiniteNumber(current.peRatio)) currentLines.push(`- Current P/E ratio was ${String(current.peRatio)}.`);

  const annualLines = [];
  for (const period of newestAnnualPeriods(financialMetrics.annual ?? [])) {
    const fiscalDate = typeof period?.fiscalDate === "string" ? period.fiscalDate : "";
    if (!/^\d{4}-/.test(fiscalDate)) continue;
    const fiscalYear = fiscalDate.slice(0, 4);
    const growthFact = (label, field) => {
      if (isFiniteNumber(period[field])) annualLines.push(`- Fiscal ${fiscalYear} ${label} was ${asPercent(period[field])}.`);
    };
    growthFact("revenue growth", "revenueGrowth");
    growthFact("net income growth", "netIncomeGrowth");
    growthFact("EPS growth", "epsGrowth");
    growthFact("cash growth", "cashGrowth");
  }

  const sections = [];
  if (currentLines.length > 0) sections.push(`CURRENT FINANCIAL FACTS\n${currentLines.join("\n")}`);
  if (annualLines.length > 0) sections.push(`ANNUAL FINANCIAL FACTS\n${annualLines.join("\n")}`);
  if (sections.length === 0) return "";

  return `CANONICAL FINANCIAL FACTS (quote exactly, one per sentence):\n\n${sections.join("\n\n")}`;
};

// Shared financial-integrity rule blocks (D3/D4.1 contract). The wording is
// deliberately compact for the max-reduction pass; every rule that the
// deterministic validation relies on or that the prompt contracts pin is
// preserved verbatim, and the duplicated prose between the three financial
// prompts is deduplicated into these shared blocks.
const FINANCIAL_DATA_RULES = `
FINANCIAL DATA INTEGRITY RULES:
- Use ONLY the numerical values explicitly present in the VERIFIED FINANCIAL CONTEXT above.
- A null field means that value is unavailable — never guess, estimate, substitute, or invent a replacement.
- Do not claim financial information is live or current beyond the retrievedAt timestamp shown above.`;

const DERIVED_METRICS_RULES = `
DERIVED METRICS INTEGRITY RULES:
- Use ONLY the supplied metrics; null means unavailable.
- Do not calculate, recompute, invent, or introduce new financial metrics or ratios yourself — the VERIFIED DERIVED FINANCIAL METRICS section below is the only metric source you may use.
- The supplied metrics are backend-authoritative: use them when financially relevant, but do not calculate, recompute, invent, or introduce new financial metrics.
- Do not create a metric by performing additional arithmetic on supplied values.`;

const NO_FUTURE_CLAIMS_RULES = `
NO FUTURE QUANTITATIVE CLAIMS & NO DIRECTIONAL BENCHMARKING:
- Do NOT invent, estimate, forecast, project, target, or introduce any future quantitative value.
- Do NOT use verified historical/current numbers as future directional targets, thresholds, bounds, or projected levels.
- State verified numbers only as historical/current facts; never transform them into future thresholds, bounds, targets, or projected levels (e.g. "beyond $416B", "rising to $500B", "reaching $5T").
- Scenarios must remain qualitative unless the prompt explicitly supplies a future quantitative value.`;

// D4 one-call consolidation: a single Groq analysis call produces the full
// research profile (the strict union formerly split across four nodes).
// Reuses every verified building block: external evidence (3 results,
// 300-char snippets), newest-3 financial context, derived metrics, the
// canonical financial fact statements, and the shared integrity rules.
export const buildAnalysisPrompt = ({ company, externalResearch, financialData, financialMetrics }) => {
  const evidenceSection = formatExternalResearchContext(externalResearch);
  const evidenceBlock = evidenceSection ? `\n\n${evidenceSection}` : "";

  return `
You are a senior equity research analyst producing a complete investment research profile for ${company} in ONE analysis.
Research the company and synthesize qualitative research, business fundamentals, an investment thesis, and a final recommendation.${evidenceBlock}

The overview, industry, strengths, and risks sections must be strictly qualitative business analysis.

IMPORTANT DATA INTEGRITY RULES:
- Do NOT fabricate or guess real-time or quantitative financial metrics (no stock prices, P/E ratios, market capitalization, specific revenue numbers, margins, growth percentages, or earnings figures) beyond the verified financial context below.
- Do NOT present unverified financial metrics as facts.

VERIFIED FINANCIAL CONTEXT:
Backend-verified financial data:
${formatVerifiedFinancialContext(financialData, 0)}
${FINANCIAL_DATA_RULES}

VERIFIED DERIVED FINANCIAL METRICS:
${formatVerifiedDerivedMetrics(financialMetrics, 0)}
${DERIVED_METRICS_RULES}

${NO_FUTURE_CLAIMS_RULES}

Produce every section concisely in the single JSON object below.

NARRATIVE RULES (override any other instruction):
- All financial numbers are authoritative backend data delivered through financialData/financialMetrics — never reproduce them in narrative text.
- Do not include percentages, currency amounts (or words like billion/million), multiples (e.g. "2x"), ratios, growth rates, prices, market capitalization, revenue figures, net income figures, EPS, P/E, or other financial figures in overview, industry, strengths, risks, fundamentalAssessment, keyCatalysts, keyConcerns, investmentThesis, bullCase, bearCase, or reasoning.
- Use the verified financial data to choose accurate qualitative characterizations without stating the values. For example: "strong profitability", "improving liquidity", or "reasonable valuation".
- Non-financial structured fields such as confidence and recommendation follow their existing schema rules.

Return ONLY valid JSON with this exact shape:
{
  "overview": "Concise qualitative business overview (max 60 words)",
  "industry": "Primary industry sector",
  "strengths": ["Qualitative strategic strength 1", "Qualitative strategic strength 2", "Qualitative strategic strength 3"],
  "risks": ["Qualitative structural risk 1", "Qualitative structural risk 2", "Qualitative structural risk 3"],
  "fundamentalAssessment": {
    "businessQuality": "Qualitative assessment of business model durability, pricing power, and customer value proposition (max 50 words)",
    "competitiveAdvantage": "Qualitative assessment of economic moat, intellectual property, scale, or switching costs (max 50 words)",
    "financialHealth": "Assessment grounded in the verified financial context where values are available; note any unavailable (null) fields (max 80 words)"
  },
  "keyCatalysts": ["Qualitative growth catalyst 1", "Qualitative growth catalyst 2", "Qualitative growth catalyst 3"],
  "keyConcerns": ["Qualitative structural concern 1", "Qualitative structural concern 2", "Qualitative structural concern 3"],
  "investmentThesis": "Core investment thesis grounded in qualitative analysis and verified financial context (max 90 words)",
  "bullCase": "Optimistic scenario describing how the business model thrives; use verified financial data for a qualitative assessment only and do not reproduce financial figures, percentages, ratios, multiples, prices, currency amounts, growth rates, or other financial numbers (max 60 words)",
  "bearCase": "Downside scenario describing how structural risks or financial weaknesses materialize (max 60 words)",
  "recommendation": "Invest",
  "confidence": 80,
  "reasoning": "Clear rationale grounding the recommendation in the qualitative analysis and verified financial context (max 60 words)"
}
Rules:
- Keep overview concise (max 60 words); industry must be one concise value.
- Strengths and risks must each contain exactly 3 clear, concise, qualitative bullet strings.
- businessQuality and competitiveAdvantage: max 50 words each. financialHealth: max 80 words.
- keyCatalysts and keyConcerns: exactly 3 concise qualitative items each.
- investmentThesis must be a cohesive, high-level strategic argument (max 90 words).
- bullCase and bearCase: 2 to 3 concise sentences, max 60 words each.
- Recommendation must be EXACTLY one of: "Invest", "Hold", "Avoid".
- "Invest": strong quality, clear moat, and catalysts that outweigh risks. "Hold": balanced risk/reward or notable uncertainty. "Avoid": substantial structural risks or severe headwinds.
- Confidence: an INTEGER between 0 and 100 reflecting conviction based on the qualitative analysis and verified financial context.
 - Reasoning: max 60 words, use verified financial data to support the reasoning qualitatively, but do not reproduce financial figures, percentages, ratios, multiples, prices, currency amounts, growth rates, or other financial numbers.
- No markdown formatting outside JSON. No extra keys.
`;
};
