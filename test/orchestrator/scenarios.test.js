import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScenario } from '../../src/orchestrator/scenarios.js';

// The real test stage would re-run the shortener suite; a stub keeps these tests quick.
const testRunner = async () => ({ total: 5, passed: 5, failed: 0 });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-'));

test('greenfield: succeeds, recovers from an injected docs failure', async () => {
  const outRoot = tmp();
  const { report } = await runScenario('greenfield', { outRoot, testRunner });
  assert.equal(report.status, 'succeeded');
  assert.equal(report.metrics.retries, 1);
  assert.ok(report.auditIntact);
  for (const f of ['SUMMARY.md', 'DESIGN.md', 'RELEASE_NOTES.md', 'audit.jsonl']) assert.ok(fs.existsSync(path.join(outRoot, 'greenfield', f)), f);
});

test('brownfield: finds impacted modules and falls back on the security review', async () => {
  const { wf, report } = await runScenario('brownfield', { outRoot: tmp(), testRunner });
  assert.equal(report.status, 'succeeded');
  assert.equal(report.metrics.fallbacks, 1);
  const files = wf.state.get('codebase').output.impacted.map((h) => h.file);
  assert.ok(files.includes('src/shortener/service.js'));
  assert.ok(wf.state.get('implement').output.changePlan.length > 0);
});

test('ambiguous: human answers unblock design, then a revision triggers a replan', async () => {
  const { wf, report } = await runScenario('ambiguous', { outRoot: tmp(), testRunner });
  assert.equal(report.status, 'succeeded');
  assert.equal(report.metrics.replans, 1);
  assert.match(wf.state.get('design').output.resolved.fast, /20 ms/);
  assert.equal(wf.state.get('design').replans, 1);
});

test('ambiguous with no human answers: design is blocked and the run stops', async () => {
  const approver = async () => ({ approved: true, by: 'someone in a hurry' });
  const { report } = await runScenario('ambiguous', { outRoot: tmp(), testRunner, approver });
  assert.equal(report.status, 'safe_stopped');
  assert.match(report.stopReason, /unresolved ambiguities/);
});

test('a rejected release rolls back written docs and skips the summary', async () => {
  const outRoot = tmp();
  const { report } = await runScenario('greenfield', { outRoot, testRunner, approveRelease: false });
  assert.equal(report.status, 'safe_stopped');
  assert.equal(fs.existsSync(path.join(outRoot, 'greenfield', 'DESIGN.md')), false);
  assert.equal(report.stages.find((s) => s.id === 'summary').status, 'skipped');
});
