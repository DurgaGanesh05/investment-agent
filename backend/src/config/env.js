import dotenv from "dotenv";

dotenv.config();

const DEFAULT_FINANCIAL_CACHE_TTL_MS = 3600000;

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

if (Number.isNaN(port) || port <= 0) {
  throw new Error("Invalid PORT environment variable. It must be a positive number.");
}

const parsedFinancialCacheTtlMs = Number.parseInt(
  process.env.FINANCIAL_CACHE_TTL_MS ?? String(DEFAULT_FINANCIAL_CACHE_TTL_MS),
  10
);
const financialCacheTtlMs =
  Number.isFinite(parsedFinancialCacheTtlMs) && parsedFinancialCacheTtlMs > 0
    ? parsedFinancialCacheTtlMs
    : DEFAULT_FINANCIAL_CACHE_TTL_MS;

export const validateProductionConfiguration = (configuration) => {
  if (configuration?.nodeEnv !== "production") {
    return;
  }

  const missing = ["GROQ_API_KEY", "FMP_API_KEY"].filter(
    (key) => typeof configuration[key] !== "string" || !configuration[key].trim()
  );
  if (missing.length > 0) {
    throw new Error(`Missing required production configuration: ${missing.join(", ")}.`);
  }
};

const configuration = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port,
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  groqModel: process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
  fmpApiKey: process.env.FMP_API_KEY ?? "",
  tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
  financialCacheTtlMs
};

validateProductionConfiguration({
  ...configuration,
  GROQ_API_KEY: configuration.groqApiKey,
  FMP_API_KEY: configuration.fmpApiKey
});

export const env = configuration;
