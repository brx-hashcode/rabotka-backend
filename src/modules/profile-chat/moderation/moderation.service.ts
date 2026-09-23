import { Injectable, Logger } from '@nestjs/common';
import { MessageModerationStatus } from '@prisma/client';
import { SystemConfigService } from '../../system-config/system-config.service';
import { detectContacts, type DetectedSpan } from './detect';
import { redact, redactedRatio } from './redact';

export interface ModerationVerdict {
  status: MessageModerationStatus;
  /** Offsets into the ORIGINAL body. Empty for CLEAN and for a semantic-only hold. */
  spans: DetectedSpan[];
  /** What the recipient is shown. Never contains the withheld characters. */
  deliveredBody: string;
  /** Share of the body withheld, for the hold threshold and for the stats. */
  ratio: number;
}

const PREFIX_KEY = 'messaging.operator_prefixes';
const HELD_RATIO_KEY = 'messaging.held_ratio_threshold';
const DEFAULT_HELD_RATIO = 0.5;

/**
 * Decides what happens to one message, and returns BOTH views of it.
 *
 * Deliberately thin. All the judgement lives in `detect.ts`, which is pure and
 * exhaustively tested; this adds the two things that need the outside world —
 * configuration, and the rule for when a message is withheld whole.
 *
 * Synchronous and free at this stage: no network, no model. The semantic pass
 * (L6) plugs in here, behind its own switch, and is allowed to fail. This is
 * not.
 */
@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(private readonly config: SystemConfigService) {}

  /**
   * Every message, with no exception. An earlier version could be switched off
   * for a pair that had already paid to unlock each other; the product ruled
   * that contact details never travel through a conversation, whatever has
   * been paid before.
   */
  async review(body: string): Promise<ModerationVerdict> {
    const [prefixes, heldRatio] = await Promise.all([
      this.operatorPrefixes(),
      this.heldRatioThreshold(),
    ]);

    const spans = detectContacts(body, { operatorPrefixes: prefixes });
    if (spans.length === 0) {
      return {
        status: MessageModerationStatus.CLEAN,
        spans: [],
        deliveredBody: body,
        ratio: 0,
      };
    }

    const ratio = redactedRatio(body, spans);
    if (ratio >= heldRatio) {
      // Held, and the recipient is sent NOTHING — not even the holes. A body
      // that is more hole than text carries no meaning, and delivering it only
      // announces that somebody tried.
      return {
        status: MessageModerationStatus.HELD,
        spans,
        deliveredBody: '',
        ratio,
      };
    }

    return {
      status: MessageModerationStatus.REDACTED,
      spans,
      deliveredBody: redact(body, spans),
      ratio,
    };
  }

  private async operatorPrefixes(): Promise<string[]> {
    const raw = await this.config.get(PREFIX_KEY, '');
    return raw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  }

  private async heldRatioThreshold(): Promise<number> {
    const raw = await this.config.get(HELD_RATIO_KEY, String(DEFAULT_HELD_RATIO));
    const value = Number.parseFloat(raw);
    // A misconfigured threshold must not silently hold or release everything:
    // out of range falls back rather than being clamped, so the admin sees the
    // default behaviour and not a mystery.
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      this.logger.warn(
        `${HELD_RATIO_KEY}="${raw}" is not a ratio in (0, 1] — using ${DEFAULT_HELD_RATIO}`,
      );
      return DEFAULT_HELD_RATIO;
    }
    return value;
  }
}
