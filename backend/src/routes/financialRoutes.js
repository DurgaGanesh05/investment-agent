import { Router } from "express";
import { getFinancialData, resolveCompanyToTicker } from "../services/financialDataService.js";

const financialRouter = Router();

financialRouter.get("/financial-data/:ticker", async (req, res, next) => {
  try {
    const { ticker } = req.params;
    const resolvedTicker = resolveCompanyToTicker(ticker);
    const data = await getFinancialData(resolvedTicker);
    return res.status(200).json({
      status: "OK",
      data
    });
  } catch (error) {
    return next(error);
  }
});

export default financialRouter;
