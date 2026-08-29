import { env } from "../config/env.js";
import { AppError } from "../utils/appError.js";
import {
  fetchRawFinancialData,
  FINANCIAL_PROVIDER_SOURCE
} from "./providers/alphaVantageProvider.js";

// Process-local LRU-ish cache: Map preserves insertion order.
// On read/write, a key is moved to the newest position. When size exceeds
// MAX_FINANCIAL_CACHE_ENTRIES, the oldest entry is evicted. No Redis/DB.
const cache = new Map();
export const MAX_FINANCIAL_CACHE_ENTRIES = 256;

const RESOLUTION_MAP = {
  apple: "AAPL",
  "apple inc": "AAPL",
  "apple inc.": "AAPL",
  tesla: "TSLA",
  "tesla inc": "TSLA",
  "tesla inc.": "TSLA",
  "tesla corp": "TSLA",
  "tesla corporation": "TSLA",
  nokia: "NOK",
  "nokia corp": "NOK",
  "nokia corporation": "NOK",
  microsoft: "MSFT",
  "microsoft corp": "MSFT",
  "microsoft corporation": "MSFT",
  google: "GOOGL",
  alphabet: "GOOGL",
  amazon: "AMZN",
  nvidia: "NVDA",
  meta: "META",
  netflix: "NFLX"
};

/**
 * Resolves a company name to a valid ticker.
 * If reliable resolution is not possible, throws a controlled AppError.
 */
export const resolveCompanyToTicker = (companyInput) => {
  if (typeof companyInput !== "string") {
    throw new AppError("Company input must be a string.", 400);
  }

  const cleaned = companyInput.trim();
  if (!cleaned) {
    throw new AppError("Company input cannot be empty.", 400);
  }

  const lower = cleaned.toLowerCase();
  if (RESOLUTION_MAP[lower]) {
    return RESOLUTION_MAP[lower];
  }

  // Direct tickers: AAPL, aapl, and class shares such as BRK.B / BRK-B.
  const tickerLike = cleaned.toUpperCase().replace(/-/g, ".");
  if (/^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(tickerLike)) {
    return tickerLike;
  }

  throw new AppError(
    `Could not reliably resolve company name "${companyInput}" to a ticker symbol.`,
    400
  );
};

const parseNumber = (val) => {
  if (val === null || val === undefined || val === "" || val === "None" || val === "null") {
    return null;
  }
  const parsed = Number(val);
  return Number.isFinite(parsed) ? parsed : null;
};

const usableText = (val) => {
  if (typeof val !== "string") {
    return null;
  }
  const trimmed = val.trim();
  if (!trimmed || trimmed === "None" || trimmed === "null") {
    return null;
  }
  return trimmed;
};

const setCacheEntry = (ticker, entry) => {
  if (cache.has(ticker)) {
    cache.delete(ticker);
  }
  cache.set(ticker, entry);
  while (cache.size > MAX_FINANCIAL_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
};

const getCachedData = (ticker) => {
  const cached = cache.get(ticker);
  if (!cached) {
    return null;
  }

  if (Date.now() >= cached.expiresAt) {
    cache.delete(ticker);
    return null;
  }

  cache.delete(ticker);
  cache.set(ticker, cached);
  return cached.data;
};

const normalizeFinancialData = (ticker, raw) => {
  const { overview, quote, income, balance } = raw;

  const name = usableText(overview?.Name);
  const overviewSymbol = usableText(overview?.Symbol);
  const exchange = usableText(overview?.Exchange);
  const currency = usableText(overview?.Currency);

  const quoteData = quote?.["Global Quote"] ?? {};
  const price = parseNumber(quoteData["05. price"]);
  const marketCap = parseNumber(overview?.MarketCapitalization);

  const annualIncomeReports = income?.annualReports ?? [];
  const latestIncome = annualIncomeReports[0] ?? {};
  const fiscalDate = usableText(latestIncome.fiscalDateEnding);
  const revenue = parseNumber(latestIncome.totalRevenue);
  const netIncome = parseNumber(latestIncome.netIncome);
  const eps = parseNumber(overview?.EPS);

  const annualBalanceReports = balance?.annualReports ?? [];
  const latestBalance = annualBalanceReports[0] ?? {};
  const totalAssets = parseNumber(latestBalance.totalAssets);
  const totalLiabilities = parseNumber(latestBalance.totalLiabilities);
  const cashAndEquivalents = parseNumber(latestBalance.cashAndCashEquivalentsAtCarryingValue);

  const hasIdentity = Boolean(name || overviewSymbol);
  const hasQuote = price !== null || marketCap !== null;
  if (!hasIdentity && !hasQuote) {
    throw new AppError(`No financial data found for ticker "${ticker}".`, 404);
  }

  return {
    company: {
      name,
      ticker,
      exchange,
      currency
    },
    market: {
      price,
      marketCap
    },
    financials: {
      revenue,
      netIncome,
      eps,
      totalAssets,
      totalLiabilities,
      cashAndEquivalents
    },
    periods: {
      fiscalDate,
      periodType: "Annual"
    },
    metadata: {
      source: FINANCIAL_PROVIDER_SOURCE,
      retrievedAt: new Date().toISOString()
    }
  };
};

/**
 * Retrieves and normalizes financial data for a ticker.
 */
export const getFinancialData = async (symbol, options = {}) => {
  if (typeof symbol !== "string" || !symbol.trim()) {
    throw new AppError("Ticker symbol is required.", 400);
  }

  const ticker = symbol.trim().toUpperCase().replace(/-/g, ".");
  const ttl = options.ttl ?? env.financialCacheTtlMs;

  const cached = getCachedData(ticker);
  if (cached) {
    return cached;
  }

  const raw = await fetchRawFinancialData(ticker);
  const normalized = normalizeFinancialData(ticker, raw);

  setCacheEntry(ticker, {
    data: normalized,
    expiresAt: Date.now() + ttl
  });

  return normalized;
};

export const clearFinancialCache = () => {
  cache.clear();
};

export const getFinancialCacheSize = () => cache.size;

export const hasFinancialCacheEntry = (ticker) => {
  if (typeof ticker !== "string") {
    return false;
  }
  return cache.has(ticker.trim().toUpperCase().replace(/-/g, "."));
};
