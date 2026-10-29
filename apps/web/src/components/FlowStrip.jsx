// The signal-flow strip: the pipeline drawn as a line with six stops.
const ICONS = {
  receive: <path d="M4 12h11m-4-4 4 4-4 4M19 5v14" />,
  queue: <path d="M4 7h16M4 12h16M4 17h10" />,
  assemble: <path d="M6 6h4v4H6zM14 6h4v4h-4zM10 14h4v4h-4zM8 10l3 4m5-4-3 4" />,
  sample: <path d="M4 5h16l-6 8v6l-4-2v-4z" />,
  store: <path d="M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zm0 0v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />,
  archive: <path d="M4 5h16v4H4zM6 9v10h12V9M10 13h4" />,
};

export function FlowStrip({ stages }) {
  const moving = stages.some((s) => s.key === 'receive' && s.state !== 'idle');
  return (
    <div className={'flow' + (moving ? '' : ' idle')} role="list" aria-label="Pipeline stages">
      {stages.map((s) => (
        <div key={s.key} className={`stage ${s.state}`} role="listitem" aria-label={`${s.name}: ${s.why}`}>
          <div className="node" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{ICONS[s.key]}</svg>
          </div>
          <div className="name">{s.name}</div>
          <div className="num">{s.num}</div>
          <div className="unit">{s.unit}</div>
          <p className="why">{s.why}</p>
        </div>
      ))}
    </div>
  );
}
