import { AppError } from "./appError.js";

export const safeJsonParse = (value, fallback = null) => {
  if (typeof value !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export const extractFirstJsonObject = (text) => {
  if (typeof text !== "string" || !text.trim()) {
    throw new AppError("AI service returned an empty response.", 502);
  }

  // 1. Try markdown code fences first
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    const parsed = safeJsonParse(fencedMatch[1].trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  }

  // 2. Try direct JSON parse of trimmed string
  const directParsed = safeJsonParse(text.trim());
  if (directParsed && typeof directParsed === "object" && !Array.isArray(directParsed)) {
    return directParsed;
  }

  // 3. Fallback: extract substring between first '{' and last '}'
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = text.slice(start, end + 1);
    const slicedParsed = safeJsonParse(sliced);
    if (slicedParsed && typeof slicedParsed === "object" && !Array.isArray(slicedParsed)) {
      return slicedParsed;
    }
  }

  throw new AppError("AI service response was not valid JSON.", 502);
};
