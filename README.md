# AI Investment Research Agent

An AI-powered web application that researches a company and generates an investment recommendation using a multi-step LangGraph workflow powered by the Groq API (Llama 3.3 70B Versatile).

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
- Groq API
- Llama 3.3 70B Versatile

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
GROQ_API_KEY=YOUR_GROQ_API_KEY
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
| GROQ_API_KEY | Groq API Key |

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
Groq API
  │
JSON Response
  │
React UI
```

---

# Key Design Decisions & Trade-offs

## Design Decisions

- Used LangGraph to model the workflow as sequential AI nodes.
- Used the Groq API with the Llama 3.3 70B Versatile model to generate structured JSON responses.
- Separated prompts into reusable modules.
- Built a REST API using Express for frontend-backend communication.

## Trade-offs

- AI responses depend on the availability of the Groq API.
- No database is used because data persistence is not required.
- No authentication is implemented since the project focuses on AI workflow.
- The quality of recommendations depends on the underlying language model.
---


# AI Model

Provider: Groq

Model: llama-3.3-70b-versatile

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

---

# License

This project is provided for educational purposes as part of an AI engineering assignment.
