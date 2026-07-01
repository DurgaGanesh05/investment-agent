export const notFoundHandler = (req, res) => {
  return res.status(404).json({
    status: "NOT_FOUND",
    message: `Route ${req.originalUrl} not found`
  });
};
