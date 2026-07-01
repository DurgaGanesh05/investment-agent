# AI Investment Research Agent

An AI-powered web application that researches a company and generates an investment recommendation using a multi-step LangGraph workflow powered by Google's Gemini API.

---

# Overview

The AI Investment Research Agent allows users to enter a company name and receive an AI-generated investment analysis.

The application performs research, analyzes strengths and risks, evaluates the company, and finally generates an investment recommendation with a confidence score and reasoning.

The backend uses LangGraph to orchestrate multiple AI steps while the frontend provides a clean and responsive interface built with React.

---

# Features

- AI-powered company research
- Multi-step LangGraph workflow
- Investment recommendation (Invest / Hold / Avoid)
- Confidence score
- Company overview
- Industry identification
- Strengths analysis
- Risk analysis
- AI-generated reasoning
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
- Google Gemini API

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
GEMINI_API_KEY=YOUR_API_KEY
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
| GEMINI_API_KEY | Google Gemini API Key |

---

# API Endpoint

### POST /research

Request

```json
{
  "company": "Apple"
}
```

Response

```json
{
  "company": "Apple",
  "overview": "...",
  "industry": "...",
  "strengths": [],
  "risks": [],
  "recommendation": "Invest",
  "confidence": 88,
  "reasoning": "..."
}
```

---

# How It Works

The backend uses LangGraph to execute a three-step workflow.

1. **Research Node**
   - Researches the company.
   - Generates overview, industry, strengths, and risks.

2. **Analysis Node**
   - Evaluates the research.
   - Produces a confidence score and reasoning.

3. **Recommendation Node**
   - Generates the final investment recommendation.
   - Returns the completed response to the frontend.

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
├── Research Node
├── Analysis Node
└── Recommendation Node
  │
Google Gemini API
  │
JSON Response
  │
React UI
```

---

# Key Design Decisions & Trade-offs

## Design Decisions

- Used LangGraph to model the workflow as sequential AI nodes.
- Used Google Gemini API to generate structured JSON responses.
- Separated prompts into reusable modules.
- Built a REST API using Express for frontend-backend communication.

## Trade-offs

- AI responses depend on the Gemini API.
- No database is used because data persistence is not required.
- No authentication is implemented since the project focuses on AI workflow.
- Free-tier Gemini API quota may temporarily limit requests.

---

# Example Run

### Input

```
Apple
```

### Output

```
Company: Apple

Industry: Consumer Electronics

Recommendation: Invest

Confidence: 88%

Overview:
Apple Inc. is a global technology company known for designing consumer electronics, software, and digital services.

Strengths:
• Strong global brand
• High customer loyalty
• Large cash reserves

Risks:
• Supply chain dependence
• Regulatory pressure
• Premium pricing

Reasoning:
Apple maintains strong financial performance, a loyal customer base, and continuous innovation, making it an attractive long-term investment despite existing market risks.
```

---

# What I Would Improve With More Time

- Integrate live financial market data.
- Compare multiple companies.
- Add charts and financial visualizations.
- Store previous analyses in a database.
- Add user authentication.
- Containerize the application using Docker.
- Deploy the application to the cloud.
- Add automated unit and integration tests.
- Stream AI responses for improved user experience.

---

# Author

**Seeram Venkata Durga Ganesh**

GitHub: https://github.com/DurgaGanesh05
