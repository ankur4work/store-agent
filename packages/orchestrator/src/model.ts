import type { SystemBlock } from './prompt.js';

/**
 * Narrow model interface the orchestrator depends on.
 *
 * Deliberately not the Anthropic SDK type: the loop needs speculative tool
 * execution and mid-generation abortion on grounding failure, neither of which
 * the SDK tool runner exposes (ARCHITECTURE.md §3.4). Keeping our own seam also
 * makes the loop testable with zero credentials.
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

export interface ToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ToolUseBlock;

export interface Message {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly ContentBlock[] | readonly ToolResultBlock[];
}

export interface ToolResultBlock {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn';

export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

export interface ModelRequest {
  readonly model: string;
  readonly system: readonly SystemBlock[];
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolDef[];
  /**
   * Keep ADAPTIVE on Sonnet 5 even for fast turns. Disabling thinking makes
   * the model measurably less likely to call tools, which would silently
   * degrade the grounding this product sells. `effort` is the latency lever.
   * See ARCHITECTURE.md §7.2.
   */
  readonly thinking?: { readonly type: 'adaptive' | 'disabled' };
  readonly output_config?: { readonly effort?: Effort; readonly format?: unknown };
  readonly max_tokens: number;
}

export interface ModelResponse {
  readonly model: string;
  readonly stop_reason: StopReason;
  readonly content: readonly ContentBlock[];
  readonly usage: Usage;
  /** Populated only when stop_reason === 'refusal'. */
  readonly stop_details?: { readonly category?: string | null };
}

export interface ModelClient {
  create(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}

/** Model ids, per ARCHITECTURE.md §7.1. */
export const MODELS = {
  classify: 'claude-haiku-4-5',
  workhorse: 'claude-sonnet-5',
  escalation: 'claude-opus-5',
} as const;

export function firstText(res: ModelResponse): string {
  for (const b of res.content) if (b.type === 'text') return b.text;
  return '';
}

export function toolUses(res: ModelResponse): ToolUseBlock[] {
  return res.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}
