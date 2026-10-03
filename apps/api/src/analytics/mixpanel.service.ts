import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

/** Server-side Mixpanel track — no emails, passwords, or tokens. */
@Injectable()
export class MixpanelService {
  private readonly logger = new Logger(MixpanelService.name);
  private readonly token = process.env.MIXPANEL_TOKEN?.trim() || '';

  get enabled(): boolean {
    return this.token.length > 0;
  }

  async track(
    event: string,
    distinctId: string,
    properties: Record<string, string | number | boolean | undefined> = {},
  ) {
    const safe: Record<string, string | number | boolean> = {
      distinct_id: hashId(distinctId),
      time: Math.floor(Date.now() / 1000),
      source: 'winger-api',
    };
    for (const [key, value] of Object.entries(properties)) {
      if (value === undefined) continue;
      if (/email|password|token|secret|phone|authorization/i.test(key)) {
        continue;
      }
      safe[key] = value;
    }

    if (!this.enabled) {
      this.logger.debug(`[mixpanel:noop] ${event} ${JSON.stringify(safe)}`);
      return { queued: false, mode: 'noop' as const };
    }

    const payload = Buffer.from(
      JSON.stringify({ event, properties: { ...safe, token: this.token } }),
    ).toString('base64');

    try {
      const response = await fetch('https://api.mixpanel.com/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(payload)}`,
      });
      return { queued: response.ok, mode: 'mixpanel' as const };
    } catch (error) {
      this.logger.warn(
        `Mixpanel track failed: ${error instanceof Error ? error.message : error}`,
      );
      return { queued: false, mode: 'error' as const };
    }
  }
}

function hashId(id: string): string {
  return crypto.createHash('sha256').update(id).digest('hex').slice(0, 32);
}
