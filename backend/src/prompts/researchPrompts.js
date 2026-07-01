export const buildResearchPrompt = ({ company }) => `
You are an equity research assistant.
Research the company: ${company}.
Return ONLY valid JSON with this exact shape:
{
  "overview": "",
  "industry": "",
  "strengths": ["", ""],
  "risks": ["", ""]
}
Rules:
- Keep overview concise (max 120 words).
- Strengths and risks must each have 3 to 5 bullet-style strings.
- No markdown, no extra keys, no commentary outside JSON.
`;

export const buildAnalysisPrompt = ({ company, overview, industry, strengths, risks }) => `
You are a senior equity research analyst.

Analyze the following company.

Company: ${company}

Overview:
${overview}

Industry:
${industry}

Strengths:
${JSON.stringify(strengths)}

Risks:
${JSON.stringify(risks)}

Evaluate the overall investment quality based on the strengths and risks.

Return ONLY valid JSON in exactly this format:

{
  "confidence": 0,
  "reasoning": ""
}

Rules:

- confidence must be an INTEGER between 0 and 100.

Assign confidence using these guidelines:

90-100:
Outstanding company with very strong fundamentals and very low risk.

80-89:
Strong company with manageable risks.

65-79:
Good company but with noticeable concerns.

50-64:
Mixed outlook with significant uncertainty.

30-49:
Weak investment with substantial risks.

0-29:
Very poor investment outlook.

Do NOT always return 80.

Choose the confidence score based on the actual strengths and risks of the company.

Reasoning should clearly explain why the confidence score was assigned.

Maximum reasoning length: 120 words.

No markdown.

No extra keys.

Return JSON only.
`;

export const buildRecommendationPrompt = ({ company, overview, industry, strengths, risks, confidence, reasoning }) => `
You are an investment recommendation assistant.
Create a final recommendation for ${company}.
Input:
- overview: ${overview}
- industry: ${industry}
- strengths: ${JSON.stringify(strengths)}
- risks: ${JSON.stringify(risks)}
- confidence: ${confidence}
- reasoning: ${reasoning}
Return ONLY valid JSON with this exact shape:
{
  "company": "",
  "overview": "",
  "industry": "",
  "strengths": ["", ""],
  "risks": ["", ""],
  "recommendation": "Invest",
  "confidence": 0,
  "reasoning": ""
}
Rules:
- recommendation must be exactly one of: Invest, Hold, Avoid.
- confidence must be an integer from 0 to 100.
- Ensure company field matches the input company.
- No markdown, no extra keys.
`;
