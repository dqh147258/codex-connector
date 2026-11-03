import { parseEnvelope, ProtocolError, type CommandEnvelope } from './protocol.js';

export const SLACK_TRANSPORT_REVISION = 'self-address-v2';
export class SlackTransportError extends ProtocolError {
  constructor(readonly stage: 'address' | 'block-shape' | 'fallback-mismatch') {
    super('invalid_envelope', 'Slack command transport rejected.');
  }
}
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const keysOnly = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const selfId = (address: string) => /^<@([UW][A-Z0-9]+)>$/.exec(address)?.[1];

/** This recognizes an address attempt, not authority or a valid command. It is
 * called only after event authentication. Labels never select an identity. */
export function isSlackAddressed(text: string, address: string, trustedBot: boolean): boolean {
  const id = selfId(address);
  return Boolean(id && (text.startsWith(address) || trustedBot &&
    (text.startsWith(`<@${id}|`) || text.startsWith(`&lt;@${id}&gt;`))));
}

/** Canonicalize only one complete leading token referring to the verified self
 * ID. Preserve the separator and every envelope byte. No general HTML decoding. */
function canonicalAddress(value: string, address: string, trustedBot: boolean): string {
  const id = selfId(address);
  if (!id) throw new SlackTransportError('address');
  if (value.startsWith(address)) return value;
  if (trustedBot) {
    const escaped = `&lt;@${id}&gt;`;
    if (value.startsWith(escaped)) return address + value.slice(escaped.length);
    const labelled = new RegExp(`^<@${id}\\|[^<>&|\\x00-\\x1f\\x7f]{1,80}>`).exec(value)?.[0];
    if (labelled) return address + value.slice(labelled.length);
  }
  throw new SlackTransportError('address');
}

/** Authenticated bot transport only; never recover human decisions from blocks.
 * Ordinary legacy rich_text remains display-only. Explicit plain_text sections
 * must agree with the entire fallback after only self-address canonicalization.
 */
export function parseSlackEnvelope(text: string, blocks: unknown, target: string, trustedBot: boolean, address?: string): CommandEnvelope {
  const canonical = (value: string) => address ? canonicalAddress(value, address, trustedBot) : value;
  const stripAddress = (value: string) => {
    if (!address) return value;
    const rest = value.slice(address.length);
    if (rest.startsWith('\r\n')) return rest.slice(2);
    if (rest.startsWith('\n') || rest.startsWith(' ')) return rest.slice(1);
    throw new SlackTransportError('address');
  };
  const fallback = canonical(text);
  const candidate = trustedBot && Array.isArray(blocks) && blocks.some(b => object(b) && b.type === 'section' && object(b.text) && b.text.type === 'plain_text');
  if (!candidate) return parseEnvelope(stripAddress(fallback), target);
  const invalid = () => new SlackTransportError('block-shape');
  if (!Array.isArray(blocks) || blocks.length !== 1) throw invalid();
  const block: unknown = blocks[0];
  if (!object(block) || !keysOnly(block, ['type', 'text', 'block_id']) || block.type !== 'section') throw invalid();
  if ('block_id' in block && (typeof block.block_id !== 'string' || block.block_id.length > 255)) throw invalid();
  const content = block.text;
  if (!object(content) || !keysOnly(content, ['type', 'text', 'emoji']) || content.type !== 'plain_text' || typeof content.text !== 'string') throw invalid();
  if ('emoji' in content && typeof content.emoji !== 'boolean') throw invalid();
  if (content.text.length > 3000) throw invalid();
  const shown = canonical(content.text);
  // Only exact text or CRLF/LF-to-one-space transport transformation, after the
  // validated self token. No trim, body decoding, whitespace collapse or search.
  if (fallback !== shown && fallback !== shown.replace(/\r\n/g, '\n').replace(/\n/g, ' ')) throw new SlackTransportError('fallback-mismatch');
  return parseEnvelope(stripAddress(shown), target);
}
