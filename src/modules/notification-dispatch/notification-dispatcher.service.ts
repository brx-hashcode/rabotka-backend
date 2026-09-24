import { Injectable, Logger } from '@nestjs/common';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { WhatsAppLoginLinkService } from '../auth/whatsapp-login-link.service';
import { BotPauseService } from '../bot/services/bot-pause.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { notificationDispatchCounter } from '../whatsapp/telemetry/metrics';
import type { TemplateKey, TemplateParams } from '../whatsapp/contracts';

/** How the message actually left, for the caller and for the metric. */
export type DispatchMode = 'FREE_FORM' | 'TEMPLATE';

export type DispatchResult = {
  mode: DispatchMode;
  sent: boolean;
};

/**
 * The free-form rendering of a notification: the same words the approved
 * template carries, plus the button that template's CTA provides.
 *
 * `path` is an app path (`applications/<id>`, `recherche-offres`), never a full
 * URL — the login code is minted against it here, so the reader lands signed
 * in, exactly as `withLoginCode` does for template buttons.
 */
export type FreeFormMessage = {
  body: string;
  buttonText: string;
  path: string;
};

type DispatchInput<K extends TemplateKey> = {
  phone: string;
  /**
   * Required for the free-form path: it is what the window is read from and
   * what a login code is minted against. Without it the template is sent, which
   * is what every caller did before this service existed.
   */
  profileId?: string;
  template: { key: K; params: TemplateParams<K> };
  freeForm?: FreeFormMessage;
  /** Human-readable rendering for the conversation view, as `sendTemplateMessage` takes. */
  body?: string;
  /** A window verdict the caller already has, so a fan-out reads it once for everyone. */
  windowOpen?: boolean;
};

/**
 * Sends a notification the cheapest way that still delivers it.
 *
 * Inside WhatsApp's 24h customer-service window a free-form message is
 * accepted and costs nothing; outside it, only an approved template is. Before
 * this service the codebase sent the template either way — roughly thirty call
 * sites, each paying a template fee to reach people who had written to us
 * minutes earlier.
 *
 * Three rules hold it together:
 *
 * 1. THE TEMPLATE IS ALWAYS THE FALLBACK. Every failure of the free-form path —
 *    window closed, no login code, Meta refusing it, the config key off —
 *    lands on the same template the caller would have sent anyway. This
 *    service can make a notification cheaper; it must never make one silently
 *    not arrive.
 * 2. THE WORDS DO NOT CHANGE. The free-form body is the template's copy,
 *    written out in `bot/messages/*`, because the reader must not be able to
 *    tell which path was taken.
 * 3. A BUTTON, NOT A BARE LINK. A bare URL does not open WhatsApp's in-app
 *    browser; an interactive CTA does, which is what made templates the only
 *    option for the bot's replies in the first place.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);

  constructor(
    private readonly whatsApp: WhatsAppService,
    private readonly loginLink: WhatsAppLoginLinkService,
    private readonly systemConfig: SystemConfigService,
    private readonly botPause: BotPauseService,
  ) {}

  /**
   * Whether the free-form path may be used at all right now.
   *
   * Read once per fan-out rather than per recipient: it is a config lookup, and
   * a fan-out that flips halfway through a batch would be harder to reason
   * about than one that is wholly on or wholly off.
   */
  async freeFormEnabled(): Promise<boolean> {
    return this.systemConfig.prefersFreeForm();
  }

  /**
   * Which of these profiles can be reached for free right now.
   *
   * One query for the whole batch — see `WhatsAppService.openServiceWindows`.
   * Callers pass each verdict back in as `windowOpen`.
   */
  async openWindows(profileIds: string[]): Promise<Set<string>> {
    return this.whatsApp.openServiceWindows(profileIds);
  }

  async send<K extends TemplateKey>(
    input: DispatchInput<K>,
  ): Promise<DispatchResult> {
    const { phone, profileId, template, freeForm, body } = input;

    /**
     * An admin has taken this conversation over — nothing automated goes out.
     *
     * This is the chokepoint EVERY scheduled message passes through: the
     * reminder processor and `BotNotificationService` both dispatch here.
     * Suppressing the bot's replies alone would not have been enough — a
     * mission reminder landing mid-handover means the admin is talking over a
     * robot, which is the thing the toggle exists to stop.
     *
     * The admin's OWN messages do not come through here. They are enqueued
     * straight onto the outbound queue by `whatsapp-admin.service`, so they
     * are unaffected and a paused profile can still be answered.
     */
    if (await this.botPause.isPaused(profileId)) {
      notificationDispatchCounter.inc({
        mode: 'template',
        reason: 'bot_paused',
        template: template.key,
      });
      return { mode: 'TEMPLATE', sent: false };
    }

    if (!freeForm || !profileId) {
      return this.sendTemplate(
        template,
        phone,
        profileId,
        body,
        'no_free_form',
      );
    }

    if (!(await this.freeFormEnabled())) {
      return this.sendTemplate(template, phone, profileId, body, 'disabled');
    }

    const open =
      input.windowOpen ??
      (await this.whatsApp.isServiceWindowOpen(profileId)).open;
    if (!open) {
      return this.sendTemplate(
        template,
        phone,
        profileId,
        body,
        'window_closed',
      );
    }

    // No code, no free-form send. The template path mints its own downstream
    // (`withLoginCode`) and degrades to a live login link when it cannot, which
    // is better than a free message whose button drops the reader nowhere.
    const url = await this.loginLink
      .shortLink(profileId, freeForm.path)
      .catch(() => null);
    if (!url) {
      return this.sendTemplate(template, phone, profileId, body, 'no_link');
    }

    const sent = await this.whatsApp
      .sendInteractiveCta(phone, {
        body: freeForm.body,
        buttonText: freeForm.buttonText,
        url,
        profileId,
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `Free-form ${template.key} to ${profileId} failed, falling back to the template: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      });

    if (sent) {
      notificationDispatchCounter.inc({
        mode: 'free_form',
        reason: 'window_open',
        template: template.key,
      });
      return { mode: 'FREE_FORM', sent: true };
    }

    // Anything at all went wrong: the reader is owed the message, and the
    // template is the path that was working yesterday.
    return this.sendTemplate(template, phone, profileId, body, 'fallback');
  }

  private async sendTemplate<K extends TemplateKey>(
    template: { key: K; params: TemplateParams<K> },
    phone: string,
    profileId: string | undefined,
    body: string | undefined,
    reason: string,
  ): Promise<DispatchResult> {
    notificationDispatchCounter.inc({
      mode: 'template',
      reason,
      template: template.key,
    });

    const sent = await this.whatsApp.sendTemplateMessage(
      phone,
      template.key,
      template.params,
      profileId,
      body,
    );

    return { mode: 'TEMPLATE', sent };
  }
}
