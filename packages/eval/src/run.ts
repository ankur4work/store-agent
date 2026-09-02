import { Orchestrator, type MerchantPack, type ModelClient, type ModelTierMap } from '@storeagent/orchestrator';
import { CASES } from './cases.js';
import { isTainted, scoreReply, summarize } from './score.js';
import type { CaseResult, EvalCase, EvalReport } from './types.js';

const MERCHANT: MerchantPack = {
  merchantId: 'eval',
  brandVoice: 'Warm, direct, never pushy. Short sentences. No emoji.',
  policySummary: 'Free shipping over $75. Free returns within 30 days.',
  locale: 'en-US',
  currency: 'USD',
};

export interface RunOptions {
  readonly model: ModelClient;
  readonly models: ModelTierMap;
  /** Bound concurrency — the eval is not a load test. */
  readonly concurrency?: number;
  readonly filter?: (c: EvalCase) => boolean;
  readonly onResult?: (r: CaseResult) => void;
}

export async function runCase(c: EvalCase, opts: RunOptions): Promise<CaseResult> {
  const started = performance.now();

  const tools = {
    async execute(name: string, input: Record<string, unknown>): Promise<unknown> {
      const handler = c.tools[name];
      if (handler !== undefined) return handler(input);
      // Escalation is a capability of ours, not the merchant's storefront — it
      // does not depend on the catalog and should never be "down" unless a case
      // explicitly says so. Leaving it unfixtured made the agent apologise that
      // "the team handoff is unavailable", which is not a scenario we want to
      // be testing by accident.
      if (name === 'escalate_to_human') {
        return { ok: true, escalated: true, reason: String(input['reason'] ?? '') };
      }
      // Any other unfixtured tool is legitimately unavailable — that IS a
      // scenario (degrade rather than invent), not a harness error.
      return { error: true, message: `${name} unavailable` };
    },
  };

  const orchestrator = new Orchestrator({ model: opts.model, tools, models: opts.models });

  try {
    const result = await orchestrator.runTurn({
      message: c.message,
      context: { sessionId: `eval_${c.id}`, ...(c.page ? { page: c.page } : {}) },
      merchant: MERCHANT,
    });

    // A deliberate hand-off counts as an escalation for scoring — from the
    // shopper's side there is no difference, and it is the outcome we WANT.
    const failures = scoreReply(
      result.reply,
      c.truth,
      { escalated: result.escalated || result.handedOff },
      c.expect,
    );
    const tainted = isTainted(failures);

    return {
      id: c.id,
      category: c.category,
      reply: result.reply,
      tainted,
      failures,
      validatorOk: result.verdict.ok,
      escalated: result.escalated || result.handedOff,
      attempts: result.attempts,
      ms: performance.now() - started,
      // The two quadrants that matter. Scorer and validator disagreeing is the
      // signal; agreeing is just confirmation.
      escape: tainted && result.verdict.ok,
      falsePositive: !tainted && !result.verdict.ok,
    };
  } catch (err) {
    return {
      id: c.id,
      category: c.category,
      reply: '',
      tainted: false,
      failures: [{ kind: 'threw', detail: (err as Error).message }],
      validatorOk: false,
      escalated: false,
      attempts: 0,
      ms: performance.now() - started,
      escape: false,
      falsePositive: false,
    };
  }
}

export async function runEval(opts: RunOptions): Promise<EvalReport> {
  const cases = CASES.filter(opts.filter ?? (() => true));
  const limit = opts.concurrency ?? 4;
  const results: CaseResult[] = [];
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= cases.length) return;
      const r = await runCase(cases[i]!, opts);
      results.push(r);
      opts.onResult?.(r);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, cases.length) }, worker));
  // Restore corpus order so runs are comparable regardless of scheduling.
  results.sort((a, b) => cases.findIndex((c) => c.id === a.id) - cases.findIndex((c) => c.id === b.id));
  return summarize(results);
}
