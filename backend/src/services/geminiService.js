import { GoogleGenAI } from "@google/genai";
import { env } from "../config/env.js";
import { AppError } from "../utils/appError.js";
import { extractFirstJsonObject } from "../utils/json.js";

const DEFAULT_MODEL = "gemini-2.5-flash";

const getResponseText = (response) => {
  if (!response) {
    return "";
  }

  if (typeof response.text === "string") {
    return response.text;
  }

  if (typeof response.text === "function") {
    return response.text();
  }

  if (Array.isArray(response.candidates) && response.candidates.length > 0) {
    const firstCandidate = response.candidates[0];
    const parts = firstCandidate?.content?.parts ?? [];
    return parts
      .map((part) => part.text)
      .filter((value) => typeof value === "string")
      .join("\n");
  }

  return "";
};

const getGeminiClient = () => {
  if (!env.geminiApiKey) {
    throw new AppError("GEMINI_API_KEY is not configured.", 500);
  }

  return new GoogleGenAI({ apiKey: env.geminiApiKey });
};

export const generateJsonWithGemini = async (prompt, options = {}) => {
  const client = getGeminiClient();
  const model = options.model ?? DEFAULT_MODEL;

  try {
    const response = await client.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        temperature: 0.2
      }
    });

    const text = getResponseText(response);
    return extractFirstJsonObject(text);
  } catch (error) {
  const message = error?.message ?? "Gemini API request failed.";
  throw new AppError(`Gemini API error: ${message}`, 502);
}
};