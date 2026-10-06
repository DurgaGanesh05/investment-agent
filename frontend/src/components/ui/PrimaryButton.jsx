const PrimaryButton = ({ children, onClick, disabled = false, type = "button", className = "" }) => {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center rounded-xl bg-[#0284C7] px-5 py-3 text-sm font-semibold text-white transition-colors duration-150 hover:bg-[#0369A1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0284C7] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B0F19] disabled:cursor-not-allowed disabled:bg-[#1E293B] disabled:text-[#64748B] ${className}`}
    >
      {children}
    </button>
  );
};

export default PrimaryButton;
