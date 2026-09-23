import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { generateJsonWithGroq, workflowStorage } from "../services/groqService.js";
import {
  buildFundamentalPrompt,
  buildRecommendationPrompt,
  buildResearchPrompt,
  buildThesisPrompt
} from "../prompts/researchPrompts.js";
import { AppError } from "../utils/appError.js";
import {
  ResearchNodeSchema,
  FundamentalNodeSchema,
  ThesisNodeSchema,
  RecommendationNodeSchema,
  FinalResearchOutputSchema,
  validateNodeOutput
} from "../schemas/researchSchemas.js";
import { buildVerifiedFacts } from "../utils/researchIntegrity.js";

export const WORKFLOW_TIMEOUT_MS = 45000;

const GraphState = Annotation.Root({
  company: Annotation(),
  ticker: Annotation(),
  financialData: Annotation(),
  financialMetrics: Annotation(),
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

const SCHEMA_CORRECTION_PROMPT = `
CORRECTION REQUIRED:
Your previous response failed output validation.
Return ONLY valid JSON matching the required schema.
Do not include markdown or extra text.
`.trim();

const INTEGRITY_CORRECTION_PROMPT = `
CORRECTION REQUIRED:
Your previous response contained financial numbers not present in the
VERIFIED FINANCIAL CONTEXT.
Use ONLY numbers explicitly provided in VERIFIED FINANCIAL CONTEXT or
VERIFIED DERIVED FINANCIAL METRICS.
Do not invent, estimate, forecast, or introduce unsupported numbers.
`.trim();

const isValidationError = (error) => {
  if (!(error instanceof AppError) || error.statusCode !== 502) {
    return false;
  }
  return (
    error.code === "JSON_EXTRACTION_FAILED" ||
    error.code === "SCHEMA_VALIDATION_FAILED" ||
    error.code === "UNSUPPORTED_FINANCIAL_CLAIM"
  );
};

const assertWithinDeadline = () => {
  const context = workflowStorage.getStore();
  if (context?.deadline && Date.now() >= context.deadline) {
    throw new AppError("AI research request timed out. Please try again.", 504, "REQUEST_TIMEOUT");
  }
};

export const executeNodeWithValidationRetry = async ({
  promptBuilder,
  schema,
  nodeName,
  state
}) => {
  assertWithinDeadline();

  const verifiedFacts = buildVerifiedFacts(state.financialData, state.financialMetrics);
  const initialPrompt = promptBuilder(state);

  try {
    const result = await generateJsonWithGroq(initialPrompt);
    return validateNodeOutput(schema, result, nodeName, { verifiedFacts });
  } catch (error) {
    if (!isValidationError(error)) {
      throw error;
    }

    const correctionInstruction =
      error.code === "UNSUPPORTED_FINANCIAL_CLAIM"
        ? INTEGRITY_CORRECTION_PROMPT
        : SCHEMA_CORRECTION_PROMPT;

    assertWithinDeadline();

    const retryPrompt = `${initialPrompt}\n\n${correctionInstruction}`;
    const retryResult = await generateJsonWithGroq(retryPrompt);
    return validateNodeOutput(schema, retryResult, nodeName, { verifiedFacts });
  }
};

export const researchNode = async (state) => {
  return executeNodeWithValidationRetry({
    promptBuilder: (s) => buildResearchPrompt({ company: s.company }),
    schema: ResearchNodeSchema,
    nodeName: "research node",
    state
  });
};

export const fundamentalNode = async (state) => {
  return executeNodeWithValidationRetry({
    promptBuilder: (s) =>
      buildFundamentalPrompt({
        company: s.company,
        overview: s.overview,
        industry: s.industry,
        strengths: s.strengths,
        risks: s.risks,
        financialData: s.financialData,
        financialMetrics: s.financialMetrics
      }),
    schema: FundamentalNodeSchema,
    nodeName: "fundamental analysis node",
    state
  });
};

export const thesisNode = async (state) => {
  return executeNodeWithValidationRetry({
    promptBuilder: (s) =>
      buildThesisPrompt({
        company: s.company,
        overview: s.overview,
        industry: s.industry,
        strengths: s.strengths,
        risks: s.risks,
        fundamentalAssessment: s.fundamentalAssessment,
        keyCatalysts: s.keyCatalysts,
        keyConcerns: s.keyConcerns,
        financialData: s.financialData,
        financialMetrics: s.financialMetrics
      }),
    schema: ThesisNodeSchema,
    nodeName: "investment thesis node",
    state
  });
};

export const recommendationNode = async (state) => {
  return executeNodeWithValidationRetry({
    promptBuilder: (s) =>
      buildRecommendationPrompt({
        company: s.company,
        overview: s.overview,
        industry: s.industry,
        strengths: s.strengths,
        risks: s.risks,
        fundamentalAssessment: s.fundamentalAssessment,
        keyCatalysts: s.keyCatalysts,
        keyConcerns: s.keyConcerns,
        investmentThesis: s.investmentThesis,
        bullCase: s.bullCase,
        bearCase: s.bearCase,
        financialData: s.financialData,
        financialMetrics: s.financialMetrics
      }),
    schema: RecommendationNodeSchema,
    nodeName: "recommendation node",
    state
  });
};

export const workflow = new StateGraph(GraphState)
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

export const runInvestmentResearchWorkflow = async ({ company, ticker, financialData, financialMetrics }) => {
  if (typeof company !== "string" || !company.trim()) {
    throw new AppError("'company' is required and must be a non-empty string.", 400);
  }

  const trimmedCompany = company.trim();
  const deadline = Date.now() + WORKFLOW_TIMEOUT_MS;

  return workflowStorage.run({ deadline }, async () => {
    const initialState = {
      company: trimmedCompany,
      ticker: ticker,
      financialData: financialData,
      financialMetrics: financialMetrics,
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

    const finalResult = validateNodeOutput(FinalResearchOutputSchema, result, "workflow pipeline");

    return {
      company: finalResult.company,
      ticker: result?.ticker,
      financialData: result?.financialData,
      financialMetrics: result?.financialMetrics,
      overview: finalResult.overview,
      industry: finalResult.industry,
      investmentThesis: finalResult.investmentThesis,
      fundamentalAssessment: finalResult.fundamentalAssessment,
      strengths: finalResult.strengths,
      risks: finalResult.risks,
      keyCatalysts: finalResult.keyCatalysts,
      keyConcerns: finalResult.keyConcerns,
      bullCase: finalResult.bullCase,
      bearCase: finalResult.bearCase,
      recommendation: finalResult.recommendation,
      confidence: finalResult.confidence,
      reasoning: finalResult.reasoning
    };
  });
};
