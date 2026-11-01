import { WebClient, LogLevel } from '@slack/web-api';
import type { SlackPort } from './types.js';
export const escapeSlack = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function chunks(text: string, size = 2800): string[] {
  // Unicode code points, not UTF-16 halves. Escape each chunk separately to avoid splitting entities.
  const points = [...text]; const out: string[] = [];
  for (let i = 0; i < points.length; i += size) out.push(escapeSlack(points.slice(i, i + size).join('')));
  return out.length ? out : ['(empty response)'];
}
export class SlackClient implements SlackPort {
  readonly web: WebClient;
  private tails = new Map<string, Promise<unknown>>();
  private next = new Map<string, number>();
  constructor(token: string) {
    this.web = new WebClient(token, { logLevel: LogLevel.ERROR, retryConfig: { retries: 3, minTimeout: 1000, maxTimeout: 10000 }, rejectRateLimitedCalls: false });
  }
  async post(channel: string, text: string, threadTs?: string): Promise<string> {
    const operation = async () => {
      let first = '';
      for (const chunk of chunks(text)) {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, (this.next.get(channel) || 0) - Date.now())));
        const r = await this.web.chat.postMessage({ channel, text: chunk, thread_ts: threadTs || first || undefined, mrkdwn: false, unfurl_links: false, unfurl_media: false, parse: 'none' });
        this.next.set(channel, Date.now() + 1100);
        if (!r.ts) throw Error('Slack did not return a message timestamp');
        if (!first) first = r.ts;
      }
      return first;
    };
    const p = (this.tails.get(channel) || Promise.resolve()).catch(() => {}).then(operation);
    this.tails.set(channel, p);
    return p;
  }
}
