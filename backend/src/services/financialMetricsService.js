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
 * Output contract preserves the existing flat current metrics and adds an
 * authoritative period-aware `annual` analysis array.
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
 * Calculates conventional growth only for positive-to-positive values.
 * Sign changes and negative bases are intentionally null because a percentage
 * growth interpretation is misleading for those cases.
 */
export const calculateGrowth = (current, previous) => {
  if (!isFiniteNumber(current) || !isFiniteNumber(previous) || previous <= 0 || current < 0) {
    return null;
  }
  return roundTo4((current / previous) - 1);
};

export const calculateChange = (current, previous) => {
  if (!isFiniteNumber(current) || !isFiniteNumber(previous)) return null;
  return roundTo4(current - previous);
};

export const calculateMargin = (netIncome, revenue) => safeDivide(netIncome, revenue);
export const calculateROA = (netIncome, assets) => safeDivide(netIncome, assets);
export const calculateLiabilityToAsset = (liabilities, assets) => safeDivide(liabilities, assets);
export const calculateCashToLiability = (cash, liabilities) => safeDivide(cash, liabilities);

const periodMetrics = (period, previous) => {
  const netProfitMargin = calculateMargin(period.netIncome, period.revenue);
  const returnOnAssets = calculateROA(period.netIncome, period.totalAssets);
  const liabilityToAssetRatio = calculateLiabilityToAsset(period.totalLiabilities, period.totalAssets);
  const cashToLiabilityRatio = calculateCashToLiability(period.cashAndEquivalents, period.totalLiabilities);

  return {
    fiscalDate: period.fiscalDate,
    periodType: period.periodType,
    revenueGrowth: calculateGrowth(period.revenue, previous?.revenue),
    netIncomeGrowth: calculateGrowth(period.netIncome, previous?.netIncome),
    epsGrowth: calculateGrowth(period.eps, previous?.eps),
    cashGrowth: calculateGrowth(period.cashAndEquivalents, previous?.cashAndEquivalents),
    liabilityGrowth: calculateGrowth(period.totalLiabilities, previous?.totalLiabilities),
    netProfitMargin,
    returnOnAssets,
    liabilityToAssetRatio,
    cashToLiabilityRatio,
    netProfitMarginChange: calculateChange(netProfitMargin, previous?.netProfitMargin),
    returnOnAssetsChange: calculateChange(returnOnAssets, previous?.returnOnAssets),
    liabilityToAssetRatioChange: calculateChange(liabilityToAssetRatio, previous?.liabilityToAssetRatio),
    cashToLiabilityRatioChange: calculateChange(cashToLiabilityRatio, previous?.cashToLiabilityRatio)
  };
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

  const netProfitMargin = calculateMargin(netIncome, revenue);

  // 2. Return on assets: netIncome / totalAssets
  const returnOnAssets = calculateROA(netIncome, totalAssets);

  // 3. Liability-to-assets ratio: totalLiabilities / totalAssets
  const liabilityToAssetRatio = calculateLiabilityToAsset(totalLiabilities, totalAssets);

  // 4. Cash-to-liabilities ratio: cashAndEquivalents / totalLiabilities
  const cashToLiabilityRatio = calculateCashToLiability(cashAndEquivalents, totalLiabilities);

  // 5. P/E ratio: price / eps
  //    Additional constraint: negative or zero EPS → null.
  let peRatio;
  if (!isFiniteNumber(eps) || eps <= 0) {
    peRatio = null;
  } else {
    peRatio = safeDivide(price, eps);
  }

  const current = {
    netProfitMargin,
    returnOnAssets,
    liabilityToAssetRatio,
    cashToLiabilityRatio,
    peRatio
  };

  const annualPeriods = Array.isArray(financials?.annualPeriods) ? financials.annualPeriods : [];
  const annual = annualPeriods.map((period, index) => {
    const previous = index + 1 < annualPeriods.length ? annualPeriods[index + 1] : null;
    const previousMetrics = previous ? periodMetrics(previous, null) : null;
    return periodMetrics(period, previous ? { ...previous, ...previousMetrics } : null);
  });

  return {
    ...current,
    current,
    annual
  };
};
