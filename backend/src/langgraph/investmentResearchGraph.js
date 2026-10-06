import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { generateJsonWithGroq, workflowStorage } from "../services/groqService.js";
import { buildAnalysisPrompt } from "../prompts/researchPrompts.js";
import { AppError } from "../utils/appError.js";
import {
  CombinedAnalysisSchema,
  FinalResearchOutputSchema,
  validateNodeOutput
} from "../schemas/researchSchemas.js";
import { buildVerifiedFacts } from "../utils/researchIntegrity.js";

export const WORKFLOW_TIMEOUT_MS = 45000;

// Per-node completion-token caps forwarded to Groq as `max_completion_tokens`
// (D4 max-reduction pass). The configured model (openai/gpt-oss-120b) is a
// reasoning model: reasoning tokens count toward the completion budget, so
// these caps are aggressive and sized against the tightened output contracts:
// Completion-token cap for the single analysis call, forwarded to Groq as
// `max_completion_tokens` (D4 one-call consolidation). The call produces the
// full 13-field research profile; measured per-section completions summed to
// ~1,100-1,300 tokens at "low" reasoning effort (research ~192, fundamental
// ~470-620, thesis ~251, recommendation ~169), so 1600 carries measured
// headroom. The same cap applies to the validation retry.
export const ANALYSIS_COMPLETION_BUDGET = 1600;

// Reasoning effort sent as `reasoning_effort` for every node call (D4
// reasoning-optimization pass). The measured gpt-oss-120b default ("medium")
// spends ~440 reasoning tokens even on trivial JSON tasks, which exhausted
// the aggressive completion budgets; "low" reduces that overhead without
// touching the budgets. The same effort applies to a node's validation retry.
// (The fundamental "medium" experiment was reverted: medium reasoning alone
// consumed the entire 1024-token budget before any JSON was generated.)
export const REASONING_EFFORT = "low";

const GraphState = Annotation.Root({
  company: Annotation(),
  ticker: Annotation(),
  financialData: Annotation(),
  financialMetrics: Annotation(),
  externalResearch: Annotation(),
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
Your previous response contained financial numbers in narrative text.
Remove all financial numbers from every narrative field.
Do not insert verified numbers and do not cite financial values.
Do not invent, estimate, forecast, or introduce unsupported numbers.
Describe the financial implication qualitatively instead
(for example: "strong profitability", "improving liquidity").
Return the same JSON structure with all requested fields.
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

// TEMPORARY D4 DIAGNOSTIC (node-level observability for the live Groq 429
// investigation). Logs only the node label, outcome, provider-error
// classification, and elapsed milliseconds. Never logs prompts, responses,
// financial data, or credentials. Does not alter error handling, retry
// behavior, timing, or the returned response. Remove once the
// token-rate-limit bottleneck is resolved.
const NODE_LOG_LABELS = {
  "analysis node": "analysis"
};

const diagnosticErrorType = (error) =>
  error instanceof AppError
    ? error.code ?? `APP_ERROR_${error.statusCode}`
    : error?.code ?? error?.name ?? "UNKNOWN_ERROR";

export const executeNodeWithValidationRetry = async ({
  promptBuilder,
  schema,
  nodeName,
  state,
  completionBudget,
  reasoningEffort
}) => {
  const diagnosticLabel = NODE_LOG_LABELS[nodeName] ?? nodeName;
  const diagnosticStartedAt = Date.now();
  console.log(`[${diagnosticLabel}] START`);
  try {
    assertWithinDeadline();

    const verifiedFacts = buildVerifiedFacts(state.financialData, state.financialMetrics);
    const initialPrompt = promptBuilder(state);
    // One shared options object guarantees the validation retry runs under the
    // exact same Groq options (completion budget and reasoning effort) as the
    // initial attempt. Omitted values leave the request unchanged.
    const groqOptions = {
      ...(completionBudget == null ? {} : { maxCompletionTokens: completionBudget }),
      ...(reasoningEffort == null ? {} : { reasoningEffort })
    };

    try {
      const result = await generateJsonWithGroq(initialPrompt, groqOptions);
      const validated = validateNodeOutput(schema, result, nodeName, { verifiedFacts });
      console.log(`[${diagnosticLabel}] SUCCESS elapsedMs=${Date.now() - diagnosticStartedAt}`);
      return validated;
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
      const retryResult = await generateJsonWithGroq(retryPrompt, groqOptions);
      const validated = validateNodeOutput(schema, retryResult, nodeName, { verifiedFacts });
      console.log(`[${diagnosticLabel}] SUCCESS elapsedMs=${Date.now() - diagnosticStartedAt}`);
      return validated;
    }
  } catch (error) {
    console.log(`[${diagnosticLabel}] ERROR type=${diagnosticErrorType(error)} elapsedMs=${Date.now() - diagnosticStartedAt}`);
    throw error;
  }
};

export const analysisNode = async (state) => {
  return executeNodeWithValidationRetry({
    promptBuilder: (s) =>
      buildAnalysisPrompt({
        company: s.company,
        externalResearch: s.externalResearch,
        financialData: s.financialData,
        financialMetrics: s.financialMetrics
      }),
    schema: CombinedAnalysisSchema,
    nodeName: "analysis node",
    completionBudget: ANALYSIS_COMPLETION_BUDGET,
    reasoningEffort: REASONING_EFFORT,
    state
  });
};

export const workflow = new StateGraph(GraphState)
  .addNode("analysis_step", analysisNode)
  .addEdge(START, "analysis_step")
  .addEdge("analysis_step", END)
  .compile();

export const runInvestmentResearchWorkflow = async ({
  company,
  ticker,
  financialData,
  financialMetrics,
  externalResearch
}) => {
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
      externalResearch: externalResearch ?? null,
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
