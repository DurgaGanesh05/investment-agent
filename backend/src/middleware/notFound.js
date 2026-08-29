import { AppError } from "../utils/appError.js";

export const notFoundHandler = (req, _res, next) => {
  return next(new AppError(`Route ${req.originalUrl} not found`, 404));
};
