import { AppError } from "../utils/appError.js";

const MAX_COMPANY_LENGTH = 100;

export const validateResearchRequest = (req, _res, next) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return next(new AppError("Request body must be a valid JSON object.", 400));
  }

  const { company } = req.body;

  if (typeof company !== "string") {
    return next(new AppError("Field 'company' is required and must be a string.", 400));
  }

  const trimmed = company.trim();

  if (!trimmed) {
    return next(new AppError("Field 'company' cannot be empty or whitespace.", 400));
  }

  if (trimmed.length > MAX_COMPANY_LENGTH) {
    return next(
      new AppError(
        `Field 'company' exceeds maximum length of ${MAX_COMPANY_LENGTH} characters.`,
        400
      )
    );
  }

  // Reject unprintable control characters
  if (/[\u0000-\u001F\u007F-\u009F]/.test(trimmed)) {
    return next(new AppError("Field 'company' contains invalid control characters.", 400));
  }

  req.body.company = trimmed;
  return next();
};
