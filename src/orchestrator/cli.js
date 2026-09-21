import readline from 'node:readline/promises';
import { createScenarioWorkflow, scenarios } from './scenarios.js';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
const flag = (f) => args.includes(`--${f}`);

if (!name || !scenarios[name]) {
  console.log(`usage: node src/orchestrator/cli.js <${Object.keys(scenarios).join('|')}> [--interactive] [--reject-release]`);
  process.exit(1);
}

let rl;
function interactiveApprover() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return async ({ stage, reason, output }) => {
    console.log(`\n  ? approval needed for "${stage}": ${reason}`);
    const answers = {};
    for (const a of output?.ambiguities ?? []) {
      const reply = await rl.question(`    ${a.question}\n    > `);
      if (reply.trim()) answers[a.term] = reply.trim();
    }
    const ok = (await rl.question('    approve? [y/N] ')).trim().toLowerCase() === 'y';
    return { approved: ok, by: 'you', comment: ok ? '' : 'declined at the prompt', amend: Object.keys(answers).length ? { resolved: answers } : undefined };
  };
}

const wf = createScenarioWorkflow(name, {
  approveRelease: !flag('reject-release'),
  approver: flag('interactive') ? interactiveApprover() : undefined,
});

const interesting = new Set(['stage.start', 'stage.done', 'stage.failed', 'stage.retry', 'stage.fallback', 'approval.granted', 'approval.rejected', 'replan', 'workflow.safe_stop', 'stage.rolled_back', 'stage.skipped', 'stage.discarded', 'policy.violation']);
const t0 = Date.now();
wf.audit.onEntry = (e) => {
  if (!interesting.has(e.type)) return;
  const detail = e.data.error ?? e.data.reason ?? e.data.by ?? (e.type === 'replan' ? `invalidated ${e.data.invalidated.join(', ')}` : '');
  console.log(`  +${String(Date.now() - t0).padStart(5)}ms  ${e.type.padEnd(18)} ${(e.stage ?? '').padEnd(13)} ${detail}`);
};

console.log(`\nScenario: ${name}\n  ${scenarios[name].requirement}\n  (${scenarios[name].note})\n`);
const report = await wf.run();
rl?.close();

fs.writeFileSync(path.join(wf.context.outDir, 'audit.jsonl'), wf.audit.toJsonl());
fs.writeFileSync(path.join(wf.context.outDir, 'report.json'), JSON.stringify(report, null, 2));

const m = report.metrics;
console.log(`\nResult: ${report.status}${report.stopReason ? ` (${report.stopReason})` : ''}`);
console.table(report.stages.map(({ id, status, attempts, version, replans }) => ({ stage: id, status, attempts, version, replans })));
console.log(`success rate ${m.successRate}  retries ${m.retries}  fallbacks ${m.fallbacks}  rollbacks ${m.rollbacks}  replans ${m.replans}  MTTR ${m.mttrMs === null ? 'n/a' : `${Math.round(m.mttrMs)}ms`}  end-to-end ${m.endToEndMs}ms`);
console.log(`audit chain intact: ${report.auditIntact}\nArtifacts in ${wf.context.outDir}\n`);
process.exit(report.status === 'succeeded' ? 0 : 2);
