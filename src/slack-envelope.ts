import { parseEnvelope, ProtocolError, type CommandEnvelope } from './protocol.js';

const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const keysOnly = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));

/** Authenticated bot transport only; never recover human decisions from blocks.
 * Ordinary legacy rich_text remains display-only. An explicit plain_text section
 * must agree with the entire fallback, even when that fallback is already valid.
 */
export function parseSlackEnvelope(text: string, blocks: unknown, target: string, trustedBot: boolean, address?: string): CommandEnvelope {
  const stripAddress=(value:string)=>{if(!address)return value;if(value.startsWith(address+'\n')||value.startsWith(address+' '))return value.slice(address.length+1);throw new ProtocolError('invalid_envelope','Use only the exact leading connector address.');};
  const candidate = trustedBot && Array.isArray(blocks) && blocks.some(b => object(b) && b.type === 'section' && object(b.text) && b.text.type === 'plain_text');
  if (!candidate) return parseEnvelope(stripAddress(text), target);
  const invalid = () => new ProtocolError('invalid_envelope', 'Structured command and fallback must agree exactly.');
  if (!Array.isArray(blocks) || blocks.length !== 1) throw invalid();
  const block: unknown = blocks[0];
  if (!object(block) || !keysOnly(block, ['type', 'text', 'block_id']) || block.type !== 'section') throw invalid();
  if ('block_id' in block && (typeof block.block_id !== 'string' || block.block_id.length > 255)) throw invalid();
  const content = block.text;
  if (!object(content) || !keysOnly(content, ['type', 'text', 'emoji']) || content.type !== 'plain_text' || typeof content.text !== 'string') throw invalid();
  if ('emoji' in content && typeof content.emoji !== 'boolean') throw invalid();
  // Only exact original text or CRLF/LF-to-one-space transport transformation.
  // No trim, HTML decoding, arbitrary whitespace collapse, or command extraction.
  if (content.text.length > 3000 || (text !== content.text && text !== content.text.replace(/\r\n/g, '\n').replace(/\n/g, ' '))) throw invalid();
  return parseEnvelope(stripAddress(content.text), target);
}
