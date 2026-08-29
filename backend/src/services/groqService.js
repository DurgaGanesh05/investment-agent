import { AsyncLocalStorage } from "node:async_hooks";
import Groq from "groq-sdk";
import { env } from "../config/env.js";
import { AppError } from "../utils/appError.js";
import { extractFirstJsonObject } from "../utils/json.js";

export const DEFAULT_TIMEOUT_MS = 12000;
export const MAX_RETRIES = 2; // total attempts = 3
export const INITIAL_RETRY_DELAY_MS = 500;

export const workflowStorage = new AsyncLocalStorage();

let groqClientInstance = null;

export const getGroqClient = () => {
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

export const isRetryableError = (error) => {
  if (!error) return false;

  const status = error.status ?? error.statusCode;
  const name = error.name ?? "";
  const code = error.code ?? error.cause?.code ?? "";

  // Explicit non-retryable HTTP client errors (400, 401, 403, 404, 422)
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) {
    return false;
  }

  // 429 Rate Limit and 5xx Server Errors are retryable
  if (typeof status === "number") {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    return false;
  }

  // Network, connection, and timeout errors are retryable
  if (
    name === "APIConnectionError" ||
    name === "APIConnectionTimeoutError" ||
    name === "FetchError" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ECONNREFUSED" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return true;
  }

  return false;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const executeWithRetry = async (
  fn,
  maxRetries = MAX_RETRIES,
  delayMs = INITIAL_RETRY_DELAY_MS,
  deadline = null
) => {
  let attempt = 0;

  while (attempt <= maxRetries) {
    if (deadline && Date.now() >= deadline) {
      throw new AppError("AI research request timed out. Please try again.", 504, "REQUEST_TIMEOUT");
    }

    try {
      return await fn();
    } catch (error) {
      attempt++;

      if (attempt > maxRetries || !isRetryableError(error)) {
        throw error;
      }

      const remainingMs = deadline ? deadline - Date.now() : Infinity;
      if (remainingMs <= 500) {
        throw new AppError("AI research request timed out. Please try again.", 504, "REQUEST_TIMEOUT");
      }

      // Exponential backoff with random jitter (±20%)
      const jitter = 0.8 + Math.random() * 0.4;
      const waitTime = Math.round(delayMs * Math.pow(2, attempt - 1) * jitter);

      if (waitTime >= remainingMs) {
        throw new AppError("AI research request timed out. Please try again.", 504, "REQUEST_TIMEOUT");
      }

      await sleep(waitTime);
    }
  }
};

export const formatGroqError = (error) => {
  if (error instanceof AppError) {
    return error;
  }

  const status = error?.status ?? error?.statusCode;
  const name = error?.name ?? "";
  const code = error?.code ?? "";

  if (
    name === "APIConnectionTimeoutError" ||
    name === "APIUserAbortError" ||
    name === "AbortError" ||
    code === "ETIMEDOUT"
  ) {
    return new AppError("AI research request timed out. Please try again.", 504, "REQUEST_TIMEOUT");
  }

  if (status === 429) {
    return new AppError("AI service rate limit reached. Please try again shortly.", 503, "RATE_LIMIT_EXCEEDED");
  }

  if (status === 401 || status === 403) {
    return new AppError("AI service authentication failed.", 500, "AUTH_ERROR");
  }

  if (status === 404) {
    return new AppError("Configured AI model is currently unavailable.", 502, "MODEL_UNAVAILABLE");
  }

  if (status === 400 || status === 422) {
    return new AppError("Upstream AI service rejected the request.", 502, "UPSTREAM_BAD_REQUEST");
  }

  if (name === "APIConnectionError" || code === "ENOTFOUND" || code === "ECONNRESET" || code === "ECONNREFUSED") {
    return new AppError("Unable to connect to AI service. Please try again.", 502, "CONNECTION_ERROR");
  }

  let rawMessage = error?.message ?? "Upstream AI request failed.";
  if (env.groqApiKey && rawMessage.includes(env.groqApiKey)) {
    rawMessage = rawMessage.replaceAll(env.groqApiKey, "[REDACTED]");
  }
  rawMessage = rawMessage.replace(/gsk_[A-Za-z0-9]+/g, "[REDACTED]");

  return new AppError(`AI research service error: ${rawMessage}`, 502, "UPSTREAM_ERROR");
};

export const generateJsonWithGroq = async (prompt, options = {}) => {
  const client = getGroqClient();
  const model = options.model ?? env.groqModel;

  const context = workflowStorage.getStore();
  const deadline = options.deadline ?? context?.deadline ?? null;

  if (deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 500) {
      throw new AppError("AI research request timed out. Please try again.", 504, "REQUEST_TIMEOUT");
    }
  }

  try {
    const response = await executeWithRetry(
      () => {
        const remainingForAttempt = deadline ? deadline - Date.now() : DEFAULT_TIMEOUT_MS;
        const attemptTimeout = Math.min(DEFAULT_TIMEOUT_MS, Math.max(500, remainingForAttempt));

        return client.chat.completions.create(
          {
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
          },
          {
            timeout: attemptTimeout
          }
        );
      },
      MAX_RETRIES,
      INITIAL_RETRY_DELAY_MS,
      deadline
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
