import express from "express";
import cors from "cors";
import healthRouter from "./routes/healthRoutes.js";
import researchRouter from "./routes/researchRoutes.js";
import { corsOptions } from "./config/cors.js";
import { notFoundHandler } from "./middleware/notFound.js";
import { errorHandler } from "./middleware/errorHandler.js";

const app = express();

app.use(cors(corsOptions));
app.use(express.json());

app.use("/", healthRouter);
app.use("/", researchRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
