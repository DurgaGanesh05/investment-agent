import { z } from "zod";

const nonEmptyTrimmedString = z.string().trim().min(1);

export const ExternalResearchCompanySchema = z
  .object({
    name: nonEmptyTrimmedString,
    ticker: nonEmptyTrimmedString
  })
  .strict();

export const ExternalResearchResultItemSchema = z
  .object({
    title: nonEmptyTrimmedString,
    url: z.string().trim().url(),
    content: nonEmptyTrimmedString,
    relevanceScore: z.number().finite().min(0).max(1)
  })
  .strict();

export const ExternalResearchMetadataSchema = z
  .object({
    provider: nonEmptyTrimmedString,
    query: nonEmptyTrimmedString,
    retrievedAt: z.string().datetime(),
    responseTimeMs: z.number().finite().min(0),
    requestId: nonEmptyTrimmedString
  })
  .strict();

export const ExternalResearchSchema = z
  .object({
    company: ExternalResearchCompanySchema,
    results: z.array(ExternalResearchResultItemSchema).min(1),
    metadata: ExternalResearchMetadataSchema
  })
  .strict();

export const validateExternalResearch = (data) => {
  return ExternalResearchSchema.parse(data);
};
