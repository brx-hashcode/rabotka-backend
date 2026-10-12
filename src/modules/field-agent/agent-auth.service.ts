import { mayLogSecretsLocally } from '../auth/local-dev-secrets';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AgentStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../common/services/redis/redis.constants';
import { AuthService } from '../auth/auth.service';
import {
  assertCanSendOtp,
  consumeOtp,
  generateOtp,
  storeOtp,
} from '../auth/otp-store';
import { LogService } from '../log/log.service';
import { LayoutService } from '../mail/layout.service';
import { MailService } from '../mail/mail.service';
import { sendOtpEmail } from '../mail/templates';
import { normalizeAgentEmail } from './agent-identity';
import { AGENT_SELF_SELECT, toAgentSelf } from './agent-selects';

const OTP_KEY_PREFIX = `${REDIS_KEY_PREFIX}agent:otp:`;
const OTP_ATTEMPTS_KEY_PREFIX = `${REDIS_KEY_PREFIX}agent:otp-attempts:`;
const OTP_SENDS_KEY_PREFIX = `${REDIS_KEY_PREFIX}agent:otp-sends:`;
const RESEND_COOLDOWN_KEY_PREFIX = `${REDIS_KEY_PREFIX}agent:otp:resend:`;
const REFRESH_KEY_PREFIX = `${REDIS_KEY_PREFIX}agent:refresh:`;
const RESEND_COOLDOWN_SECONDS = 60;
const DEFAULT_REFRESH_TTL_SECONDS = 24 * 60 * 60;

/** Distinct from the mobile app's `refresh`, so neither can redeem the other's. */
const REFRESH_TOKEN_TYPE = 'agent_refresh';

type JwtExpiresIn = `${number}${'s' | 'm' | 'h' | 'd'}` | `${number}`;

export type AgentTokens = {
  token: string;
  refreshToken: string;
  agent: ReturnType<typeof toAgentSelf>;
};

/**
 * Login for the agent app: email + a one-time code sent by email.
 *
 * Modelled on the admin flow (`sendAdminOtp` / `verifyAdminOtp`) and sharing
 * its primitives (otp-store.ts), with two deliberate differences:
 *
 * - NO ENUMERATION. The admin flow answers 404 for an unknown address; this
 *   one answers the same `{ success: true }` whether or not an active agent
 *   owns the email. The agent app is public, and "is this person one of our
 *   agents?" is not something it should tell a stranger.
 * - BEARER TOKENS, NOT A COOKIE, with the mobile app's rotating refresh
 *   tokens. See AgentAuthGuard for why a cookie would be wrong here.
 *
 * Token lifetimes reuse the mobile settings (JWT_ACCESS_EXPIRES_IN,
 * JWT_REFRESH_EXPIRES_IN), so there is no new configuration to deploy.
 */
@Injectable()
export class AgentAuthService {
  private readonly logger = new Logger(AgentAuthService.name);

  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
    private readonly layoutService: LayoutService,
    private readonly logService: LogService,
    private readonly authService: AuthService,
  ) {}

  async sendOtp(email: string): Promise<{ success: true }> {
    const normalized = normalizeAgentEmail(email);
    // Counted before the lookup, for every address: the cap bounds what one
    // caller can make us send, and counting only real agents would let the
    // 429 itself reveal which addresses are real.
    await assertCanSendOtp(this.redis, `${OTP_SENDS_KEY_PREFIX}${normalized}`);
    await this.issueOtp(normalized);
    return { success: true };
  }

  async resendOtp(email: string): Promise<{ success: true }> {
    const normalized = normalizeAgentEmail(email);
    const cooldownKey = `${RESEND_COOLDOWN_KEY_PREFIX}${normalized}`;
    if (await this.redis.get(cooldownKey)) {
      throw new HttpException(
        'Veuillez attendre avant de renvoyer le code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await assertCanSendOtp(this.redis, `${OTP_SENDS_KEY_PREFIX}${normalized}`);
    await this.redis.set(cooldownKey, '1', 'EX', RESEND_COOLDOWN_SECONDS);
    await this.issueOtp(normalized);
    return { success: true };
  }

  async verifyOtp(
    email: string,
    otp: string,
    meta?: { ipAddress?: string; userAgent?: string },
  ): Promise<AgentTokens> {
    const normalized = normalizeAgentEmail(email);
    const matched = await consumeOtp(
      this.redis,
      `${OTP_KEY_PREFIX}${normalized}`,
      `${OTP_ATTEMPTS_KEY_PREFIX}${normalized}`,
      otp,
    );
    if (!matched) {
      throw new UnauthorizedException(
        'Code de vérification invalide ou expiré',
      );
    }

    // Re-checked here, not only at send: an agent suspended in the five
    // minutes between the two must not walk in with the code they were sent.
    const agent = await this.prisma.agent.findUnique({
      where: { email: normalized },
      select: { id: true, status: true },
    });
    if (agent?.status !== AgentStatus.ACTIVE) {
      throw new UnauthorizedException(
        'Code de vérification invalide ou expiré',
      );
    }

    await this.prisma.agent.update({
      where: { id: agent.id },
      data: { last_login_at: new Date() },
    });
    await this.logService
      .create({
        action: 'AGENT_LOGIN',
        entityType: 'Agent',
        entityId: agent.id,
        metadata: { agentId: agent.id, method: 'email_otp' },
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      })
      .catch((err: unknown) =>
        this.logger.warn(`Could not log agent login ${agent.id}`, err),
      );

    return this.issueTokens(agent.id);
  }

  async refresh(refreshToken: string): Promise<AgentTokens> {
    let payload: { sub?: string; type?: string; jti?: string };
    try {
      payload = this.jwtService.verify(refreshToken);
    } catch {
      throw new UnauthorizedException('Refresh token invalide ou expiré');
    }
    if (payload.type !== REFRESH_TOKEN_TYPE || !payload.jti || !payload.sub) {
      throw new UnauthorizedException('Refresh token invalide');
    }

    // Single use: deleted on redemption, so a stolen copy replayed after the
    // owner refreshed finds nothing.
    const key = `${REFRESH_KEY_PREFIX}${payload.jti}`;
    const stored = await this.redis.get(key);
    if (stored !== payload.sub) {
      throw new UnauthorizedException('Refresh token révoqué ou déjà utilisé');
    }
    await this.redis.del(key);

    const agent = await this.prisma.agent.findUnique({
      where: { id: payload.sub },
      select: { id: true, status: true },
    });
    if (agent?.status !== AgentStatus.ACTIVE) {
      throw new UnauthorizedException('Compte agent inactif');
    }

    return this.issueTokens(agent.id);
  }

  async logout(accessToken: string, refreshToken?: string): Promise<void> {
    await this.authService.revokeToken(accessToken);
    if (!refreshToken) return;
    try {
      const payload = this.jwtService.decode<{ jti?: string } | null>(
        refreshToken,
      );
      if (payload?.jti) {
        await this.redis.del(`${REFRESH_KEY_PREFIX}${payload.jti}`);
      }
    } catch {
      // Already unreadable — nothing left to revoke.
    }
  }

  async getSelf(agentId: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: AGENT_SELF_SELECT,
    });
    if (!agent) throw new UnauthorizedException('Compte agent introuvable');
    return toAgentSelf(agent);
  }

  /** Sends a code only to an ACTIVE agent; silent for everyone else. */
  private async issueOtp(email: string): Promise<void> {
    const agent = await this.prisma.agent.findUnique({
      where: { email },
      select: { first_name: true, status: true },
    });
    if (agent?.status !== AgentStatus.ACTIVE) return;

    const otp = generateOtp();
    await storeOtp(
      this.redis,
      `${OTP_KEY_PREFIX}${email}`,
      `${OTP_ATTEMPTS_KEY_PREFIX}${email}`,
      otp,
    );

    if (mayLogSecretsLocally(this.configService)) {
      this.logger.warn(`[AGENT OTP] ${email} → ${otp}`);
    }

    await this.mailService.sendMail({
      to: email,
      subject: 'Votre code de connexion Rabotka Agent',
      html: await this.layoutService.wrap(sendOtpEmail(otp, agent.first_name), {
        previewText: `Votre code de connexion : ${otp}`,
      }),
    });
  }

  private async issueTokens(agentId: string): Promise<AgentTokens> {
    const token = this.jwtService.sign(
      { sub: agentId, type: 'agent', jti: randomUUID() },
      {
        expiresIn: this.configService.get<string>(
          'JWT_ACCESS_EXPIRES_IN',
          '15m',
        ) as JwtExpiresIn,
      },
    );

    const refreshJti = randomUUID();
    const refreshToken = this.jwtService.sign(
      { sub: agentId, type: REFRESH_TOKEN_TYPE, jti: refreshJti },
      {
        expiresIn: this.configService.get<string>(
          'JWT_REFRESH_EXPIRES_IN',
          '24h',
        ) as JwtExpiresIn,
      },
    );
    const decoded = this.jwtService.decode<{ exp?: number } | null>(
      refreshToken,
    );
    const ttl = decoded?.exp
      ? decoded.exp - Math.floor(Date.now() / 1000)
      : DEFAULT_REFRESH_TTL_SECONDS;
    await this.redis.set(
      `${REFRESH_KEY_PREFIX}${refreshJti}`,
      agentId,
      'EX',
      Math.max(ttl, 1),
    );

    return { token, refreshToken, agent: await this.getSelf(agentId) };
  }
}
