import dotenv from "dotenv";

dotenv.config();

const port = Number.parseInt(process.env.PORT ?? "4000", 10);

if (Number.isNaN(port) || port <= 0) {
  throw new Error("Invalid PORT environment variable. It must be a positive number.");
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port,
  geminiApiKey: process.env.GEMINI_API_KEY ?? ""
};
