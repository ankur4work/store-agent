import { describe, expect, it } from 'vitest';
import { ReplyExtractor, SseParser } from '../src/streaming.js';

/**
 * Structured output and streaming are in tension: the model streams JSON, but
 * the shopper must see prose. ReplyExtractor pulls `reply` out of a growing,
 * still-invalid document. Chunk boundaries are where this gets hard, so most of
 * these tests deliberately split in awkward places.
 */
describe('ReplyExtractor', () => {
  function feed(chunks: string[]): string {
    const x = new ReplyExtractor();
    return chunks.map((c) => x.push(c)).join('');
  }

  it('extracts the reply from a complete document', () => {
    expect(feed(['{"reply":"Hello there","claims":[]}'])).toBe('Hello there');
  });

  it('emits incrementally as chunks arrive', () => {
    const x = new ReplyExtractor();
    expect(x.push('{"reply":"Hel')).toBe('Hel');
    expect(x.push('lo th')).toBe('lo th');
    expect(x.push('ere","claims":[]}')).toBe('ere');
  });

  it('emits nothing before the reply value starts', () => {
    const x = new ReplyExtractor();
    expect(x.push('{"rep')).toBe('');
    expect(x.push('ly":')).toBe('');
    expect(x.push('"Hi')).toBe('Hi');
  });

  it('handles the key split across a chunk boundary', () => {
    expect(feed(['{"re', 'ply"', ':', '"ok"}'])).toBe('ok');
  });

  it('stops at the closing quote and ignores the rest', () => {
    expect(feed(['{"reply":"done","claims":[{"assertion":"x"}]}'])).toBe('done');
  });

  it('marks itself finished once the string closes', () => {
    const x = new ReplyExtractor();
    x.push('{"reply":"a"}');
    expect(x.finished).toBe(true);
  });

  it('decodes escaped quotes without ending the string early', () => {
    expect(feed(['{"reply":"He said \\"hi\\" back","claims":[]}'])).toBe('He said "hi" back');
  });

  it('decodes newlines and tabs', () => {
    expect(feed(['{"reply":"a\\nb\\tc"}'])).toBe('a\nb\tc');
  });

  it('handles a chunk ending on a lone backslash', () => {
    const x = new ReplyExtractor();
    expect(x.push('{"reply":"a\\')).toBe('a');
    expect(x.push('nb"}')).toBe('\nb');
  });

  it('handles a unicode escape split across chunks', () => {
    const x = new ReplyExtractor();
    expect(x.push('{"reply":"cafe\\u00')).toBe('cafe');
    expect(x.push('e9"}')).toBe('é');
  });

  it('handles an escaped backslash at a boundary', () => {
    expect(feed(['{"reply":"a\\\\', 'b"}'])).toBe('a\\b');
  });

  it('survives being fed one character at a time', () => {
    const doc = '{"reply":"The coat is $189.00.","claims":[]}';
    expect(feed(doc.split(''))).toBe('The coat is $189.00.');
  });

  it('tolerates whitespace around the colon', () => {
    expect(feed(['{ "reply" : "spaced" }'])).toBe('spaced');
  });

  it('ignores a "reply" that appears inside an earlier string value', () => {
    // `claims` first, containing the literal text `"reply"`, then the real key.
    const doc = '{"claims":[],"reply":"real"}';
    expect(feed([doc])).toBe('real');
  });
});

describe('SseParser', () => {
  it('parses a single event', () => {
    expect(new SseParser().push('data: {"a":1}\n\n')).toEqual([{ event: undefined, data: '{"a":1}' }]);
  });

  it('parses an event name', () => {
    expect(new SseParser().push('event: ping\ndata: {}\n\n')).toEqual([{ event: 'ping', data: '{}' }]);
  });

  it('handles a record split across chunks', () => {
    const p = new SseParser();
    expect(p.push('data: {"a"')).toEqual([]);
    expect(p.push(':1}\n\n')).toEqual([{ event: undefined, data: '{"a":1}' }]);
  });

  it('parses multiple records in one chunk', () => {
    expect(new SseParser().push('data: 1\n\ndata: 2\n\n')).toHaveLength(2);
  });

  it('joins multi-line data fields', () => {
    expect(new SseParser().push('data: line1\ndata: line2\n\n')[0]!.data).toBe('line1\nline2');
  });

  it('ignores comment heartbeats', () => {
    expect(new SseParser().push(': keep-alive\n\n')).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    expect(new SseParser().push('data: x\r\n\r\n')).toEqual([{ event: undefined, data: 'x' }]);
  });

  it('buffers an incomplete trailing record', () => {
    const p = new SseParser();
    p.push('data: a\n\ndata: b');
    expect(p.push('\n\n')).toEqual([{ event: undefined, data: 'b' }]);
  });
});
