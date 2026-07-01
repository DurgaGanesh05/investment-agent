export const getHealth = (_req, res) => {
  return res.status(200).json({
    status: "OK",
    message: "Investment Research Agent API is running"
  });
};
