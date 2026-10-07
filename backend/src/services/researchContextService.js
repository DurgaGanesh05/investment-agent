import { resolveCompanyToTicker, getFinancialData } from "./financialDataService.js";
import { calculateFinancialMetrics } from "./financialMetricsService.js";
import { tavilyResearchProvider } from "./providers/tavilyResearchProvider.js";

/**
 * Aggregates context required for investment research workflow.
 *
 * Financial data (FMP) is the primary verified financial source.
 * External research (Tavily) is an optional qualitative enrichment layer:
 * if Tavily fails for any reason, externalResearch is set to null
 * so the research workflow continues without exposing any failure.
 */
export const getResearchContext = async (company) => {
  const ticker = await resolveCompanyToTicker(company);

  const [financialDataResult, externalResearchResult] = await Promise.allSettled([
    getFinancialData(ticker),
    tavilyResearchProvider.searchCompanyResearch({ company, ticker })
  ]);

  if (financialDataResult.status === "rejected") {
    throw financialDataResult.reason;
  }

  const financialData = financialDataResult.value;
  const financialMetrics = calculateFinancialMetrics(financialData);

  const externalResearch =
    externalResearchResult.status === "fulfilled"
      ? externalResearchResult.value
      : null;

  const externalResearchNotice =
    externalResearchResult.status === "fulfilled"
      ? (externalResearchResult.value.metadata.partialFailure
          ? "Partial live external research coverage retrieved."
          : null)
      : "Live external research could not be retrieved for this request.";

  return {
    company,
    ticker,
    financialData,
    financialMetrics,
    externalResearch,
    externalResearchNotice
  };
};
