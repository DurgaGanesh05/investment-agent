import dotenv from "dotenv";

dotenv.config();

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

if (Number.isNaN(port) || port <= 0) {
  throw new Error("Invalid PORT environment variable. It must be a positive number.");
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port,
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  groqModel: process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
  alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY ?? ""
};