import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { validateUrl } from '../shortener/validate.js';

// These agents are deterministic on purpose: the point of the prototype is the governed workflow around them.
// Each one has the same shape a model-backed agent would have, so swapping one in is a local change.

const VAGUE_TERMS = [
  ['fast', /\b(fast|quick(ly)?)\b/i, 'What latency counts as fast (for example p95 redirect time), and at what request rate?'],
  ['secure', /\b(secure|safe)\b/i, 'Which threats matter most: open redirects, abuse, private hosts, data leaks?'],
  ['scale', /\bscal(e|able|ing)\b/i, 'How many links and redirects per day, and is a single instance acceptable?'],
  ['soon', /\b(soon|shortly)\b/i, 'How long should a link live before it expires?'],
  ['reliable', /\breliab(le|ility)\b/i, 'What uptime or data-loss tolerance is expected?'],
];

const STOP_WORDS = new Set(['existing', 'reaches', 'return', 'should', 'stop', 'once', 'maximum', 'links', 'counting', 'gone']);

export function writeArtifact(ctx, name, content) {
  const file = path.join(ctx.outDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function injectFault(ctx, stageId, { attempt, isFallback }) {
  const f = ctx.faults?.[stageId];
  if (!f) return;
  if (f.failFirst && attempt <= f.failFirst) throw new Error(`injected fault in ${stageId} (attempt ${attempt})`);
  if (f.failPrimary && !isFallback) throw new Error(`injected fault in ${stageId} primary agent`);
}

const listJs = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
const shortenerDir = (ctx) => path.join(ctx.repoRoot, 'src/shortener');

export const requirements = async ({ context }) => {
  const parts = context.requirement.split(/[.;:]|,\s*(?:and\s+)?/).map((p) => p.trim()).filter((p) => p.length > 3);
  const ambiguities = VAGUE_TERMS.filter(([, re]) => re.test(context.requirement)).map(([term, , question]) => ({ term, question }));
  return {
    output: {
      problem: context.requirement,
      requirements: parts.map((text, i) => ({ id: `R${i + 1}`, text })),
      ambiguities,
      resolved: {},
      assumptions: ['Single instance, in-memory store with a JSON file mirror', 'No user accounts; links are public', 'Redirects use 302 so every click can be counted'],
    },
    decisions: [{ what: `Split the request into ${parts.length} requirements`, why: 'each one can be built and tested on its own' }, ...ambiguities.map((a) => ({ what: `Flagged "${a.term}" as ambiguous`, why: 'no measurable target given' }))],
  };
};

export const decompose = async ({ inputs }) => {
  const tasks = [];
  for (const r of inputs.requirements.requirements) {
    tasks.push({ id: `${r.id}-build`, title: `Build: ${r.text}`, dependsOn: [] });
    tasks.push({ id: `${r.id}-test`, title: `Test: ${r.text}`, dependsOn: [`${r.id}-build`] });
  }
  const builds = tasks.filter((t) => t.id.endsWith('-build')).map((t) => t.id);
  tasks.push({ id: 'docs', title: 'Write API and design docs', dependsOn: builds });
  tasks.push({ id: 'release-check', title: 'Release readiness check', dependsOn: tasks.filter((t) => t.id.endsWith('-test')).map((t) => t.id).concat('docs') });

  const level = {};
  const depth = (t) => (level[t.id] ??= t.dependsOn.length ? 1 + Math.max(...t.dependsOn.map((d) => depth(tasks.find((x) => x.id === d)))) : 0);
  tasks.forEach(depth);
  const waves = [];
  for (const t of tasks) (waves[level[t.id]] ??= []).push(t.id);
  return {
    output: { tasks, waves },
    decisions: [{ what: `Grouped ${tasks.length} tasks into ${waves.length} waves`, why: 'tasks in the same wave have no dependency on each other and can run in parallel' }],
  };
};

export const codebase = async ({ context }) => {
  const dir = shortenerDir(context);
  const files = listJs(dir).map((f) => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    return { file: `src/shortener/${f}`, loc: text.split('\n').length, text: text.toLowerCase(), imports: [...text.matchAll(/from '\.\/([\w-]+)\.js'/g)].map((m) => `src/shortener/${m[1]}.js`) };
  });
  const words = [...new Set(context.requirement.toLowerCase().match(/[a-z]{4,}/g))]
    .map((w) => w.replace(/s$/, ''))
    .filter((w) => !STOP_WORDS.has(w));
  // A keyword that appears in every file says nothing about impact.
  const keywords = words.filter((w) => files.some((f) => f.text.includes(w)) && !files.every((f) => f.text.includes(w)));
  const hits = files.map((f) => ({ file: f.file, matches: keywords.filter((k) => f.text.includes(k)) })).filter((h) => h.matches.length);
  const hitFiles = new Set(hits.map((h) => h.file));
  const importers = files.filter((f) => f.imports.some((i) => hitFiles.has(i)) && !hitFiles.has(f.file)).map((f) => f.file);
  return {
    output: {
      modules: files.map(({ file, loc, imports }) => ({ file, loc, imports })),
      keywords,
      impacted: hits,
      indirectlyImpacted: importers,
    },
    decisions: [{ what: `Impact set: ${hits.map((h) => h.file).join(', ') || 'none'}`, why: `these modules mention ${keywords.join(', ')}; importers are checked for knock-on changes` }],
  };
};

export const design = async ({ inputs, context }) => {
  const resolved = inputs.requirements.resolved;
  const decisions = [
    { what: 'Redirect with 302', why: 'a 301 would be cached by browsers and hide clicks from analytics' },
    { what: 'Reject private and loopback hosts at creation time', why: 'stops the service being used to point people at internal addresses' },
    { what: 'Fixed-window rate limit per client address', why: 'cheap, predictable, good enough for a single instance' },
    ...Object.entries(resolved).map(([term, answer]) => ({ what: `Read "${term}" as: ${answer}`, why: 'confirmed by a human reviewer' })),
  ];
  const output = {
    components: ['validate (input rules)', 'service (business logic)', 'store (memory + JSON file)', 'ratelimit', 'server (HTTP routes)'],
    apis: ['POST /api/links', 'GET /:code', 'GET /api/links/:code/stats', 'DELETE /api/links/:code', 'GET /health'],
    risks: [
      { risk: 'Single instance: state lives in one process', mitigation: 'JSON mirror gives restart safety; a shared database is the next step for scale-out' },
      { risk: 'Open redirect / abuse of the service', mitigation: 'http(s) only, no credentials in urls, no private hosts, rate limit' },
      { risk: 'Alias collisions and code guessing', mitigation: '409 on clashes; random 7-char codes with bounded retries' },
    ],
    resolved,
    decisions,
  };
  if (context.brownfield && inputs.codebase) {
    output.changes = [...inputs.codebase.impacted.map((h) => ({ file: h.file, kind: 'modify', because: `mentions ${h.matches.join(', ')}` })), ...inputs.codebase.indirectlyImpacted.map((f) => ({ file: f, kind: 'review', because: 'imports a modified module' }))];
  }
  return { output, decisions };
};

export const implement = async ({ inputs, context }) => {
  const dir = shortenerDir(context);
  const files = listJs(dir).map((f) => ({ file: `src/shortener/${f}`, loc: fs.readFileSync(path.join(dir, f), 'utf8').split('\n').length }));
  const output = { mode: context.brownfield ? 'change-plan' : 'verify-existing', files };
  if (context.brownfield) {
    // Agents propose, humans apply: the plan is a reviewable artifact, not an automatic edit.
    output.changePlan = inputs.design.changes ?? [];
  }
  return { output, decisions: [{ what: context.brownfield ? 'Produced a change plan instead of editing code' : 'Confirmed modules match the design', why: 'code changes to a live service stay under human control' }] };
};

function runTestFiles(ctx) {
  const dir = path.join(ctx.repoRoot, 'test/shortener');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).map((f) => path.join(dir, f));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: ctx.repoRoot });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', () => {
      const n = (name) => Number(out.match(new RegExp(`^# ${name} (\\d+)`, 'm'))?.[1] ?? 0);
      resolve({ total: n('tests'), passed: n('pass'), failed: n('fail') });
    });
  });
}

export const test = async ({ context, attempt, isFallback }) => {
  injectFault(context, 'test', { attempt, isFallback });
  const run = await (context.testRunner ?? runTestFiles)(context);
  return { output: run, decisions: [{ what: `Ran the shortener test suite: ${run.passed}/${run.total} passed`, why: 'regression guard for both new and changed behaviour' }] };
};
export const testGate = (out) => (out.failed > 0 ? `${out.failed} tests failed` : out.passed === 0 ? 'no tests ran' : null);

const RISKY_CODE = [[/\beval\s*\(/, 'eval'], [/new Function\s*\(/, 'new Function'], [/child_process/, 'child_process'], [/(password|secret|api[_-]?key)\s*=\s*["']/i, 'hardcoded secret']];

function scanSource(ctx) {
  const dir = shortenerDir(ctx);
  const findings = [];
  for (const f of listJs(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const [re, label] of RISKY_CODE) if (re.test(text)) findings.push({ severity: 'high', msg: `${label} in ${f}` });
  }
  return findings;
}

export const security = async ({ context, attempt, isFallback }) => {
  injectFault(context, 'security', { attempt, isFallback });
  const findings = scanSource(context);
  // Exercise the real validator rather than trusting that it does what its name says.
  const probes = [['http://127.0.0.1/admin', false], ['http://localhost:8080', false], ['javascript:alert(1)', false], ['https://user:pw@example.com', false], ['https://example.com', true]];
  for (const [url, expected] of probes) {
    if (validateUrl(url).ok !== expected) findings.push({ severity: 'high', msg: `validator answered wrongly for ${url}` });
  }
  return { output: { findings, checks: ['source scan', `${probes.length} validator probes`] }, decisions: [{ what: `Security review found ${findings.length} issues`, why: 'source scan plus live validator probes' }] };
};

// Cheaper backup if the full review can't run: source scan only.
export const securityLite = async ({ context }) => ({
  output: { findings: scanSource(context), checks: ['source scan only (fallback)'] },
  decisions: [{ what: 'Used the lightweight scan', why: 'the full review failed; reduced coverage is recorded so a human can weigh it' }],
});

export const docs = async ({ inputs, context, attempt, isFallback }) => {
  injectFault(context, 'docs', { attempt, isFallback });
  const d = inputs.design;
  const body = [
    `# Design notes`, '', `**Problem:** ${context.requirement}`, '',
    '## Components', ...d.components.map((c) => `- ${c}`), '',
    '## API', ...d.apis.map((a) => `- \`${a}\``), '',
    '## Decisions', ...d.decisions.map((x) => `- ${x.what}`), '',
    '## Risks', ...d.risks.map((r) => `- ${r.risk} -> ${r.mitigation}`), '',
  ].join('\n');
  const file = writeArtifact(context, 'DESIGN.md', body);
  return { output: { writes: [file] }, decisions: [{ what: 'Generated DESIGN.md from the design output', why: 'docs come from the same source as the code decisions so they cannot drift' }] };
};

export const readiness = async ({ inputs }) => {
  const checklist = [
    { item: 'all tests pass', ok: inputs.test.failed === 0 && inputs.test.passed > 0 },
    { item: 'no high-severity security findings', ok: !inputs.security.findings.some((f) => f.severity === 'high') },
    { item: 'design docs written', ok: inputs.docs.writes.length > 0 },
  ];
  return { output: { ready: checklist.every((c) => c.ok), checklist }, decisions: [{ what: `Release ready: ${checklist.every((c) => c.ok)}`, why: 'joined the test, security and docs results' }] };
};

export const release = async ({ context }) => {
  const file = writeArtifact(context, 'RELEASE_NOTES.md', `# Release notes\n\nPackaged for review. Nothing is deployed by this workflow.\n`);
  return { output: { writes: [file], deployed: false }, decisions: [{ what: 'Wrote release notes only', why: 'deployment is out of scope and stays a human action' }] };
};

export const summary = async ({ inputs, context }) => {
  const tasks = inputs.decompose.tasks;
  const rel = (files) => files.map((f) => path.relative(context.repoRoot, f)).join(', ');
  const lines = [
    `# Engineering summary`, '', `> ${context.requirement}`, '',
    '## Plan and rationale',
    `- ${inputs.requirements.requirements.length} requirements became ${tasks.length} tasks in ${inputs.decompose.waves.length} waves.`,
    ...inputs.design.components.map((c) => `- Component: ${c}`),
    ...(Object.keys(inputs.design.resolved).length ? Object.entries(inputs.design.resolved).map(([k, v]) => `- Human-confirmed "${k}": ${v}`) : []),
    ...(inputs.codebase ? [`- Impacted modules: ${inputs.codebase.impacted.map((h) => h.file).join(', ') || 'none'}`] : []),
    '', '## Artifacts',
    `- Tests: ${inputs.test.passed}/${inputs.test.total} passing`,
    `- Docs: ${rel(inputs.docs.writes)}`,
    `- Release notes: ${rel(inputs.release.writes)}`,
    ...(inputs.implement.changePlan?.length ? ['- Change plan:', ...inputs.implement.changePlan.map((c) => `  - ${c.kind} ${c.file} (${c.because})`)] : []),
    '', '## Risks, trade-offs and validation',
    ...inputs.design.risks.map((r) => `- ${r.risk}. Mitigation: ${r.mitigation}`),
    `- Security review: ${inputs.security.findings.length} findings (${inputs.security.checks.join('; ')})`,
    ...inputs.readiness.checklist.map((c) => `- Readiness: ${c.item}: ${c.ok ? 'yes' : 'NO'}`),
    '', '## Assumptions', ...inputs.requirements.assumptions.map((a) => `- ${a}`),
    '', '## Limitations',
    '- Agents here are rule-based stand-ins, not language models.',
    '- Human approvals are scripted unless run with --interactive.',
    '- Storage is a single process; there is no shared database.',
    '- Release only writes notes; nothing is deployed.', '',
  ];
  const file = writeArtifact(context, 'SUMMARY.md', lines.join('\n'));
  return { output: { writes: [file] }, decisions: [{ what: 'Wrote the final engineering summary', why: 'one reviewable page tying plan, evidence and limits together' }] };
};
