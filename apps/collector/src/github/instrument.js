'use strict';
// Decide what the "add OpenTelemetry" pull request changes in a repository.
// Pure functions: given the files we read from the repo, return the new file contents.
// Principles: zero-code instrumentation only; never put secrets in the repository; change as
// little as possible and explain everything else in OPENTELEMETRY.md.

const NODE_DEPS = {
  '@opentelemetry/api': '^1.9.0',
  '@opentelemetry/auto-instrumentations-node': '>=0.56.0 <1.0.0',
};
const NODE_REGISTER = '@opentelemetry/auto-instrumentations-node/register';
const PY_PACKAGES = ['opentelemetry-distro', 'opentelemetry-exporter-otlp'];

/** Which language/runtime the repository uses, from the files at its root. */
function detectStack(files) {
  if (typeof files['package.json'] === 'string') {
    let pkg = {};
    try { pkg = JSON.parse(files['package.json']); } catch { /* malformed: still Node */ }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const framework = ['next', '@nestjs/core', 'express', 'fastify', 'koa', '@hapi/hapi'].find((f) => deps[f]);
    return { language: 'node', framework: framework || null, label: framework ? `Node.js (${framework})` : 'Node.js' };
  }
  if (typeof files['requirements.txt'] === 'string' || typeof files['pyproject.toml'] === 'string') {
    const txt = `${files['requirements.txt'] || ''}\n${files['pyproject.toml'] || ''}`.toLowerCase();
    const framework = ['django', 'flask', 'fastapi'].find((f) => txt.includes(f));
    return { language: 'python', framework: framework || null, label: framework ? `Python (${framework})` : 'Python' };
  }
  if (typeof files['go.mod'] === 'string') return { language: 'go', framework: null, label: 'Go' };
  if (typeof files['pom.xml'] === 'string' || typeof files['build.gradle'] === 'string') return { language: 'java', framework: null, label: 'Java' };
  return { language: 'unknown', framework: null, label: 'Unknown' };
}

const indentOf = (text) => {
  const m = /\n([ \t]+)"/.exec(text);
  return m ? m[1] : '  ';
};

/** Add the OTel packages and preload the SDK in "start" when it is a plain `node <file>`. */
function patchPackageJson(text) {
  const pkg = JSON.parse(text);
  const notes = [];
  pkg.dependencies = pkg.dependencies || {};
  for (const [name, version] of Object.entries(NODE_DEPS)) {
    if (!pkg.dependencies[name] && !pkg.devDependencies?.[name]) pkg.dependencies[name] = version;
  }
  // keep dependencies sorted, as npm does
  pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)));
  let startPatched = false;
  const start = pkg.scripts?.start;
  if (typeof start === 'string' && !start.includes(NODE_REGISTER)) {
    const m = /^(\s*)node(\s+)(.*)$/.exec(start);
    if (m && !/[;&|]/.test(start)) {
      pkg.scripts.start = `${m[1]}node --require ${NODE_REGISTER}${m[2]}${m[3]}`;
      startPatched = true;
    } else {
      notes.push(`Your start script ("${start}") is not a plain \`node <file>\` command, so it was left unchanged. Set NODE_OPTIONS=--require ${NODE_REGISTER} where the app runs instead.`);
    }
  } else if (typeof start !== 'string') {
    notes.push(`No "start" script was found. Start your app with \`node --require ${NODE_REGISTER} <entry file>\`, or set NODE_OPTIONS=--require ${NODE_REGISTER}.`);
  }
  const trailing = text.endsWith('\n') ? '\n' : '';
  return { content: JSON.stringify(pkg, null, indentOf(text)) + trailing, startPatched, notes };
}

function patchRequirements(text) {
  const lines = text.split(/\r?\n/);
  const have = new Set(lines.map((l) => l.trim().toLowerCase().split(/[<>=!~\s[]/)[0]));
  const add = PY_PACKAGES.filter((p) => !have.has(p));
  if (!add.length) return { content: text, changed: false };
  const base = text.length && !text.endsWith('\n') ? text + '\n' : text;
  return { content: base + add.join('\n') + '\n', changed: true };
}

/** Prefix web processes in a Procfile with opentelemetry-instrument. */
function patchProcfile(text) {
  let changed = false;
  const out = text.split(/\r?\n/).map((line) => {
    const m = /^(\s*web\s*:\s*)(.+)$/.exec(line);
    if (m && !m[2].includes('opentelemetry-instrument')) { changed = true; return `${m[1]}opentelemetry-instrument ${m[2]}`; }
    return line;
  }).join('\n');
  return { content: out, changed };
}

function guide({ stack, serviceName, endpoint, notes, changedFiles }) {
  const env = [
    `OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`,
    'OTEL_EXPORTER_OTLP_HEADERS=x-api-key=<your ingest key from the dashboard>',
    `OTEL_SERVICE_NAME=${serviceName}`,
    'OTEL_TRACES_EXPORTER=otlp',
    'OTEL_METRICS_EXPORTER=none',
    'OTEL_LOGS_EXPORTER=none',
    ...(stack.language === 'python' ? ['OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf'] : []),
  ].join('\n');
  const how = {
    node: `The \`@opentelemetry/auto-instrumentations-node\` package traces HTTP servers and clients, Express, databases and more without code changes. It is loaded before your app with \`--require ${NODE_REGISTER}\`.`,
    python: 'The OpenTelemetry distro traces Django, Flask, FastAPI, requests, database clients and more without code changes. Run `opentelemetry-bootstrap -a install` once after installing dependencies, then start your app with `opentelemetry-instrument <your usual command>`.',
    go: 'Go needs a few lines of code: see https://opentelemetry.io/docs/languages/go/getting-started/ and point the OTLP HTTP exporter at the endpoint below.',
    java: 'Attach the OpenTelemetry Java agent: `java -javaagent:opentelemetry-javaagent.jar -jar app.jar` (https://opentelemetry.io/docs/zero-code/java/agent/). It reads the variables below.',
    unknown: 'We could not detect the language of this repository. Follow the zero-code guide for your language at https://opentelemetry.io/docs/zero-code/ and use the variables below.',
  }[stack.language];
  return `# OpenTelemetry tracing

This repository sends traces to **Tracepipe**, an OpenTelemetry pipeline with tail-based
sampling: failed and slow requests are always kept, healthy ones are sampled.

## What this pull request changed

${changedFiles.map((f) => `- \`${f.path}\`: ${f.why}`).join('\n')}

${how}

## What you still need to do

Set these environment variables where the app runs (Render, Vercel, Docker, your shell).
Get the ingest key from the project's **Settings** page in the dashboard. Never commit it.

\`\`\`
${env}
\`\`\`

Then deploy. Traces appear in the dashboard a few seconds after the first request.
${notes.length ? `\n## Notes\n\n${notes.map((n) => `- ${n}`).join('\n')}\n` : ''}
## Turning it off

Set \`OTEL_SDK_DISABLED=true\`, or revert this pull request.
`;
}

/**
 * @param {object} files root files read from the repo: { 'package.json': text, ... }
 * @returns {{ stack, changes: [{ path, content, why }], notes: string[] }}
 */
function planInstrumentation(files, { serviceName, endpoint }) {
  const stack = detectStack(files);
  const changes = [];
  const notes = [];
  if (stack.language === 'node') {
    try {
      const p = patchPackageJson(files['package.json']);
      changes.push({ path: 'package.json', content: p.content, why: p.startPatched ? 'adds the OpenTelemetry packages and preloads them in the "start" script' : 'adds the OpenTelemetry packages' });
      notes.push(...p.notes);
      notes.push('Run `npm install` (or your package manager) so the lockfile picks up the new packages.');
    } catch {
      notes.push('package.json could not be parsed, so it was not changed. Add @opentelemetry/api and @opentelemetry/auto-instrumentations-node yourself.');
    }
  } else if (stack.language === 'python') {
    if (typeof files['requirements.txt'] === 'string') {
      const r = patchRequirements(files['requirements.txt']);
      if (r.changed) changes.push({ path: 'requirements.txt', content: r.content, why: 'adds opentelemetry-distro and opentelemetry-exporter-otlp' });
    } else {
      notes.push('Add `opentelemetry-distro` and `opentelemetry-exporter-otlp` to your dependencies (pyproject.toml was not edited automatically).');
    }
    if (typeof files.Procfile === 'string') {
      const p = patchProcfile(files.Procfile);
      if (p.changed) changes.push({ path: 'Procfile', content: p.content, why: 'starts the web process with opentelemetry-instrument' });
    } else {
      notes.push('Start the app with `opentelemetry-instrument <your usual start command>`, after running `opentelemetry-bootstrap -a install` once.');
    }
  }
  const doc = guide({ stack, serviceName, endpoint, notes, changedFiles: [...changes, { path: 'OPENTELEMETRY.md', why: 'this guide' }] });
  changes.push({ path: 'OPENTELEMETRY.md', content: doc, why: 'how tracing is set up and which environment variables to add' });
  return { stack, changes, notes };
}

const ROOT_FILES = ['package.json', 'requirements.txt', 'pyproject.toml', 'Procfile', 'go.mod', 'pom.xml', 'build.gradle'];

module.exports = { detectStack, patchPackageJson, patchRequirements, patchProcfile, planInstrumentation, ROOT_FILES, NODE_REGISTER };
