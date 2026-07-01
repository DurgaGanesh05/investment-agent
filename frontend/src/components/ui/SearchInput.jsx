const SearchInput = ({ value, onChange, placeholder = "Enter company name", className = "" }) => {
  return (
    <input
      type="text"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className={`w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-900 shadow-sm outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-200 ${className}`}
      aria-label="Company name"
    />
  );
};

export default SearchInput;
