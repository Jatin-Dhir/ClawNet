import React from 'react';

const RewardToken = ({
  icon: Icon,
  value,
  label,
  glow = '#00e0ff',
  orientation = 'vertical',
  className = '',
  valueClassName = '',
  labelClassName = '',
}) => {
  const isHorizontal = orientation === 'horizontal';
  const showIcon = Boolean(Icon);

  return (
    <div
      className={`group relative overflow-hidden rounded-xl border border-white/10 bg-black/30 p-4 ${
        isHorizontal ? 'flex items-center gap-4 text-left' : 'flex flex-col items-center gap-2 text-center'
      } ${className}`}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: `radial-gradient(circle at 50% 0%, ${glow}40, transparent 70%)`,
        }}
      />
      {showIcon && (
        <div className="relative z-10 flex h-10 w-10 items-center justify-center rounded-lg border border-white/15 bg-white/5 text-white">
          <Icon className="h-5 w-5" />
        </div>
      )}
      <div
        className={`relative z-10 ${
          isHorizontal
            ? `flex flex-col justify-center ${showIcon ? '' : 'pl-1'}`
            : 'flex flex-col items-center gap-1'
        }`}
      >
        <span className={`font-orbitron text-xl text-white ${valueClassName}`}>{value}</span>
        <span
          className={`font-exo text-[10px] uppercase tracking-[0.3em] text-gray-400 ${labelClassName}`}
        >
          {label}
        </span>
      </div>
    </div>
  );
};

export default RewardToken;

