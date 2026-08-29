import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { generateJsonWithGroq, workflowStorage } from "../services/groqService.js";
import {
  buildFundamentalPrompt,
  buildRecommendationPrompt,
  buildResearchPrompt,
  buildThesisPrompt
} from "../prompts/researchPrompts.js";
import { AppError } from "../utils/appError.js";

export const WORKFLOW_TIMEOUT_MS = 45000;

const GraphState = Annotation.Root({
  company: Annotation(),
  overview: Annotation(),
  industry: Annotation(),
  strengths: Annotation(),
  risks: Annotation(),
  fundamentalAssessment: Annotation(),
  keyCatalysts: Annotation(),
  keyConcerns: Annotation(),
  investmentThesis: Annotation(),
  bullCase: Annotation(),
  bearCase: Annotation(),
  recommendation: Annotation(),
  confidence: Annotation(),
  reasoning: Annotation()
});

export const parseStringArray = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
};

export const parseConfidence = (value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    return null;
  }
  if (num < 0 || num > 100) {
    return null;
  }
  return num;
};

export const parseFundamentalAssessment = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const businessQuality = typeof value.businessQuality === "string" ? value.businessQuality.trim() : "";
  const competitiveAdvantage =
    typeof value.competitiveAdvantage === "string" ? value.competitiveAdvantage.trim() : "";
  const financialHealth = typeof value.financialHealth === "string" ? value.financialHealth.trim() : "";

  if (!businessQuality || !competitiveAdvantage || !financialHealth) {
    return null;
  }

  return {
    businessQuality,
    competitiveAdvantage,
    financialHealth
  };
};

const assertWithinDeadline = () => {
  const context = workflowStorage.getStore();
  if (context?.deadline && Date.now() >= context.deadline) {
    throw new AppError("AI research request timed out. Please try again.", 504, "REQUEST_TIMEOUT");
  }
};

const researchNode = async (state) => {
  assertWithinDeadline();

  const result = await generateJsonWithGroq(
    buildResearchPrompt({ company: state.company })
  );

  const overview = typeof result?.overview === "string" ? result.overview.trim() : "";
  const industry = typeof result?.industry === "string" ? result.industry.trim() : "";
  const strengths = parseStringArray(result?.strengths);
  const risks = parseStringArray(result?.risks);

  if (!overview || !industry) {
    throw new AppError("AI research node failed to produce required company overview or industry.", 502);
  }

  if (strengths.length === 0 || risks.length === 0) {
    throw new AppError("AI research node failed to produce required company strengths or risks.", 502);
  }

  return {
    overview,
    industry,
    strengths,
    risks
  };
};

const fundamentalNode = async (state) => {
  assertWithinDeadline();

  const result = await generateJsonWithGroq(
    buildFundamentalPrompt({
      company: state.company,
      overview: state.overview,
      industry: state.industry,
      strengths: state.strengths,
      risks: state.risks
    })
  );

  const fundamentalAssessment = parseFundamentalAssessment(result?.fundamentalAssessment);
  const keyCatalysts = parseStringArray(result?.keyCatalysts);
  const keyConcerns = parseStringArray(result?.keyConcerns);

  if (!fundamentalAssessment) {
    throw new AppError("AI fundamental analysis node failed to produce valid fundamental assessment.", 502);
  }

  if (keyCatalysts.length === 0 || keyConcerns.length === 0) {
    throw new AppError("AI fundamental analysis node failed to produce key catalysts or key concerns.", 502);
  }

  return {
    fundamentalAssessment,
    keyCatalysts,
    keyConcerns
  };
};

const thesisNode = async (state) => {
  assertWithinDeadline();

  const result = await generateJsonWithGroq(
    buildThesisPrompt({
      company: state.company,
      overview: state.overview,
      industry: state.industry,
      strengths: state.strengths,
      risks: state.risks,
      fundamentalAssessment: state.fundamentalAssessment,
      keyCatalysts: state.keyCatalysts,
      keyConcerns: state.keyConcerns
    })
  );

  const investmentThesis = typeof result?.investmentThesis === "string" ? result.investmentThesis.trim() : "";
  const bullCase = typeof result?.bullCase === "string" ? result.bullCase.trim() : "";
  const bearCase = typeof result?.bearCase === "string" ? result.bearCase.trim() : "";

  if (!investmentThesis || !bullCase || !bearCase) {
    throw new AppError("AI investment thesis node failed to produce thesis, bull case, or bear case.", 502);
  }

  return {
    investmentThesis,
    bullCase,
    bearCase
  };
};

const recommendationNode = async (state) => {
  assertWithinDeadline();

  const result = await generateJsonWithGroq(
    buildRecommendationPrompt({
      company: state.company,
      overview: state.overview,
      industry: state.industry,
      strengths: state.strengths,
      risks: state.risks,
      fundamentalAssessment: state.fundamentalAssessment,
      keyCatalysts: state.keyCatalysts,
      keyConcerns: state.keyConcerns,
      investmentThesis: state.investmentThesis,
      bullCase: state.bullCase,
      bearCase: state.bearCase
    })
  );

  const rawRecommendation = typeof result?.recommendation === "string" ? result.recommendation.trim() : "";
  if (!["Invest", "Hold", "Avoid"].includes(rawRecommendation)) {
    throw new AppError(
      `AI recommendation node produced an invalid recommendation: "${rawRecommendation}". Must be Invest, Hold, or Avoid.`,
      502
    );
  }

  const confidence = parseConfidence(result?.confidence);
  if (confidence === null) {
    throw new AppError("AI recommendation node failed to produce a valid confidence score (0-100).", 502);
  }

  const reasoning = typeof result?.reasoning === "string" ? result.reasoning.trim() : "";
  if (!reasoning) {
    throw new AppError("AI recommendation node failed to produce recommendation reasoning.", 502);
  }

  return {
    recommendation: rawRecommendation,
    confidence,
    reasoning
  };
};

const workflow = new StateGraph(GraphState)
  .addNode("research_step", researchNode)
  .addNode("fundamental_step", fundamentalNode)
  .addNode("thesis_step", thesisNode)
  .addNode("recommendation_step", recommendationNode)
  .addEdge(START, "research_step")
  .addEdge("research_step", "fundamental_step")
  .addEdge("fundamental_step", "thesis_step")
  .addEdge("thesis_step", "recommendation_step")
  .addEdge("recommendation_step", END)
  .compile();

export const runInvestmentResearchWorkflow = async ({ company }) => {
  if (typeof company !== "string" || !company.trim()) {
    throw new AppError("'company' is required and must be a non-empty string.", 400);
  }

  const trimmedCompany = company.trim();
  const deadline = Date.now() + WORKFLOW_TIMEOUT_MS;

  return workflowStorage.run({ deadline }, async () => {
    const initialState = {
      company: trimmedCompany,
      overview: "",
      industry: "",
      strengths: [],
      risks: [],
      fundamentalAssessment: null,
      keyCatalysts: [],
      keyConcerns: [],
      investmentThesis: "",
      bullCase: "",
      bearCase: "",
      recommendation: "Hold",
      confidence: 0,
      reasoning: ""
    };

    const result = await workflow.invoke(initialState);

    const finalCompany = typeof result?.company === "string" ? result.company.trim() : "";
    const finalOverview = typeof result?.overview === "string" ? result.overview.trim() : "";
    const finalIndustry = typeof result?.industry === "string" ? result.industry.trim() : "";
    const finalStrengths = parseStringArray(result?.strengths);
    const finalRisks = parseStringArray(result?.risks);
    const finalFundamentalAssessment = parseFundamentalAssessment(result?.fundamentalAssessment);
    const finalKeyCatalysts = parseStringArray(result?.keyCatalysts);
    const finalKeyConcerns = parseStringArray(result?.keyConcerns);
    const finalInvestmentThesis =
      typeof result?.investmentThesis === "string" ? result.investmentThesis.trim() : "";
    const finalBullCase = typeof result?.bullCase === "string" ? result.bullCase.trim() : "";
    const finalBearCase = typeof result?.bearCase === "string" ? result.bearCase.trim() : "";
    const finalRecommendation =
      typeof result?.recommendation === "string" ? result.recommendation.trim() : "";
    const finalConfidence = parseConfidence(result?.confidence);
    const finalReasoning = typeof result?.reasoning === "string" ? result.reasoning.trim() : "";

    if (
      !finalCompany ||
      !finalOverview ||
      !finalIndustry ||
      finalStrengths.length === 0 ||
      finalRisks.length === 0 ||
      !finalFundamentalAssessment ||
      finalKeyCatalysts.length === 0 ||
      finalKeyConcerns.length === 0 ||
      !finalInvestmentThesis ||
      !finalBullCase ||
      !finalBearCase ||
      !["Invest", "Hold", "Avoid"].includes(finalRecommendation) ||
      finalConfidence === null ||
      !finalReasoning
    ) {
      throw new AppError("Investment research pipeline produced an incomplete or invalid response.", 502);
    }

    return {
      company: finalCompany,
      overview: finalOverview,
      industry: finalIndustry,
      investmentThesis: finalInvestmentThesis,
      fundamentalAssessment: finalFundamentalAssessment,
      strengths: finalStrengths,
      risks: finalRisks,
      keyCatalysts: finalKeyCatalysts,
      keyConcerns: finalKeyConcerns,
      bullCase: finalBullCase,
      bearCase: finalBearCase,
      recommendation: finalRecommendation,
      confidence: finalConfidence,
      reasoning: finalReasoning
    };
  });
};
