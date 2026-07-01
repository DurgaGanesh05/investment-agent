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
You are a financial analyst.
Analyze this research input for ${company}.
Overview: ${overview}
Industry: ${industry}
Strengths: ${JSON.stringify(strengths)}
Risks: ${JSON.stringify(risks)}
Return ONLY valid JSON with this exact shape:
{
  "confidence": 0,
  "reasoning": ""
}
Rules:
- confidence must be an integer from 0 to 100.
- reasoning should be concise and evidence-based (max 140 words).
- No markdown, no extra keys.
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
