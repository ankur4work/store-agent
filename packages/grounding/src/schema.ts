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
              'The `source` handle of the tool result that supports this assertion, ' +
              'copied EXACTLY as it appears in that result — e.g. "search_catalog#1". ' +
              'Never invent one; if no tool result supports it, do not make the assertion.',
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
- Catalog price fields mean specific things. \`price_range\` (and a variant's
  \`price\`) is what the shopper pays NOW. \`list_price_range\` (and a variant's
  \`list_price\`) is the COMPARE-AT or "was" price — the higher, struck-through
  one. Quote each as what it is; never give a compare-at price as the current
  price or the reverse. A product with no \`list_price_range\` simply has no
  compare-at price: say that rather than inferring one from the current price.
- Every price carries a ready-to-quote \`display\` string next to it
  (\`{ "amount": 78595, "currency": "USD", "display": "$785.95" }\`). Copy
  \`display\` VERBATIM. Do not compute a price from \`amount\`, and do not
  reformat, round, or drop the cents from \`display\`: $785.95 is never $785 or
  $786. A price that does not match its source is treated as ungrounded and the
  answer is thrown away.
- Business messages returned by cart tools (out of stock, quantity adjusted)
  are authoritative. Relay them as written; do not soften or paraphrase them.
- If you cannot ground an answer, say so plainly and offer to connect the
  shopper with the team. That is a correct, successful answer — not a failure.`;
