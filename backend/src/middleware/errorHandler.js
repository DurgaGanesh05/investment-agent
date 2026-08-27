import { env } from "../config/env.js";

export const errorHandler = (err, _req, res, _next) => {
  const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;

  // Handle malformed JSON in request body
  if (err.type === "entity.parse.failed" || (err instanceof SyntaxError && err.status === 400)) {
    return res.status(400).json({
      status: "ERROR",
      message: "Invalid JSON format in request body."
    });
  }

  let message = err.message ?? "Internal Server Error";

  // In production, mask unexpected 500 internal errors
  if (statusCode === 500 && env.nodeEnv === "production" && !err.isOperational) {
    message = "An unexpected internal server error occurred.";
  }

  // Ensure API key is never exposed in error messages
  if (typeof message === "string" && env.groqApiKey && message.includes(env.groqApiKey)) {
    message = message.replaceAll(env.groqApiKey, "[REDACTED]");
  }

  return res.status(statusCode).json({
    status: "ERROR",
    message
  });
};
