import { runInvestmentResearchWorkflow } from "../langgraph/investmentResearchGraph.js";
import { resolveCompanyToTicker, getFinancialData } from "../services/financialDataService.js";
import { calculateFinancialMetrics } from "../services/financialMetricsService.js";

export const postResearch = async (req, res, next) => {
  try {
    const company = req.body.company;
    const ticker = resolveCompanyToTicker(company);
    const financialData = await getFinancialData(ticker);
    const financialMetrics = calculateFinancialMetrics(financialData);

    const result = await runInvestmentResearchWorkflow({
      company,
      ticker,
      financialData,
      financialMetrics
    });

    return res.status(200).json(result);
  } catch (error) {
    return next(error);
  }
};