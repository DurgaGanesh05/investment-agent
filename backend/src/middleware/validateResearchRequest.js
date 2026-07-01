import { AppError } from "../utils/appError.js";

export const validateResearchRequest = (req, _res, next) => {
  const { company } = req.body ?? {};

  if (typeof company !== "string" || !company.trim()) {
    return next(new AppError("Request body must include a non-empty 'company' string.", 400));
  }

  req.body.company = company.trim();
  return next();
};
