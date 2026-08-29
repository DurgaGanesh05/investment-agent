import { env } from "../config/env.js";
import { AppError } from "../utils/appError.js";

// Cache Map: ticker/identifier -> { data, expiresAt }
const cache = new Map();
const DEFAULT_TTL_MS = 3600000; // 1 hour

const RESOLUTION_MAP = {
  "apple": "AAPL",
  "apple inc": "AAPL",
  "apple inc.": "AAPL",
  "tesla": "TSLA",
  "tesla inc": "TSLA",
  "tesla inc.": "TSLA",
  "tesla corp": "TSLA",
  "tesla corporation": "TSLA",
  "nokia": "NOK",
  "nokia corp": "NOK",
  "nokia corporation": "NOK",
  "microsoft": "MSFT",
  "microsoft corp": "MSFT",
  "microsoft corporation": "MSFT",
  "google": "GOOGL",
  "alphabet": "GOOGL",
  "amazon": "AMZN",
  "nvidia": "NVDA",
  "meta": "META",
  "netflix": "NFLX"
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

  // If matches ticker pattern (1-5 uppercase alphabetic letters), use it directly
  if (/^[A-Za-z]{1,5}$/.test(cleaned)) {
    return cleaned.toUpperCase();
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Helper to fetch a single Alpha Vantage endpoint with timeout and transient retry logic.
 */
const fetchWithRetry = async (funcName, symbol, retries = 2, delayMs = 500) => {
  const apiKey = env.alphaVantageApiKey;
  if (!apiKey) {
    throw new AppError("ALPHA_VANTAGE_API_KEY is not configured.", 500);
  }

  const url = `https://www.alphavantage.co/query?function=${funcName}&symbol=${symbol}&apikey=${apiKey}`;
  const censoredUrl = `https://www.alphavantage.co/query?function=${funcName}&symbol=${symbol}&apikey=[REDACTED]`;

  let attempt = 0;
  while (attempt <= retries) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 5000); // 5s timeout

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(id);

      if (!response.ok) {
        // HTTP level error is transient if 5xx or connection issues
        if (response.status >= 500 && attempt < retries) {
          attempt++;
          await sleep(delayMs * Math.pow(2, attempt - 1));
          continue;
        }
        throw new AppError(`Upstream financial service returned HTTP ${response.status}.`, 502);
      }

      const data = await response.json();

      // Alpha Vantage returns HTTP 200 even for Errors and Rate limit messages
      if (data["Error Message"]) {
        throw new AppError(`Alpha Vantage error: ${data["Error Message"]}`, 400);
      }
      if (data["Information"]) {
        const info = data["Information"];
        // Rate limit warning is considered a transient retryable or permanent 429
        if (info.toLowerCase().includes("rate limit") || info.toLowerCase().includes("thank you")) {
          if (attempt < retries) {
            attempt++;
            await sleep(delayMs * Math.pow(2, attempt - 1));
            continue;
          }
          throw new AppError("Financial data provider rate limit exceeded. Please try again later.", 429);
        }
        throw new AppError(`Financial service information notice: ${info}`, 502);
      }
      if (data["Note"]) {
        const note = data["Note"];
        if (note.toLowerCase().includes("rate limit") || note.toLowerCase().includes("thank you")) {
          if (attempt < retries) {
            attempt++;
            await sleep(delayMs * Math.pow(2, attempt - 1));
            continue;
          }
          throw new AppError("Financial data provider rate limit exceeded. Please try again later.", 429);
        }
        throw new AppError(`Financial service note notice: ${note}`, 502);
      }

      return data;
    } catch (error) {
      clearTimeout(id);

      // Handle aborted/timeout requests
      const isTimeout = error.name === "AbortError" || error.name === "TimeoutError";
      if (isTimeout || error.status >= 500) {
        if (attempt < retries) {
          attempt++;
          await sleep(delayMs * Math.pow(2, attempt - 1));
          continue;
        }
        throw new AppError("Financial data request timed out.", 504);
      }

      // Redact apiKey from any leaked error message
      let msg = error.message ?? "Upstream request failed.";
      msg = msg.replaceAll(apiKey, "[REDACTED]");
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(`Financial API fetch failed: ${msg}`, 502);
    }
  }
};

/**
 * Retrieves and normalizes financial data for a ticker.
 */
export const getFinancialData = async (symbol, options = {}) => {
  if (typeof symbol !== "string" || !symbol.trim()) {
    throw new AppError("Ticker symbol is required.", 400);
  }

  const ticker = symbol.trim().toUpperCase();
  const ttl = options.ttl ?? DEFAULT_TTL_MS;

  // Cache lookup
  const cached = cache.get(ticker);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  // Fetch OVERVIEW, GLOBAL_QUOTE, INCOME_STATEMENT, BALANCE_SHEET in parallel
  const [overview, quote, income, balance] = await Promise.all([
    fetchWithRetry("OVERVIEW", ticker),
    fetchWithRetry("GLOBAL_QUOTE", ticker),
    fetchWithRetry("INCOME_STATEMENT", ticker),
    fetchWithRetry("BALANCE_SHEET", ticker)
  ]);

  // Reject obviously malformed responses
  if (!overview || typeof overview !== "object" || Object.keys(overview).length === 0) {
    throw new AppError("Provider returned an empty or malformed overview response.", 502);
  }

  // Extract core company attributes
  const name = overview.Name ?? null;
  const exchange = overview.Exchange ?? null;
  const currency = overview.Currency ?? null;

  // Extract quote info
  const quoteData = quote?.["Global Quote"] ?? {};
  const price = parseNumber(quoteData["05. price"]);
  const marketCap = parseNumber(overview.MarketCapitalization);

  // Extract income report
  const annualIncomeReports = income?.annualReports ?? [];
  const latestIncome = annualIncomeReports[0] ?? {};
  const fiscalDate = latestIncome.fiscalDateEnding ?? null;
  const revenue = parseNumber(latestIncome.totalRevenue);
  const netIncome = parseNumber(latestIncome.netIncome);
  const eps = parseNumber(overview.EPS); // EPS from OVERVIEW is most reliable

  // Extract balance sheet report
  const annualBalanceReports = balance?.annualReports ?? [];
  const latestBalance = annualBalanceReports[0] ?? {};
  const totalAssets = parseNumber(latestBalance.totalAssets);
  const totalLiabilities = parseNumber(latestBalance.totalLiabilities);
  const cashAndEquivalents = parseNumber(latestBalance.cashAndCashEquivalentsAtCarryingValue);

  const normalized = {
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
      source: "Alpha Vantage",
      retrievedAt: new Date().toISOString()
    }
  };

  // Cache payload
  cache.set(ticker, {
    data: normalized,
    expiresAt: Date.now() + ttl
  });

  return normalized;
};

// Expose clear cache helper for testing
export const clearFinancialCache = () => {
  cache.clear();
};
