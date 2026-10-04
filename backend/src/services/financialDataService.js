import { env } from "../config/env.js";
import { AppError } from "../utils/appError.js";
import {
  fetchRawFinancialData,
  FINANCIAL_PROVIDER_SOURCE
} from "./providers/fmpProvider.js";

// Process-local LRU-ish cache: Map preserves insertion order.
// On read/write, a key is moved to the newest position. When size exceeds
// MAX_FINANCIAL_CACHE_ENTRIES, the oldest entry is evicted. No Redis/DB.
const cache = new Map();
const inFlightRequests = new Map();
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

const usableFiscalDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : value;
};

const annualStatementsByDate = (statements) => {
  const byDate = new Map();
  for (const statement of statements) {
    const date = usableFiscalDate(statement?.date ?? statement?.fiscalDateEnding);
    if (!date || (statement?.period && statement.period !== "FY" && statement.period !== "Annual")) {
      continue;
    }
    // Provider order is authoritative for duplicate dates, making this deterministic.
    if (!byDate.has(date)) byDate.set(date, { ...statement, date, fiscalDateEnding: date });
  }
  return byDate;
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

  const profile = raw.profile ?? overview ?? {};
  const quoteData = Array.isArray(quote) ? quote[0] ?? {} : quote ?? {};
  const incomeStatements = Array.isArray(income) ? income : income?.annualReports ?? [];
  const balanceSheets = Array.isArray(balance) ? balance : balance?.annualReports ?? [];
  const incomeByDate = annualStatementsByDate(incomeStatements);
  const balanceByDate = annualStatementsByDate(balanceSheets);
  const annualDates = [...new Set([...incomeByDate.keys(), ...balanceByDate.keys()])]
    .sort((left, right) => right.localeCompare(left))
    .slice(0, 5);
  const annualPeriods = annualDates.map((date) => {
    const incomeStatement = incomeByDate.get(date) ?? {};
    const balanceStatement = balanceByDate.get(date) ?? {};
    return {
      fiscalDate: date,
      periodType: "Annual",
      revenue: parseNumber(incomeStatement.revenue ?? incomeStatement.totalRevenue),
      netIncome: parseNumber(incomeStatement.netIncome),
      eps: parseNumber(incomeStatement.eps),
      totalAssets: parseNumber(balanceStatement.totalAssets),
      totalLiabilities: parseNumber(balanceStatement.totalLiabilities),
      cashAndEquivalents: parseNumber(
        balanceStatement.cashAndCashEquivalents ?? balanceStatement.cashAndCashEquivalentsAtCarryingValue
      )
    };
  });
  const latestPeriod = annualPeriods[0] ?? null;

  const name = usableText(profile.companyName ?? profile.Name);
  const overviewSymbol = usableText(profile.symbol ?? profile.Symbol);
  const exchange = usableText(profile.exchangeShortName ?? profile.exchange ?? profile.Exchange);
  const currency = usableText(profile.currency ?? profile.Currency);

  const price = parseNumber(quoteData.price ?? quoteData["Global Quote"]?.["05. price"]);
  const marketCap = parseNumber(
    quoteData.marketCap ?? profile.mktCap ?? profile.MarketCapitalization
  );

  const fiscalDate = latestPeriod?.fiscalDate ?? null;
  const revenue = latestPeriod?.revenue ?? null;
  const netIncome = latestPeriod?.netIncome ?? null;
  const eps = latestPeriod?.eps ?? null;
  const totalAssets = latestPeriod?.totalAssets ?? null;
  const totalLiabilities = latestPeriod?.totalLiabilities ?? null;
  const cashAndEquivalents = latestPeriod?.cashAndEquivalents ?? null;

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
      cashAndEquivalents,
      annualPeriods
    },
    periods: {
      fiscalDate,
      // FMP's annual records use period: "FY"; the public contract remains "Annual".
      periodType: "Annual",
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

  const inFlightRequest = inFlightRequests.get(ticker);
  if (inFlightRequest) {
    return inFlightRequest;
  }

  const request = (async () => {
    try {
      const raw = await fetchRawFinancialData(ticker);
      const normalized = normalizeFinancialData(ticker, raw);

      setCacheEntry(ticker, {
        data: normalized,
        expiresAt: Date.now() + ttl
      });

      return normalized;
    } finally {
      inFlightRequests.delete(ticker);
    }
  })();

  inFlightRequests.set(ticker, request);
  return request;
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
