import { useState } from "react";
import SearchInput from "../components/ui/SearchInput";
import PrimaryButton from "../components/ui/PrimaryButton";
import api from "../services/api";

const Home = () => {
  const [companyName, setCompanyName] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [researchResult, setResearchResult] = useState(null);

  const handleAnalyze = async () => {
    const trimmedCompany = companyName.trim();

    if (!trimmedCompany || isAnalyzing) {
      return;
    }

    setErrorMessage("");
    setIsAnalyzing(true);

    try {
      const response = await api.post("/research", {
        company: trimmedCompany
      });

      setResearchResult(response.data);
    } catch {
      setErrorMessage("Unable to analyze company.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    handleAnalyze();
  };

  const isAnalyzeDisabled = companyName.trim().length === 0 || isAnalyzing;

  const getRecommendationBadgeClass = (recommendation) => {
    if (recommendation === "Invest") {
      return "bg-green-100 text-green-800 border-green-200";
    }

    if (recommendation === "Avoid") {
      return "bg-red-100 text-red-800 border-red-200";
    }

    return "bg-yellow-100 text-yellow-800 border-yellow-200";
  };

  const handleAnalyzeAnotherCompany = () => {
    setResearchResult(null);
    setCompanyName("");
    setErrorMessage("");

    requestAnimationFrame(() => {
      const companyInput = document.querySelector('input[aria-label="Company name"]');
      companyInput?.focus();
    });
  };

  return (
    <section className="w-full rounded-2xl border border-slate-200 bg-white p-8 shadow-lg sm:p-10">
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 text-center">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
          AI Investment Research Agent
        </h1>
        <p className="text-sm text-slate-600 sm:text-base">
          Enter a company name to begin analysis.
        </p>
      </div>

      <div className="mx-auto mt-8 flex w-full max-w-xl flex-col gap-4">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <SearchInput
            value={companyName}
            onChange={(event) => setCompanyName(event.target.value)}
            placeholder="Type a company name (e.g., Apple)"
          />
          <PrimaryButton type="submit" disabled={isAnalyzeDisabled}>
            {isAnalyzing ? "Analyzing..." : "Analyze"}
          </PrimaryButton>
        </form>
        {errorMessage ? <p className="text-sm text-red-600">{errorMessage}</p> : null}
        {researchResult ? (
          <section className="mt-2 space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-left text-sm text-slate-700 sm:p-5">
            <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <p>
                  <span className="font-semibold text-slate-900">Company:</span> {researchResult.company}
                </p>
                <p>
                  <span className="font-semibold text-slate-900">Industry:</span> {researchResult.industry}
                </p>
              </div>

              <div className="space-y-2 sm:text-right">
                <div>
                  <span className="mr-2 font-semibold text-slate-900">Recommendation</span>
                  <span
                    className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${getRecommendationBadgeClass(
                      researchResult.recommendation
                    )}`}
                  >
                    {researchResult.recommendation}
                  </span>
                </div>
                <p>
                  <span className="font-semibold text-slate-900">Confidence:</span> {researchResult.confidence}%
                </p>
              </div>
            </div>

            <div>
              <p className="font-semibold text-slate-900">Overview</p>
              <p className="mt-1">{researchResult.overview}</p>
            </div>

            {researchResult.investmentThesis ? (
              <div>
                <p className="font-semibold text-slate-900">Investment Thesis</p>
                <p className="mt-1 text-slate-800">{researchResult.investmentThesis}</p>
              </div>
            ) : null}

            {researchResult.fundamentalAssessment ? (
              <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3.5">
                <p className="font-semibold text-slate-900">Fundamental Assessment</p>
                <div className="space-y-1.5 text-xs sm:text-sm">
                  <p>
                    <span className="font-medium text-slate-900">Business Quality:</span>{" "}
                    {researchResult.fundamentalAssessment.businessQuality}
                  </p>
                  <p>
                    <span className="font-medium text-slate-900">Competitive Advantage:</span>{" "}
                    {researchResult.fundamentalAssessment.competitiveAdvantage}
                  </p>
                  <p>
                    <span className="font-medium text-slate-900">Financial Health:</span>{" "}
                    {researchResult.fundamentalAssessment.financialHealth}
                  </p>
                </div>
              </div>
            ) : null}

            <div>
              <p className="font-semibold text-slate-900">Strengths</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {(researchResult.strengths ?? []).map((strength, index) => (
                  <li key={`strength-${index}`}>{strength}</li>
                ))}
              </ul>
            </div>

            <div>
              <p className="font-semibold text-slate-900">Risks</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {(researchResult.risks ?? []).map((risk, index) => (
                  <li key={`risk-${index}`}>{risk}</li>
                ))}
              </ul>
            </div>

            {researchResult.keyCatalysts?.length ? (
              <div>
                <p className="font-semibold text-slate-900">Key Catalysts</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {researchResult.keyCatalysts.map((catalyst, index) => (
                    <li key={`catalyst-${index}`}>{catalyst}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {researchResult.keyConcerns?.length ? (
              <div>
                <p className="font-semibold text-slate-900">Key Concerns</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {researchResult.keyConcerns.map((concern, index) => (
                    <li key={`concern-${index}`}>{concern}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {researchResult.bullCase || researchResult.bearCase ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {researchResult.bullCase ? (
                  <div className="rounded-lg border border-green-200 bg-green-50/50 p-3">
                    <p className="font-semibold text-green-900">Bull Case</p>
                    <p className="mt-1 text-xs text-green-800 sm:text-sm">{researchResult.bullCase}</p>
                  </div>
                ) : null}
                {researchResult.bearCase ? (
                  <div className="rounded-lg border border-red-200 bg-red-50/50 p-3">
                    <p className="font-semibold text-red-900">Bear Case</p>
                    <p className="mt-1 text-xs text-red-800 sm:text-sm">{researchResult.bearCase}</p>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div>
              <p className="font-semibold text-slate-900">Reasoning</p>
              <p className="mt-1">{researchResult.reasoning}</p>
            </div>

            <button
              type="button"
              onClick={handleAnalyzeAnotherCompany}
              className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Analyze Another Company
            </button>
          </section>
        ) : null}
      </div>
    </section>
  );
};

export default Home;
