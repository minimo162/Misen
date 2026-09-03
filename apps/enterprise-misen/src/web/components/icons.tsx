type IconName = 'send' | 'stop' | 'running' | 'success' | 'error' | 'chevron-right' | 'chevron-down' | 'file' | 'open' | 'back' | 'plus'

export function Icon({ name, className = 'size-4' }: { name: IconName; className?: string }) {
  const common = { className, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  if (name === 'send') return <svg {...common}><path d="M10 15V5m0 0L6.5 8.5M10 5l3.5 3.5" /></svg>
  if (name === 'stop') return <svg {...common} fill="currentColor" stroke="none"><rect x="6" y="6" width="8" height="8" rx="1.5" /></svg>
  if (name === 'running') return <svg {...common} className={`${className} animate-spin motion-reduce:animate-none`}><circle cx="10" cy="10" r="6.5" opacity=".28" /><path d="M10 3.5a6.5 6.5 0 0 1 6.5 6.5" /></svg>
  if (name === 'success') return <svg {...common}><path d="m5.5 10 3 3 6-6" /></svg>
  if (name === 'error') return <svg {...common}><path d="m6.5 6.5 7 7m0-7-7 7" /></svg>
  if (name === 'chevron-right') return <svg {...common}><path d="m8 6 4 4-4 4" /></svg>
  if (name === 'chevron-down') return <svg {...common}><path d="m6 8 4 4 4-4" /></svg>
  if (name === 'file') return <svg {...common}><path d="M6 3.5h5l3 3V16.5H6z" /><path d="M11 3.5v3h3" /></svg>
  if (name === 'open') return <svg {...common}><path d="M8 5h7v7M15 5 7 13" /><path d="M13 11v4H5V7h4" /></svg>
  if (name === 'plus') return <svg {...common}><path d="M10 4v12M4 10h12" /></svg>
  return <svg {...common}><path d="m6 8 4 4 4-4" /></svg>
}
