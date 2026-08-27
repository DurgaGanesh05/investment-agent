import Groq from "groq-sdk";
import { env } from "../config/env.js";
import { AppError } from "../utils/appError.js";
import { extractFirstJsonObject } from "../utils/json.js";

const DEFAULT_TIMEOUT_MS = 25000;
const MAX_RETRIES = 2; // total attempts = 3
const INITIAL_RETRY_DELAY_MS = 500;

let groqClientInstance = null;

const getGroqClient = () => {
  if (!env.groqApiKey) {
    throw new AppError("GROQ_API_KEY is not configured.", 500);
  }

  if (!groqClientInstance) {
    groqClientInstance = new Groq({
      apiKey: env.groqApiKey,
      timeout: DEFAULT_TIMEOUT_MS
    });
  }

  return groqClientInstance;
};

const isRetryableError = (error) => {
  const status = error?.status ?? error?.statusCode;
  const name = error?.name ?? "";
  const code = error?.code ?? error?.cause?.code ?? "";

  // 429 Rate Limit, 500-599 Server Errors are retryable
  if (typeof status === "number") {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    // 400, 401, 403, 404, 422 are NOT retryable
    return false;
  }

  // Network and connection errors are retryable
  if (
    name === "APIConnectionError" ||
    name === "APIConnectionTimeoutError" ||
    name === "FetchError" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return true;
  }

  return false;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const executeWithRetry = async (fn, maxRetries = MAX_RETRIES, delayMs = INITIAL_RETRY_DELAY_MS) => {
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      return await fn();
    } catch (error) {
      attempt++;

      if (attempt > maxRetries || !isRetryableError(error)) {
        throw error;
      }

      // Exponential backoff with random jitter (±20%)
      const jitter = 0.8 + Math.random() * 0.4;
      const waitTime = Math.round(delayMs * Math.pow(2, attempt - 1) * jitter);
      await sleep(waitTime);
    }
  }
};

const formatGroqError = (error) => {
  const status = error?.status ?? error?.statusCode;
  const name = error?.name ?? "";

  if (name === "APIConnectionTimeoutError" || error?.code === "ETIMEDOUT") {
    return new AppError("AI research request timed out. Please try again.", 504);
  }

  if (status === 429) {
    return new AppError("AI service rate limit reached. Please try again shortly.", 503);
  }

  if (status === 401 || status === 403) {
    return new AppError("AI service authentication failed.", 500);
  }

  if (status === 404) {
    return new AppError("Configured AI model is currently unavailable.", 502);
  }

  let rawMessage = error?.message ?? "Upstream AI request failed.";
  if (env.groqApiKey && rawMessage.includes(env.groqApiKey)) {
    rawMessage = rawMessage.replaceAll(env.groqApiKey, "[REDACTED]");
  }

  return new AppError(`Groq API error: ${rawMessage}`, 502);
};

export const generateJsonWithGroq = async (prompt, options = {}) => {
  const client = getGroqClient();
  const model = options.model ?? env.groqModel;

  try {
    const response = await executeWithRetry(() =>
      client.chat.completions.create({
        model,
        temperature: 0.2,
        response_format: {
          type: "json_object"
        },
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      })
    );

    const text = response.choices?.[0]?.message?.content ?? "";
    return extractFirstJsonObject(text);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw formatGroqError(error);
  }
};
