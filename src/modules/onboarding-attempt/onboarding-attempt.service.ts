import { Injectable, Logger } from '@nestjs/common';
import {
  OnboardingStage,
  Prisma,
  type OnboardingAttempt,
  type ProfileType,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';

/** Each stage is a screen further than the one before it. */
const STAGE_ORDER: readonly OnboardingStage[] = [
  OnboardingStage.CODE_SENT,
  OnboardingStage.PHONE_VERIFIED,
  OnboardingStage.DOCUMENTS,
  OnboardingStage.CONFIRMATION,
  OnboardingStage.COMPLETED,
];

export function isFurther(next: OnboardingStage, current: OnboardingStage) {
  return STAGE_ORDER.indexOf(next) > STAGE_ORDER.indexOf(current);
}

/** The stages the app reports itself; the others the server sees directly. */
export const REPORTABLE_STAGES = [
  OnboardingStage.DOCUMENTS,
  OnboardingStage.CONFIRMATION,
] as const;
export type ReportableStage = (typeof REPORTABLE_STAGES)[number];

type Who = {
  firstName?: string | null;
  lastName?: string | null;
  profileType?: ProfileType | null;
};

/**
 * An attempt is keyed by what its sign-up proves: the phone for a WhatsApp
 * sign-up, the email for a business one. A phone never contains '@'.
 */
const keyOf = (contact: string): { email: string } | { phone: string } =>
  contact.includes('@') ? { email: contact } : { phone: contact };

export type AdminOnboardingAttemptItem = {
  id: string;
  phone: string | null;
  email: string | null;
  /** 'business' for an email (business) sign-up, 'whatsapp' otherwise. */
  entry: string;
  firstName: string | null;
  lastName: string | null;
  profileType: ProfileType | null;
  stage: OnboardingStage;
  codeSends: number;
  startedAt: string;
  lastActivityAt: string;
  phoneVerifiedAt: string | null;
  completedAt: string | null;
  profileId: string | null;
  contactedAt: string | null;
  contactedBy: string | null;
  contactNote: string | null;
};

/**
 * Where each sign-up got to, so the team can call the people who stopped.
 *
 * Every recording method is best-effort and never throws: this is a back-office
 * view onto sign-ups, and a sign-up must not fail, or wait, because the view
 * could not be written. Callers fire and forget.
 */
@Injectable()
export class OnboardingAttemptService {
  private readonly logger = new Logger(OnboardingAttemptService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * A code went out — on WhatsApp to a phone, or by email to a business — a
   * new attempt, or another code for one.
   */
  async codeSent(contact: string, who: Who = {}): Promise<void> {
    await this.safely('codeSent', async () => {
      const now = new Date();
      const names = this.namesOf(who);
      const existing = await this.prisma.onboardingAttempt.findUnique({
        where: keyOf(contact),
      });

      if (!existing) {
        try {
          await this.prisma.onboardingAttempt.create({
            data: {
              ...keyOf(contact),
              entry: contact.includes('@') ? 'business' : 'whatsapp',
              ...names,
              started_at: now,
              last_activity_at: now,
            },
          });
          return;
        } catch (err) {
          // Two codes requested at once: the other request created the row.
          if (!this.isUniqueViolation(err)) throw err;
        }
      }

      if (existing?.stage === OnboardingStage.COMPLETED) {
        // Sending a signup code is refused while an account exists, so this
        // number's account was deleted and they are starting over — a new
        // attempt, not the old one's history.
        await this.prisma.onboardingAttempt.update({
          where: keyOf(contact),
          data: {
            ...names,
            stage: OnboardingStage.CODE_SENT,
            code_sends: 1,
            started_at: now,
            last_activity_at: now,
            phone_verified_at: null,
            completed_at: null,
            profile_id: null,
            contacted_at: null,
            contacted_by_id: null,
            contact_note: null,
          },
        });
        return;
      }

      await this.prisma.onboardingAttempt.update({
        where: keyOf(contact),
        data: {
          ...names,
          code_sends: { increment: 1 },
          last_activity_at: now,
        },
      });
    });
  }

  /** The code was right: the phone — or the business's email — is proven. */
  async phoneVerified(contact: string): Promise<void> {
    await this.advance(contact, OnboardingStage.PHONE_VERIFIED, {
      phone_verified_at: new Date(),
    });
  }

  /** A screen the app reports reaching, past the number check. */
  async reached(
    contact: string,
    stage: ReportableStage,
    who: Who = {},
  ): Promise<void> {
    await this.advance(contact, stage, this.namesOf(who));
  }

  /** The account exists. Called for every account, however it was created. */
  async completed(contact: string, profileId: string): Promise<void> {
    await this.advance(contact, OnboardingStage.COMPLETED, {
      completed_at: new Date(),
      profile_id: profileId,
    });
  }

  async listForAdmin(params: {
    page?: number;
    limit?: number;
    q?: string;
    stage?: OnboardingStage[];
    entry?: 'whatsapp' | 'business';
    /** Only attempts that never became an account. */
    incomplete?: boolean;
    contacted?: boolean;
    startedFrom?: string;
    startedTo?: string;
  }): Promise<{
    data: AdminOnboardingAttemptItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const where = this.adminWhere(params);

    const [rows, total] = await Promise.all([
      this.prisma.onboardingAttempt.findMany({
        where,
        orderBy: { last_activity_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.onboardingAttempt.count({ where }),
    ]);

    const adminIds = [
      ...new Set(rows.map((r) => r.contacted_by_id).filter(Boolean)),
    ] as string[];
    const admins = adminIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: adminIds } },
          select: { id: true, first_name: true, last_name: true },
        })
      : [];
    const adminName = new Map(
      admins.map((a) => [
        a.id,
        [a.first_name, a.last_name].filter(Boolean).join(' ') || null,
      ]),
    );

    return {
      data: rows.map((row) => this.toItem(row, adminName)),
      total,
      page,
      limit,
    };
  }

  /**
   * The funnel: how many attempts reached each stage or further, inside the
   * window. "Reached or further" so each bar is a subset of the one before it.
   */
  async statsForAdmin(params: { startedFrom?: string; startedTo?: string }) {
    const groups = await this.prisma.onboardingAttempt.groupBy({
      by: ['stage'],
      where: this.windowWhere(params),
      _count: { _all: true },
    });
    const atStage = new Map(groups.map((g) => [g.stage, g._count._all]));
    const reached = STAGE_ORDER.map((stage, index) => ({
      stage,
      count: STAGE_ORDER.slice(index).reduce(
        (sum, s) => sum + (atStage.get(s) ?? 0),
        0,
      ),
    }));
    const started = reached[0].count;
    const completed = atStage.get(OnboardingStage.COMPLETED) ?? 0;
    const contacted = await this.prisma.onboardingAttempt.count({
      where: {
        ...this.windowWhere(params),
        stage: { not: OnboardingStage.COMPLETED },
        contacted_at: { not: null },
      },
    });
    return {
      started,
      completed,
      dropped: started - completed,
      contacted,
      completionRate: started ? completed / started : 0,
      funnel: reached,
    };
  }

  async markContacted(
    id: string,
    adminId: string,
    note: string | null,
  ): Promise<AdminOnboardingAttemptItem> {
    const row = await this.prisma.onboardingAttempt.update({
      where: { id },
      data: {
        contacted_at: new Date(),
        contacted_by_id: adminId,
        contact_note: note?.trim() || null,
      },
    });
    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { first_name: true, last_name: true },
    });
    const name = admin
      ? [admin.first_name, admin.last_name].filter(Boolean).join(' ') || null
      : null;
    return this.toItem(row, new Map([[adminId, name]]));
  }

  private async advance(
    contact: string,
    stage: OnboardingStage,
    data: Prisma.OnboardingAttemptUpdateInput,
  ): Promise<void> {
    await this.safely(`advance:${stage}`, async () => {
      const existing = await this.prisma.onboardingAttempt.findUnique({
        where: keyOf(contact),
        select: { stage: true },
      });
      // No row: an attempt from before this table, or one whose code-sent
      // write failed. Nothing to advance.
      if (!existing) return;
      await this.prisma.onboardingAttempt.update({
        where: keyOf(contact),
        data: {
          ...data,
          last_activity_at: new Date(),
          // Never backwards: going back a screen is not getting less far.
          ...(isFurther(stage, existing.stage) ? { stage } : {}),
        },
      });
    });
  }

  private adminWhere(params: {
    q?: string;
    stage?: OnboardingStage[];
    entry?: 'whatsapp' | 'business';
    incomplete?: boolean;
    contacted?: boolean;
    startedFrom?: string;
    startedTo?: string;
  }): Prisma.OnboardingAttemptWhereInput {
    const q = params.q?.trim();
    return {
      ...this.windowWhere(params),
      ...(params.stage?.length
        ? { stage: { in: params.stage } }
        : params.incomplete
          ? { stage: { not: OnboardingStage.COMPLETED } }
          : {}),
      ...(params.entry ? { entry: params.entry } : {}),
      ...(params.contacted === true ? { contacted_at: { not: null } } : {}),
      ...(params.contacted === false ? { contacted_at: null } : {}),
      ...(q
        ? {
            OR: [
              { phone: { contains: q } },
              { email: { contains: q, mode: 'insensitive' } },
              { first_name: { contains: q, mode: 'insensitive' } },
              { last_name: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
  }

  private windowWhere(params: {
    startedFrom?: string;
    startedTo?: string;
  }): Prisma.OnboardingAttemptWhereInput {
    if (!params.startedFrom && !params.startedTo) return {};
    return {
      started_at: {
        ...(params.startedFrom ? { gte: new Date(params.startedFrom) } : {}),
        ...(params.startedTo
          ? { lte: new Date(`${params.startedTo}T23:59:59.999Z`) }
          : {}),
      },
    };
  }

  private toItem(
    row: OnboardingAttempt,
    adminName: Map<string, string | null>,
  ): AdminOnboardingAttemptItem {
    return {
      id: row.id,
      phone: row.phone,
      email: row.email,
      entry: row.entry,
      firstName: row.first_name,
      lastName: row.last_name,
      profileType: row.profile_type,
      stage: row.stage,
      codeSends: row.code_sends,
      startedAt: row.started_at.toISOString(),
      lastActivityAt: row.last_activity_at.toISOString(),
      phoneVerifiedAt: row.phone_verified_at?.toISOString() ?? null,
      completedAt: row.completed_at?.toISOString() ?? null,
      profileId: row.profile_id,
      contactedAt: row.contacted_at?.toISOString() ?? null,
      contactedBy: row.contacted_by_id
        ? (adminName.get(row.contacted_by_id) ?? null)
        : null,
      contactNote: row.contact_note,
    };
  }

  /** Only what was given: a later call without a name keeps the earlier one. */
  private namesOf(who: Who) {
    return {
      ...(who.firstName?.trim() ? { first_name: who.firstName.trim() } : {}),
      ...(who.lastName?.trim() ? { last_name: who.lastName.trim() } : {}),
      ...(who.profileType ? { profile_type: who.profileType } : {}),
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    );
  }

  private async safely(label: string, run: () => Promise<void>) {
    try {
      await run();
    } catch (err) {
      this.logger.warn(
        `Onboarding attempt ${label} not recorded: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
