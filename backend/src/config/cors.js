export const getCorsOptions = ({
  nodeEnv = process.env.NODE_ENV ?? "development",
  corsOrigin = process.env.CORS_ORIGIN
} = {}) => {
  const origins = typeof corsOrigin === "string"
    ? corsOrigin.split(",").map((origin) => origin.trim()).filter(Boolean)
    : null;

  if (nodeEnv === "production" && (!origins || origins.length === 0)) {
    throw new Error("CORS_ORIGIN must be configured in production.");
  }

  return {
    origin: origins ?? "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  };
};

export const corsOptions = getCorsOptions();
