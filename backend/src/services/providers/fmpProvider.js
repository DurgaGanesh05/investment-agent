import { env } from "../../config/env.js";
import { AppError } from "../../utils/appError.js";

/**
 * Provider contract:
 *   fetchRawFinancialData(ticker: string) => Promise<{ overview, quote, income, balance }>
 *
 * FMP responses are adapted to the raw field names currently consumed by the
 * financial data service. This preserves the service contract during migration.
 */
export const FINANCIAL_PROVIDER_SOURCE = "Financial Modeling Prep";

const BASE_URL = "https://financialmodelingprep.com/stable/";
const REQUEST_TIMEOUT_MS = 5000;
const MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 500;
const RATE_LIMIT_MESSAGE = "Financial data provider rate limit reached. Please try again later.";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const redactSecrets = (message, apiKey) => {
  if (typeof message !== "string") {
    return "Upstream request failed.";
  }

  let clean = message;
  if (apiKey) {
    clean = clean.replaceAll(apiKey, "[REDACTED]");
  }
  return clean.replace(/apikey=[^&\s]+/gi, "apikey=[REDACTED]");
};

const isTimeoutError = (error) =>
  error?.name === "AbortError" || error?.name === "TimeoutError";

const isRetryableNetworkError = (error) => {
  if (isTimeoutError(error)) {
    return true;
  }

  const code = error?.code ?? error?.cause?.code ?? "";
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ECONNREFUSED" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  );
};

const fetchFmpEndpoint = async (path, ticker) => {
  const apiKey = env.fmpApiKey;
  if (!apiKey) {
    throw new AppError("FMP_API_KEY is not configured.", 500);
  }

  const url = new URL(path, BASE_URL);
  url.searchParams.set("symbol", ticker);
  url.searchParams.set("apikey", apiKey);

  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    let timeoutId;
    try {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.status === 401 || response.status === 403) {
        throw new AppError("Financial data provider authentication failed.", 500, "AUTH_ERROR");
      }

      if (response.status === 429) {
        throw new AppError(RATE_LIMIT_MESSAGE, 429, "RATE_LIMIT_EXCEEDED");
      }

      if (response.status >= 400 && response.status < 500) {
        throw new AppError("Financial data provider rejected the request.", response.status);
      }

      if (!response.ok) {
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          attempt += 1;
          await sleep(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1));
          continue;
        }

        throw new AppError(
          `Financial data provider is temporarily unavailable (HTTP ${response.status}).`,
          502
        );
      }

      try {
        const data = await response.json();
        if (!Array.isArray(data)) {
          throw new AppError("Financial data provider returned a malformed response.", 502);
        }
        return data;
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError("Financial data provider returned a malformed response.", 502);
      }
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof AppError) {
        throw error;
      }

      if (isRetryableNetworkError(error) && attempt < MAX_RETRIES) {
        attempt += 1;
        await sleep(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1));
        continue;
      }

      if (isTimeoutError(error)) {
        throw new AppError("Financial data request timed out.", 504);
      }

      const message = redactSecrets(error.message ?? "Upstream request failed.", apiKey);
      throw new AppError(`Financial API fetch failed: ${message}`, 502);
    }
  }
};

const hasUsableText = (value) => typeof value === "string" && value.trim().length > 0;

const isUsableProfile = (profile) =>
  profile &&
  typeof profile === "object" &&
  !Array.isArray(profile) &&
  (hasUsableText(profile.symbol) || hasUsableText(profile.companyName));

const asString = (value) => (value === null || value === undefined ? value : String(value));

/**
 * Fetches FMP data sequentially and adapts it to the service's temporary raw shape.
 */
export const fetchRawFinancialData = async (ticker) => {
  const profiles = await fetchFmpEndpoint("profile", ticker);
  const profile = profiles[0];
  if (!isUsableProfile(profile)) {
    throw new AppError(`No financial data found for ticker "${ticker}".`, 404);
  }

  const quotes = await fetchFmpEndpoint("quote", ticker);
  const incomeStatements = await fetchFmpEndpoint("income-statement", ticker);
  const balanceSheets = await fetchFmpEndpoint("balance-sheet-statement", ticker);

  const quote = quotes[0] ?? {};
  const income = incomeStatements[0] ?? {};
  const balance = balanceSheets[0] ?? {};

  return {
    overview: {
      Name: profile.companyName,
      Symbol: profile.symbol,
      Exchange: profile.exchangeShortName ?? profile.exchange,
      Currency: profile.currency,
      MarketCapitalization: asString(profile.mktCap ?? quote.marketCap),
      EPS: asString(quote.eps)
    },
    quote: {
      "Global Quote": {
        "05. price": asString(quote.price)
      }
    },
    income: {
      annualReports: incomeStatements.map((statement) => ({
        fiscalDateEnding: statement.date,
        totalRevenue: asString(statement.revenue),
        netIncome: asString(statement.netIncome),
        eps: asString(statement.eps)
      }))
    },
    balance: {
      annualReports: balanceSheets.map((statement) => ({
        totalAssets: asString(statement.totalAssets),
        totalLiabilities: asString(statement.totalLiabilities),
        cashAndCashEquivalentsAtCarryingValue: asString(statement.cashAndCashEquivalents)
      }))
    }
  };
};
