import { env } from "../../config/env.js";
import { AppError } from "../../utils/appError.js";
import { ExternalResearchSchema } from "../../schemas/externalResearchSchemas.js";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const REQUEST_TIMEOUT_MS = 5000;
const MAX_RETRIES = 2; // 3 total attempts
const INITIAL_RETRY_DELAY_MS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const redactApiKey = (text, apiKey) => {
  if (typeof text !== "string") return "External research request failed.";
  let clean = text;
  if (apiKey) {
    clean = clean.replaceAll(apiKey, "[REDACTED]");
  }
  return clean;
};

export class TavilyResearchProvider {
  async _executeSingleSearch(apiKey, query) {
    const payload = {
      api_key: apiKey,
      query,
      search_depth: "basic",
      max_results: 4
    };

    const startTime = Date.now();
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      let response;
      let timeoutId;

      try {
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        response = await fetch(TAVILY_SEARCH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
      } catch (err) {
        if (err.name === "AbortError" || err.name === "TimeoutError") {
          lastError = new AppError("Tavily research request timed out.", 504, "TIMEOUT_ERROR");
        } else {
          const rawMsg = err.message || "Network error during external research query.";
          lastError = new AppError(redactApiKey(rawMsg, apiKey), 502, "NETWORK_ERROR");
        }

        if (attempt <= MAX_RETRIES) {
          const jitter = 0.8 + Math.random() * 0.4;
          const waitTime = Math.round(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1) * jitter);
          await sleep(waitTime);
          continue;
        } else {
          throw lastError;
        }
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      if (response.status === 401 || response.status === 403) {
        throw new AppError("Tavily API authentication failed.", 500, "AUTH_ERROR");
      }

      if (response.status === 429) {
        throw new AppError("Tavily rate limit exceeded.", 429, "RATE_LIMIT_EXCEEDED");
      }

      if (response.status >= 400 && response.status < 500) {
        throw new AppError(`Tavily search request rejected (HTTP ${response.status}).`, response.status, "PROVIDER_ERROR");
      }

      if (!response.ok) {
        lastError = new AppError(`Tavily search provider unavailable (HTTP ${response.status}).`, 502, "PROVIDER_ERROR");
        if (attempt <= MAX_RETRIES) {
          const jitter = 0.8 + Math.random() * 0.4;
          const waitTime = Math.round(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1) * jitter);
          await sleep(waitTime);
          continue;
        } else {
          throw lastError;
        }
      }

      let data;
      try {
        data = await response.json();
      } catch {
        throw new AppError("Tavily search provider returned unparseable JSON.", 502, "PROVIDER_ERROR");
      }

      if (!data || typeof data !== "object" || !Array.isArray(data.results)) {
        throw new AppError("Tavily search provider returned a malformed response structure.", 502, "PROVIDER_ERROR");
      }

      const durationMs = Date.now() - startTime;
      const responseTimeMs =
        typeof data.response_time === "number" && Number.isFinite(data.response_time) && data.response_time >= 0
          ? Math.round(data.response_time * 1000)
          : durationMs;

      const requestId =
        typeof data.request_id === "string" && data.request_id.trim()
          ? data.request_id.trim()
          : `tavily-${Date.now()}`;

      return {
        results: data.results,
        responseTimeMs,
        requestId,
        query
      };
    }
  }

  async searchCompanyResearch({ company, ticker } = {}) {
    if (typeof company !== "string" || !company.trim()) {
      throw new AppError("Company name must be a non-empty string.", 400, "INVALID_INPUT");
    }
    if (typeof ticker !== "string" || !ticker.trim()) {
      throw new AppError("Ticker symbol must be a non-empty string.", 400, "INVALID_INPUT");
    }

    const name = company.trim();
    const symbol = ticker.trim();

    const apiKey = env.tavilyApiKey;
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      throw new AppError("TAVILY_API_KEY is not configured.", 500, "CONFIG_ERROR");
    }

    const query1 = `${name} ${symbol} recent company announcements developments`;
    const query2 = `${name} ${symbol} industry trends developments`;

    const [res1, res2] = await Promise.allSettled([
      this._executeSingleSearch(apiKey, query1),
      this._executeSingleSearch(apiKey, query2)
    ]);

    if (res1.status === "rejected" && res2.status === "rejected") {
      throw res1.reason;
    }

    const successfulQueries = [];
    let combinedRawResults = [];
    let maxResponseTimeMs = 0;
    let fallbackRequestId = `tavily-${Date.now()}`;

    const processResult = (res) => {
      if (res.status === "fulfilled") {
        successfulQueries.push(res.value.query);
        combinedRawResults = combinedRawResults.concat(res.value.results);
        maxResponseTimeMs = Math.max(maxResponseTimeMs, res.value.responseTimeMs);
        fallbackRequestId = res.value.requestId;
      }
    };

    processResult(res1);
    processResult(res2);

    const normalizeUrl = (u) => {
      try {
        const parsed = new URL(u);
        let pathname = parsed.pathname;
        if (pathname.length > 1 && pathname.endsWith('/')) {
          pathname = pathname.slice(0, -1);
        }
        return parsed.origin + pathname + parsed.search;
      } catch {
        return u;
      }
    };

    const seenUrls = new Set();
    const deduplicatedResults = [];

    for (const item of combinedRawResults) {
      if (!item || !item.url) continue;
      const normalized = normalizeUrl(item.url);
      if (!seenUrls.has(normalized)) {
        seenUrls.add(normalized);
        deduplicatedResults.push({
          title: item?.title,
          url: item?.url,
          content: item?.content,
          relevanceScore: item?.score
        });
      }
    }

    const finalResults = deduplicatedResults.slice(0, 8);

    if (finalResults.length === 0) {
      throw new AppError("Tavily search provider returned a malformed response structure.", 502, "PROVIDER_ERROR");
    }

    const normalizedData = {
      company: {
        name,
        ticker: symbol
      },
      results: finalResults,
      metadata: {
        provider: "tavily",
        query: successfulQueries.length === 1 ? successfulQueries[0] : successfulQueries,
        retrievedAt: new Date().toISOString(),
        responseTimeMs: maxResponseTimeMs,
        requestId: fallbackRequestId,
        ...(successfulQueries.length < 2 && { partialFailure: true })
      }
    };

    try {
      return ExternalResearchSchema.parse(normalizedData);
    } catch {
      throw new AppError("Normalized Tavily research output failed schema validation.", 502, "SCHEMA_VALIDATION_FAILED");
    }
  }
}

export const tavilyResearchProvider = new TavilyResearchProvider();
