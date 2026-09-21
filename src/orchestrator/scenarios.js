import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workflow } from './engine.js';
import { defaultPolicies } from './policies.js';
import * as agent from './agents.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const remove = async (output) => output.writes.forEach((f) => fs.rmSync(f, { force: true }));

// The dependency graph. requirements fans out to decompose (and codebase, for brownfield work),
// test / security / docs run in parallel, and readiness joins them before the gated release.
export function buildStages({ brownfield }) {
  const base = { retries: 2 };
  const stages = [
    { ...base, id: 'requirements', title: 'Understand requirements', agent: agent.requirements, approval: { when: 'after', reason: 'confirm the requirements and answer open questions' } },
    { ...base, id: 'decompose', title: 'Break work into tasks', deps: ['requirements'], agent: agent.decompose },
    { ...base, id: 'design', title: 'Design', deps: ['requirements', 'decompose', ...(brownfield ? ['codebase'] : [])], agent: agent.design,
      entryGate: (inputs) => {
        const open = inputs.requirements.ambiguities.filter((a) => !inputs.requirements.resolved[a.term]).map((a) => a.term);
        return open.length ? `unresolved ambiguities: ${open.join(', ')}` : null;
      } },
    { ...base, id: 'implement', title: 'Implement', deps: ['design', ...(brownfield ? ['codebase'] : [])], agent: agent.implement },
    { ...base, id: 'test', title: 'Run tests', deps: ['implement'], agent: agent.test, exitGate: agent.testGate },
    { ...base, id: 'security', title: 'Security review', deps: ['implement'], agent: agent.security, fallback: agent.securityLite },
    { ...base, id: 'docs', title: 'Write docs', deps: ['design', 'implement'], agent: agent.docs, rollback: remove },
    { ...base, id: 'readiness', title: 'Release readiness', deps: ['test', 'security', 'docs'], agent: agent.readiness },
    { ...base, id: 'release', title: 'Prepare release', deps: ['readiness'], agent: agent.release, highImpact: true, retries: 0,
      approval: { when: 'before', reason: 'releasing is high impact and needs a named human' },
      entryGate: (inputs) => (inputs.readiness.ready ? null : 'readiness checklist has failures'), rollback: remove },
  ];
  const all = stages.map((s) => s.id).filter((id) => id !== 'release');
  stages.push({ ...base, id: 'summary', title: 'Engineering summary', deps: [...all, 'release'], agent: agent.summary, rollback: remove });
  if (brownfield) {
    stages.splice(1, 0, { ...base, id: 'codebase', title: 'Analyse existing code', deps: ['requirements'], agent: agent.codebase });
  }
  return stages;
}

export const scenarios = {
  greenfield: {
    requirement: 'Build a URL shortener with a POST API to create short links, optional custom aliases, expiry in seconds, redirects, per-link click analytics, and a rate limit per client.',
    note: 'Clear requirements. One docs attempt is made to fail, to show retry and recovery time.',
    faults: { docs: { failFirst: 1 } },
  },
  brownfield: {
    requirement: 'Add a maximum click limit to existing links: once a link reaches its limit it should return 410 Gone and stop counting clicks.',
    note: 'Change to existing code. The codebase agent finds the impacted modules. The full security review is made to fail so the fallback runs.',
    brownfield: true,
    faults: { security: { failPrimary: true } },
  },
  ambiguous: {
    requirement: 'Make the link shortener fast and secure, and able to scale. Links should expire soon.',
    note: 'Vague request. Design is blocked until a human answers the open questions, then a stakeholder changes an answer mid-run and downstream work is re-planned.',
    answers: {
      fast: 'p95 redirect under 50 ms at 200 requests per second',
      secure: 'http(s) only, no private hosts, no embedded credentials, 60 requests per minute per client',
      scale: 'up to 1 million links, single instance for now',
      soon: 'default expiry of 7 days, configurable per link',
    },
    revision: { fast: 'p95 redirect under 20 ms at 200 requests per second' },
  },
};

export function scriptedApprover({ answers, approveRelease = true }) {
  return async ({ stage }) => {
    if (stage === 'requirements') {
      return { approved: true, by: 'product owner (scripted)', comment: 'answered the open questions', amend: answers ? { resolved: answers } : undefined };
    }
    if (stage === 'release') {
      return { approved: approveRelease, by: 'release manager (scripted)', comment: approveRelease ? 'looks good' : 'holding the release' };
    }
    return { approved: true, by: 'reviewer (scripted)' };
  };
}

export function createScenarioWorkflow(name, { outRoot = path.join(repoRoot, 'out'), approver, approveRelease = true, testRunner, now } = {}) {
  const sc = scenarios[name];
  if (!sc) throw new Error(`unknown scenario "${name}". Try: ${Object.keys(scenarios).join(', ')}`);
  const context = { repoRoot, outDir: path.join(outRoot, name), requirement: sc.requirement, brownfield: !!sc.brownfield, faults: sc.faults, testRunner };
  fs.rmSync(context.outDir, { recursive: true, force: true });
  fs.mkdirSync(context.outDir, { recursive: true });

  return new Workflow({
    name,
    stages: buildStages({ brownfield: !!sc.brownfield }),
    policies: defaultPolicies,
    approver: approver ?? scriptedApprover({ answers: sc.answers, approveRelease }),
    context,
    now,
    onStageDone: (stage, wf) => {
      // Simulates a stakeholder changing their mind after seeing the design.
      if (sc.revision && stage.id === 'design' && !context.revised) {
        context.revised = true;
        wf.replan('requirements', { resolved: { ...wf.state.get('requirements').output.resolved, ...sc.revision } }, 'stakeholder tightened a target after reviewing the design');
      }
    },
  });
}

export async function runScenario(name, options = {}) {
  const wf = createScenarioWorkflow(name, options);
  const report = await wf.run();
  fs.writeFileSync(path.join(wf.context.outDir, 'audit.jsonl'), wf.audit.toJsonl());
  fs.writeFileSync(path.join(wf.context.outDir, 'report.json'), JSON.stringify(report, null, 2));
  return { wf, report };
}
