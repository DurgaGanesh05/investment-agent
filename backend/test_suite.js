import assert from "node:assert/strict";
import http from "node:http";
import app from "./src/app.js";
import { env } from "./src/config/env.js";
import { isRetryableError, executeWithRetry, formatGroqError, workflowStorage } from "./src/services/groqService.js";
import {
  parseConfidence,
  parseStringArray,
  parseFundamentalAssessment,
  WORKFLOW_TIMEOUT_MS
} from "./src/langgraph/investmentResearchGraph.js";
import { validateResearchRequest } from "./src/middleware/validateResearchRequest.js";
import { extractFirstJsonObject } from "./src/utils/json.js";
import { AppError } from "./src/utils/appError.js";
import {
  resolveCompanyToTicker,
  getFinancialData,
  clearFinancialCache
} from "./src/services/financialDataService.js";

async function runUnitTests() {
  console.log("=== RUNNING UNIT TESTS ===");

  // 1. Test parseConfidence
  console.log("Testing parseConfidence...");
  assert.equal(parseConfidence("85"), 85);
  assert.equal(parseConfidence(85), 85);
  assert.equal(parseConfidence(0), 0);
  assert.equal(parseConfidence(100), 100);
  assert.equal(parseConfidence(-1), null);
  assert.equal(parseConfidence(101), null);
  assert.equal(parseConfidence("abc"), null);
  assert.equal(parseConfidence(null), null);
  assert.equal(parseConfidence(undefined), null);
  assert.equal(parseConfidence(""), null);
  console.log("✓ parseConfidence passed");

  // 2. Test parseStringArray
  console.log("Testing parseStringArray...");
  assert.deepEqual(parseStringArray(["a", "b", "  c  ", ""]), ["a", "b", "c"]);
  assert.deepEqual(parseStringArray("not an array"), []);
  assert.deepEqual(parseStringArray([null, undefined, 123, "valid"]), ["valid"]);
  console.log("✓ parseStringArray passed");

  // 3. Test parseFundamentalAssessment
  console.log("Testing parseFundamentalAssessment...");
  assert.deepEqual(
    parseFundamentalAssessment({
      businessQuality: " High quality moat ",
      competitiveAdvantage: " Strong brand ",
      financialHealth: " Disciplined balance sheet "
    }),
    {
      businessQuality: "High quality moat",
      competitiveAdvantage: "Strong brand",
      financialHealth: "Disciplined balance sheet"
    }
  );
  assert.equal(parseFundamentalAssessment(null), null);
  assert.equal(parseFundamentalAssessment("string"), null);
  assert.equal(parseFundamentalAssessment([]), null);
  assert.equal(
    parseFundamentalAssessment({
      businessQuality: "High",
      competitiveAdvantage: ""
    }),
    null
  );
  console.log("✓ parseFundamentalAssessment passed");

  // 4. Test extractFirstJsonObject (LLM output parsing)
  console.log("Testing extractFirstJsonObject...");
  assert.deepEqual(extractFirstJsonObject('{"foo": "bar"}'), { foo: "bar" });
  assert.deepEqual(extractFirstJsonObject('```json\n{"foo": "bar"}\n```'), { foo: "bar" });
  assert.deepEqual(extractFirstJsonObject('Here is the response: {"foo": "bar"} Thanks!'), { foo: "bar" });

  assert.throws(() => extractFirstJsonObject(""), (err) => err instanceof AppError && err.statusCode === 502);
  assert.throws(() => extractFirstJsonObject("Not json at all"), (err) => err instanceof AppError && err.statusCode === 502);
  assert.throws(() => extractFirstJsonObject("```json\n[1, 2, 3]\n```"), (err) => err instanceof AppError && err.statusCode === 502);
  console.log("✓ extractFirstJsonObject passed");

  // 5. Test validateResearchRequest middleware
  console.log("Testing validateResearchRequest middleware...");
  function testValidate(body) {
    let capturedErr = null;
    const req = { body };
    validateResearchRequest(req, {}, (err) => {
      capturedErr = err ?? null;
    });
    return { req, err: capturedErr };
  }

  assert.equal(testValidate({ company: "Apple" }).err, null);
  assert.equal(testValidate({ company: "  AT&T  " }).req.body.company, "AT&T");
  assert.equal(testValidate({ company: "L'Oréal S.A." }).req.body.company, "L'Oréal S.A.");
  assert.equal(testValidate({ company: "3M" }).req.body.company, "3M");

  assert.equal(testValidate({}).err?.statusCode, 400);
  assert.equal(testValidate({ company: "" }).err?.statusCode, 400);
  assert.equal(testValidate({ company: "   " }).err?.statusCode, 400);
  assert.equal(testValidate({ company: 123 }).err?.statusCode, 400);
  assert.equal(testValidate({ company: "A".repeat(101) }).err?.statusCode, 400);
  assert.equal(testValidate({ company: "Apple\u0000Corp" }).err?.statusCode, 400);
  assert.equal(testValidate(null).err?.statusCode, 400);
  assert.equal(testValidate([]).err?.statusCode, 400);
  console.log("✓ validateResearchRequest passed");

  // 6. Test isRetryableError
  console.log("Testing isRetryableError classification...");
  // Non-retryable
  assert.equal(isRetryableError({ status: 400 }), false);
  assert.equal(isRetryableError({ status: 401 }), false);
  assert.equal(isRetryableError({ status: 403 }), false);
  assert.equal(isRetryableError({ status: 404 }), false);
  assert.equal(isRetryableError({ status: 422 }), false);
  assert.equal(isRetryableError(null), false);
  assert.equal(isRetryableError(new Error("generic")), false);

  // Retryable
  assert.equal(isRetryableError({ status: 429 }), true);
  assert.equal(isRetryableError({ status: 500 }), true);
  assert.equal(isRetryableError({ status: 502 }), true);
  assert.equal(isRetryableError({ status: 503 }), true);
  assert.equal(isRetryableError({ status: 504 }), true);
  assert.equal(isRetryableError({ name: "APIConnectionError" }), true);
  assert.equal(isRetryableError({ name: "APIConnectionTimeoutError" }), true);
  assert.equal(isRetryableError({ code: "ECONNRESET" }), true);
  assert.equal(isRetryableError({ code: "ETIMEDOUT" }), true);
  assert.equal(isRetryableError({ code: "ENOTFOUND" }), true);
  assert.equal(isRetryableError({ code: "EAI_AGAIN" }), true);
  assert.equal(isRetryableError({ code: "UND_ERR_CONNECT_TIMEOUT" }), true);
  console.log("✓ isRetryableError passed");

  // 7. Test executeWithRetry and deadline abort
  console.log("Testing executeWithRetry logic and deadline enforcement...");
  let nonRetryableAttempts = 0;
  try {
    await executeWithRetry(async () => {
      nonRetryableAttempts++;
      const err = new Error("Invalid API key");
      err.status = 401;
      throw err;
    }, 2, 10);
    assert.fail("Should have thrown");
  } catch (err) {
    assert.equal(err.status, 401);
    assert.equal(nonRetryableAttempts, 1, "Non-retryable error should not be retried");
  }

  let transientAttempts = 0;
  const result = await executeWithRetry(async () => {
    transientAttempts++;
    if (transientAttempts < 3) {
      const err = new Error("Rate limit");
      err.status = 429;
      throw err;
    }
    return "success";
  }, 2, 10);
  assert.equal(result, "success");
  assert.equal(transientAttempts, 3, "Transient error should retry up to maxRetries");

  // Test deadline abort in executeWithRetry
  const pastDeadline = Date.now() - 1000;
  await assert.rejects(
    () => executeWithRetry(async () => "should not run", 2, 100, pastDeadline),
    (err) => err instanceof AppError && err.statusCode === 504
  );

  // Test retry deadline exhaustion
  const tightDeadline = Date.now() + 50;
  await assert.rejects(
    () =>
      executeWithRetry(
        async () => {
          const err = new Error("503 error");
          err.status = 503;
          throw err;
        },
        2,
        200,
        tightDeadline
      ),
    (err) => err instanceof AppError && err.statusCode === 504
  );
  console.log("✓ executeWithRetry and deadline enforcement passed");

  // 8. Test formatGroqError and secret redaction
  console.log("Testing formatGroqError and redaction...");
  const timeoutErr = formatGroqError({ name: "APIConnectionTimeoutError" });
  assert.equal(timeoutErr.statusCode, 504);

  const abortErr = formatGroqError({ name: "APIUserAbortError" });
  assert.equal(abortErr.statusCode, 504);

  const rateLimitErr = formatGroqError({ status: 429 });
  assert.equal(rateLimitErr.statusCode, 503);

  const authErr = formatGroqError({ status: 401 });
  assert.equal(authErr.statusCode, 500);

  const keyLeakErr = formatGroqError(new Error("Failed with gsk_secretkey1234567890abcdef in message"));
  assert.ok(!keyLeakErr.message.includes("gsk_secretkey1234567890abcdef"));
  assert.ok(keyLeakErr.message.includes("[REDACTED]"));
  console.log("✓ formatGroqError passed");

  console.log("ALL UNIT TESTS PASSED!\n");
}

async function runIntegrationTests() {
  console.log("=== RUNNING INTEGRATION & API TESTS ===");

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  console.log(`Test server running on port ${port}`);

  async function request(path, options = {}) {
    const res = await fetch(`${baseUrl}${path}`, options);
    let body;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, headers: res.headers, body };
  }

  try {
    // Test A: Health check
    console.log("Test A: GET /health");
    const resA = await request("/health");
    assert.equal(resA.status, 200);
    assert.equal(resA.body.status, "OK");
    console.log("✓ GET /health -> 200 OK");

    // Test E: Missing company
    console.log("Test E: POST /research with {}");
    const resE = await request("/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(resE.status, 400);
    assert.equal(resE.body.status, "ERROR");
    console.log("✓ POST /research {} -> 400 ERROR:", resE.body.message);

    // Test F: Empty company
    console.log("Test F: POST /research with {\"company\": \"\"}");
    const resF = await request("/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company: "" })
    });
    assert.equal(resF.status, 400);
    assert.equal(resF.body.status, "ERROR");
    console.log("✓ POST /research {\"company\":\"\"} -> 400 ERROR:", resF.body.message);

    // Test G: Whitespace company
    console.log("Test G: POST /research with {\"company\": \"   \"}");
    const resG = await request("/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company: "   " })
    });
    assert.equal(resG.status, 400);
    assert.equal(resG.body.status, "ERROR");
    console.log("✓ POST /research {\"company\":\"   \"} -> 400 ERROR:", resG.body.message);

    // Test H: Invalid type company
    console.log("Test H: POST /research with {\"company\": 123}");
    const resH = await request("/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company: 123 })
    });
    assert.equal(resH.status, 400);
    assert.equal(resH.body.status, "ERROR");
    console.log("✓ POST /research {\"company\":123} -> 400 ERROR:", resH.body.message);

    // Test I: Malformed JSON
    console.log("Test I: POST /research with malformed JSON");
    const resI = await request("/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{\"company\": \"Apple\", badjson"
    });
    assert.equal(resI.status, 400);
    assert.equal(resI.body.status, "ERROR");
    assert.equal(resI.body.message, "Invalid JSON format in request body.");
    console.log("✓ Malformed JSON -> 400 ERROR:", resI.body.message);

    // Test J: Oversized request body (>10KB)
    console.log("Test J: POST /research with oversized request body");
    const oversizedBody = JSON.stringify({ company: "Apple", extra: "x".repeat(15000) });
    const resJ = await request("/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversizedBody
    });
    assert.equal(resJ.status, 413);
    assert.equal(resJ.body.status, "ERROR");
    console.log("✓ Oversized body -> 413 ERROR:", resJ.body.message);

    // Test 404 Route
    console.log("Test 404: GET /unknown-route");
    const res404 = await request("/unknown-route");
    assert.equal(res404.status, 404);
    assert.equal(res404.body.status, "ERROR");
    console.log("✓ 404 Route -> 404 ERROR:", res404.body.message);

    // Helper to validate upgraded research payload schema (14 fields)
    function validateResearchResponse(body, expectedCompany) {
      assert.ok(typeof body === "object" && body !== null, "Response must be an object");
      assert.equal(body.company.toLowerCase(), expectedCompany.toLowerCase(), `Company must match ${expectedCompany}`);
      assert.ok(typeof body.overview === "string" && body.overview.length > 0, "Overview must be non-empty string");
      assert.ok(typeof body.industry === "string" && body.industry.length > 0, "Industry must be non-empty string");
      assert.ok(typeof body.investmentThesis === "string" && body.investmentThesis.length > 0, "Investment Thesis must be non-empty string");

      // Fundamental Assessment nested object validation
      assert.ok(typeof body.fundamentalAssessment === "object" && body.fundamentalAssessment !== null, "fundamentalAssessment must be object");
      assert.ok(typeof body.fundamentalAssessment.businessQuality === "string" && body.fundamentalAssessment.businessQuality.length > 0, "businessQuality must be non-empty string");
      assert.ok(typeof body.fundamentalAssessment.competitiveAdvantage === "string" && body.fundamentalAssessment.competitiveAdvantage.length > 0, "competitiveAdvantage must be non-empty string");
      assert.ok(typeof body.fundamentalAssessment.financialHealth === "string" && body.fundamentalAssessment.financialHealth.length > 0, "financialHealth must be non-empty string");

      // Array fields validation
      assert.ok(Array.isArray(body.strengths) && body.strengths.length > 0, "Strengths must be non-empty array");
      assert.ok(body.strengths.every((s) => typeof s === "string" && s.trim().length > 0), "Each strength must be string");

      assert.ok(Array.isArray(body.risks) && body.risks.length > 0, "Risks must be non-empty array");
      assert.ok(body.risks.every((r) => typeof r === "string" && r.trim().length > 0), "Each risk must be string");

      assert.ok(Array.isArray(body.keyCatalysts) && body.keyCatalysts.length > 0, "Key Catalysts must be non-empty array");
      assert.ok(body.keyCatalysts.every((c) => typeof c === "string" && c.trim().length > 0), "Each catalyst must be string");

      assert.ok(Array.isArray(body.keyConcerns) && body.keyConcerns.length > 0, "Key Concerns must be non-empty array");
      assert.ok(body.keyConcerns.every((c) => typeof c === "string" && c.trim().length > 0), "Each concern must be string");

      // Bull and Bear cases
      assert.ok(typeof body.bullCase === "string" && body.bullCase.length > 0, "Bull Case must be non-empty string");
      assert.ok(typeof body.bearCase === "string" && body.bearCase.length > 0, "Bear Case must be non-empty string");

      // Recommendation, Confidence, Reasoning
      assert.ok(["Invest", "Hold", "Avoid"].includes(body.recommendation), `Recommendation must be Invest/Hold/Avoid (was ${body.recommendation})`);
      assert.ok(Number.isInteger(body.confidence) && body.confidence >= 0 && body.confidence <= 100, `Confidence must be integer 0-100 (was ${body.confidence})`);
      assert.ok(typeof body.reasoning === "string" && body.reasoning.length > 0, "Reasoning must be non-empty string");
    }

    // Test B: Apple Live API
    console.log("\nTest B: POST /research {\"company\": \"Apple\"} (Live 4-Stage Groq Pipeline)");
    const startApple = Date.now();
    const resB = await request("/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company: "Apple" })
    });
    const appleDuration = ((Date.now() - startApple) / 1000).toFixed(2);
    console.log(`Apple research took ${appleDuration}s`);
    assert.equal(resB.status, 200);
    validateResearchResponse(resB.body, "Apple");
    console.log("✓ Apple research passed 14-field schema validation:");
    console.log(`  Company: ${resB.body.company}`);
    console.log(`  Industry: ${resB.body.industry}`);
    console.log(`  Recommendation: ${resB.body.recommendation}`);
    console.log(`  Confidence: ${resB.body.confidence}%`);
    console.log(`  Thesis: ${resB.body.investmentThesis.slice(0, 70)}...`);
    console.log(`  Bull Case: ${resB.body.bullCase.slice(0, 70)}...`);
    console.log(`  Bear Case: ${resB.body.bearCase.slice(0, 70)}...`);

    // Test C: Tesla Live API
    console.log("\nTest C: POST /research {\"company\": \"Tesla\"} (Live 4-Stage Groq Pipeline)");
    const startTesla = Date.now();
    const resC = await request("/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company: "Tesla" })
    });
    const teslaDuration = ((Date.now() - startTesla) / 1000).toFixed(2);
    console.log(`Tesla research took ${teslaDuration}s`);
    assert.equal(resC.status, 200);
    validateResearchResponse(resC.body, "Tesla");
    console.log("✓ Tesla research passed 14-field schema validation:");
    console.log(`  Company: ${resC.body.company}`);
    console.log(`  Industry: ${resC.body.industry}`);
    console.log(`  Recommendation: ${resC.body.recommendation}`);
    console.log(`  Confidence: ${resC.body.confidence}%`);

    // Test D: Nokia Live API
    console.log("\nTest D: POST /research {\"company\": \"Nokia\"} (Live 4-Stage Groq Pipeline)");
    const startNokia = Date.now();
    const resD = await request("/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company: "Nokia" })
    });
    const nokiaDuration = ((Date.now() - startNokia) / 1000).toFixed(2);
    console.log(`Nokia research took ${nokiaDuration}s`);
    if (resD.status !== 200) {
      console.error("Nokia response failed:", resD.status, resD.body);
    }
    assert.equal(resD.status, 200);
    validateResearchResponse(resD.body, "Nokia");
    console.log("✓ Nokia research passed 14-field schema validation:");
    console.log(`  Company: ${resD.body.company}`);
    console.log(`  Industry: ${resD.body.industry}`);
    console.log(`  Recommendation: ${resD.body.recommendation}`);
    console.log(`  Confidence: ${resD.body.confidence}%`);

    // Test K: GET /financial-data/:ticker Verification Endpoint
    console.log("\nTest K: GET /financial-data/AAPL");
    const resK = await request("/financial-data/AAPL");
    if (!env.alphaVantageApiKey) {
      assert.equal(resK.status, 500);
      console.log("✓ GET /financial-data/AAPL handled unconfigured API key gracefully");
    } else {
      assert.ok(resK.status === 200 || resK.status === 429 || resK.status === 502);
      if (resK.status === 200) {
        assert.equal(resK.body.status, "OK");
        assert.equal(resK.body.data.company.ticker, "AAPL");
        console.log("✓ GET /financial-data/AAPL returned valid normalized data");
      } else {
        console.log(`✓ GET /financial-data/AAPL returned error status ${resK.status} (likely rate limit/transient)`);
      }
    }

  } finally {
    server.close();
  }

  console.log("\nALL TESTS PASSED SUCCESSFULLY!");
}

async function runFinancialTests() {
  console.log("=== RUNNING FINANCIAL DATA LAYER TESTS ===");

  // 1. Ticker Resolution
  console.log("Testing resolveCompanyToTicker...");
  assert.equal(resolveCompanyToTicker("Apple"), "AAPL");
  assert.equal(resolveCompanyToTicker("Apple Inc."), "AAPL");
  assert.equal(resolveCompanyToTicker("tesla corp"), "TSLA");
  assert.equal(resolveCompanyToTicker("nokia"), "NOK");
  assert.equal(resolveCompanyToTicker("AAPL"), "AAPL");
  assert.equal(resolveCompanyToTicker("tsla"), "TSLA");

  assert.throws(() => resolveCompanyToTicker(""), (err) => err instanceof AppError && err.statusCode === 400);
  assert.throws(() => resolveCompanyToTicker("   "), (err) => err instanceof AppError && err.statusCode === 400);
  assert.throws(() => resolveCompanyToTicker("Unknown Company Name Go Here"), (err) => err instanceof AppError && err.statusCode === 400);
  console.log("✓ resolveCompanyToTicker passed");

  // Mock standard Alpha Vantage payloads
  const mockOverview = {
    Symbol: "AAPL",
    Name: "Apple Inc",
    Exchange: "NASDAQ",
    Currency: "USD",
    MarketCapitalization: "2730000000000",
    EPS: "6.13"
  };

  const mockQuote = {
    "Global Quote": {
      "05. price": "175.84"
    }
  };

  const mockIncome = {
    annualReports: [
      {
        fiscalDateEnding: "2023-09-30",
        totalRevenue: "383285000000",
        netIncome: "96995000000"
      }
    ]
  };

  const mockBalance = {
    annualReports: [
      {
        totalAssets: "352581000000",
        totalLiabilities: "290437000000",
        cashAndCashEquivalentsAtCarryingValue: "29965000000"
      }
    ]
  };

  // Helper to mock global fetch
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;

  const setupMockFetch = (mockBehavior) => {
    fetchCallCount = 0;
    globalThis.fetch = async (url, options) => {
      fetchCallCount++;
      return mockBehavior(url, options);
    };
  };

  const restoreFetch = () => {
    globalThis.fetch = originalFetch;
  };

  // 2. Normal Response Validation
  console.log("Testing standard Alpha Vantage response normalization...");
  setupMockFetch((url) => {
    if (url.includes("function=OVERVIEW")) return { ok: true, json: async () => mockOverview };
    if (url.includes("function=GLOBAL_QUOTE")) return { ok: true, json: async () => mockQuote };
    if (url.includes("function=INCOME_STATEMENT")) return { ok: true, json: async () => mockIncome };
    if (url.includes("function=BALANCE_SHEET")) return { ok: true, json: async () => mockBalance };
    return { ok: false, status: 404 };
  });

  clearFinancialCache();
  const data = await getFinancialData("AAPL");
  assert.equal(data.company.name, "Apple Inc");
  assert.equal(data.company.ticker, "AAPL");
  assert.equal(data.company.exchange, "NASDAQ");
  assert.equal(data.company.currency, "USD");
  assert.equal(data.market.price, 175.84);
  assert.equal(data.market.marketCap, 2730000000000);
  assert.equal(data.financials.revenue, 383285000000);
  assert.equal(data.financials.netIncome, 96995000000);
  assert.equal(data.financials.eps, 6.13);
  assert.equal(data.financials.totalAssets, 352581000000);
  assert.equal(data.financials.totalLiabilities, 290437000000);
  assert.equal(data.financials.cashAndEquivalents, 29965000000);
  assert.equal(data.periods.fiscalDate, "2023-09-30");
  assert.equal(data.periods.periodType, "Annual");
  assert.equal(data.metadata.source, "Alpha Vantage");
  assert.ok(data.metadata.retrievedAt);
  assert.equal(fetchCallCount, 4, "Should have triggered 4 fetches (parallel requests)");
  console.log("✓ Normal response normalization passed");

  // 3. Cache hits and misses
  console.log("Testing cache hit behavior...");
  fetchCallCount = 0;
  const data2 = await getFinancialData("AAPL");
  assert.deepEqual(data2, data);
  assert.equal(fetchCallCount, 0, "Should have returned cached data without fetching API");
  console.log("✓ Cache hit passed");

  // Cache expiry
  console.log("Testing cache expiry behavior...");
  clearFinancialCache();
  await getFinancialData("AAPL", { ttl: -1000 }); // expired instantly
  fetchCallCount = 0;
  const data3 = await getFinancialData("AAPL"); // will be missed because ttl was negative
  assert.equal(fetchCallCount, 4, "Should have refetched after cache expired");
  console.log("✓ Cache expiry passed");

  // 4. Missing fields mapped to null
  console.log("Testing missing fields mapped to null...");
  setupMockFetch((url) => {
    if (url.includes("function=OVERVIEW")) return { ok: true, json: async () => ({ Symbol: "AAPL" }) };
    if (url.includes("function=GLOBAL_QUOTE")) return { ok: true, json: async () => ({}) };
    if (url.includes("function=INCOME_STATEMENT")) return { ok: true, json: async () => ({}) };
    if (url.includes("function=BALANCE_SHEET")) return { ok: true, json: async () => ({}) };
    return { ok: false, status: 404 };
  });

  clearFinancialCache();
  const sparseData = await getFinancialData("AAPL");
  assert.equal(sparseData.company.name, null);
  assert.equal(sparseData.market.price, null);
  assert.equal(sparseData.financials.revenue, null);
  assert.equal(sparseData.financials.cashAndEquivalents, null);
  console.log("✓ Missing fields mapped to null passed");

  // 5. Invalid numeric values parsed to null
  console.log("Testing invalid numeric values mapped to null...");
  setupMockFetch((url) => {
    if (url.includes("function=OVERVIEW")) return { ok: true, json: async () => ({ Symbol: "AAPL", EPS: "None", MarketCapitalization: "null" }) };
    if (url.includes("function=GLOBAL_QUOTE")) return { ok: true, json: async () => ({ "Global Quote": { "05. price": "invalid" } }) };
    if (url.includes("function=INCOME_STATEMENT")) return { ok: true, json: async () => ({}) };
    if (url.includes("function=BALANCE_SHEET")) return { ok: true, json: async () => ({}) };
    return { ok: false, status: 404 };
  });

  clearFinancialCache();
  const invalidData = await getFinancialData("AAPL");
  assert.equal(invalidData.financials.eps, null);
  assert.equal(invalidData.market.price, null);
  assert.equal(invalidData.market.marketCap, null);
  console.log("✓ Invalid numeric values mapped to null passed");

  // 6. Rate Limit error handling
  console.log("Testing Alpha Vantage rate limit (Note / Information) handling...");
  setupMockFetch(() => {
    return {
      ok: true,
      json: async () => ({
        Note: "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day..."
      })
    };
  });

  clearFinancialCache();
  await assert.rejects(
    () => getFinancialData("AAPL"),
    (err) => err instanceof AppError && err.statusCode === 429
  );
  console.log("✓ Rate limit response handled successfully");

  // 7. Auth/Invalid parameter handling
  console.log("Testing Alpha Vantage Error Message handling...");
  setupMockFetch(() => {
    return {
      ok: true,
      json: async () => ({
        "Error Message": "the parameter apikey is invalid or missing."
      })
    };
  });

  clearFinancialCache();
  await assert.rejects(
    () => getFinancialData("AAPL"),
    (err) => err instanceof AppError && err.statusCode === 400
  );
  console.log("✓ Authentication/Invalid request error handled successfully");

  // 8. Timeout handling
  console.log("Testing Alpha Vantage timeout error handling...");
  setupMockFetch(() => {
    const err = new DOMException("The operation was aborted.", "AbortError");
    throw err;
  });

  clearFinancialCache();
  await assert.rejects(
    () => getFinancialData("AAPL"),
    (err) => err instanceof AppError && err.statusCode === 504
  );
  console.log("✓ Timeout error handled successfully");

  // 9. Transient retry behavior
  console.log("Testing Alpha Vantage transient retry behavior...");
  let requestAttempts = 0;
  setupMockFetch((url) => {
    requestAttempts++;
    if (requestAttempts === 1) {
      return { ok: false, status: 500 };
    }
    return { ok: true, json: async () => mockOverview };
  });

  requestAttempts = 0;
  clearFinancialCache();
  const testData = await getFinancialData("AAPL", { ttl: 3600000 });
  assert.equal(testData.company.ticker, "AAPL");
  assert.ok(requestAttempts > 4, "Should have retried the failed request");
  console.log("✓ Transient retry behavior passed");

  // 10. URL Censoring / Key Redaction
  console.log("Testing error message key redaction...");
  setupMockFetch((url) => {
    throw new Error(`Failed to request ${url}`);
  });

  clearFinancialCache();
  try {
    await getFinancialData("AAPL");
    assert.fail("Should have failed");
  } catch (err) {
    assert.ok(!err.message.includes(env.alphaVantageApiKey), "Error message should not leak the API Key");
    assert.ok(err.message.includes("[REDACTED]"), "Error message should censor the API Key");
  }
  console.log("✓ URL key redaction passed");

  restoreFetch();
  console.log("ALL FINANCIAL DATA TESTS PASSED SUCCESSFULLY!\n");
}

async function main() {
  await runUnitTests();
  await runFinancialTests();
  await runIntegrationTests();
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});

