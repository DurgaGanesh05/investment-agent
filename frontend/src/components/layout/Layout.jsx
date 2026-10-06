const Layout = ({ children, onAnalyzeNew }) => {
  const handleAnalyzeNewClick = () => {
    if (onAnalyzeNew) {
      onAnalyzeNew();
      return;
    }
    window.dispatchEvent(new CustomEvent("insight:analyze-new"));
    const companyInput = document.querySelector('input[aria-label="Company name"]');
    companyInput?.focus();
  };

  return (
    <div className="min-h-screen bg-[#0B0F19] text-[#F8FAFC] flex flex-col antialiased selection:bg-[#0284C7]/30 selection:text-white">
      <header className="sticky top-0 z-30 border-b border-[#1E293B] bg-[#0B0F19]/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-[1200px] items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2.5">
            <span className="h-2 w-2 rounded-full bg-[#0284C7]" aria-hidden="true" />
            <span className="text-sm font-semibold tracking-wider text-[#F8FAFC]">
              INSIGHT INVESTOR
            </span>
          </div>
          <button
            type="button"
            onClick={handleAnalyzeNewClick}
            className="rounded-lg border border-transparent px-3 py-1.5 text-xs font-medium text-[#94A3B8] transition-colors hover:border-[#1E293B] hover:bg-[#131B2E] hover:text-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0284C7]"
          >
            Analyze New
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        {children}
      </main>
    </div>
  );
};

export default Layout;
