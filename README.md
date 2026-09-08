# AI Investment Research Agent

An AI-powered web application that researches a company and generates an investment recommendation using a 4-stage LangGraph workflow powered by Groq (`openai/gpt-oss-120b`). A separate verified financial data layer fetches Financial Modeling Prep (FMP) fundamentals; it is not yet wired into the research workflow.

---

# Overview

The AI Investment Research Agent allows users to enter a company name and receive an AI-generated investment analysis.

The application performs qualitative research, fundamental assessment, thesis construction, and a final recommendation with a confidence score and reasoning.

The backend uses LangGraph to orchestrate four AI steps. The frontend is a React + Vite UI. Verified market/financial snapshots are available from `GET /financial-data/:ticker`.

---

# Live Demo
Repository

https://github.com/DurgaGanesh05/investment-agent

Frontend

https://investment-agent-frontend.onrender.com

Backend

https://investment-agent-3uzp.onrender.com

Health Endpoint

https://investment-agent-3uzp.onrender.com/health

---

# Features

- AI-powered company research (4-stage LangGraph workflow)
- Investment recommendation (Invest / Hold / Avoid)
- Confidence score (0–100 integer)
- Overview, industry, thesis, bull/bear cases, catalysts, and concerns
- Qualitative fundamental assessment (business quality, competitive advantage, financial health)
- Verified financial data endpoint backed by Financial Modeling Prep (FMP) (not yet used by LangGraph)
- Responsive React frontend
- REST API backend using Express

---

# Tech Stack

## Frontend

- React
- Vite
- Axios
- Tailwind CSS

## Backend

- Node.js
- Express.js
- LangGraph
- Groq API (`openai/gpt-oss-120b`)
- Financial Modeling Prep (FMP) (financial data provider)

---

# Project Structure

```
investment-agent/
│
├── backend/
│   ├── src/
│   │   ├── config/
│   │   ├── controllers/
│   │   ├── langgraph/
│   │   ├── middleware/
│   │   ├── prompts/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── utils/
│   │   ├── app.js
│   │   └── server.js
│   │
│   ├── package.json
│   └── .env.example
│
├── frontend/
│   ├── src/
│   ├── public/
│   └── package.json
│
└── README.md
```

---

# Setup Instructions

## 1. Clone the Repository

```bash
git clone https://github.com/DurgaGanesh05/investment-agent.git

cd investment-agent
```

---

## 2. Backend Setup

```bash
cd backend

npm install
```

Create a `.env` file inside the backend folder.

Example:

```
PORT=3000
NODE_ENV=development
GROQ_API_KEY=your_groq_api_key_here
GROQ_MODEL=openai/gpt-oss-120b
CORS_ORIGIN=http://localhost:5173
FMP_API_KEY=your_fmp_api_key_here
FINANCIAL_CACHE_TTL_MS=3600000
```

Start the backend server:

```bash
npm run dev
```

---

## 3. Frontend Setup

```bash
cd frontend

npm install

npm run dev
```

The frontend will run at:

```
http://localhost:5173
```

---

# Environment Variables

| Variable | Description |
|----------|-------------|
| PORT | Backend server port |
| NODE_ENV | Application environment |
| GROQ_API_KEY | Groq API key |
| GROQ_MODEL | Groq model id (default `openai/gpt-oss-120b`) |
| CORS_ORIGIN | Allowed frontend origin(s) |
| FMP_API_KEY | Financial Modeling Prep API key |
| FINANCIAL_CACHE_TTL_MS | In-memory financial cache TTL in milliseconds (default `3600000`) |

---

# API Endpoints

### GET /health

Returns `{ "status": "OK" }` when the API is running.

### POST /research

Request

```json
{
  "company": "Apple"
}
```

Response (14 fields)

```json
{
  "company": "Apple",
  "overview": "...",
  "industry": "...",
  "investmentThesis": "...",
  "fundamentalAssessment": {
    "businessQuality": "...",
    "competitiveAdvantage": "...",
    "financialHealth": "..."
  },
  "strengths": [],
  "risks": [],
  "keyCatalysts": [],
  "keyConcerns": [],
  "bullCase": "...",
  "bearCase": "...",
  "recommendation": "Invest",
  "confidence": 88,
  "reasoning": "..."
}
```

`recommendation` is exactly one of: `Invest`, `Hold`, `Avoid`.

Research prompts are qualitative. They do not use the FMP financial layer yet.

### GET /financial-data/:ticker

Resolves a ticker or a small set of known company names (for example `Apple` → `AAPL`) and returns a normalized snapshot:

```json
{
  "status": "OK",
  "data": {
    "company": { "name": "...", "ticker": "AAPL", "exchange": "...", "currency": "..." },
    "market": { "price": 0, "marketCap": 0 },
    "financials": {
      "revenue": 0,
      "netIncome": 0,
      "eps": 0,
      "totalAssets": 0,
      "totalLiabilities": 0,
      "cashAndEquivalents": 0
    },
    "periods": { "fiscalDate": "...", "periodType": "Annual" },
    "metadata": { "source": "Financial Modeling Prep", "retrievedAt": "..." }
  }
}
```

Missing values are `null`, never fabricated zeros. Results are cached in memory by ticker.

---

# How It Works

The backend uses LangGraph to execute a four-step workflow.

1. **research_step** — overview, industry, strengths, and risks
2. **fundamental_step** — qualitative fundamental assessment, key catalysts, and key concerns
3. **thesis_step** — investment thesis, bull case, and bear case
4. **recommendation_step** — Invest / Hold / Avoid, confidence, and reasoning

A separate financial data service talks to Financial Modeling Prep (FMP) through a provider module. LangGraph does not consume that data yet.

---

# Architecture

```
User
  │
  ▼
React Frontend
  │
HTTP Request
  │
Express Backend
  │
Research Controller
  │
LangGraph Workflow
  │
├── research_step
├── fundamental_step
├── thesis_step
└── recommendation_step
  │
Groq (`openai/gpt-oss-120b`)
  │
JSON Response
  │
React UI

GET /financial-data/:ticker
  │
financialDataService (resolve, cache, in-flight deduplicate, normalize)
  │
fmpProvider
  │
Financial Modeling Prep (profile, quote, income-statement, balance-sheet-statement)
```

---

# Key Design Decisions & Trade-offs

## Design Decisions

- Used LangGraph to model the workflow as sequential AI nodes.
- Used the Groq API with `openai/gpt-oss-120b` to generate structured JSON responses.
- Isolated Financial Modeling Prep behind a thin provider so the public financial schema stays provider-agnostic.
- Separated prompts into reusable modules.
- Built a REST API using Express for frontend-backend communication.

## Trade-offs

- AI responses depend on the availability of the Groq API.
- No database is used because data persistence is not required.
- No authentication is implemented since the project focuses on AI workflow.
- The quality of recommendations depends on the underlying language model.
---

                    +----------------+
                    |     User       |
                    +-------+--------+
                            |
                            v
                +-----------------------+
                |   React Frontend      |
                +-----------+-----------+
                            |
                     POST /research
                            |
                            v
                +-----------------------+
                |   Express Backend     |
                +-----------+-----------+
                            |
                            v
                +-----------------------+
                |   LangGraph Workflow  |
                +-----------+-----------+
                            |
        +-------------------+-------------------+-------------------+
        |                   |                   |                   |
        v                   v                   v                   v
 research_step     fundamental_step      thesis_step     recommendation_step
        |                   |                   |                   |
        +-------------------+-------------------+-------------------+
                            |
                            v
                      Groq LLM API
                            |
                            v
                     JSON Response
                            |
                            v
                     React UI Display

---



# Deployment

Frontend

Render Static Site

Backend

Render Web Service

Both applications are deployed independently and communicate through REST APIs.

---


# AI Model

Provider: Groq

Model: openai/gpt-oss-120b

The model is used to perform:
- Company research
- Investment analysis
- Recommendation generation
- Confidence scoring

---


# Example Runs

### Input

```
GameStop
```

### Output


<img width="1470" height="956" alt="image" src="https://github.com/user-attachments/assets/be16c49c-3beb-4ea6-918c-7dc40ef9e6dd" />



---

### Input

```
Apple
```

### Output


<img width="1470" height="956" alt="image" src="https://github.com/user-attachments/assets/f35131d8-88c8-47a3-9385-12bb16c89879" />



---

### Input

```
Nokia
```

### Output


<img width="1470" height="956" alt="image" src="https://github.com/user-attachments/assets/43d79150-293d-4a39-994b-ee0dc6dd9599" />



---


# AI-Assisted Development

This project was developed with the assistance of Large Language Models (LLMs) for brainstorming, debugging, code generation, workflow design, and documentation.

Tools used:

- ChatGPT (OpenAI)
- Groq API Documentation
- LangGraph Documentation

All architecture decisions, implementation, debugging, deployment, and testing were performed by me.

---

# What I Would Improve With More Time

- Feed verified FMP data into the LangGraph research workflow (P2.2).
- Compare multiple companies.
- Add charts and financial visualizations.
- Store previous analyses in a database.
- Add user authentication.
- Containerize the application using Docker.
- Add caching for repeated research analyses.
- Stream AI responses for improved user experience.

---

# Author

**Seeram Venkata Durga Ganesh**

GitHub: https://github.com/DurgaGanesh05

---

# License

This project is provided for educational purposes as part of an AI engineering assignment.
