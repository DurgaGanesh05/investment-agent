import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { generateJsonWithGroq } from "../services/groqService.js";
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
  const result = await generateJsonWithGroq(
    buildResearchPrompt({ company: state.company })
  );

  const overview = typeof result?.overview === "string" ? result.overview.trim() : "";
  const industry = typeof result?.industry === "string" ? result.industry.trim() : "";
  const strengths = normalizeStringArray(result?.strengths);
  const risks = normalizeStringArray(result?.risks);

  if (!overview || !industry) {
    throw new AppError("AI research node failed to produce required company overview or industry.", 502);
  }

  return {
    overview,
    industry,
    strengths,
    risks
  };
};

const analysisNode = async (state) => {
  const result = await generateJsonWithGroq(
    buildAnalysisPrompt({
      company: state.company,
      overview: state.overview,
      industry: state.industry,
      strengths: state.strengths,
      risks: state.risks
    })
  );

  const reasoning = typeof result?.reasoning === "string" ? result.reasoning.trim() : "";
  const confidence = normalizeConfidence(result?.confidence);

  if (!reasoning) {
    throw new AppError("AI analysis node failed to produce analytical reasoning.", 502);
  }

  return {
    confidence,
    reasoning
  };
};

const recommendationNode = async (state) => {
  const result = await generateJsonWithGroq(
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

  const rawRecommendation = typeof result?.recommendation === "string" ? result.recommendation.trim() : "Hold";
  const recommendation = ["Invest", "Hold", "Avoid"].includes(rawRecommendation)
    ? rawRecommendation
    : "Hold";

  return {
    company: typeof result?.company === "string" && result.company.trim() ? result.company.trim() : state.company,
    overview: typeof result?.overview === "string" && result.overview.trim() ? result.overview.trim() : state.overview,
    industry: typeof result?.industry === "string" && result.industry.trim() ? result.industry.trim() : state.industry,
    strengths: normalizeStringArray(result?.strengths).length > 0 ? normalizeStringArray(result.strengths) : state.strengths,
    risks: normalizeStringArray(result?.risks).length > 0 ? normalizeStringArray(result.risks) : state.risks,
    recommendation,
    confidence: normalizeConfidence(result?.confidence ?? state.confidence),
    reasoning: typeof result?.reasoning === "string" && result.reasoning.trim() ? result.reasoning.trim() : state.reasoning
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

  const finalCompany = typeof result.company === "string" ? result.company.trim() : "";
  const finalOverview = typeof result.overview === "string" ? result.overview.trim() : "";
  const finalIndustry = typeof result.industry === "string" ? result.industry.trim() : "";
  const finalStrengths = normalizeStringArray(result.strengths);
  const finalRisks = normalizeStringArray(result.risks);
  const finalRecommendation = ["Invest", "Hold", "Avoid"].includes(result.recommendation)
    ? result.recommendation
    : "Hold";
  const finalConfidence = normalizeConfidence(result.confidence);
  const finalReasoning = typeof result.reasoning === "string" ? result.reasoning.trim() : "";

  if (!finalCompany || !finalOverview || !finalIndustry || !finalReasoning) {
    throw new AppError("Investment research pipeline produced an incomplete response.", 502);
  }

  return {
    company: finalCompany,
    overview: finalOverview,
    industry: finalIndustry,
    strengths: finalStrengths,
    risks: finalRisks,
    recommendation: finalRecommendation,
    confidence: finalConfidence,
    reasoning: finalReasoning
  };
};
