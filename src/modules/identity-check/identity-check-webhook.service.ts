import { resolvesToPrivateAddress } from '../../common/utils/private-address.util';
import { Injectable, Logger } from '@nestjs/common';
import { OAuthAppStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  OIDC_SIGNING_ALG,
  OidcKeyService,
} from '../oauth/services/oidc-key.service';
import { OAuthTokenService } from '../oauth/services/oauth-token.service';
import {
  WEBHOOK_JWS_TYPE,
  WEBHOOK_TIMEOUT_MS,
} from './identity-check.constants';
import { toPartnerView, type PartnerCheckView } from './identity-check.view';

export const IDENTITY_CHECK_EVENT = 'identity_check.updated';

/**
 * Delivers a finished check to the partner's webhook.
 *
 * The body is `{ "jws": "<compact JWS>" }`, signed RS256 with the OIDC key and
 * verifiable against `/.well-known/jwks.json` — the same key a partner already
 * trusts for ID tokens, so there is no second secret to store or rotate.
 * `aud` is the partner's `client_id`, so a payload replayed to another partner
 * fails verification there.
 */
@Injectable()
export class IdentityCheckWebhookService {
  private readonly logger = new Logger(IdentityCheckWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: OidcKeyService,
    private readonly tokens: OAuthTokenService,
  ) {}

  async sign(view: PartnerCheckView, clientId: string): Promise<string> {
    const { key, kid } = this.keys.signingKey();
    return new SignJWT({ event: IDENTITY_CHECK_EVENT, check: view })
      .setProtectedHeader({ alg: OIDC_SIGNING_ALG, kid, typ: WEBHOOK_JWS_TYPE })
      .setIssuer(this.tokens.issuer())
      .setAudience(clientId)
      .setSubject(view.id)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(key);
  }

  /**
   * One delivery attempt. Throws on failure so the queue retries it.
   *
   * Returns quietly when there is nothing to deliver: already delivered, still
   * pending, or the app has since lost its webhook, been suspended or deleted.
   */
  async deliver(checkId: string): Promise<void> {
    const check = await this.prisma.identityCheck.findUnique({
      where: { id: checkId },
      include: {
        app: {
          select: {
            client_id: true,
            webhook_url: true,
            status: true,
            deleted_at: true,
            is_sandbox: true,
          },
        },
      },
    });

    if (!check || check.webhook_delivered_at) return;
    if (check.status === 'PENDING_CONSENT') return;

    const { app } = check;
    if (
      !app.webhook_url ||
      app.deleted_at ||
      app.status !== OAuthAppStatus.ACTIVE
    ) {
      return;
    }

    const jws = await this.sign(toPartnerView(check), app.client_id);

    let failure: string | null = null;
    try {
      // Re-checked at every send: the name may have been re-pointed at an
      // internal address since it was registered (DNS rebinding). A sandbox
      // app may target the developer's own machine.
      if (
        !app.is_sandbox &&
        (await resolvesToPrivateAddress(new URL(app.webhook_url).hostname))
      ) {
        throw new Error('destination refusée : adresse interne');
      }
      const res = await fetch(app.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Rabotka-Webhooks/1.0',
        },
        body: JSON.stringify({ jws }),
        // A redirect would send a person's KYC result wherever the partner's
        // server points it. The registered URL is the only destination.
        redirect: 'error',
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (!res.ok) failure = `HTTP ${res.status}`;
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    await this.prisma.identityCheck.update({
      where: { id: checkId },
      data: {
        webhook_attempts: { increment: 1 },
        webhook_last_error: failure?.slice(0, 500) ?? null,
        ...(failure ? {} : { webhook_delivered_at: new Date() }),
      },
    });

    if (failure) {
      this.logger.warn(
        `Identity check webhook ${checkId} to ${app.client_id} failed: ${failure}`,
      );
      throw new Error(`Webhook delivery failed: ${failure}`);
    }
  }
}
