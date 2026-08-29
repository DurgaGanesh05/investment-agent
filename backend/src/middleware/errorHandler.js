import { env } from "../config/env.js";

const sanitizeMessage = (message) => {
  if (typeof message !== "string") {
    return "An unexpected error occurred.";
  }

  let clean = message;

  if (env.groqApiKey) {
    clean = clean.replaceAll(env.groqApiKey, "[REDACTED]");
  }

  if (env.alphaVantageApiKey) {
    clean = clean.replaceAll(env.alphaVantageApiKey, "[REDACTED]");
  }

  // Redact any Groq-style API keys pattern
  clean = clean.replace(/gsk_[A-Za-z0-9]+/g, "[REDACTED]");

  return clean;
};

export const errorHandler = (err, _req, res, _next) => {
  // Handle request body size limit exceeded
  if (err.type === "entity.too.large" || err.status === 413) {
    return res.status(413).json({
      status: "ERROR",
      message: "Request body exceeds allowed size limit."
    });
  }

  // Handle malformed JSON in request body
  if (err.type === "entity.parse.failed" || (err instanceof SyntaxError && ("body" in err || err.status === 400))) {
    return res.status(400).json({
      status: "ERROR",
      message: "Invalid JSON format in request body."
    });
  }

  const rawStatusCode = Number(err.statusCode ?? err.status);
  const statusCode = Number.isInteger(rawStatusCode) && rawStatusCode >= 400 && rawStatusCode <= 599
    ? rawStatusCode
    : 500;

  let message = err.message ?? "Internal Server Error";

  // In production, mask unexpected non-operational 500 internal errors
  if (statusCode === 500 && (!err.isOperational || env.nodeEnv === "production")) {
    if (!err.isOperational) {
      message = "An unexpected internal server error occurred.";
    }
  }

  message = sanitizeMessage(message);

  return res.status(statusCode).json({
    status: "ERROR",
    message
  });
};
