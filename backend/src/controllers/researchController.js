import { runInvestmentResearchWorkflow } from "../langgraph/investmentResearchGraph.js";

export const postResearch = async (req, res, next) => {
  try {
    const result = await runInvestmentResearchWorkflow({
      company: req.body.company
    });

    return res.status(200).json(result);
  } catch (error) {
    return next(error);
  }
};