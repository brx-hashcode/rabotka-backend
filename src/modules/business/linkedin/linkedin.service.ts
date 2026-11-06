import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import {
  JobOfferStatus,
  LinkedinPostStatus,
  VerificationStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { LINKEDIN_POST_QUEUE } from '../../../common/services/queue/queue.module';
import {
  QueueService,
  type ProcessedJob,
} from '../../../common/services/queue/queue.service';
import { businessDashboardUrl } from '../../mail/audience';
import { notifyProfile } from '../../profile-notification/profile-notification.events';
import { MailboxCrypto } from '../mailbox/mailbox-crypto';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
import {
  createPost,
  exchangeCode,
  fetchMember,
  LinkedinAuthError,
  linkedinAuthUrl,
  LinkedinRetryableError,
  postUrl,
  uploadImage,
} from './linkedin-api';

const STATE_AUDIENCE = 'rabotka-linkedin-connect';
/** Matches the queue's default attempts (queue.service.ts). */
const ATTEMPTS = 3;
const OPEN: JobOfferStatus[] = [
  JobOfferStatus.ACTIVE,
  JobOfferStatus.PARTIALLY_FILLED,
];

type State = { b: string; p: string; n: string };
type PostJob = { postId: string };

export const EXPIRED_MESSAGE =
  'Votre connexion LinkedIn a expiré : connectez-la de nouveau.';

/** The account holder has no member id: it is « holder ». */
export const personOf = (memberId: string | undefined): string =>
  memberId ?? 'holder';

/** The business site's origin, where the careers pages live. */
export function businessOrigin(): string {
  return businessDashboardUrl().replace(/\/espace$/, '');
}

/** Where LinkedIn sends the member back after consenting. */
export function linkedinRedirectUri(): string {
  return `${businessOrigin()}/api/v1/public/linkedin/callback`;
}

/** The offer's careers page, tagged so its candidates count as « LinkedIn ». */
export function careersOfferUrl(slug: string, reference: string): string {
  return `${businessOrigin()}/carrieres/${encodeURIComponent(slug)}/${encodeURIComponent(reference)}?source=linkedin`;
}

/** The card's text under the title: the description's start, on one line. */
export function excerpt(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * A team member's own LinkedIn, connected to post the business's offers on
 * its feed. The post links to the offer's careers page, where candidates
 * apply. Off when the app's credentials or the token key are missing.
 */
@Injectable()
export class LinkedinService implements OnModuleInit {
  private readonly logger = new Logger(LinkedinService.name);
  private readonly crypto: MailboxCrypto | null = null;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly subscriptions: BusinessSubscriptionService,
    private readonly queue: QueueService,
    private readonly events: EventEmitter2,
    config: ConfigService,
  ) {
    this.clientId = config.get<string>('LINKEDIN_CLIENT_ID') || undefined;
    this.clientSecret =
      config.get<string>('LINKEDIN_CLIENT_SECRET') || undefined;
    const key = config.get<string>('MAILBOX_TOKEN_KEY');
    try {
      if (key) this.crypto = new MailboxCrypto(key);
    } catch (err) {
      this.logger.error(`LinkedIn disabled: ${String(err)}`);
    }
  }

  onModuleInit(): void {
    this.queue.createWorker<PostJob>(
      LINKEDIN_POST_QUEUE,
      (job) => this.process(job),
      { concurrency: 2 },
    );
  }

  get available(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.crypto);
  }

  // ── The connection ───────────────────────────────────────────────────

  async account(profileId: string, memberId: string | undefined) {
    if (!this.available) return { available: false, account: null };
    const businessId = await this.businessId(profileId);
    const row = await this.prisma.businessLinkedinAccount.findUnique({
      where: {
        business_id_person: {
          business_id: businessId,
          person: personOf(memberId),
        },
      },
    });
    return {
      available: true,
      account: row
        ? {
            name: row.name,
            pictureUrl: row.picture_url,
            connectedAt: row.created_at,
            expired: row.expired_at !== null || row.expires_at <= new Date(),
          }
        : null,
    };
  }

  async connectUrl(profileId: string, memberId: string | undefined) {
    if (!this.available) {
      throw new ServiceUnavailableException(
        'LinkedIn ne peut pas encore être connecté.',
      );
    }
    const businessId = await this.businessId(profileId);
    const state = await this.jwt.signAsync(
      { b: businessId, p: personOf(memberId), n: randomUUID() } satisfies State,
      { audience: STATE_AUDIENCE, expiresIn: '10m' },
    );
    return {
      url: linkedinAuthUrl(this.clientId!, linkedinRedirectUri(), state),
    };
  }

  /** Back from the consent screen: the code becomes a sealed token. */
  async complete(code: string, state: string) {
    if (!this.available) {
      throw new ServiceUnavailableException('LinkedIn not configured');
    }
    let s: State;
    try {
      s = await this.jwt.verifyAsync<State>(state, {
        audience: STATE_AUDIENCE,
      });
    } catch {
      throw new BadRequestException('Invalid or expired state');
    }
    const token = await exchangeCode(
      this.clientId!,
      this.clientSecret!,
      code,
      linkedinRedirectUri(),
    );
    const member = await fetchMember(token.accessToken);
    const data = {
      linkedin_sub: member.sub,
      name: member.name,
      picture_url: member.picture,
      access_token_enc: this.crypto!.seal(token.accessToken),
      expires_at: token.expiresAt,
      expired_at: null,
    };
    await this.prisma.businessLinkedinAccount.upsert({
      where: { business_id_person: { business_id: s.b, person: s.p } },
      create: { business_id: s.b, person: s.p, ...data },
      update: data,
    });
    return { name: member.name };
  }

  async disconnect(profileId: string, memberId: string | undefined) {
    const businessId = await this.businessId(profileId);
    await this.prisma.businessLinkedinAccount.deleteMany({
      where: { business_id: businessId, person: personOf(memberId) },
    });
    return { disconnected: true };
  }

  // ── Posts ────────────────────────────────────────────────────────────

  /** An offer's posts, newest first: « Publiée sur LinkedIn le … ». */
  async posts(profileId: string, offerId: string) {
    const businessId = await this.businessId(profileId);
    const rows = await this.prisma.jobOfferLinkedinPost.findMany({
      where: { offer_id: offerId, business_id: businessId },
      orderBy: { created_at: 'desc' },
      take: 10,
    });
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      authorName: r.author_name,
      url: r.post_urn ? postUrl(r.post_urn) : null,
      error: r.error,
      createdAt: r.created_at,
      publishedAt: r.published_at,
    }));
  }

  /**
   * Queues a post of the offer on the member's LinkedIn. Once is enough: a
   * second post of the same offer needs `again` (after an edit, a republish).
   */
  async queuePost(
    profileId: string,
    memberId: string | undefined,
    offerId: string,
    text: string,
    again = false,
    image?: Buffer,
  ) {
    if (!this.available) {
      throw new ServiceUnavailableException(
        'LinkedIn ne peut pas encore être connecté.',
      );
    }
    const businessId = await this.businessId(profileId);
    const person = personOf(memberId);
    const account = await this.prisma.businessLinkedinAccount.findUnique({
      where: { business_id_person: { business_id: businessId, person } },
    });
    if (!account) {
      throw new BadRequestException('Connectez d’abord votre compte LinkedIn.');
    }
    if (account.expired_at || account.expires_at <= new Date()) {
      throw new BadRequestException(EXPIRED_MESSAGE);
    }
    await this.publicOffer(businessId, offerId);
    if (!again) {
      const previous = await this.prisma.jobOfferLinkedinPost.findFirst({
        where: {
          offer_id: offerId,
          status: {
            in: [LinkedinPostStatus.QUEUED, LinkedinPostStatus.PUBLISHED],
          },
        },
        select: { id: true },
      });
      if (previous) {
        throw new ConflictException(
          'Cette offre est déjà publiée sur LinkedIn.',
        );
      }
    }
    // The recruiter's own picture goes to LinkedIn now, while they wait: a
    // file is never queued, and a refused token is said at once.
    const thumbnail = image
      ? await this.uploadOwnPicture(
          account.id,
          account.access_token_enc,
          account.linkedin_sub,
          image,
        )
      : null;
    const post = await this.prisma.jobOfferLinkedinPost.create({
      data: {
        offer_id: offerId,
        business_id: businessId,
        person,
        author_name: account.name,
        text: text.trim(),
        thumbnail_urn: thumbnail,
      },
    });
    await this.queue.addJob<PostJob>(LINKEDIN_POST_QUEUE, { postId: post.id });
    return { id: post.id, status: post.status };
  }

  /** The queued post, published: card picture first, then the post itself. */
  async process(job: ProcessedJob<PostJob>): Promise<void> {
    const post = await this.prisma.jobOfferLinkedinPost.findUnique({
      where: { id: job.data.postId },
    });
    if (!post || post.status !== LinkedinPostStatus.QUEUED) return;

    const fail = (error: string) => this.finish(post.id, { error });
    if (!this.crypto)
      return fail('LinkedIn n’est plus disponible pour le moment.');
    const account = await this.prisma.businessLinkedinAccount.findUnique({
      where: {
        business_id_person: {
          business_id: post.business_id,
          person: post.person,
        },
      },
    });
    if (!account || account.expired_at) return fail(EXPIRED_MESSAGE);

    let offer: Awaited<ReturnType<LinkedinService['publicOffer']>>;
    try {
      offer = await this.publicOffer(post.business_id, post.offer_id);
    } catch {
      return fail('l’offre n’est plus en ligne sur votre page carrières.');
    }

    const token = this.crypto.open(account.access_token_enc);
    const author = `urn:li:person:${account.linkedin_sub}`;
    try {
      const thumbnail =
        post.thumbnail_urn ?? (await this.cardPicture(token, author, offer));
      const urn = await createPost(token, {
        authorUrn: author,
        text: post.text,
        url: careersOfferUrl(offer.slug, offer.reference),
        title: `${offer.title} — ${offer.businessName}`,
        description: excerpt(offer.description),
        thumbnail,
      });
      await this.finish(post.id, { urn });
    } catch (err) {
      if (err instanceof LinkedinAuthError) {
        await this.prisma.businessLinkedinAccount.update({
          where: { id: account.id },
          data: { expired_at: new Date() },
        });
        return fail(EXPIRED_MESSAGE);
      }
      if (
        err instanceof LinkedinRetryableError &&
        job.attemptsMade + 1 < ATTEMPTS
      ) {
        throw err; // the queue tries again, with backoff
      }
      this.logger.warn(`LinkedIn post ${post.id} failed: ${String(err)}`);
      return fail(
        'LinkedIn n’a pas accepté la publication. Réessayez plus tard.',
      );
    }
  }

  /**
   * A picture of the recruiter's own for the card: re-encoded as a JPEG at
   * most 1200 px wide (LinkedIn takes no WEBP; a photo's metadata goes), then
   * uploaded to LinkedIn. Returns the image's URN.
   */
  private async uploadOwnPicture(
    accountId: string,
    sealedToken: string,
    sub: string,
    image: Buffer,
  ): Promise<string> {
    let jpeg: Buffer;
    try {
      jpeg = await sharp(image)
        .rotate()
        .resize({ width: 1200, withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch {
      throw new BadRequestException('Cette image n’a pas pu être lue.');
    }
    try {
      return await uploadImage(
        this.crypto!.open(sealedToken),
        `urn:li:person:${sub}`,
        jpeg,
      );
    } catch (err) {
      if (err instanceof LinkedinAuthError) {
        await this.prisma.businessLinkedinAccount.update({
          where: { id: accountId },
          data: { expired_at: new Date() },
        });
        throw new BadRequestException(EXPIRED_MESSAGE);
      }
      this.logger.warn(`LinkedIn picture upload failed: ${String(err)}`);
      throw new BadRequestException(
        'LinkedIn n’a pas accepté cette image. Réessayez, ou gardez l’image de l’offre.',
      );
    }
  }

  /** The offer's share picture, uploaded; none if anything goes wrong. */
  private async cardPicture(
    token: string,
    author: string,
    offer: { slug: string; reference: string },
  ): Promise<string | null> {
    try {
      const res = await fetch(
        `${businessOrigin()}/carrieres/${encodeURIComponent(offer.slug)}/${encodeURIComponent(offer.reference)}/opengraph-image`,
        { signal: AbortSignal.timeout(15_000) },
      );
      if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) {
        return null;
      }
      return await uploadImage(
        token,
        author,
        Buffer.from(await res.arrayBuffer()),
      );
    } catch (err) {
      this.logger.warn(`LinkedIn card picture skipped: ${String(err)}`);
      return null;
    }
  }

  private async finish(
    postId: string,
    outcome: { urn: string } | { error: string },
  ): Promise<void> {
    const post = await this.prisma.jobOfferLinkedinPost.update({
      where: { id: postId },
      data:
        'urn' in outcome
          ? {
              status: LinkedinPostStatus.PUBLISHED,
              post_urn: outcome.urn,
              published_at: new Date(),
              error: null,
            }
          : { status: LinkedinPostStatus.FAILED, error: outcome.error },
      select: {
        offer_id: true,
        author_name: true,
        offer: { select: { title: true, employer_id: true } },
      },
    });
    notifyProfile(this.events, {
      recipientId: post.offer.employer_id,
      input: {
        type: 'LINKEDIN_POST',
        jobOfferId: post.offer_id,
        jobTitle: post.offer.title,
        authorName: post.author_name,
        postUrl: 'urn' in outcome ? postUrl(outcome.urn) : null,
        error: 'urn' in outcome ? null : outcome.error,
      },
    });
  }

  /**
   * The offer as its careers page shows it, or refused: the business
   * verified and on the careers site, the offer open and not past its date.
   */
  private async publicOffer(businessId: string, offerId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        profile_id: true,
        name: true,
        public_slug: true,
        verification_status: true,
        deleted_at: true,
      },
    });
    const offer = await this.prisma.jobOffer.findFirst({
      where: {
        id: offerId,
        employer_id: business?.profile_id,
        deleted_at: null,
        status: { in: OPEN },
        OR: [{ scheduled_at: null }, { scheduled_at: { gte: new Date() } }],
      },
      select: { title: true, description: true, reference: true },
    });
    if (!business || !offer) throw new NotFoundException('Offre introuvable.');
    if (
      !business.public_slug ||
      business.deleted_at ||
      business.verification_status !== VerificationStatus.VERIFIED
    ) {
      throw new BadRequestException(
        'L’offre sera publiable dès que votre organisation sera vérifiée.',
      );
    }
    return {
      ...offer,
      slug: business.public_slug,
      businessName: business.name,
    };
  }

  private async businessId(profileId: string): Promise<string> {
    const id = await this.subscriptions.businessOf(profileId);
    if (!id)
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    return id;
  }
}
