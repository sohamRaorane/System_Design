import { useState } from 'react';

export function CopyButton({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="quiet"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked */ }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

/**
 * The environment variables a user adds to their app. `apiKey` is the full key right after
 * creation; otherwise a placeholder is shown (keys are never retrievable later).
 */
export function SetupSnippet({ setup, apiKey, serviceName = 'my-service' }) {
  if (!setup) return null;
  const key = apiKey || '<your ingest key>';
  const lines = [
    `OTEL_EXPORTER_OTLP_ENDPOINT=${setup.endpoint}`,
    `OTEL_EXPORTER_OTLP_HEADERS=x-api-key=${key}`,
    `OTEL_SERVICE_NAME=${serviceName}`,
    'OTEL_TRACES_EXPORTER=otlp',
    'OTEL_METRICS_EXPORTER=none',
    'OTEL_LOGS_EXPORTER=none',
  ].join('\n');
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="code-block" aria-label="Environment variables">
        {lines}
        <CopyButton text={lines} />
      </div>
      <details className="small">
        <summary>How to use these in a Node.js app</summary>
        <ol className="muted" style={{ paddingLeft: 18, margin: '8px 0 0' }}>
          <li><code>npm install @opentelemetry/api @opentelemetry/auto-instrumentations-node</code></li>
          <li>Set the variables above where your app runs (Render, Vercel, Docker, your shell).</li>
          <li>Start your app with <code>node --require @opentelemetry/auto-instrumentations-node/register app.js</code> (or set <code>NODE_OPTIONS</code> to the same <code>--require</code>).</li>
        </ol>
      </details>
      <details className="small">
        <summary>How to use these in a Python app</summary>
        <ol className="muted" style={{ paddingLeft: 18, margin: '8px 0 0' }}>
          <li><code>pip install opentelemetry-distro opentelemetry-exporter-otlp</code> then <code>opentelemetry-bootstrap -a install</code></li>
          <li>Set the variables above, plus <code>OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf</code>.</li>
          <li>Start with <code>opentelemetry-instrument python app.py</code>.</li>
        </ol>
      </details>
    </div>
  );
}
