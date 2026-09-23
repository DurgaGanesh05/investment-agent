import { z } from "zod";
import { AppError } from "../utils/appError.js";
import { validateFinancialCandidates } from "../utils/researchIntegrity.js";

const nonEmptyString = z.string().trim().min(1);
const stringListSchema = z.array(nonEmptyString).min(1);

export const FundamentalAssessmentSchema = z
  .object({
    businessQuality: nonEmptyString,
    competitiveAdvantage: nonEmptyString,
    financialHealth: nonEmptyString
  })
  .strict();

export const ResearchNodeSchema = z
  .object({
    overview: nonEmptyString,
    industry: nonEmptyString,
    strengths: stringListSchema,
    risks: stringListSchema
  })
  .strict();

export const FundamentalNodeSchema = z
  .object({
    fundamentalAssessment: FundamentalAssessmentSchema,
    keyCatalysts: stringListSchema,
    keyConcerns: stringListSchema
  })
  .strict();

export const ThesisNodeSchema = z
  .object({
    investmentThesis: nonEmptyString,
    bullCase: nonEmptyString,
    bearCase: nonEmptyString
  })
  .strict();

export const RecommendationNodeSchema = z
  .object({
    recommendation: z.enum(["Invest", "Hold", "Avoid"]),
    confidence: z.number().int().min(0).max(100),
    reasoning: nonEmptyString
  })
  .strict();

export const FinalResearchOutputSchema = z.object({
  company: nonEmptyString,
  ticker: z.string().trim().nullable().optional(),
  financialData: z.unknown().optional(),
  financialMetrics: z.unknown().optional(),
  overview: nonEmptyString,
  industry: nonEmptyString,
  fundamentalAssessment: FundamentalAssessmentSchema,
  strengths: stringListSchema,
  risks: stringListSchema,
  keyCatalysts: stringListSchema,
  keyConcerns: stringListSchema,
  investmentThesis: nonEmptyString,
  bullCase: nonEmptyString,
  bearCase: nonEmptyString,
  recommendation: z.enum(["Invest", "Hold", "Avoid"]),
  confidence: z.number().int().min(0).max(100),
  reasoning: nonEmptyString
});

export const validateNodeOutput = (schema, data, nodeName, options = {}) => {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new AppError(
      `AI ${nodeName} failed output schema validation: ${details}`,
      502,
      "SCHEMA_VALIDATION_FAILED"
    );
  }

  const validatedData = result.data;

  if (options.verifiedFacts && Array.isArray(options.verifiedFacts)) {
    const serializedText = JSON.stringify(validatedData);
    const integrityResult = validateFinancialCandidates(serializedText, options.verifiedFacts);

    if (!integrityResult.valid) {
      throw new AppError(
        `AI ${nodeName} produced unsupported financial claims.`,
        502,
        "UNSUPPORTED_FINANCIAL_CLAIM"
      );
    }
  }

  return validatedData;
};
