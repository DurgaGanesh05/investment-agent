import { useState, useEffect } from "react";
import SearchInput from "../components/ui/SearchInput";
import PrimaryButton from "../components/ui/PrimaryButton";
import Surface from "../components/ui/Surface";
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
      return "bg-[#10B981]/15 text-[#10B981] border-[#10B981]/30";
    }

    if (recommendation === "Avoid") {
      return "bg-[#EF4444]/15 text-[#EF4444] border-[#EF4444]/30";
    }

    return "bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/30";
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

  useEffect(() => {
    const handleReset = () => {
      handleAnalyzeAnotherCompany();
    };

    window.addEventListener("insight:analyze-new", handleReset);
    return () => {
      window.removeEventListener("insight:analyze-new", handleReset);
    };
  }, []);

  return (
    <div className="mx-auto flex w-full flex-col items-center">
      <Surface className="w-full max-w-2xl p-6 sm:p-8">
        <div className="flex flex-col items-center gap-2.5 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-[#F8FAFC] sm:text-3xl">
            AI Investment Research Agent
          </h1>
          <p className="text-sm text-[#94A3B8]">
            Enter a company name to begin analysis.
          </p>
        </div>

        <div className="mt-6 flex w-full flex-col gap-4">
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <SearchInput
              value={companyName}
              onChange={(event) => setCompanyName(event.target.value)}
              placeholder="Type a company name (e.g., Apple)"
            />
            <PrimaryButton type="submit" disabled={isAnalyzeDisabled}>
              {isAnalyzing ? "Analyzing..." : "Analyze"}
            </PrimaryButton>
          </form>
          {errorMessage ? <p className="text-sm text-[#EF4444]">{errorMessage}</p> : null}
          {researchResult ? (
            <section className="mt-2 space-y-4 rounded-xl border border-[#1E293B] bg-[#0B0F19]/60 p-4 text-left text-sm text-[#94A3B8] sm:p-5">
              <div className="flex flex-col gap-3 border-b border-[#1E293B] pb-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                  <p>
                    <span className="font-semibold text-[#F8FAFC]">Company:</span>{" "}
                    <span className="text-[#F8FAFC]">{researchResult.company}</span>
                  </p>
                  <p>
                    <span className="font-semibold text-[#F8FAFC]">Industry:</span> {researchResult.industry}
                  </p>
                </div>

                <div className="space-y-2 sm:text-right">
                  <div>
                    <span className="mr-2 font-semibold text-[#F8FAFC]">Recommendation</span>
                    <span
                      className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${getRecommendationBadgeClass(
                        researchResult.recommendation
                      )}`}
                    >
                      {researchResult.recommendation}
                    </span>
                  </div>
                  <p>
                    <span className="font-semibold text-[#F8FAFC]">Confidence:</span>{" "}
                    <span className="text-[#F8FAFC]">{researchResult.confidence}%</span>
                  </p>
                </div>
              </div>

              <div>
                <p className="font-semibold text-[#F8FAFC]">Overview</p>
                <p className="mt-1 leading-relaxed">{researchResult.overview}</p>
              </div>

              {researchResult.investmentThesis ? (
                <div>
                  <p className="font-semibold text-[#F8FAFC]">Investment Thesis</p>
                  <p className="mt-1 leading-relaxed text-[#F8FAFC]/90">{researchResult.investmentThesis}</p>
                </div>
              ) : null}

              {researchResult.fundamentalAssessment ? (
                <div className="space-y-2 rounded-lg border border-[#1E293B] bg-[#131B2E] p-3.5">
                  <p className="font-semibold text-[#F8FAFC]">Fundamental Assessment</p>
                  <div className="space-y-1.5 text-xs sm:text-sm">
                    <p>
                      <span className="font-medium text-[#F8FAFC]">Business Quality:</span>{" "}
                      {researchResult.fundamentalAssessment.businessQuality}
                    </p>
                    <p>
                      <span className="font-medium text-[#F8FAFC]">Competitive Advantage:</span>{" "}
                      {researchResult.fundamentalAssessment.competitiveAdvantage}
                    </p>
                    <p>
                      <span className="font-medium text-[#F8FAFC]">Financial Health:</span>{" "}
                      {researchResult.fundamentalAssessment.financialHealth}
                    </p>
                  </div>
                </div>
              ) : null}

              <div>
                <p className="font-semibold text-[#F8FAFC]">Strengths</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {(researchResult.strengths ?? []).map((strength, index) => (
                    <li key={`strength-${index}`}>{strength}</li>
                  ))}
                </ul>
              </div>

              <div>
                <p className="font-semibold text-[#F8FAFC]">Risks</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {(researchResult.risks ?? []).map((risk, index) => (
                    <li key={`risk-${index}`}>{risk}</li>
                  ))}
                </ul>
              </div>

              {researchResult.keyCatalysts?.length ? (
                <div>
                  <p className="font-semibold text-[#F8FAFC]">Key Catalysts</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {researchResult.keyCatalysts.map((catalyst, index) => (
                      <li key={`catalyst-${index}`}>{catalyst}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {researchResult.keyConcerns?.length ? (
                <div>
                  <p className="font-semibold text-[#F8FAFC]">Key Concerns</p>
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
                    <div className="rounded-lg border border-[#10B981]/30 bg-[#10B981]/10 p-3">
                      <p className="font-semibold text-[#10B981]">Bull Case</p>
                      <p className="mt-1 text-xs text-[#10B981]/90 sm:text-sm">{researchResult.bullCase}</p>
                    </div>
                  ) : null}
                  {researchResult.bearCase ? (
                    <div className="rounded-lg border border-[#EF4444]/30 bg-[#EF4444]/10 p-3">
                      <p className="font-semibold text-[#EF4444]">Bear Case</p>
                      <p className="mt-1 text-xs text-[#EF4444]/90 sm:text-sm">{researchResult.bearCase}</p>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div>
                <p className="font-semibold text-[#F8FAFC]">Reasoning</p>
                <p className="mt-1 leading-relaxed">{researchResult.reasoning}</p>
              </div>

              <button
                type="button"
                onClick={handleAnalyzeAnotherCompany}
                className="w-full rounded-lg border border-[#1E293B] bg-[#131B2E] px-4 py-2.5 text-sm font-medium text-[#F8FAFC] transition-colors hover:bg-[#1E293B]"
              >
                Analyze Another Company
              </button>
            </section>
          ) : null}
        </div>
      </Surface>
    </div>
  );
};

export default Home;
