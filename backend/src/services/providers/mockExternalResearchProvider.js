import { ExternalResearchSchema } from "../../schemas/externalResearchSchemas.js";
import { AppError } from "../../utils/appError.js";

/**
 * Deterministic Mock External Research Provider.
 *
 * Implements searchCompanyResearch({ company, ticker }) without network calls,
 * returning strict, normalized research data for deterministic testing.
 */
export class MockExternalResearchProvider {
  async searchCompanyResearch({ company, ticker } = {}) {
    if (typeof company !== "string" || !company.trim()) {
      throw new AppError("Company name must be a non-empty string.", 400, "INVALID_INPUT");
    }
    if (typeof ticker !== "string" || !ticker.trim()) {
      throw new AppError("Ticker symbol must be a non-empty string.", 400, "INVALID_INPUT");
    }

    const name = company.trim();
    const symbol = ticker.trim();

    const data = {
      company: {
        name,
        ticker: symbol
      },
      results: [
        {
          title: "Synthetic research result one",
          url: "https://example.com/research-one",
          domain: "example.com",
          content: "Synthetic external research context for deterministic testing.",
          relevanceScore: 0.92
        },
        {
          title: "Synthetic research result two",
          url: "https://example.com/research-two",
          domain: "example.com",
          content: "Another deterministic external research result.",
          relevanceScore: 0.81
        }
      ],
      metadata: {
        provider: "mock",
        query: `${name} ${symbol} latest company developments`,
        retrievedAt: "2026-01-01T00:00:00.000Z",
        responseTimeMs: 0,
        requestId: "mock-request-001"
      }
    };

    return ExternalResearchSchema.parse(data);
  }
}

export const mockExternalResearchProvider = new MockExternalResearchProvider();
