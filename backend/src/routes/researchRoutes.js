import { Router } from "express";
import { postResearch } from "../controllers/researchController.js";
import { validateResearchRequest } from "../middleware/validateResearchRequest.js";

const researchRouter = Router();

researchRouter.post("/research", validateResearchRequest, postResearch);

export default researchRouter;
