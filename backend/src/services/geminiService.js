import Groq from "groq-sdk";
import { env } from "../config/env.js";
import { AppError } from "../utils/appError.js";
import { extractFirstJsonObject } from "../utils/json.js";

const DEFAULT_MODEL = "llama-3.3-70b-versatile";

const getGroqClient = () => {
  if (!env.groqApiKey) {
    throw new AppError("GROQ_API_KEY is not configured.", 500);
  }

  return new Groq({
    apiKey: env.groqApiKey,
  });
};

export const generateJsonWithGemini = async (prompt, options = {}) => {
  const client = getGroqClient();
  const model = options.model ?? DEFAULT_MODEL;

  try {
    const response = await client.chat.completions.create({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const text = response.choices?.[0]?.message?.content ?? "";

    return extractFirstJsonObject(text);
  } catch (error) {
    const message = error?.message ?? "Groq API request failed.";

    throw new AppError(`Groq API error: ${message}`, 502);
  }
};