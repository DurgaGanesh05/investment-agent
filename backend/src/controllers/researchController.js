import { runInvestmentResearchWorkflow } from "../langgraph/investmentResearchGraph.js";
import { getResearchContext } from "../services/researchContextService.js";

export const postResearch = async (req, res, next) => {
  try {
    const company = req.body.company;
    const context = await getResearchContext(company);

    const result = await runInvestmentResearchWorkflow({
      company: context.company,
      ticker: context.ticker,
      financialData: context.financialData,
      financialMetrics: context.financialMetrics,
      externalResearch: context.externalResearch
    });

    return res.status(200).json({
      ...result,
      notice: context.externalResearchNotice ?? null
    });
  } catch (error) {
    return next(error);
  }
};