import assert from "node:assert/strict";
import http from "node:http";
import app from "./src/app.js";
import { env } from "./src/config/env.js";
import { isRetryableError, executeWithRetry, formatGroqError, workflowStorage, setGroqClient, resetGroqClient } from "./src/services/groqService.js";
import {
  parseConfidence,
  parseStringArray,
  parseFundamentalAssessment,
  WORKFLOW_TIMEOUT_MS,
  researchNode,
  fundamentalNode,
  thesisNode,
  recommendationNode,
  runInvestmentResearchWorkflow
} from "./src/langgraph/investmentResearchGraph.js";
import { validateResearchRequest } from "./src/middleware/validateResearchRequest.js";
import { extractFirstJsonObject } from "./src/utils/json.js";
import { AppError } from "./src/utils/appError.js";
import { errorHandler } from "./src/middleware/errorHandler.js";
import {
  resolveCompanyToTicker,
  getFinancialData,
  clearFinancialCache,
  getFinancialCacheSize,
  hasFinancialCacheEntry,
  MAX_FINANCIAL_CACHE_ENTRIES
} from "./src/services/financialDataService.js";
import { calculateFinancialMetrics } from "./src/services/financialMetricsService.js";

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

  // 9. Error handler secret redaction
  console.log("Testing errorHandler secret redaction...");
  function captureErrorResponse(err) {
    let payload = null;
    let statusCode = null;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        payload = body;
        return this;
      }
    };
    errorHandler(err, {}, res, () => {});
    return { statusCode, payload };
  }

  const leaked = captureErrorResponse(
    new AppError(`boom gsk_secretkey1234567890abcdef apikey=supersecretkey`, 502)
  );
  assert.equal(leaked.statusCode, 502);
  assert.ok(!leaked.payload.message.includes("gsk_secretkey1234567890abcdef"));
  assert.ok(!leaked.payload.message.includes("supersecretkey"));
  assert.ok(leaked.payload.message.includes("[REDACTED]"));

  if (env.groqApiKey) {
    const groqLeak = captureErrorResponse(new AppError(`failed ${env.groqApiKey}`, 502));
    assert.ok(!groqLeak.payload.message.includes(env.groqApiKey));
  }
  const originalFmpApiKey = env.fmpApiKey;
  const fmpApiKeyForTest = originalFmpApiKey || "test-fmp-api-key";
  env.fmpApiKey = fmpApiKeyForTest;
  const fmpLeak = captureErrorResponse(new AppError(`failed ${fmpApiKeyForTest}`, 502));
  assert.ok(!fmpLeak.payload.message.includes(fmpApiKeyForTest));
  env.fmpApiKey = originalFmpApiKey;
  console.log("✓ errorHandler secret redaction passed");

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

    // Test K: at most one live FMP request (quota-sensitive)
    console.log("\nTest K: GET /financial-data/AAPL (live, single request)");
    const resK = await request("/financial-data/AAPL");
    if (!env.fmpApiKey) {
      assert.equal(resK.status, 500);
      console.log("✓ GET /financial-data/AAPL handled unconfigured API key gracefully");
    } else {
      assert.ok(
        resK.status === 200 || resK.status === 429 || resK.status === 502 || resK.status === 504,
        `Unexpected live financial status: ${resK.status}`
      );
      if (resK.status === 200) {
        assert.equal(resK.body.status, "OK");
        assert.equal(resK.body.data.company.ticker, "AAPL");
        assert.equal(resK.body.data.metadata.source, "Financial Modeling Prep");
        assert.ok(resK.body.data.financials);
        console.log("✓ GET /financial-data/AAPL returned valid normalized data");
      } else {
        assert.equal(resK.body.status, "ERROR");
        console.log(`✓ GET /financial-data/AAPL returned controlled error status ${resK.status}`);
      }
    }

  } finally {
    server.close();
  }

  console.log("\nALL TESTS PASSED SUCCESSFULLY!");
}

async function runFinancialTests() {
  console.log("=== RUNNING MOCKED FINANCIAL DATA TESTS ===");
  const originalFmpApiKey = env.fmpApiKey;
  env.fmpApiKey = "test-fmp-api-key";

  console.log("Testing resolveCompanyToTicker...");
  assert.equal(resolveCompanyToTicker("Apple"), "AAPL");
  assert.equal(resolveCompanyToTicker("apple"), "AAPL");
  assert.equal(resolveCompanyToTicker("Apple Inc."), "AAPL");
  assert.equal(resolveCompanyToTicker("Tesla"), "TSLA");
  assert.equal(resolveCompanyToTicker("tesla corp"), "TSLA");
  assert.equal(resolveCompanyToTicker("Nokia"), "NOK");
  assert.equal(resolveCompanyToTicker("nokia"), "NOK");
  assert.equal(resolveCompanyToTicker("AAPL"), "AAPL");
  assert.equal(resolveCompanyToTicker("aapl"), "AAPL");
  assert.equal(resolveCompanyToTicker("tsla"), "TSLA");
  assert.equal(resolveCompanyToTicker("BRK.B"), "BRK.B");
  assert.equal(resolveCompanyToTicker("brk-b"), "BRK.B");

  assert.throws(() => resolveCompanyToTicker(""), (err) => err instanceof AppError && err.statusCode === 400);
  assert.throws(() => resolveCompanyToTicker("   "), (err) => err instanceof AppError && err.statusCode === 400);
  assert.throws(
    () => resolveCompanyToTicker("Unknown Company Name Go Here"),
    (err) => err instanceof AppError && err.statusCode === 400
  );
  console.log("✓ resolveCompanyToTicker passed");

  const mockProfile = [{
    symbol: "AAPL",
    companyName: "Apple Inc",
    exchangeShortName: "NASDAQ",
    currency: "USD",
    mktCap: "2730000000000"
  }];
  const mockQuote = [{ price: "175.84", eps: "6.13" }];
  const mockIncome = [{ date: "2023-09-30", revenue: "383285000000", netIncome: "96995000000" }];
  const mockBalance = [{
    totalAssets: "352581000000",
    totalLiabilities: "290437000000",
    cashAndCashEquivalents: "29965000000"
  }];

  // Helper to mock global fetch
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;

  const setupMockFetch = (mockBehavior) => {
    fetchCallCount = 0;
    globalThis.fetch = async (url, options) => {
      const target = String(url);
      if (!target.includes("financialmodelingprep.com")) {
        return originalFetch(url, options);
      }
      fetchCallCount += 1;
      return mockBehavior(url, options);
    };
  };

  const restoreFetch = () => {
    globalThis.fetch = originalFetch;
  };

  const mockStandardFmpResponse = (url) => {
    const target = String(url);
    if (target.includes("/profile?")) return { ok: true, json: async () => mockProfile };
    if (target.includes("/quote?")) return { ok: true, json: async () => mockQuote };
    if (target.includes("/income-statement?")) return { ok: true, json: async () => mockIncome };
    if (target.includes("/balance-sheet-statement?")) return { ok: true, json: async () => mockBalance };
    return { ok: false, status: 404 };
  };

  // 2. Normal Response Validation
  console.log("Testing standard FMP response normalization...");
  setupMockFetch(mockStandardFmpResponse);

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
  assert.equal(data.metadata.source, "Financial Modeling Prep");
  assert.ok(data.metadata.retrievedAt);
  assert.equal(fetchCallCount, 4, "Should have triggered 4 provider fetches");
  console.log("✓ Normal response normalization passed");

  // 3. Cache hits and misses
  console.log("Testing cache hit behavior...");
  fetchCallCount = 0;
  const data2 = await getFinancialData("AAPL");
  assert.deepEqual(data2, data);
  assert.equal(fetchCallCount, 0, "Should have returned cached data without fetching API");
  console.log("✓ Cache hit passed");

  console.log("Testing simultaneous financial data requests are deduplicated...");
  clearFinancialCache();
  setupMockFetch(mockStandardFmpResponse);
  const [concurrentData1, concurrentData2] = await Promise.all([
    getFinancialData("AAPL"),
    getFinancialData("AAPL")
  ]);
  assert.equal(fetchCallCount, 4, "Simultaneous requests should make one provider data fetch");
  assert.strictEqual(concurrentData1, concurrentData2);
  console.log("✓ Simultaneous financial data requests are deduplicated");

  // Cache expiry
  console.log("Testing cache expiry behavior...");
  clearFinancialCache();
  await getFinancialData("AAPL", { ttl: -1000 }); // expired instantly
  fetchCallCount = 0;
  const data3 = await getFinancialData("AAPL"); // will be missed because ttl was negative
  assert.equal(fetchCallCount, 4, "Should have refetched after cache expired");
  console.log("✓ Cache expiry passed");

  console.log("Testing numeric zero is preserved (not converted from missing)...");
  setupMockFetch((url) => {
    const target = String(url);
    if (target.includes("/profile?")) {
      return {
        ok: true,
        json: async () => [{ ...mockProfile[0], mktCap: "0" }]
      };
    }
    if (target.includes("/quote?")) {
      return { ok: true, json: async () => [{ price: "0", eps: "0" }] };
    }
    if (target.includes("/income-statement?")) {
      return {
        ok: true,
        json: async () => [{ date: "2023-09-30", revenue: "0", netIncome: "0" }]
      };
    }
    if (target.includes("/balance-sheet-statement?")) {
      return { ok: true, json: async () => mockBalance };
    }
    return { ok: false, status: 404 };
  });
  clearFinancialCache();
  const zeroData = await getFinancialData("AAPL");
  assert.equal(zeroData.market.price, 0);
  assert.equal(zeroData.market.marketCap, 0);
  assert.equal(zeroData.financials.eps, 0);
  assert.equal(zeroData.financials.revenue, 0);
  assert.equal(zeroData.financials.netIncome, 0);
  console.log("✓ Zero values preserved passed");

  // 4. Missing fields mapped to null
  console.log("Testing missing fields mapped to null...");
  setupMockFetch((url) => {
    const target = String(url);
    if (target.includes("/profile?")) return { ok: true, json: async () => [{ symbol: "AAPL" }] };
    if (target.includes("/quote?")) return { ok: true, json: async () => [] };
    if (target.includes("/income-statement?")) return { ok: true, json: async () => [] };
    if (target.includes("/balance-sheet-statement?")) return { ok: true, json: async () => [] };
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
    const target = String(url);
    if (target.includes("/profile?")) return { ok: true, json: async () => [{ symbol: "AAPL", mktCap: "null" }] };
    if (target.includes("/quote?")) return { ok: true, json: async () => [{ price: "invalid", eps: "None" }] };
    if (target.includes("/income-statement?")) return { ok: true, json: async () => [] };
    if (target.includes("/balance-sheet-statement?")) return { ok: true, json: async () => [] };
    return { ok: false, status: 404 };
  });

  clearFinancialCache();
  const invalidData = await getFinancialData("AAPL");
  assert.equal(invalidData.financials.eps, null);
  assert.equal(invalidData.market.price, null);
  assert.equal(invalidData.market.marketCap, null);
  console.log("✓ Invalid numeric values mapped to null passed");

  console.log("Testing HTTP 429 fail-fast (no retry)...");
  setupMockFetch(() => ({ ok: false, status: 429, json: async () => ({}) }));
  clearFinancialCache();
  await assert.rejects(
    () => getFinancialData("AAPL"),
    (err) =>
      err instanceof AppError &&
      err.statusCode === 429 &&
      err.message === "Financial data provider rate limit reached. Please try again later."
  );
  assert.equal(fetchCallCount, 1, "Rate-limit HTTP 429 must not be retried");
  assert.equal(hasFinancialCacheEntry("AAPL"), false);
  console.log("✓ HTTP 429 fail-fast passed");

  console.log("Testing HTTP 500 retry then 502...");
  setupMockFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
  clearFinancialCache();
  await assert.rejects(
    () => getFinancialData("AAPL"),
    (err) => err instanceof AppError && err.statusCode === 502
  );
  assert.equal(fetchCallCount, 3, "HTTP 500 should retry up to 3 total attempts");
  console.log("✓ HTTP 500 retry then 502 passed");

  console.log("Testing HTTP 502 retry then 502...");
  setupMockFetch(() => ({ ok: false, status: 502, json: async () => ({}) }));
  clearFinancialCache();
  await assert.rejects(
    () => getFinancialData("AAPL"),
    (err) => err instanceof AppError && err.statusCode === 502
  );
  assert.equal(fetchCallCount, 3, "HTTP 502 should retry up to 3 total attempts");
  console.log("✓ HTTP 502 retry passed");

  console.log("Testing timeout error handling...");
  setupMockFetch(() => {
    const err = new DOMException("The operation was aborted.", "AbortError");
    throw err;
  });
  clearFinancialCache();
  await assert.rejects(
    () => getFinancialData("AAPL"),
    (err) => err instanceof AppError && err.statusCode === 504
  );
  assert.equal(fetchCallCount, 3, "Timeouts should use bounded retries");
  console.log("✓ Timeout error handling passed");

  console.log("Testing network error handling...");
  setupMockFetch(() => {
    const err = new Error("socket hang up");
    err.code = "ECONNRESET";
    throw err;
  });
  clearFinancialCache();
  await assert.rejects(
    () => getFinancialData("AAPL"),
    (err) => err instanceof AppError && err.statusCode === 502
  );
  assert.equal(fetchCallCount, 3, "Network errors should use bounded retries");
  console.log("✓ Network error handling passed");

  console.log("Testing transient retry then success...");
  let requestAttempts = 0;
  setupMockFetch((url) => {
    requestAttempts += 1;
    if (requestAttempts === 1) {
      return { ok: false, status: 500 };
    }
    return mockStandardFmpResponse(url);
  });
  clearFinancialCache();
  const testData = await getFinancialData("AAPL", { ttl: 3600000 });
  assert.equal(testData.company.ticker, "AAPL");
  assert.ok(requestAttempts > 4, "Should have retried the failed overview request");
  console.log("✓ Transient retry then success passed");

  console.log("Testing empty/invalid profile is 404 and is not cached...");
  setupMockFetch(() => ({ ok: true, json: async () => [] }));
  clearFinancialCache();
  await assert.rejects(
    () => getFinancialData("AAPL"),
    (err) => err instanceof AppError && err.statusCode === 404
  );
  assert.equal(hasFinancialCacheEntry("AAPL"), false);
  assert.equal(getFinancialCacheSize(), 0);
  console.log("✓ Empty profile 404 / no-cache passed");

  console.log("Testing invalid profile is 404 and is not cached...");
  setupMockFetch(() => ({ ok: true, json: async () => [{}] }));
  clearFinancialCache();
  await assert.rejects(
    () => getFinancialData("AAPL"),
    (err) => err instanceof AppError && err.statusCode === 404
  );
  assert.equal(hasFinancialCacheEntry("AAPL"), false);
  assert.equal(getFinancialCacheSize(), 0);
  console.log("✓ Invalid profile 404 / no-cache passed");

  console.log("Testing bounded cache eviction...");
  setupMockFetch((url) => {
    const target = String(url);
    const symbolMatch = target.match(/symbol=([^&]+)/i);
    const symbol = symbolMatch ? decodeURIComponent(symbolMatch[1]) : "X";
    if (target.includes("/profile?")) {
      return { ok: true, json: async () => [{ symbol, companyName: `${symbol} Corp` }] };
    }
    return { ok: true, json: async () => [] };
  });
  clearFinancialCache();
  for (let i = 0; i <= MAX_FINANCIAL_CACHE_ENTRIES; i += 1) {
    await getFinancialData(`T${i}`);
  }
  assert.equal(getFinancialCacheSize(), MAX_FINANCIAL_CACHE_ENTRIES);
  assert.equal(hasFinancialCacheEntry("T0"), false, "Oldest cache entry should be evicted");
  console.log("✓ Bounded cache eviction passed");

  console.log("Testing error message key redaction...");
  setupMockFetch((url) => {
    throw new Error(`Failed to request ${url}`);
  });
  clearFinancialCache();
  try {
    await getFinancialData("AAPL");
    assert.fail("Should have failed");
  } catch (err) {
    assert.ok(!err.message.includes(env.fmpApiKey), "Error message should not leak the API Key");
    assert.ok(!/apikey=(?!\[REDACTED\])[^\s&]+/i.test(err.message), "apikey query values must be redacted");
    assert.ok(err.message.includes("[REDACTED]"), "Error message should censor the API Key");
  }
  console.log("✓ URL key redaction passed");

  console.log("Testing mocked GET /financial-data/:ticker HTTP contract...");
  setupMockFetch(mockStandardFmpResponse);
  clearFinancialCache();
  const financialServer = http.createServer(app);
  await new Promise((resolve) => financialServer.listen(0, resolve));
  const financialPort = financialServer.address().port;
  try {
    const appleRes = await fetch(`http://localhost:${financialPort}/financial-data/apple`);
    const appleBody = await appleRes.json();
    assert.equal(appleRes.status, 200);
    assert.equal(appleBody.status, "OK");
    assert.equal(appleBody.data.company.ticker, "AAPL");

    const aaplRes = await fetch(`http://localhost:${financialPort}/financial-data/AAPL`);
    const aaplBody = await aaplRes.json();
    assert.equal(aaplRes.status, 200);
    assert.equal(aaplBody.data.company.ticker, "AAPL");

    const badRes = await fetch(`http://localhost:${financialPort}/financial-data/NotARealCompanyName`);
    const badBody = await badRes.json();
    assert.equal(badRes.status, 400);
    assert.equal(badBody.status, "ERROR");
  } finally {
    await new Promise((resolve) => financialServer.close(resolve));
  }
  console.log("✓ Mocked financial HTTP contract passed");

  restoreFetch();
  env.fmpApiKey = originalFmpApiKey;
  console.log("ALL MOCKED FINANCIAL DATA TESTS PASSED SUCCESSFULLY!\n");
}

async function runNodeUnitTests() {
  console.log("=== RUNNING DETERMINISTIC LANGGRAPH NODE TESTS ===");

  // Helper: build a mock Groq client that returns the given payload, tracks calls, and captures the last prompt.
  function createMockGroqClient(payload) {
    let callCount = 0;
    let lastPrompt = "";
    const client = {
      chat: {
        completions: {
          create: async (params) => {
            callCount += 1;
            lastPrompt = params.messages[0].content;
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify(payload)
                  }
                }
              ]
            };
          }
        }
      }
    };
    return { client, getCallCount: () => callCount, getLastPrompt: () => lastPrompt };
  }

  // Shared deterministic financialData used in node tests 2, 3, and 4.
  const sharedMockFinancialData = {
    company: {
      name: "Apple Inc.",
      ticker: "AAPL",
      exchange: "NASDAQ",
      currency: "USD"
    },
    market: {
      price: 200,
      marketCap: 3000000000000
    },
    financials: {
      revenue: 400000000000,
      netIncome: 100000000000,
      eps: 7.5,
      totalAssets: 350000000000,
      totalLiabilities: 280000000000,
      cashAndEquivalents: 30000000000
    },
    periods: {
      fiscalDate: "2025-09-27",
      periodType: "Annual"
    },
    metadata: {
      source: "Financial Modeling Prep",
      retrievedAt: "2026-01-01T00:00:00.000Z"
    }
  };

  // --- Test 1: researchNode ---
  console.log("Test 1: researchNode with mocked Groq...");
  {
    const mockPayload = {
      overview: "Apple Inc. designs and manufactures consumer electronics, software, and services.",
      industry: "Consumer Electronics",
      strengths: ["Brand equity", "Ecosystem lock-in", "High operating margins"],
      risks: ["Supply chain concentration", "Regulatory scrutiny", "Market saturation"]
    };
    const { client, getCallCount } = createMockGroqClient(mockPayload);
    setGroqClient(client);
    try {
      const result = await researchNode({ company: "Apple" });

      assert.equal(result.overview, mockPayload.overview, "overview must match mock");
      assert.equal(result.industry, mockPayload.industry, "industry must match mock");
      assert.ok(Array.isArray(result.strengths), "strengths must be an array");
      assert.equal(result.strengths.length, 3, "strengths must have 3 items");
      assert.deepEqual(result.strengths, mockPayload.strengths, "strengths values must match mock");
      assert.ok(Array.isArray(result.risks), "risks must be an array");
      assert.equal(result.risks.length, 3, "risks must have 3 items");
      assert.deepEqual(result.risks, mockPayload.risks, "risks values must match mock");
      assert.equal(getCallCount(), 1, "Mock Groq client must have been called exactly once");
      console.log("✓ researchNode passed");
    } finally {
      resetGroqClient();
    }
  }

  // --- Test 2: fundamentalNode ---
  console.log("Test 2: fundamentalNode with mocked Groq...");
  {
    const mockPayload = {
      fundamentalAssessment: {
        businessQuality: "High-quality business model with durable pricing power.",
        competitiveAdvantage: "Strong economic moat driven by ecosystem switching costs.",
        financialHealth: "Solid balance sheet with disciplined capital allocation."
      },
      keyCatalysts: ["Services revenue growth", "Wearables expansion"],
      keyConcerns: ["Smartphone market saturation", "Antitrust enforcement"]
    };
    const { client, getCallCount, getLastPrompt } = createMockGroqClient(mockPayload);
    setGroqClient(client);
    try {
      const inputState = {
        company: "Apple",
        overview: "Apple Inc. designs and manufactures consumer electronics, software, and services.",
        industry: "Consumer Electronics",
        strengths: ["Brand equity", "Ecosystem lock-in", "High operating margins"],
        risks: ["Supply chain concentration", "Regulatory scrutiny", "Market saturation"],
        financialData: sharedMockFinancialData,
        financialMetrics: { peRatio: 28.5, netProfitMargin: 0.25 }
      };
      const result = await fundamentalNode(inputState);

      // Verify prompt forwarded financialData correctly.
      const capturedPrompt = getLastPrompt();
      assert.ok(capturedPrompt.includes("VERIFIED FINANCIAL CONTEXT"), "fundamentalNode prompt must contain VERIFIED FINANCIAL CONTEXT");
      assert.ok(capturedPrompt.includes("AAPL"), "fundamentalNode prompt must contain AAPL");
      assert.ok(capturedPrompt.includes("200"), "fundamentalNode prompt must contain price 200");
      assert.ok(capturedPrompt.includes("400000000000"), "fundamentalNode prompt must contain revenue 400000000000");

      assert.ok(capturedPrompt.includes("VERIFIED DERIVED FINANCIAL METRICS"), "fundamentalNode prompt must contain VERIFIED DERIVED FINANCIAL METRICS");
      assert.ok(capturedPrompt.includes("peRatio"), "fundamentalNode prompt must contain peRatio");
      assert.ok(capturedPrompt.includes("netProfitMargin"), "fundamentalNode prompt must contain netProfitMargin");
      assert.ok(capturedPrompt.includes("NO FUTURE QUANTITATIVE CLAIMS"), "fundamentalNode prompt must contain NO FUTURE QUANTITATIVE CLAIMS");

      assert.ok(result.fundamentalAssessment !== null && typeof result.fundamentalAssessment === "object", "fundamentalAssessment must be an object");
      assert.equal(result.fundamentalAssessment.businessQuality, mockPayload.fundamentalAssessment.businessQuality, "businessQuality must match mock");
      assert.equal(result.fundamentalAssessment.competitiveAdvantage, mockPayload.fundamentalAssessment.competitiveAdvantage, "competitiveAdvantage must match mock");
      assert.equal(result.fundamentalAssessment.financialHealth, mockPayload.fundamentalAssessment.financialHealth, "financialHealth must match mock");
      assert.ok(Array.isArray(result.keyCatalysts), "keyCatalysts must be an array");
      assert.equal(result.keyCatalysts.length, 2, "keyCatalysts must have 2 items");
      assert.deepEqual(result.keyCatalysts, mockPayload.keyCatalysts, "keyCatalysts values must match mock");
      assert.ok(Array.isArray(result.keyConcerns), "keyConcerns must be an array");
      assert.equal(result.keyConcerns.length, 2, "keyConcerns must have 2 items");
      assert.deepEqual(result.keyConcerns, mockPayload.keyConcerns, "keyConcerns values must match mock");
      assert.equal(getCallCount(), 1, "Mock Groq client must have been called exactly once");
      console.log("\u2713 fundamentalNode passed");
    } finally {
      resetGroqClient();
    }
  }

  // --- Test 3: thesisNode ---
  console.log("Test 3: thesisNode with mocked Groq...");
  {
    const mockPayload = {
      investmentThesis: "Apple remains a premier technology franchise with expanding high-margin services and a deeply loyal customer base.",
      bullCase: "Services revenue accelerates significantly and hardware upgrade cycles remain strong, driving sustained earnings growth.",
      bearCase: "Regulatory pressure erodes App Store take rates while consumer spending weakness slows hardware replacement cycles."
    };
    const { client, getCallCount, getLastPrompt } = createMockGroqClient(mockPayload);
    setGroqClient(client);
    try {
      const inputState = {
        company: "Apple",
        overview: "Apple Inc. designs and manufactures consumer electronics, software, and services.",
        industry: "Consumer Electronics",
        strengths: ["Brand equity", "Ecosystem lock-in", "High operating margins"],
        risks: ["Supply chain concentration", "Regulatory scrutiny", "Market saturation"],
        fundamentalAssessment: {
          businessQuality: "High-quality business model with durable pricing power.",
          competitiveAdvantage: "Strong economic moat driven by ecosystem switching costs.",
          financialHealth: "Solid balance sheet with disciplined capital allocation."
        },
        keyCatalysts: ["Services revenue growth", "Wearables expansion"],
        keyConcerns: ["Smartphone market saturation", "Antitrust enforcement"],
        financialData: sharedMockFinancialData,
        financialMetrics: { peRatio: 28.5, netProfitMargin: 0.25 }
      };
      const result = await thesisNode(inputState);

      // Verify prompt forwarded financialData correctly.
      const capturedPrompt = getLastPrompt();
      assert.ok(capturedPrompt.includes("VERIFIED FINANCIAL CONTEXT"), "thesisNode prompt must contain VERIFIED FINANCIAL CONTEXT");
      assert.ok(capturedPrompt.includes("AAPL"), "thesisNode prompt must contain AAPL");
      assert.ok(capturedPrompt.includes("200"), "thesisNode prompt must contain price 200");
      assert.ok(capturedPrompt.includes("400000000000"), "thesisNode prompt must contain revenue 400000000000");

      assert.ok(capturedPrompt.includes("VERIFIED DERIVED FINANCIAL METRICS"), "thesisNode prompt must contain VERIFIED DERIVED FINANCIAL METRICS");
      assert.ok(capturedPrompt.includes("peRatio"), "thesisNode prompt must contain peRatio");
      assert.ok(capturedPrompt.includes("netProfitMargin"), "thesisNode prompt must contain netProfitMargin");
      assert.ok(capturedPrompt.includes("NO FUTURE QUANTITATIVE CLAIMS"), "thesisNode prompt must contain NO FUTURE QUANTITATIVE CLAIMS");

      assert.equal(result.investmentThesis, mockPayload.investmentThesis, "investmentThesis must match mock");
      assert.equal(result.bullCase, mockPayload.bullCase, "bullCase must match mock");
      assert.equal(result.bearCase, mockPayload.bearCase, "bearCase must match mock");
      assert.equal(getCallCount(), 1, "Mock Groq client must have been called exactly once");
      console.log("\u2713 thesisNode passed");
    } finally {
      resetGroqClient();
    }
  }

  // --- Test 4: recommendationNode ---
  console.log("Test 4: recommendationNode with mocked Groq...");
  {
    const mockPayload = {
      recommendation: "Invest",
      confidence: 85,
      reasoning: "Strong qualitative moat and services expansion outweigh regulatory concerns, supporting a high-conviction investment case."
    };
    const { client, getCallCount, getLastPrompt } = createMockGroqClient(mockPayload);
    setGroqClient(client);
    try {
      const inputState = {
        company: "Apple",
        overview: "Apple Inc. designs and manufactures consumer electronics, software, and services.",
        industry: "Consumer Electronics",
        strengths: ["Brand equity", "Ecosystem lock-in", "High operating margins"],
        risks: ["Supply chain concentration", "Regulatory scrutiny", "Market saturation"],
        fundamentalAssessment: {
          businessQuality: "High-quality business model with durable pricing power.",
          competitiveAdvantage: "Strong economic moat driven by ecosystem switching costs.",
          financialHealth: "Solid balance sheet with disciplined capital allocation."
        },
        keyCatalysts: ["Services revenue growth", "Wearables expansion"],
        keyConcerns: ["Smartphone market saturation", "Antitrust enforcement"],
        investmentThesis: "Apple remains a premier technology franchise with expanding high-margin services.",
        bullCase: "Services revenue accelerates significantly and hardware upgrade cycles remain strong.",
        bearCase: "Regulatory pressure erodes App Store take rates while consumer spending weakness slows hardware replacement cycles.",
        financialData: sharedMockFinancialData,
        financialMetrics: { peRatio: 28.5, netProfitMargin: 0.25 }
      };
      const result = await recommendationNode(inputState);

      // Verify prompt forwarded financialData correctly.
      const capturedPrompt = getLastPrompt();
      assert.ok(capturedPrompt.includes("VERIFIED FINANCIAL CONTEXT"), "recommendationNode prompt must contain VERIFIED FINANCIAL CONTEXT");
      assert.ok(capturedPrompt.includes("AAPL"), "recommendationNode prompt must contain AAPL");
      assert.ok(capturedPrompt.includes("200"), "recommendationNode prompt must contain price 200");
      assert.ok(capturedPrompt.includes("400000000000"), "recommendationNode prompt must contain revenue 400000000000");

      assert.ok(capturedPrompt.includes("VERIFIED DERIVED FINANCIAL METRICS"), "recommendationNode prompt must contain VERIFIED DERIVED FINANCIAL METRICS");
      assert.ok(capturedPrompt.includes("peRatio"), "recommendationNode prompt must contain peRatio");
      assert.ok(capturedPrompt.includes("netProfitMargin"), "recommendationNode prompt must contain netProfitMargin");
      assert.ok(capturedPrompt.includes("NO FUTURE QUANTITATIVE CLAIMS"), "recommendationNode prompt must contain NO FUTURE QUANTITATIVE CLAIMS");

      assert.equal(result.recommendation, "Invest", "recommendation must be Invest");
      assert.equal(result.confidence, 85, "confidence must be 85");
      assert.ok(typeof result.reasoning === "string" && result.reasoning.length > 0, "reasoning must be non-empty string");
      assert.equal(result.reasoning, mockPayload.reasoning, "reasoning must match mock");
      assert.equal(getCallCount(), 1, "Mock Groq client must have been called exactly once");
      console.log("\u2713 recommendationNode passed");
    } finally {
      resetGroqClient();
    }
  }

  console.log("ALL DETERMINISTIC LANGGRAPH NODE TESTS PASSED!\n");
}

async function runWorkflowMockedTest() {
  console.log("=== RUNNING DETERMINISTIC FULL WORKFLOW TEST ===");

  const mockResponses = {
    research: {
      overview: "Apple is a global technology company focused on consumer devices and services.",
      industry: "Consumer Electronics",
      strengths: ["Brand", "Ecosystem", "Distribution"],
      risks: ["Regulation", "Competition", "Demand cyclicality"]
    },
    fundamental: {
      fundamentalAssessment: {
        businessQuality: "High-quality business with strong recurring ecosystem economics.",
        competitiveAdvantage: "Strong switching costs and ecosystem effects.",
        financialHealth: "Strong balance sheet and cash generation."
      },
      keyCatalysts: ["Services growth", "Product innovation"],
      keyConcerns: ["Regulatory pressure", "Market saturation"]
    },
    thesis: {
      investmentThesis: "Apple combines a durable ecosystem with opportunities for continued services growth.",
      bullCase: "Services growth accelerates while the ecosystem continues expanding.",
      bearCase: "Regulatory pressure and slower hardware demand weaken growth."
    },
    recommendation: {
      recommendation: "Invest",
      confidence: 85,
      reasoning: "The durable moat and strong business quality outweigh the identified risks."
    }
  };

  let callCount = 0;
  const callSequence = [];

  const mockClient = {
    chat: {
      completions: {
        create: async (params) => {
          callCount += 1;
          const prompt = params.messages[0].content;

          let payload;
          if (prompt.includes("qualitative equity research assistant")) {
            callSequence.push("research");
            payload = mockResponses.research;
          } else if (prompt.includes("VERIFIED FINANCIAL CONTEXT") && prompt.includes("Evaluate the business fundamentals")) {
            callSequence.push("fundamental");
            payload = mockResponses.fundamental;
          } else if (prompt.includes("senior investment strategist")) {
            callSequence.push("thesis");
            payload = mockResponses.thesis;
          } else if (prompt.includes("senior investment committee member")) {
            callSequence.push("recommendation");
            payload = mockResponses.recommendation;
          } else {
            throw new Error(`Unexpected prompt in mock: ${prompt.slice(0, 80)}...`);
          }

          return {
            choices: [
              {
                message: {
                  content: JSON.stringify(payload)
                }
              }
            ]
          };
        }
      }
    }
  };

  setGroqClient(mockClient);
  try {
    const mockFinancialData = {
      company: {
        name: "Apple Inc.",
        ticker: "AAPL",
        exchange: "NASDAQ",
        currency: "USD"
      },
      market: {
        price: 200,
        marketCap: 3000000000000
      },
      financials: {
        revenue: 400000000000,
        netIncome: 100000000000,
        eps: 7.5,
        totalAssets: 350000000000,
        totalLiabilities: 280000000000,
        cashAndEquivalents: 30000000000
      },
      periods: {
        fiscalDate: "2025-09-27",
        periodType: "Annual"
      },
      metadata: {
        source: "Financial Modeling Prep",
        retrievedAt: "2026-01-01T00:00:00.000Z"
      }
    };

    const mockFinancialMetrics = { peRatio: 15, netProfitMargin: 0.25 };

    const result = await runInvestmentResearchWorkflow({
      company: "Apple",
      ticker: "AAPL",
      financialData: mockFinancialData,
      financialMetrics: mockFinancialMetrics
    });

    // --- Verify call sequence ---
    assert.equal(callCount, 4, "Mock Groq client must have been called exactly 4 times");
    assert.deepEqual(
      callSequence,
      ["research", "fundamental", "thesis", "recommendation"],
      "Calls must occur in the expected node sequence"
    );

    // --- Verify all top-level fields ---
    assert.equal(result.company, "Apple", "company must be Apple");
    assert.equal(result.ticker, "AAPL", "ticker must be AAPL");
    assert.ok(result.financialData, "financialData exists");
    assert.equal(result.financialData.company.ticker, "AAPL", "financialData.company.ticker must be AAPL");
    assert.equal(result.financialData.market.price, 200, "financialData.market.price must be 200");
    assert.equal(result.financialData.financials.revenue, 400000000000, "financialData.financials.revenue must be 400000000000");

    assert.ok(result.financialMetrics, "financialMetrics exists");
    assert.equal(result.financialMetrics.peRatio, 15, "financialMetrics.peRatio must be 15");
    assert.equal(result.financialMetrics.netProfitMargin, 0.25, "financialMetrics.netProfitMargin must be 0.25");

    assert.equal(result.overview, mockResponses.research.overview, "overview must match mock");
    assert.equal(result.industry, mockResponses.research.industry, "industry must match mock");
    assert.equal(result.investmentThesis, mockResponses.thesis.investmentThesis, "investmentThesis must match mock");

    // fundamentalAssessment
    assert.ok(
      result.fundamentalAssessment !== null && typeof result.fundamentalAssessment === "object",
      "fundamentalAssessment must be an object"
    );
    assert.equal(
      result.fundamentalAssessment.businessQuality,
      mockResponses.fundamental.fundamentalAssessment.businessQuality,
      "businessQuality must match mock"
    );
    assert.equal(
      result.fundamentalAssessment.competitiveAdvantage,
      mockResponses.fundamental.fundamentalAssessment.competitiveAdvantage,
      "competitiveAdvantage must match mock"
    );
    assert.equal(
      result.fundamentalAssessment.financialHealth,
      mockResponses.fundamental.fundamentalAssessment.financialHealth,
      "financialHealth must match mock"
    );

    // Array fields
    assert.ok(Array.isArray(result.strengths), "strengths must be an array");
    assert.deepEqual(result.strengths, mockResponses.research.strengths, "strengths must match mock");
    assert.ok(Array.isArray(result.risks), "risks must be an array");
    assert.deepEqual(result.risks, mockResponses.research.risks, "risks must match mock");
    assert.ok(Array.isArray(result.keyCatalysts), "keyCatalysts must be an array");
    assert.deepEqual(result.keyCatalysts, mockResponses.fundamental.keyCatalysts, "keyCatalysts must match mock");
    assert.ok(Array.isArray(result.keyConcerns), "keyConcerns must be an array");
    assert.deepEqual(result.keyConcerns, mockResponses.fundamental.keyConcerns, "keyConcerns must match mock");

    // Bull/Bear cases
    assert.equal(result.bullCase, mockResponses.thesis.bullCase, "bullCase must match mock");
    assert.equal(result.bearCase, mockResponses.thesis.bearCase, "bearCase must match mock");

    // Recommendation fields
    assert.equal(result.recommendation, "Invest", "recommendation must be Invest");
    assert.equal(result.confidence, 85, "confidence must be 85");
    assert.ok(
      typeof result.reasoning === "string" && result.reasoning.length > 0,
      "reasoning must be non-empty string"
    );
    assert.equal(result.reasoning, mockResponses.recommendation.reasoning, "reasoning must match mock");

    // Verify all strings are non-empty
    const stringFields = [
      "company", "overview", "industry", "investmentThesis",
      "bullCase", "bearCase", "recommendation", "reasoning"
    ];
    for (const field of stringFields) {
      assert.ok(
        typeof result[field] === "string" && result[field].length > 0,
        `${field} must be a non-empty string`
      );
    }

    console.log("\u2713 Full workflow mocked test passed (4 nodes, 14 fields, correct sequence)");
  } finally {
    resetGroqClient();
  }

  console.log("ALL DETERMINISTIC FULL WORKFLOW TESTS PASSED!\n");
}

async function runFinancialMetricsTests() {
  console.log("=== RUNNING DETERMINISTIC FINANCIAL METRICS TESTS ===");

  // --- Test 1: Happy path ---
  console.log("Test 1: Happy path with clean deterministic values...");
  {
    const data = {
      market: { price: 200, marketCap: 3000000000000 },
      financials: {
        revenue: 400000000000,
        netIncome: 100000000000,
        eps: 10,
        totalAssets: 500000000000,
        totalLiabilities: 300000000000,
        cashAndEquivalents: 60000000000
      }
    };
    const m = calculateFinancialMetrics(data);
    assert.equal(m.netProfitMargin, 0.25, "netProfitMargin must be 0.25");
    assert.equal(m.returnOnAssets, 0.2, "returnOnAssets must be 0.2");
    assert.equal(m.liabilityToAssetRatio, 0.6, "liabilityToAssetRatio must be 0.6");
    assert.equal(m.cashToLiabilityRatio, 0.2, "cashToLiabilityRatio must be 0.2");
    assert.equal(m.peRatio, 20, "peRatio must be 20");
    console.log("✓ Happy path passed");
  }

  // --- Test 2: Rounding to 4 decimal places ---
  console.log("Test 2: Rounding to 4 decimal places...");
  {
    const data = {
      market: { price: 173, marketCap: 2700000000000 },
      financials: {
        revenue: 383285000000,
        netIncome: 96995000000,
        eps: 6.13,
        totalAssets: 352581000000,
        totalLiabilities: 290437000000,
        cashAndEquivalents: 29965000000
      }
    };
    const m = calculateFinancialMetrics(data);

    // Verify each is rounded to exactly 4 decimal places
    const assertRounded = (val, label) => {
      assert.notEqual(val, null, `${label} must not be null`);
      const rounded = Math.round(val * 10000) / 10000;
      assert.equal(val, rounded, `${label} must be rounded to 4 decimal places (got ${val})`);
    };
    assertRounded(m.netProfitMargin, "netProfitMargin");
    assertRounded(m.returnOnAssets, "returnOnAssets");
    assertRounded(m.liabilityToAssetRatio, "liabilityToAssetRatio");
    assertRounded(m.cashToLiabilityRatio, "cashToLiabilityRatio");
    assertRounded(m.peRatio, "peRatio");

    // Verify specific expected values
    // netProfitMargin = 96995000000 / 383285000000 ≈ 0.253057... → 0.2531
    assert.equal(m.netProfitMargin, 0.2531, "netProfitMargin rounded value");
    // peRatio = 173 / 6.13 ≈ 28.2218... → 28.2219
    assert.equal(m.peRatio, 28.2219, "peRatio rounded value");
    console.log("✓ Rounding passed");
  }

  // --- Test 3: Missing/null inputs ---
  console.log("Test 3: Missing/null inputs produce null for affected metrics...");
  {
    const baseFinancials = {
      revenue: 400000000000,
      netIncome: 100000000000,
      eps: 10,
      totalAssets: 500000000000,
      totalLiabilities: 300000000000,
      cashAndEquivalents: 60000000000
    };
    const baseMarket = { price: 200, marketCap: 3000000000000 };

    // revenue = null → netProfitMargin null, others still calculable
    const m1 = calculateFinancialMetrics({
      market: baseMarket,
      financials: { ...baseFinancials, revenue: null }
    });
    assert.equal(m1.netProfitMargin, null, "null revenue → null netProfitMargin");
    assert.equal(m1.returnOnAssets, 0.2, "returnOnAssets unaffected by null revenue");
    assert.equal(m1.peRatio, 20, "peRatio unaffected by null revenue");

    // totalAssets = null → returnOnAssets null, liabilityToAssetRatio null
    const m2 = calculateFinancialMetrics({
      market: baseMarket,
      financials: { ...baseFinancials, totalAssets: null }
    });
    assert.equal(m2.returnOnAssets, null, "null totalAssets → null returnOnAssets");
    assert.equal(m2.liabilityToAssetRatio, null, "null totalAssets → null liabilityToAssetRatio");
    assert.equal(m2.netProfitMargin, 0.25, "netProfitMargin unaffected by null totalAssets");
    assert.equal(m2.cashToLiabilityRatio, 0.2, "cashToLiabilityRatio unaffected by null totalAssets");

    // totalLiabilities = null → liabilityToAssetRatio null (numerator), cashToLiabilityRatio null (denominator)
    const m3 = calculateFinancialMetrics({
      market: baseMarket,
      financials: { ...baseFinancials, totalLiabilities: null }
    });
    assert.equal(m3.liabilityToAssetRatio, null, "null totalLiabilities → null liabilityToAssetRatio");
    assert.equal(m3.cashToLiabilityRatio, null, "null totalLiabilities → null cashToLiabilityRatio");
    assert.equal(m3.netProfitMargin, 0.25, "netProfitMargin unaffected by null totalLiabilities");

    // cashAndEquivalents = null → cashToLiabilityRatio null
    const m4 = calculateFinancialMetrics({
      market: baseMarket,
      financials: { ...baseFinancials, cashAndEquivalents: null }
    });
    assert.equal(m4.cashToLiabilityRatio, null, "null cashAndEquivalents → null cashToLiabilityRatio");
    assert.equal(m4.liabilityToAssetRatio, 0.6, "liabilityToAssetRatio unaffected by null cashAndEquivalents");

    // eps = null → peRatio null
    const m5 = calculateFinancialMetrics({
      market: baseMarket,
      financials: { ...baseFinancials, eps: null }
    });
    assert.equal(m5.peRatio, null, "null eps → null peRatio");
    assert.equal(m5.netProfitMargin, 0.25, "netProfitMargin unaffected by null eps");

    // price = null → peRatio null
    const m6 = calculateFinancialMetrics({
      market: { ...baseMarket, price: null },
      financials: baseFinancials
    });
    assert.equal(m6.peRatio, null, "null price → null peRatio");
    assert.equal(m6.netProfitMargin, 0.25, "netProfitMargin unaffected by null price");

    console.log("✓ Missing/null inputs passed");
  }

  // --- Test 4: Undefined inputs ---
  console.log("Test 4: Undefined inputs produce null for affected metrics...");
  {
    // Entirely missing financials and market keys
    const m1 = calculateFinancialMetrics({});
    assert.equal(m1.netProfitMargin, null, "missing financials → null netProfitMargin");
    assert.equal(m1.returnOnAssets, null, "missing financials → null returnOnAssets");
    assert.equal(m1.liabilityToAssetRatio, null, "missing financials → null liabilityToAssetRatio");
    assert.equal(m1.cashToLiabilityRatio, null, "missing financials → null cashToLiabilityRatio");
    assert.equal(m1.peRatio, null, "missing market → null peRatio");

    // null financialData entirely
    const m2 = calculateFinancialMetrics(null);
    assert.equal(m2.netProfitMargin, null, "null financialData → null netProfitMargin");
    assert.equal(m2.peRatio, null, "null financialData → null peRatio");

    // undefined financialData
    const m3 = calculateFinancialMetrics(undefined);
    assert.equal(m3.netProfitMargin, null, "undefined financialData → null netProfitMargin");
    assert.equal(m3.peRatio, null, "undefined financialData → null peRatio");

    // Individual undefined fields within financials
    const m4 = calculateFinancialMetrics({
      market: { price: 200 },
      financials: { netIncome: 100, revenue: undefined, eps: 10, totalAssets: 500, totalLiabilities: 300, cashAndEquivalents: 60 }
    });
    assert.equal(m4.netProfitMargin, null, "undefined revenue → null netProfitMargin");
    assert.equal(m4.returnOnAssets, 0.2, "returnOnAssets still calculable with undefined revenue");

    console.log("✓ Undefined inputs passed");
  }

  // --- Test 5: Zero values (legitimate data, not missing) ---
  console.log("Test 5: Zero values are preserved as legitimate data...");
  {
    const base = {
      market: { price: 200, marketCap: 3000000000000 },
      financials: {
        revenue: 400000000000,
        netIncome: 0,
        eps: 10,
        totalAssets: 500000000000,
        totalLiabilities: 300000000000,
        cashAndEquivalents: 60000000000
      }
    };

    // netIncome = 0 → netProfitMargin = 0
    const m1 = calculateFinancialMetrics(base);
    assert.equal(m1.netProfitMargin, 0, "netIncome=0 → netProfitMargin=0");
    assert.equal(m1.returnOnAssets, 0, "netIncome=0 → returnOnAssets=0");

    // totalLiabilities = 0 with positive assets → liabilityToAssetRatio = 0
    const m2 = calculateFinancialMetrics({
      market: base.market,
      financials: { ...base.financials, netIncome: 100000000000, totalLiabilities: 0 }
    });
    assert.equal(m2.liabilityToAssetRatio, 0, "totalLiabilities=0 → liabilityToAssetRatio=0");

    // cashAndEquivalents = 0 with positive liabilities → cashToLiabilityRatio = 0
    const m3 = calculateFinancialMetrics({
      market: base.market,
      financials: { ...base.financials, netIncome: 100000000000, cashAndEquivalents: 0 }
    });
    assert.equal(m3.cashToLiabilityRatio, 0, "cashAndEquivalents=0 → cashToLiabilityRatio=0");

    console.log("✓ Zero values preserved passed");
  }

  // --- Test 6: Division by zero ---
  console.log("Test 6: Division by zero returns null, not NaN or Infinity...");
  {
    const base = {
      market: { price: 200, marketCap: 3000000000000 },
      financials: {
        revenue: 0,
        netIncome: 100000000000,
        eps: 10,
        totalAssets: 0,
        totalLiabilities: 0,
        cashAndEquivalents: 60000000000
      }
    };
    const m = calculateFinancialMetrics(base);

    // revenue = 0 → netProfitMargin null
    assert.equal(m.netProfitMargin, null, "revenue=0 → null netProfitMargin");
    // totalAssets = 0 → returnOnAssets null, liabilityToAssetRatio null
    assert.equal(m.returnOnAssets, null, "totalAssets=0 → null returnOnAssets");
    assert.equal(m.liabilityToAssetRatio, null, "totalAssets=0 → null liabilityToAssetRatio");
    // totalLiabilities = 0 → cashToLiabilityRatio null
    assert.equal(m.cashToLiabilityRatio, null, "totalLiabilities=0 → null cashToLiabilityRatio");

    // Verify no NaN or Infinity in any metric
    for (const [key, val] of Object.entries(m)) {
      if (val !== null) {
        assert.ok(Number.isFinite(val), `${key} must be finite or null, got ${val}`);
      }
    }

    console.log("✓ Division by zero passed");
  }

  // --- Test 7: Negative values ---
  console.log("Test 7: Negative values computed correctly...");
  {
    // Negative netIncome → negative margin and ROA
    const m1 = calculateFinancialMetrics({
      market: { price: 200, marketCap: 1000000000000 },
      financials: {
        revenue: 400000000000,
        netIncome: -50000000000,
        eps: 10,
        totalAssets: 500000000000,
        totalLiabilities: 300000000000,
        cashAndEquivalents: 60000000000
      }
    });
    assert.equal(m1.netProfitMargin, -0.125, "negative netIncome → negative netProfitMargin");
    assert.equal(m1.returnOnAssets, -0.1, "negative netIncome → negative returnOnAssets");
    assert.ok(m1.netProfitMargin < 0, "netProfitMargin must be negative");
    assert.ok(m1.returnOnAssets < 0, "returnOnAssets must be negative");

    // Negative EPS → peRatio null
    const m2 = calculateFinancialMetrics({
      market: { price: 200, marketCap: 1000000000000 },
      financials: {
        revenue: 400000000000,
        netIncome: -50000000000,
        eps: -5,
        totalAssets: 500000000000,
        totalLiabilities: 300000000000,
        cashAndEquivalents: 60000000000
      }
    });
    assert.equal(m2.peRatio, null, "negative EPS → null peRatio");

    // Negative revenue (mathematically computed)
    const m3 = calculateFinancialMetrics({
      market: { price: 200, marketCap: 1000000000000 },
      financials: {
        revenue: -100000000000,
        netIncome: -50000000000,
        eps: -5,
        totalAssets: 500000000000,
        totalLiabilities: 300000000000,
        cashAndEquivalents: 60000000000
      }
    });
    // -50B / -100B = 0.5
    assert.equal(m3.netProfitMargin, 0.5, "negative revenue and negative netIncome → positive margin");

    console.log("✓ Negative values passed");
  }

  // --- Test 8: Invalid/non-finite values ---
  console.log("Test 8: Invalid/non-finite values produce null...");
  {
    const validBase = {
      revenue: 400000000000,
      netIncome: 100000000000,
      eps: 10,
      totalAssets: 500000000000,
      totalLiabilities: 300000000000,
      cashAndEquivalents: 60000000000
    };

    // NaN inputs
    const m1 = calculateFinancialMetrics({
      market: { price: NaN, marketCap: 1000000000000 },
      financials: { ...validBase, revenue: NaN }
    });
    assert.equal(m1.netProfitMargin, null, "NaN revenue → null netProfitMargin");
    assert.equal(m1.peRatio, null, "NaN price → null peRatio");

    // Infinity inputs
    const m2 = calculateFinancialMetrics({
      market: { price: Infinity, marketCap: 1000000000000 },
      financials: { ...validBase, totalAssets: Infinity }
    });
    assert.equal(m2.returnOnAssets, null, "Infinity totalAssets → null returnOnAssets");
    assert.equal(m2.peRatio, null, "Infinity price → null peRatio");

    // -Infinity inputs
    const m3 = calculateFinancialMetrics({
      market: { price: -Infinity, marketCap: 1000000000000 },
      financials: { ...validBase, netIncome: -Infinity }
    });
    assert.equal(m3.netProfitMargin, null, "-Infinity netIncome → null netProfitMargin");
    assert.equal(m3.peRatio, null, "-Infinity price → null peRatio");

    // String numeric inputs (type mismatch)
    const m4 = calculateFinancialMetrics({
      market: { price: "200", marketCap: 1000000000000 },
      financials: { ...validBase, revenue: "400000000000" }
    });
    assert.equal(m4.netProfitMargin, null, "string revenue → null netProfitMargin");
    assert.equal(m4.peRatio, null, "string price → null peRatio");
    // Unaffected metrics remain valid
    assert.equal(m4.returnOnAssets, 0.2, "returnOnAssets unaffected by string revenue");

    console.log("✓ Invalid/non-finite values passed");
  }

  // --- Test 9: No mutation of input ---
  console.log("Test 9: calculateFinancialMetrics does not mutate its input...");
  {
    const original = {
      company: { name: "Test Corp", ticker: "TEST" },
      market: { price: 200, marketCap: 3000000000000 },
      financials: {
        revenue: 400000000000,
        netIncome: 100000000000,
        eps: 10,
        totalAssets: 500000000000,
        totalLiabilities: 300000000000,
        cashAndEquivalents: 60000000000
      },
      periods: { fiscalDate: "2025-09-27", periodType: "Annual" },
      metadata: { source: "Test", retrievedAt: "2026-01-01T00:00:00.000Z" }
    };
    const snapshot = JSON.parse(JSON.stringify(original));
    calculateFinancialMetrics(original);
    assert.deepEqual(original, snapshot, "financialData must not be mutated by calculateFinancialMetrics");
    console.log("✓ No mutation passed");
  }

  // --- Test 10: Realistic normalized FMP-shaped object ---
  console.log("Test 10: Realistic normalized FMP-shaped object...");
  {
    const realisticData = {
      company: {
        name: "Apple Inc",
        ticker: "AAPL",
        exchange: "NASDAQ",
        currency: "USD"
      },
      market: {
        price: 175.84,
        marketCap: 2730000000000
      },
      financials: {
        revenue: 383285000000,
        netIncome: 96995000000,
        eps: 6.13,
        totalAssets: 352581000000,
        totalLiabilities: 290437000000,
        cashAndEquivalents: 29965000000
      },
      periods: {
        fiscalDate: "2023-09-30",
        periodType: "Annual"
      },
      metadata: {
        source: "Financial Modeling Prep",
        retrievedAt: "2026-09-10T18:00:00.000Z"
      }
    };
    const m = calculateFinancialMetrics(realisticData);

    // All metrics should be non-null for a complete realistic dataset
    assert.notEqual(m.netProfitMargin, null, "netProfitMargin must not be null");
    assert.notEqual(m.returnOnAssets, null, "returnOnAssets must not be null");
    assert.notEqual(m.liabilityToAssetRatio, null, "liabilityToAssetRatio must not be null");
    assert.notEqual(m.cashToLiabilityRatio, null, "cashToLiabilityRatio must not be null");
    assert.notEqual(m.peRatio, null, "peRatio must not be null");

    // All metrics must be finite numbers
    for (const [key, val] of Object.entries(m)) {
      assert.ok(typeof val === "number" && Number.isFinite(val), `${key} must be a finite number`);
    }

    // All must be rounded to 4 decimal places
    for (const [key, val] of Object.entries(m)) {
      const rounded = Math.round(val * 10000) / 10000;
      assert.equal(val, rounded, `${key} must be rounded to 4 decimal places`);
    }

    // Verify expected values
    // netProfitMargin = 96995000000 / 383285000000 ≈ 0.2531
    assert.equal(m.netProfitMargin, 0.2531, "realistic netProfitMargin");
    // returnOnAssets = 96995000000 / 352581000000 ≈ 0.2751
    assert.equal(m.returnOnAssets, 0.2751, "realistic returnOnAssets");
    // liabilityToAssetRatio = 290437000000 / 352581000000 ≈ 0.8237
    assert.equal(m.liabilityToAssetRatio, 0.8237, "realistic liabilityToAssetRatio");
    // cashToLiabilityRatio = 29965000000 / 290437000000 ≈ 0.1032
    assert.equal(m.cashToLiabilityRatio, 0.1032, "realistic cashToLiabilityRatio");
    // peRatio = 175.84 / 6.13 ≈ 28.6852
    assert.equal(m.peRatio, 28.6852, "realistic peRatio");

    // Verify the function only returns the 5 metric keys
    const keys = Object.keys(m);
    assert.equal(keys.length, 5, "output must contain exactly 5 metric keys");
    assert.ok(keys.includes("netProfitMargin"), "must include netProfitMargin");
    assert.ok(keys.includes("returnOnAssets"), "must include returnOnAssets");
    assert.ok(keys.includes("liabilityToAssetRatio"), "must include liabilityToAssetRatio");
    assert.ok(keys.includes("cashToLiabilityRatio"), "must include cashToLiabilityRatio");
    assert.ok(keys.includes("peRatio"), "must include peRatio");

    console.log("✓ Realistic normalized FMP-shaped object passed");
  }

  console.log("ALL DETERMINISTIC FINANCIAL METRICS TESTS PASSED!\n");
}

async function main() {
  await runUnitTests();
  await runNodeUnitTests();
  await runWorkflowMockedTest();
  await runFinancialTests();
  await runFinancialMetricsTests();
  if (process.env.SKIP_LIVE_TESTS === "1") {
    console.log("Skipping live integration tests (SKIP_LIVE_TESTS=1).");
    return;
  }
  await runIntegrationTests();
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
