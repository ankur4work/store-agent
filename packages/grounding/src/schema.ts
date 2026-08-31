/**
 * The structured-output schema the model is constrained to.
 *
 * Passed as `output_config.format` on the Messages API so the claim set is
 * guaranteed well-formed — we never parse prose to find out what was asserted.
 *
 * Constraints match what structured outputs actually support: no recursion,
 * no numeric/string bounds, `additionalProperties: false` on every object.
 */
export const GROUNDED_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: {
      type: 'string',
      description:
        'The message shown to the shopper. Plain, short sentences. Every price, ' +
        'availability, or policy statement here MUST also appear in `claims`.',
    },
    claims: {
      type: 'array',
      description:
        'One entry per factual assertion in `reply`. Leave empty only if `reply` ' +
        'contains no product facts (e.g. a clarifying question).',
      items: {
        type: 'object',
        properties: {
          assertion: {
            type: 'string',
            description: 'The factual statement, quoted or closely paraphrased from `reply`.',
          },
          kind: {
            type: 'string',
            enum: ['price', 'stock', 'shipping', 'policy', 'other'],
          },
          source_tool_call_id: {
            type: 'string',
            description:
              'The id of the tool call from THIS turn that supports the assertion. ' +
              'Never invent one; if no tool supports it, do not make the assertion.',
          },
        },
        required: ['assertion', 'kind', 'source_tool_call_id'],
        additionalProperties: false,
      },
    },
  },
  required: ['reply', 'claims'],
  additionalProperties: false,
} as const;

/**
 * The grounding half of the system prompt. Lives in the CACHED prefix — it is
 * frozen and must never interpolate per-request state, or prompt caching dies.
 */
export const GROUNDING_SYSTEM_RULES = `## Grounding rules (non-negotiable)

You may state a price, availability, shipping time, or policy detail ONLY if a
tool call in this turn returned it. You have no reliable prior knowledge of this
store's catalog — it changes constantly.

- Every factual statement in \`reply\` must have a matching entry in \`claims\`
  citing the tool call that supports it.
- Never invent a \`source_tool_call_id\`. If nothing supports the fact, do not
  state the fact.
- Prices come back in minor units (18900 = $189.00). Convert before writing.
- Business messages returned by cart tools (out of stock, quantity adjusted)
  are authoritative. Relay them as written; do not soften or paraphrase them.
- If you cannot ground an answer, say so plainly and offer to connect the
  shopper with the team. That is a correct, successful answer — not a failure.`;
