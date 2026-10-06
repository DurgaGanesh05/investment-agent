const SearchInput = ({ value, onChange, placeholder = "Enter company name", className = "" }) => {
  return (
    <input
      type="text"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className={`w-full rounded-xl border border-[#1E293B] bg-[#131B2E] px-4 py-3 text-sm text-[#F8FAFC] placeholder-[#94A3B8]/60 shadow-sm outline-none transition-colors duration-150 focus:border-[#0284C7] focus:ring-2 focus:ring-[#0284C7]/25 ${className}`}
      aria-label="Company name"
    />
  );
};

export default SearchInput;
