import { env } from "../../config/env.js";
import { AppError } from "../../utils/appError.js";

/**
 * Provider contract:
 *   fetchRawFinancialData(ticker: string) => Promise<{ overview, quote, income, balance }>
 *
 * This module owns Alpha Vantage URLs, query function names, vendor error envelopes,
 * and raw payload retrieval. The financial data service owns cache, ticker resolution,
 * and the stable internal schema.
 */
export const FINANCIAL_PROVIDER_SOURCE = "Alpha Vantage";

const REQUEST_TIMEOUT_MS = 5000;
const MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 500;
const MIN_REQUEST_START_INTERVAL_MS = 1500;
const RATE_LIMIT_MESSAGE = "Financial data provider rate limit reached. Please try again later.";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const createAlphaVantageRequestScheduler = ({
  now = () => Date.now(),
  sleepFn = sleep,
  minIntervalMs = MIN_REQUEST_START_INTERVAL_MS
} = {}) => {
  let lastRequestStartedAt = null;
  let requestStartQueue = Promise.resolve();

  return async (requestFactory) => {
    let releaseQueue;
    const previousRequest = requestStartQueue;
    requestStartQueue = new Promise((resolve) => {
      releaseQueue = resolve;
    });

    await previousRequest;

    const waitMs =
      lastRequestStartedAt === null
        ? 0
        : Math.max(0, lastRequestStartedAt + minIntervalMs - now());
    if (waitMs > 0) {
      await sleepFn(waitMs);
    }

    lastRequestStartedAt = now();

    try {
      return requestFactory();
    } finally {
      releaseQueue();
    }
  };
};

let startRateLimitedRequest = createAlphaVantageRequestScheduler();

export const configureAlphaVantageRequestSchedulerForTesting = (options) => {
  startRateLimitedRequest = createAlphaVantageRequestScheduler(options);
};

export const resetAlphaVantageRequestSchedulerForTesting = () => {
  startRateLimitedRequest = createAlphaVantageRequestScheduler();
};

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

const throwForAlphaVantageBody = (data) => {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new AppError("Financial data provider returned a malformed response.", 502);
  }

  if (data["Error Message"]) {
    const message = String(data["Error Message"]);
    const lower = message.toLowerCase();

    if (lower.includes("apikey") || lower.includes("api key")) {
      throw new AppError("Financial data provider authentication failed.", 500, "AUTH_ERROR");
    }

    if (lower.includes("symbol") || lower.includes("invalid")) {
      throw new AppError(
        "Ticker was not found or is not available from the financial data provider.",
        404
      );
    }

    throw new AppError("Financial data provider rejected the request.", 400);
  }

  if (data.Note || data.Information) {
    throw new AppError(RATE_LIMIT_MESSAGE, 429, "RATE_LIMIT_EXCEEDED");
  }
};

const isUnusableOverview = (overview) => {
  if (!overview || typeof overview !== "object" || Array.isArray(overview)) {
    return true;
  }

  if (Object.keys(overview).length === 0) {
    return true;
  }

  const symbol = typeof overview.Symbol === "string" ? overview.Symbol.trim() : "";
  const name = typeof overview.Name === "string" ? overview.Name.trim() : "";
  const usableSymbol = symbol && symbol !== "None" && symbol !== "null";
  const usableName = name && name !== "None" && name !== "null";

  return !usableSymbol && !usableName;
};

const fetchAlphaVantageFunction = async (funcName, symbol) => {
  const apiKey = env.alphaVantageApiKey;
  if (!apiKey) {
    throw new AppError("ALPHA_VANTAGE_API_KEY is not configured.", 500);
  }

  const url = `https://www.alphavantage.co/query?function=${encodeURIComponent(funcName)}&symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    let timeoutId;

    try {
      const request = await startRateLimitedRequest(() => {
        const controller = new AbortController();
        const requestTimeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        return {
          response: fetch(url, { signal: controller.signal }),
          timeoutId: requestTimeoutId
        };
      });

      timeoutId = request.timeoutId;
      const response = await request.response;
      clearTimeout(timeoutId);

      if (response.status === 429) {
        throw new AppError(RATE_LIMIT_MESSAGE, 429, "RATE_LIMIT_EXCEEDED");
      }

      if (response.status === 401 || response.status === 403) {
        throw new AppError("Financial data provider authentication failed.", 500, "AUTH_ERROR");
      }

      if (response.status === 404) {
        throw new AppError(
          "Ticker was not found or is not available from the financial data provider.",
          404
        );
      }

      if (response.status === 400 || response.status === 422) {
        throw new AppError("Financial data provider rejected the request.", 400);
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

      let data;
      try {
        data = await response.json();
      } catch {
        throw new AppError("Financial data provider returned a malformed response.", 502);
      }

      throwForAlphaVantageBody(data);
      return data;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof AppError) {
        throw error;
      }

      const retryable = isRetryableNetworkError(error);
      if (retryable && attempt < MAX_RETRIES) {
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

export const fetchRawFinancialData = async (ticker) => {
  const overview = await fetchAlphaVantageFunction("OVERVIEW", ticker);

  if (isUnusableOverview(overview)) {
    throw new AppError(`No financial data found for ticker "${ticker}".`, 404);
  }

  const quote = await fetchAlphaVantageFunction("GLOBAL_QUOTE", ticker);
  const income = await fetchAlphaVantageFunction("INCOME_STATEMENT", ticker);
  const balance = await fetchAlphaVantageFunction("BALANCE_SHEET", ticker);

  return { overview, quote, income, balance };
};
