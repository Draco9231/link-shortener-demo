import { AuditLog } from './audit.js';

const fatal = (message) => Object.assign(new Error(message), { fatal: true });

// A stage looks like:
//   { id, title, deps: [ids], agent(args), fallback?(args), retries, approval?: {when, reason},
//     highImpact?, entryGate?(inputs, ctx), exitGate?(output, inputs), rollback?(output, ctx) }
// Gates return a reason string when they fail, nothing when they pass.
// Agents return { output, decisions?: [{ what, why }] }.
export class Workflow {
  constructor({ name, stages, policies = [], approver = null, context = {}, onStageDone = null, maxParallel = 4, now = Date.now }) {
    this.name = name;
    this.policies = policies;
    this.approver = approver;
    this.context = context;
    this.onStageDone = onStageDone;
    this.maxParallel = maxParallel;
    this.now = now;
    this.audit = new AuditLog(now);
    this.stages = new Map();
    this.state = new Map();
    this.counters = { retries: 0, fallbacks: 0, rollbacks: 0, replans: 0, approvalsGranted: 0, approvalsRejected: 0, policyViolations: 0 };
    this.recoveryTimes = [];
    this.doneCount = 0;
    this.stopped = false;
    this.stopReason = null;
    this.status = 'created';

    for (const s of stages) {
      if (this.stages.has(s.id)) throw new Error(`duplicate stage id: ${s.id}`);
      if (s.highImpact && !s.approval) throw new Error(`stage ${s.id} is high impact but has no approval checkpoint`);
      this.stages.set(s.id, { deps: [], retries: 0, ...s });
      this.state.set(s.id, this.#freshState());
    }
    for (const s of this.stages.values()) {
      for (const d of s.deps) if (!this.stages.has(d)) throw new Error(`stage ${s.id} depends on unknown stage ${d}`);
    }
    this.#assertAcyclic();
  }

  #freshState(prev) {
    return {
      status: 'pending', attempts: 0, failures: [], output: null, lineage: [], firstFailureAt: null,
      version: prev?.version ?? 0, epoch: (prev?.epoch ?? -1) + 1, replans: prev?.replans ?? 0,
      startedAt: null, endedAt: null, error: null,
    };
  }

  #assertAcyclic() {
    const remaining = new Map([...this.stages].map(([id, s]) => [id, new Set(s.deps)]));
    while (remaining.size) {
      const free = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id);
      if (!free.length) throw new Error(`dependency cycle among: ${[...remaining.keys()].join(', ')}`);
      for (const id of free) remaining.delete(id);
      for (const deps of remaining.values()) for (const id of free) deps.delete(id);
    }
  }

  descendants(id) {
    const found = new Set();
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift();
      for (const s of this.stages.values()) {
        if (s.deps.includes(cur) && !found.has(s.id)) {
          found.add(s.id);
          queue.push(s.id);
        }
      }
    }
    return found;
  }

  #ready() {
    return [...this.stages.values()].filter(
      (s) => this.state.get(s.id).status === 'pending' && s.deps.every((d) => this.state.get(d).status === 'done'),
    );
  }

  async run() {
    this.startedAt = this.now();
    this.status = 'running';
    this.audit.log('workflow.start', null, { name: this.name, stages: [...this.stages.keys()] });

    const running = new Map();
    for (;;) {
      if (!this.stopped) {
        for (const s of this.#ready()) {
          if (running.size >= this.maxParallel) break;
          running.set(s.id, this.#execute(s).finally(() => running.delete(s.id)));
        }
      }
      if (!running.size) break;
      await Promise.race(running.values());
    }

    if (this.stopped) await this.#unwind();
    else if ([...this.state.values()].some((s) => s.status !== 'done')) this.stopReason = 'workflow stalled';
    this.endedAt = this.now();
    this.status = this.stopped ? 'safe_stopped' : this.stopReason ? 'stalled' : 'succeeded';
    this.audit.log('workflow.end', null, { status: this.status, reason: this.stopReason });
    return this.report();
  }

  async #execute(stage) {
    const st = this.state.get(stage.id);
    const epoch = st.epoch;
    const stale = () => st.epoch !== epoch;
    const inputs = Object.fromEntries(stage.deps.map((d) => [d, this.state.get(d).output]));

    st.status = 'running';
    st.startedAt = this.now();
    st.lineage = stage.deps.map((d) => ({ stage: d, version: this.state.get(d).version }));
    this.audit.log('stage.start', stage.id, { lineage: st.lineage });

    try {
      const blocked = stage.entryGate?.(inputs, this.context);
      if (blocked) throw fatal(`entry gate not met: ${blocked}`);
      if (stage.approval?.when === 'before') await this.#checkpoint(stage, 'before', null);

      let result = await this.#runAgents(stage, st, inputs, stale);
      if (stale()) return this.audit.log('stage.discarded', stage.id, { reason: 'upstream changed while running' });
      if (stage.approval?.when === 'after') result = await this.#checkpoint(stage, 'after', result);
      if (stale()) return this.audit.log('stage.discarded', stage.id, { reason: 'upstream changed during approval' });

      st.output = result.output;
      st.version++;
      st.status = 'done';
      st.endedAt = this.now();
      st.doneOrder = ++this.doneCount;
      if (st.firstFailureAt !== null) this.recoveryTimes.push(st.endedAt - st.firstFailureAt);
      this.audit.log('stage.done', stage.id, { version: st.version, attempts: st.attempts });
      this.onStageDone?.(stage, this);
    } catch (err) {
      if (stale()) return;
      st.status = 'failed';
      st.error = err.message;
      st.endedAt = this.now();
      this.audit.log('stage.failed', stage.id, { error: err.message });
      this.#safeStop(`stage ${stage.id} failed: ${err.message}`);
    }
  }

  async #runAgents(stage, st, inputs, stale) {
    const chain = [{ agent: stage.agent, fallback: false, tries: stage.retries + 1 }];
    if (stage.fallback) chain.push({ agent: stage.fallback, fallback: true, tries: 1 });

    let attempt = 0;
    let lastError = 'unknown';
    for (const step of chain) {
      for (let i = 0; i < step.tries; i++) {
        if (stale()) return null;
        attempt++;
        st.attempts = attempt;
        if (step.fallback) {
          this.counters.fallbacks++;
          this.audit.log('stage.fallback', stage.id, { after: lastError });
        } else if (attempt > 1) {
          this.counters.retries++;
          this.audit.log('stage.retry', stage.id, { attempt, after: lastError });
        }
        try {
          const result = await step.agent({ stage, inputs, attempt, isFallback: step.fallback, context: this.context });
          this.#enforcePolicies(stage, result.output);
          const failedGate = stage.exitGate?.(result.output, inputs);
          if (failedGate) throw new Error(`exit gate not met: ${failedGate}`);
          for (const d of result.decisions ?? []) this.audit.log('decision', stage.id, d);
          return result;
        } catch (err) {
          if (err.fatal) throw err;
          lastError = err.message;
          st.failures.push(err.message);
          st.firstFailureAt ??= this.now();
          this.audit.log('attempt.failed', stage.id, { attempt, error: err.message });
        }
      }
    }
    throw new Error(`gave up after ${attempt} attempts (${lastError})`);
  }

  #enforcePolicies(stage, output) {
    for (const p of this.policies) {
      const violation = p.check(output, stage, this.context);
      if (violation) {
        this.counters.policyViolations++;
        this.audit.log('policy.violation', stage.id, { policy: p.id, violation });
        throw fatal(`policy ${p.id}: ${violation}`);
      }
    }
  }

  async #checkpoint(stage, phase, result) {
    this.audit.log('approval.requested', stage.id, { phase, reason: stage.approval.reason });
    const decision = this.approver
      ? await this.approver({ stage: stage.id, title: stage.title, phase, reason: stage.approval.reason, output: result?.output ?? null, context: this.context })
      : { approved: false, comment: 'no approver configured' };

    if (!decision?.approved) {
      this.counters.approvalsRejected++;
      this.audit.log('approval.rejected', stage.id, { by: decision?.by ?? 'nobody', comment: decision?.comment ?? '' });
      throw fatal(`not approved: ${decision?.comment ?? 'no reason given'}`);
    }
    this.counters.approvalsGranted++;
    this.audit.log('approval.granted', stage.id, { by: decision.by ?? 'reviewer', comment: decision.comment ?? '' });

    if (decision.amend && result) {
      this.audit.log('human.amend', stage.id, { amend: decision.amend });
      return { ...result, output: { ...result.output, ...decision.amend } };
    }
    return result;
  }

  #safeStop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    this.audit.log('workflow.safe_stop', null, { reason });
  }

  // After a safe stop: skip what never started, undo what finished (newest first).
  async #unwind() {
    for (const [id, st] of this.state) {
      if (st.status === 'pending') {
        st.status = 'skipped';
        this.audit.log('stage.skipped', id, {});
      }
    }
    const finished = [...this.state]
      .filter(([id, st]) => st.status === 'done' && this.stages.get(id).rollback)
      .sort((a, b) => b[1].doneOrder - a[1].doneOrder);
    for (const [id, st] of finished) {
      try {
        await this.stages.get(id).rollback(st.output, this.context);
        st.status = 'rolled_back';
        this.counters.rollbacks++;
        this.audit.log('stage.rolled_back', id, {});
      } catch (err) {
        this.audit.log('rollback.failed', id, { error: err.message });
      }
    }
  }

  // Change a finished stage's output and re-plan everything downstream of it.
  replan(stageId, patch, reason) {
    const st = this.state.get(stageId);
    st.output = { ...st.output, ...patch };
    st.version++;
    const affected = [...this.descendants(stageId)];
    // Reset in place: a run that is still in flight holds this object and checks its epoch when it finishes.
    for (const id of affected) {
      const old = this.state.get(id);
      Object.assign(old, this.#freshState(old));
      old.replans++;
    }
    this.counters.replans++;
    this.audit.log('replan', stageId, { reason, patch, invalidated: affected, newVersion: st.version });
  }

  metrics() {
    const states = [...this.state.values()];
    const done = states.filter((s) => s.status === 'done' || s.status === 'rolled_back').length;
    const mttr = this.recoveryTimes.length ? this.recoveryTimes.reduce((a, b) => a + b, 0) / this.recoveryTimes.length : null;
    return {
      stages: states.length,
      succeeded: done,
      successRate: states.length ? Number((done / states.length).toFixed(2)) : 0,
      attempts: states.reduce((n, s) => n + s.attempts, 0),
      ...this.counters,
      retryRate: this.counters.retries / Math.max(1, states.reduce((n, s) => n + s.attempts, 0)),
      mttrMs: mttr,
      endToEndMs: (this.endedAt ?? this.now()) - this.startedAt,
    };
  }

  report() {
    return {
      name: this.name,
      status: this.status,
      stopReason: this.stopReason,
      auditIntact: this.audit.verify(),
      metrics: this.metrics(),
      stages: [...this.state].map(([id, s]) => ({
        id, status: s.status, attempts: s.attempts, version: s.version, replans: s.replans, lineage: s.lineage, error: s.error,
      })),
    };
  }
}
