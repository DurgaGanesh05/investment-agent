import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { generateJsonWithGemini } from "../services/geminiService.js";
import {
  buildAnalysisPrompt,
  buildRecommendationPrompt,
  buildResearchPrompt
} from "../prompts/researchPrompts.js";
import { AppError } from "../utils/appError.js";

const GraphState = Annotation.Root({
  company: Annotation(),
  overview: Annotation(),
  industry: Annotation(),
  strengths: Annotation(),
  risks: Annotation(),
  recommendation: Annotation(),
  confidence: Annotation(),
  reasoning: Annotation()
});

const normalizeStringArray = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
};

const normalizeConfidence = (value) => {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  if (Number.isNaN(parsed)) {
    return 0;
  }
  return Math.min(100, Math.max(0, parsed));
};

const researchNode = async (state) => {
  const result = await generateJsonWithGemini(
    buildResearchPrompt({ company: state.company })
  );

  return {
    overview: typeof result.overview === "string" ? result.overview.trim() : "",
    industry: typeof result.industry === "string" ? result.industry.trim() : "",
    strengths: normalizeStringArray(result.strengths),
    risks: normalizeStringArray(result.risks)
  };
};

const analysisNode = async (state) => {
  const result = await generateJsonWithGemini(
    buildAnalysisPrompt({
      company: state.company,
      overview: state.overview,
      industry: state.industry,
      strengths: state.strengths,
      risks: state.risks
    })
  );

  return {
    confidence: normalizeConfidence(result.confidence),
    reasoning: typeof result.reasoning === "string" ? result.reasoning.trim() : ""
  };
};

const recommendationNode = async (state) => {
  const result = await generateJsonWithGemini(
    buildRecommendationPrompt({
      company: state.company,
      overview: state.overview,
      industry: state.industry,
      strengths: state.strengths,
      risks: state.risks,
      confidence: state.confidence,
      reasoning: state.reasoning
    })
  );

  const recommendation = typeof result.recommendation === "string" ? result.recommendation.trim() : "Hold";
  const allowedRecommendation = ["Invest", "Hold", "Avoid"].includes(recommendation)
    ? recommendation
    : "Hold";

  return {
    company: typeof result.company === "string" && result.company.trim() ? result.company.trim() : state.company,
    overview: typeof result.overview === "string" && result.overview.trim() ? result.overview.trim() : state.overview,
    industry: typeof result.industry === "string" && result.industry.trim() ? result.industry.trim() : state.industry,
    strengths: normalizeStringArray(result.strengths).length > 0 ? normalizeStringArray(result.strengths) : state.strengths,
    risks: normalizeStringArray(result.risks).length > 0 ? normalizeStringArray(result.risks) : state.risks,
    recommendation: allowedRecommendation,
    confidence: normalizeConfidence(result.confidence ?? state.confidence),
    reasoning: typeof result.reasoning === "string" && result.reasoning.trim() ? result.reasoning.trim() : state.reasoning
  };
};

const workflow = new StateGraph(GraphState)
  .addNode("research_step", researchNode)
  .addNode("analysis_step", analysisNode)
  .addNode("recommendation_step", recommendationNode)
  .addEdge(START, "research_step")
  .addEdge("research_step", "analysis_step")
  .addEdge("analysis_step", "recommendation_step")
  .addEdge("recommendation_step", END)
  .compile();

export const runInvestmentResearchWorkflow = async ({ company }) => {
  if (typeof company !== "string" || !company.trim()) {
    throw new AppError("'company' is required and must be a non-empty string.", 400);
  }

  const initialState = {
    company: company.trim(),
    overview: "",
    industry: "",
    strengths: [],
    risks: [],
    recommendation: "Hold",
    confidence: 0,
    reasoning: ""
  };

  const result = await workflow.invoke(initialState);

  return {
    company: result.company,
    overview: result.overview,
    industry: result.industry,
    strengths: normalizeStringArray(result.strengths),
    risks: normalizeStringArray(result.risks),
    recommendation: result.recommendation,
    confidence: normalizeConfidence(result.confidence),
    reasoning: result.reasoning
  };
};
