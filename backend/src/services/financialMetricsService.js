/**
 * Deterministic financial metrics service.
 *
 * Accepts the normalized financialData object produced by financialDataService
 * and returns derived metrics. All calculations are pure functions with no
 * external I/O, no mutation of inputs, and strict null-safety.
 *
 * Input contract (from financialDataService normalizeFinancialData):
 *   financialData.financials: { revenue, netIncome, eps, totalAssets, totalLiabilities, cashAndEquivalents }
 *   financialData.market:     { price, marketCap }
 *
 * Output contract:
 *   { netProfitMargin, returnOnAssets, liabilityToAssetRatio, cashToLiabilityRatio, peRatio }
 *
 * Every metric is either a number rounded to 4 decimal places or null.
 * Never returns NaN or Infinity.
 */

/**
 * Returns true only when value is a finite number (not null, undefined, NaN, or ±Infinity).
 * Legitimate zero passes this check.
 */
const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Rounds a finite number to 4 decimal places.
 * Assumes the caller has already verified the value is finite.
 */
const roundTo4 = (value) => Math.round(value * 10000) / 10000;

/**
 * Safely divides numerator by denominator.
 *
 * Returns null when:
 *   - either operand is null, undefined, or not a finite number
 *   - the denominator is zero (avoids Infinity / -Infinity)
 *
 * Otherwise returns the quotient rounded to 4 decimal places.
 */
const safeDivide = (numerator, denominator) => {
  if (!isFiniteNumber(numerator) || !isFiniteNumber(denominator)) {
    return null;
  }
  if (denominator === 0) {
    return null;
  }
  return roundTo4(numerator / denominator);
};

/**
 * Calculates deterministic financial metrics from normalized financial data.
 *
 * @param {object|null|undefined} financialData - The normalized financialData
 *   object as returned by financialDataService.getFinancialData().
 * @returns {{ netProfitMargin: number|null, returnOnAssets: number|null,
 *             liabilityToAssetRatio: number|null, cashToLiabilityRatio: number|null,
 *             peRatio: number|null }}
 */
export const calculateFinancialMetrics = (financialData) => {
  const financials = financialData?.financials;
  const market = financialData?.market;

  const revenue = financials?.revenue ?? null;
  const netIncome = financials?.netIncome ?? null;
  const eps = financials?.eps ?? null;
  const totalAssets = financials?.totalAssets ?? null;
  const totalLiabilities = financials?.totalLiabilities ?? null;
  const cashAndEquivalents = financials?.cashAndEquivalents ?? null;
  const price = market?.price ?? null;

  // 1. Net profit margin: netIncome / revenue
  const netProfitMargin = safeDivide(netIncome, revenue);

  // 2. Return on assets: netIncome / totalAssets
  const returnOnAssets = safeDivide(netIncome, totalAssets);

  // 3. Liability-to-assets ratio: totalLiabilities / totalAssets
  const liabilityToAssetRatio = safeDivide(totalLiabilities, totalAssets);

  // 4. Cash-to-liabilities ratio: cashAndEquivalents / totalLiabilities
  const cashToLiabilityRatio = safeDivide(cashAndEquivalents, totalLiabilities);

  // 5. P/E ratio: price / eps
  //    Additional constraint: negative or zero EPS → null.
  let peRatio;
  if (!isFiniteNumber(eps) || eps <= 0) {
    peRatio = null;
  } else {
    peRatio = safeDivide(price, eps);
  }

  return {
    netProfitMargin,
    returnOnAssets,
    liabilityToAssetRatio,
    cashToLiabilityRatio,
    peRatio
  };
};
