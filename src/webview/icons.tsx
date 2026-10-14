const base = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, 'aria-hidden': true };

export const PlusIcon = () => <svg {...base}><path d="M8 3v10M3 8h10" /></svg>;
export const MinusIcon = () => <svg {...base}><path d="M3 8h10" /></svg>;
export const TargetIcon = () => (
  <svg {...base}><circle cx="8" cy="8" r="5" /><circle cx="8" cy="8" r="1.5" fill="currentColor" /></svg>
);
export const OpenIcon = () => <svg {...base}><path d="M9 3h4v4M13 3L7.5 8.5M12 9.5V13H3V4h3.5" /></svg>;
export const BackIcon = () => <svg {...base}><path d="M10 3L5 8l5 5" /></svg>;
export const RefreshIcon = () => <svg {...base}><path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3" /></svg>;
export const SidebarIcon = () => <svg {...base}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M6.5 3v10" /></svg>;
