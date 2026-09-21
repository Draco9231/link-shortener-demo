import test from 'node:test';
import assert from 'node:assert/strict';
import { Workflow } from '../../src/orchestrator/engine.js';
import { AuditLog } from '../../src/orchestrator/audit.js';
import { defaultPolicies } from '../../src/orchestrator/policies.js';

const ok = (output = {}) => async () => ({ output });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const types = (wf, type) => wf.audit.entries.filter((e) => e.type === type).map((e) => e.stage);

function flow(stages, extra = {}) {
  return new Workflow({ name: 't', stages, context: { outDir: '/tmp/out' }, approver: async () => ({ approved: true, by: 'tester' }), ...extra });
}

test('runs stages in dependency order and joins parallel branches', async () => {
  const order = [];
  const step = (id, ms = 0) => async () => { order.push(`${id}:start`); await sleep(ms); order.push(`${id}:end`); return { output: { id } }; };
  const wf = flow([
    { id: 'a', agent: step('a') },
    { id: 'b', deps: ['a'], agent: step('b', 30) },
    { id: 'c', deps: ['a'], agent: step('c', 10) },
    { id: 'd', deps: ['b', 'c'], agent: step('d') },
  ]);
  const report = await wf.run();
  assert.equal(report.status, 'succeeded');
  assert.ok(order.indexOf('b:start') < order.indexOf('c:end'), 'b and c overlap');
  assert.ok(order.indexOf('d:start') > order.indexOf('b:end') && order.indexOf('d:start') > order.indexOf('c:end'), 'd waits for both');
});

test('inputs from upstream stages are passed along and recorded as lineage', async () => {
  let seen;
  const wf = flow([
    { id: 'a', agent: ok({ n: 1 }) },
    { id: 'b', deps: ['a'], agent: async ({ inputs }) => { seen = inputs; return { output: {} }; } },
  ]);
  const report = await wf.run();
  assert.deepEqual(seen, { a: { n: 1 } });
  assert.deepEqual(report.stages.find((s) => s.id === 'b').lineage, [{ stage: 'a', version: 1 }]);
});

test('retries a flaky stage and records recovery time', async () => {
  let calls = 0;
  const wf = flow([{ id: 'a', retries: 2, agent: async () => { if (++calls < 3) throw new Error('flaky'); return { output: {} }; } }]);
  const report = await wf.run();
  assert.equal(report.status, 'succeeded');
  assert.equal(report.metrics.retries, 2);
  assert.notEqual(report.metrics.mttrMs, null);
});

test('retries are bounded, then the fallback runs', async () => {
  let primary = 0;
  const wf = flow([{ id: 'a', retries: 1, agent: async () => { primary++; throw new Error('down'); }, fallback: ok({ lite: true }) }]);
  const report = await wf.run();
  assert.equal(primary, 2);
  assert.equal(report.status, 'succeeded');
  assert.equal(report.metrics.fallbacks, 1);
  assert.deepEqual(wf.state.get('a').output, { lite: true });
});

test('failure safe-stops, skips what never ran, and rolls back finished work newest first', async () => {
  const undone = [];
  const wf = flow([
    { id: 'a', agent: ok({ x: 'a' }), rollback: async (o) => undone.push(o.x) },
    { id: 'b', deps: ['a'], agent: ok({ x: 'b' }), rollback: async (o) => undone.push(o.x) },
    { id: 'c', deps: ['b'], retries: 1, agent: async () => { throw new Error('boom'); } },
    { id: 'd', deps: ['c'], agent: ok() },
  ]);
  const report = await wf.run();
  assert.equal(report.status, 'safe_stopped');
  assert.deepEqual(undone, ['b', 'a']);
  const status = Object.fromEntries(report.stages.map((s) => [s.id, s.status]));
  assert.deepEqual(status, { a: 'rolled_back', b: 'rolled_back', c: 'failed', d: 'skipped' });
  assert.equal(report.metrics.rollbacks, 2);
});

test('a failing gate stops the flow without retrying', async () => {
  let calls = 0;
  const wf = flow([
    { id: 'a', agent: ok() },
    { id: 'b', deps: ['a'], agent: async () => { calls++; return { output: {} }; }, entryGate: () => 'not allowed yet' },
  ]);
  const report = await wf.run();
  assert.equal(calls, 0);
  assert.match(report.stopReason, /entry gate not met: not allowed yet/);
});

test('an exit gate failure counts as a failed attempt', async () => {
  let calls = 0;
  const wf = flow([{ id: 'a', retries: 1, agent: async () => ({ output: { good: ++calls > 1 } }), exitGate: (o) => (o.good ? null : 'not good') }]);
  assert.equal((await wf.run()).status, 'succeeded');
  assert.equal(calls, 2);
});

test('high-impact stages must declare an approval checkpoint', () => {
  assert.throws(() => flow([{ id: 'r', highImpact: true, agent: ok() }]), /no approval checkpoint/);
});

test('approval rejection stops the flow; no approver means denied', async () => {
  const rejecting = flow([{ id: 'r', agent: ok(), approval: { when: 'before', reason: 'x' } }], { approver: async () => ({ approved: false, by: 'boss', comment: 'no' }) });
  assert.equal((await rejecting.run()).status, 'safe_stopped');
  assert.equal(rejecting.metrics().approvalsRejected, 1);

  const unattended = flow([{ id: 'r', agent: ok(), approval: { when: 'before', reason: 'x' } }], { approver: null });
  assert.equal((await unattended.run()).status, 'safe_stopped');
});

test('a human can amend output at an after-checkpoint and it is audited', async () => {
  const wf = flow([{ id: 'a', agent: ok({ v: 1 }), approval: { when: 'after', reason: 'x' } }], { approver: async () => ({ approved: true, amend: { v: 2 } }) });
  await wf.run();
  assert.equal(wf.state.get('a').output.v, 2);
  assert.deepEqual(types(wf, 'human.amend'), ['a']);
});

test('policy violations are fatal and never retried', async () => {
  let calls = 0;
  const wf = flow([{ id: 'a', retries: 3, agent: async () => { calls++; return { output: { note: 'password = "hunter2hunter2"' } }; } }], { policies: defaultPolicies });
  const report = await wf.run();
  assert.equal(calls, 1);
  assert.equal(report.status, 'safe_stopped');
  assert.equal(report.metrics.policyViolations, 1);
});

test('writes outside the output folder are blocked', async () => {
  const wf = flow([{ id: 'a', agent: ok({ writes: ['/etc/passwd'] }) }], { policies: defaultPolicies });
  assert.match((await wf.run()).stopReason, /write outside allowed folder/);
});

test('replan invalidates downstream stages and reruns them with the new input', async () => {
  const seen = [];
  const wf = flow([
    { id: 'a', agent: ok({ target: 'slow' }) },
    { id: 'b', deps: ['a'], agent: async ({ inputs }) => { seen.push(inputs.a.target); return { output: {} }; } },
    { id: 'c', deps: ['b'], agent: ok() },
  ], {
    onStageDone: (stage, w) => { if (stage.id === 'b' && seen.length === 1) w.replan('a', { target: 'fast' }, 'target changed'); },
  });
  const report = await wf.run();
  assert.deepEqual(seen, ['slow', 'fast']);
  assert.equal(report.status, 'succeeded');
  assert.equal(wf.state.get('a').version, 2);
  assert.equal(wf.state.get('b').replans, 1);
});

test('a run in flight during a replan is discarded, not applied', async () => {
  let runs = 0;
  const wf = flow([
    { id: 'a', agent: ok({ v: 1 }) },
    { id: 'slow', deps: ['a'], agent: async ({ inputs }) => { runs++; await sleep(40); return { output: { sawV: inputs.a.v } }; } },
    { id: 'quick', deps: ['a'], agent: ok() },
  ], {
    onStageDone: (stage, w) => { if (stage.id === 'quick' && !w.context.done) { w.context.done = true; w.replan('a', { v: 2 }, 'changed'); } },
  });
  await wf.run();
  assert.equal(runs, 2);
  assert.equal(wf.state.get('slow').output.sawV, 2);
  assert.deepEqual(types(wf, 'stage.discarded'), ['slow']);
});

test('bad graphs are rejected up front', () => {
  assert.throws(() => flow([{ id: 'a', deps: ['b'], agent: ok() }, { id: 'b', deps: ['a'], agent: ok() }]), /cycle/);
  assert.throws(() => flow([{ id: 'a', deps: ['zzz'], agent: ok() }]), /unknown stage/);
  assert.throws(() => flow([{ id: 'a', agent: ok() }, { id: 'a', agent: ok() }]), /duplicate/);
});

test('audit log is hash-chained and tampering is detected', async () => {
  const wf = flow([{ id: 'a', agent: ok() }]);
  await wf.run();
  assert.equal(wf.audit.verify(), true);
  wf.audit.entries[1].data = { tampered: true };
  assert.equal(wf.audit.verify(), false);
  assert.equal(new AuditLog().verify(), true);
});

test('metrics cover success rate and latency', async () => {
  let t = 0;
  const wf = flow([{ id: 'a', agent: ok() }, { id: 'b', deps: ['a'], agent: ok() }], { now: () => (t += 10) });
  const { metrics } = await wf.run();
  assert.equal(metrics.successRate, 1);
  assert.ok(metrics.endToEndMs > 0);
});
