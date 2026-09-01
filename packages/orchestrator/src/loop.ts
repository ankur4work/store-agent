import {
  GROUNDED_RESPONSE_SCHEMA,
  validateGrounding,
  violationsToFeedback,
  type GroundedResponse,
  type GroundingVerdict,
  type ToolResultRecord,
} from '@storeagent/grounding';
import {
  firstText,
  toolUses,
  type Message,
  type ModelClient,
  type ModelResponse,
  type ModelTierMap,
  type ToolResultBlock,
} from './model.js';
import { buildCachedPrefix, prefixFingerprint, renderTurnContext, type MerchantPack, type TurnContext } from './prompt.js';
import { detectFrustration, route, type Route } from './router.js';
import { planSpeculation, speculationMatches } from './speculate.js';
import { DEFAULT_TOOLS, type ToolExecutor } from './tools.js';

const MAX_TOOL_ITERATIONS = 6;

/** The escalation reply. There are no dead ends — see EXPERIENCE-CONTRACT §3. */
const ESCALATION_REPLY =
  "I don't want to guess on that one. Let me get the team to confirm — " +
  "what's the best email to reach you on?";

export interface TurnInput {
  readonly message: string;
  readonly context: TurnContext;
  readonly merchant: MerchantPack;
  readonly history?: readonly Message[];
}

export interface TurnEvent {
  readonly type: 'tool_start' | 'tool_end' | 'speculation_hit' | 'speculation_miss' | 'grounding_retry' | 'escalated';
  readonly detail?: string;
}

export interface TurnResult {
  readonly reply: string;
  readonly verdict: GroundingVerdict;
  readonly escalated: boolean;
  readonly route: Route;
  readonly toolResults: readonly ToolResultRecord[];
  readonly prefixFingerprint: string;
  readonly events: readonly TurnEvent[];
  readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number };
  readonly attempts: number;
}

export interface OrchestratorDeps {
  readonly model: ModelClient;
  readonly tools: ToolExecutor;
  /** Provider-neutral tier → model id map. Defaults to OPENAI_MODELS. */
  readonly models?: ModelTierMap;
  readonly onEvent?: (e: TurnEvent) => void;
}

/**
 * One conversational turn.
 *
 * Flow:
 *   1. Fire a speculative catalog search in parallel with the model request.
 *   2. Run the tool loop until the model stops asking for tools.
 *   3. Parse the structured response and validate grounding deterministically.
 *   4. On failure, regenerate ONCE with the specific violations as feedback.
 *   5. On second failure, escalate. Never ship an ungrounded answer.
 */
export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async runTurn(input: TurnInput, signal?: AbortSignal): Promise<TurnResult> {
    const events: TurnEvent[] = [];
    const emit = (e: TurnEvent): void => {
      events.push(e);
      this.deps.onEvent?.(e);
    };

    const system = buildCachedPrefix(input.merchant);
    const fingerprint = prefixFingerprint(system);

    // --- 1. Speculative prefetch, in parallel with everything below --------
    const plan = planSpeculation(input.message, input.context.page?.title);
    const speculation = plan.shouldSearch
      ? this.deps.tools
          .execute('search_catalog', { query: plan.query, limit: 6 }, signal)
          .catch(() => undefined)
      : undefined;

    const ctxBlock = renderTurnContext(input.context);
    const userText = ctxBlock === '' ? input.message : `${ctxBlock}\n\n${input.message}`;

    const usage = { input: 0, output: 0, cacheRead: 0 };
    const toolResults: ToolResultRecord[] = [];
    let attempts = 0;
    let lastVerdict: GroundingVerdict = { ok: false, violations: [] };
    let chosenRoute = route({ toolDepth: 0, frustration: detectFrustration(input.message) }, this.deps.models);

    // Two attempts: the original, then one grounded retry with feedback.
    for (attempts = 1; attempts <= 2; attempts++) {
      const messages: Message[] = [
        ...(input.history ?? []),
        { role: 'user', content: attempts === 1 ? userText : `${userText}\n\n${violationsToFeedback(lastVerdict.violations)}` },
      ];

      chosenRoute = route(
        {
          toolDepth: 0,
          frustration: detectFrustration(input.message),
          groundingRetry: attempts > 1,
        },
        this.deps.models,
      );

      const outcome = await this.runToolLoop({
        system,
        messages,
        route: chosenRoute,
        speculation,
        speculatedQuery: plan.query,
        toolResults,
        usage,
        emit,
        signal,
      });

      if (outcome.kind === 'refusal' || outcome.kind === 'exhausted') {
        emit({ type: 'escalated', detail: outcome.kind });
        return this.escalate(events, chosenRoute, toolResults, fingerprint, usage, attempts);
      }

      const parsed = parseGrounded(outcome.text);
      if (parsed === undefined) {
        emit({ type: 'escalated', detail: 'unparseable structured output' });
        return this.escalate(events, chosenRoute, toolResults, fingerprint, usage, attempts);
      }

      lastVerdict = validateGrounding(parsed, toolResults);
      if (lastVerdict.ok) {
        return {
          reply: parsed.reply,
          verdict: lastVerdict,
          escalated: false,
          route: chosenRoute,
          toolResults,
          prefixFingerprint: fingerprint,
          events,
          usage,
          attempts,
        };
      }

      if (attempts === 1) {
        emit({
          type: 'grounding_retry',
          detail: lastVerdict.violations.map((v) => v.code).join(','),
        });
      }
    }

    emit({ type: 'escalated', detail: 'grounding failed twice' });
    return {
      ...this.escalate(events, chosenRoute, toolResults, fingerprint, usage, 2),
      verdict: lastVerdict,
    };
  }

  // ------------------------------------------------------------------------

  private async runToolLoop(args: {
    system: ReturnType<typeof buildCachedPrefix>;
    messages: Message[];
    route: Route;
    speculation: Promise<unknown> | undefined;
    speculatedQuery: string;
    toolResults: ToolResultRecord[];
    usage: { input: number; output: number; cacheRead: number };
    emit: (e: TurnEvent) => void;
    signal?: AbortSignal | undefined;
  }): Promise<{ kind: 'text'; text: string } | { kind: 'refusal' } | { kind: 'exhausted' }> {
    const messages = [...args.messages];

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const res: ModelResponse = await this.deps.model.create(
        {
          model: args.route.model,
          system: args.system,
          // Snapshot: a request is a VALUE. Passing the live array would let
          // later pushes mutate an already-issued request, which corrupts
          // tracing, request logs, and any retry that replays the payload.
          messages: [...messages],
          tools: DEFAULT_TOOLS,
          // Adaptive stays ON — see ARCHITECTURE.md §7.2.
          thinking: { type: 'adaptive' },
          output_config: { effort: args.route.effort, format: { type: 'json_schema', schema: GROUNDED_RESPONSE_SCHEMA } },
          max_tokens: args.route.maxTokens,
        },
        args.signal,
      );

      args.usage.input += res.usage.input_tokens;
      args.usage.output += res.usage.output_tokens;
      args.usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;

      // Refusal is HTTP 200 with empty/partial content — check before reading.
      if (res.stop_reason === 'refusal') return { kind: 'refusal' };

      const calls = toolUses(res);
      if (calls.length === 0 || res.stop_reason === 'end_turn') {
        return { kind: 'text', text: firstText(res) };
      }

      messages.push({ role: 'assistant', content: res.content });

      const results: ToolResultBlock[] = [];
      for (const call of calls) {
        args.emit({ type: 'tool_start', detail: call.name });

        let payload: unknown;
        const specQuery = typeof call.input['query'] === 'string' ? call.input['query'] : '';
        const canUseSpeculation =
          call.name === 'search_catalog' &&
          args.speculation !== undefined &&
          speculationMatches(args.speculatedQuery, specQuery);

        if (canUseSpeculation) {
          payload = await args.speculation;
          if (payload === undefined) {
            payload = await this.safeExecute(call.name, call.input, args.signal);
            args.emit({ type: 'speculation_miss', detail: 'prefetch failed' });
          } else {
            args.emit({ type: 'speculation_hit', detail: specQuery });
          }
        } else {
          if (call.name === 'search_catalog' && args.speculation !== undefined) {
            args.emit({ type: 'speculation_miss', detail: specQuery });
          }
          payload = await this.safeExecute(call.name, call.input, args.signal);
        }

        // Cite by a short, deterministic HANDLE — not the provider's opaque
        // call id. Models reproduce `search_catalog#1` reliably and
        // `call_CxYz9f...` unreliably, and a mis-typed citation used to fail
        // grounding on a perfectly correct answer, pushing the retry into a
        // needless refusal. The handle is echoed inside the tool result so the
        // model can read it back off the transcript.
        const handle = `${call.name}#${args.toolResults.length + 1}`;
        args.toolResults.push({ tool_call_id: handle, tool: call.name, result: payload });
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify({ source: handle, data: payload }),
        });
        args.emit({ type: 'tool_end', detail: call.name });
      }

      messages.push({ role: 'user', content: results });
    }

    return { kind: 'exhausted' };
  }

  private async safeExecute(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      return await this.deps.tools.execute(name, input, signal);
    } catch (err) {
      // A failed tool is not a failed turn — hand the model the error so it can
      // adapt, and let grounding decide whether the answer is still safe.
      return { error: true, message: (err as Error).message };
    }
  }

  private escalate(
    events: TurnEvent[],
    chosenRoute: Route,
    toolResults: ToolResultRecord[],
    fingerprint: string,
    usage: { input: number; output: number; cacheRead: number },
    attempts: number,
  ): TurnResult {
    return {
      reply: ESCALATION_REPLY,
      verdict: { ok: true, violations: [] }, // the escalation text asserts nothing
      escalated: true,
      route: chosenRoute,
      toolResults,
      prefixFingerprint: fingerprint,
      events,
      usage,
      attempts,
    };
  }
}

/** Structured outputs guarantee shape, but never trust the wire blindly. */
export function parseGrounded(text: string): GroundedResponse | undefined {
  if (text.trim() === '') return undefined;
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== 'object' || raw === null) return undefined;
    const obj = raw as Record<string, unknown>;
    if (typeof obj['reply'] !== 'string' || !Array.isArray(obj['claims'])) return undefined;
    return { reply: obj['reply'], claims: obj['claims'] as GroundedResponse['claims'] };
  } catch {
    return undefined;
  }
}

export { ESCALATION_REPLY };
