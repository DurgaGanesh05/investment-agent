import { AppError } from "./appError.js";

export const safeJsonParse = (value, fallback = null) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export const extractFirstJsonObject = (text) => {
  if (typeof text !== "string" || !text.trim()) {
    throw new AppError("Gemini returned an empty response.", 502);
  }

  const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1] : text;

  const parsed = safeJsonParse(candidate);
  if (parsed && typeof parsed === "object") {
    return parsed;
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = text.slice(start, end + 1);
    const slicedParsed = safeJsonParse(sliced);
    if (slicedParsed && typeof slicedParsed === "object") {
      return slicedParsed;
    }
  }

  throw new AppError("Gemini response was not valid JSON.", 502);
};
