const Surface = ({ children, className = "" }) => {
  return (
    <div className={`rounded-xl border border-[#1E293B] bg-[#131B2E] p-6 text-[#F8FAFC] ${className}`}>
      {children}
    </div>
  );
};

export default Surface;
