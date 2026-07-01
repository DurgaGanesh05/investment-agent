import axios from "axios";

export const api = axios.create({
  baseURL: "https://investment-agent-3uzp.onrender.com",
  headers: {
    "Content-Type": "application/json"
  },
  timeout: 30000
});

export default api;