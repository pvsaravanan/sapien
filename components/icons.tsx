// Small stroke icons, drawn for sapien. 16px, currentColor.
type P = { size?: number };
const base = (size = 16) => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const });

export const IconPlus = ({ size }: P) => <svg {...base(size)}><path d="M12 5v14M5 12h14" /></svg>;
export const IconSearch = ({ size = 14 }: P) => <svg {...base(size)}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>;
export const IconGear = ({ size }: P) => (
  <svg {...base(size)} strokeWidth={1.6}>
    <path d="M19.27 9.78 L22.01 10.05 L22.01 13.95 L19.27 14.22 L18.71 15.57 L20.46 17.70 L17.70 20.46 L15.57 18.71 L14.22 19.27 L13.95 22.01 L10.05 22.01 L9.78 19.27 L8.43 18.71 L6.30 20.46 L3.54 17.70 L5.29 15.57 L4.73 14.22 L1.99 13.95 L1.99 10.05 L4.73 9.78 L5.29 8.43 L3.54 6.30 L6.30 3.54 L8.43 5.29 L9.78 4.73 L10.05 1.99 L13.95 1.99 L14.22 4.73 L15.57 5.29 L17.70 3.54 L20.46 6.30 L18.71 8.43 Z" />
    <circle cx="12" cy="12" r="3.2" />
  </svg>
);
export const IconPanel = ({ size = 18 }: P) => <svg {...base(size)}><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M9 4v16" /></svg>;
export const IconActivity = ({ size = 14 }: P) => <svg {...base(size)}><path d="M3 12h4l2.5-6 5 12 2.5-6h4" /></svg>;
export const IconPractice = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M6.5 6.5 17.5 17.5" />
    <path d="m4 9 5-5M3 10.5l1.5-1.5M9 4l1.5-1.5M15 20l5-5M13.5 21.5l1.5-1.5M20 15l1.5-1.5" />
  </svg>
);
export const IconPlan = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <circle cx="6" cy="5" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="12" cy="19" r="2" />
    <path d="M6 7c0 6 6 4 6 10M18 7c0 6-6 4-6 10" />
  </svg>
);
export const IconChains = ({ size }: P) => <svg {...base(size)}><path d="M4 6h3M4 12h3M4 18h3M10 6h10M13 12h7M13 18h7" /></svg>;
export const IconUpload = ({ size }: P) => <svg {...base(size)}><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-3" /></svg>;
export const IconEnter = ({ size = 20 }: P) => <svg {...base(size)}><path d="M20 5v7a3 3 0 0 1-3 3H5M9 10l-5 5 5 5" /></svg>;
export const IconClose = ({ size }: P) => <svg {...base(size)}><path d="M6 6l12 12M18 6 6 18" /></svg>;
export const IconAsk = ({ size = 14 }: P) => <svg {...base(size)}><path d="M5 18.5V7a2.5 2.5 0 0 1 2.5-2.5h9A2.5 2.5 0 0 1 19 7v6a2.5 2.5 0 0 1-2.5 2.5H9z" /></svg>;

/** Sapien mark: three linked propositions. */
export function Logo({ size = 22 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 17 12 6l6 11" stroke="#8d8d8d" strokeWidth="1.6" />
      <circle cx="12" cy="6" r="3" fill="#e6e6e6" />
      <circle cx="6" cy="17" r="3" fill="#e6e6e6" />
      <circle cx="18" cy="17" r="3" fill="#e5b93c" />
    </svg>
  );
}
