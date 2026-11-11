import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CandidateOpinionVerdict } from '@prisma/client';

import { PrismaService } from '../../../common/services/prisma/prisma.service';
import type { TeamActor } from '../team/team.service';

/** Which application: a Rabotka one, or one from the careers page. */
export type ApplicationKind = 'rabotka' | 'external';

export const MAX_NOTE = 4000;

type Target = {
  kind: ApplicationKind;
  id: string;
  cvResumeId: string | null;
  /** The note and opinion column for this kind. */
  where: { application_id: string } | { external_application_id: string };
};

const author = { select: { id: true, name: true, role: true } } as const;

/**
 * What the team thinks of a candidate: private notes, one Oui / Peut-être /
 * Non per member, and the candidate's timeline. Only ever read here, for the
 * business that owns the offer — never on any candidate-facing path
 * (a contract test holds that).
 */
@Injectable()
export class CandidateNotesService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Notes ────────────────────────────────────────────────────────────

  async notes(actor: TeamActor, kind: ApplicationKind, id: string) {
    const target = await this.target(actor, kind, id);
    const rows = await this.prisma.candidateNote.findMany({
      where: { ...target.where, deleted_at: null },
      orderBy: { created_at: 'asc' },
      include: { member: author },
    });
    return rows.map((n) => ({
      id: n.id,
      body: n.body,
      createdAt: n.created_at.toISOString(),
      edited: n.updated_at.getTime() - n.created_at.getTime() > 1000,
      author: n.member,
      mine: n.member_id === actor.member.id,
    }));
  }

  async addNote(
    actor: TeamActor,
    kind: ApplicationKind,
    id: string,
    body: string,
  ) {
    const target = await this.target(actor, kind, id);
    await this.prisma.candidateNote.create({
      data: {
        business_id: actor.businessId,
        member_id: actor.member.id,
        body: this.body(body),
        ...target.where,
      },
    });
    return this.notes(actor, kind, id);
  }

  async editNote(
    actor: TeamActor,
    kind: ApplicationKind,
    id: string,
    noteId: string,
    body: string,
  ) {
    await this.ownNote(actor, kind, id, noteId);
    await this.prisma.candidateNote.update({
      where: { id: noteId },
      data: { body: this.body(body) },
    });
    return this.notes(actor, kind, id);
  }

  async deleteNote(
    actor: TeamActor,
    kind: ApplicationKind,
    id: string,
    noteId: string,
  ) {
    await this.ownNote(actor, kind, id, noteId);
    await this.prisma.candidateNote.update({
      where: { id: noteId },
      data: { deleted_at: new Date() },
    });
    return this.notes(actor, kind, id);
  }

  // ── Opinions ─────────────────────────────────────────────────────────

  async opinions(actor: TeamActor, kind: ApplicationKind, id: string) {
    const target = await this.target(actor, kind, id);
    return this.opinionsOf(actor, target);
  }

  async setOpinion(
    actor: TeamActor,
    kind: ApplicationKind,
    id: string,
    verdict: CandidateOpinionVerdict,
  ) {
    const target = await this.target(actor, kind, id);
    const existing = await this.prisma.candidateOpinion.findFirst({
      where: { ...target.where, member_id: actor.member.id },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.candidateOpinion.update({
        where: { id: existing.id },
        data: { verdict },
      });
    } else {
      await this.prisma.candidateOpinion.create({
        data: {
          business_id: actor.businessId,
          member_id: actor.member.id,
          verdict,
          ...target.where,
        },
      });
    }
    return this.opinionsOf(actor, target);
  }

  async clearOpinion(actor: TeamActor, kind: ApplicationKind, id: string) {
    const target = await this.target(actor, kind, id);
    await this.prisma.candidateOpinion.deleteMany({
      where: { ...target.where, member_id: actor.member.id },
    });
    return this.opinionsOf(actor, target);
  }

  /** The team's opinions on every application of an offer, for its cards. */
  async offerOpinions(actor: TeamActor, offerId: string) {
    const offer = await this.prisma.jobOffer.findFirst({
      where: { id: offerId, employer_id: actor.profileId },
      select: { id: true },
    });
    if (!offer) throw new NotFoundException('Offre introuvable.');
    const rows = await this.prisma.candidateOpinion.findMany({
      where: {
        business_id: actor.businessId,
        OR: [
          { application: { job_offer_id: offerId } },
          { external_application: { job_offer_id: offerId } },
        ],
      },
      select: {
        application_id: true,
        external_application_id: true,
        verdict: true,
      },
    });
    const empty = () => ({ YES: 0, MAYBE: 0, NO: 0 });
    const rabotka: Record<string, ReturnType<typeof empty>> = {};
    const external: Record<string, ReturnType<typeof empty>> = {};
    for (const r of rows) {
      const [map, key] = r.application_id
        ? [rabotka, r.application_id]
        : [external, r.external_application_id!];
      (map[key] ??= empty())[r.verdict] += 1;
    }
    return { rabotka, external };
  }

  // ── Timeline ─────────────────────────────────────────────────────────

  /**
   * What happened to this application, oldest first: applied, seen,
   * interviews, notes, opinions, the decision — with who did it when the
   * activity log knows.
   */
  async timeline(actor: TeamActor, kind: ApplicationKind, id: string) {
    const target = await this.target(actor, kind, id);
    const [dates, interviews, notes, opinions, activity] = await Promise.all([
      this.dates(target),
      this.prisma.interview.findMany({
        where: {
          business_id: actor.businessId,
          OR: [
            ...(kind === 'rabotka' ? [{ application_id: id }] : []),
            ...(target.cvResumeId ? [{ cv_resume_id: target.cvResumeId }] : []),
          ],
        },
        select: {
          id: true,
          created_at: true,
          starts_at: true,
          status: true,
          responded_at: true,
          report: { select: { generated_at: true } },
        },
      }),
      this.prisma.candidateNote.findMany({
        where: { ...target.where, deleted_at: null },
        select: { created_at: true, member: author },
      }),
      this.prisma.candidateOpinion.findMany({
        where: target.where,
        select: { updated_at: true, verdict: true, member: author },
      }),
      this.prisma.businessActivity.findMany({
        where: { business_id: actor.businessId, target_id: id },
        select: { created_at: true, action: true, member: author },
        orderBy: { created_at: 'asc' },
      }),
    ]);

    /** Who made a decision: the activity line for it, if any. */
    const by = (pattern: RegExp) =>
      activity.find((a) => pattern.test(a.action))?.member ?? null;

    type Event = {
      at: string;
      kind:
        | 'APPLIED'
        | 'VIEWED'
        | 'SHORTLISTED'
        | 'RETAINED'
        | 'REFUSED'
        | 'WITHDRAWN'
        | 'INTERVIEW'
        | 'REPORT'
        | 'NOTE'
        | 'OPINION';
      member?: { id: string; name: string; role: string } | null;
      verdict?: CandidateOpinionVerdict;
      interview?: { startsAt: string; status: string };
      /** WITHDRAWN: who ended it — the worker, the business, or Rabotka (the offer closed or expired). */
      cancelledBy?: 'WORKER' | 'EMPLOYER' | 'SYSTEM' | null;
    };
    const events: Event[] = [];
    const push = (at: Date | null | undefined, e: Omit<Event, 'at'>) => {
      if (at) events.push({ at: at.toISOString(), ...e });
    };
    push(dates.applied, { kind: 'APPLIED' });
    push(dates.viewed, { kind: 'VIEWED' });
    push(dates.shortlisted, {
      kind: 'SHORTLISTED',
      member: by(/^POST .*\/shortlist$/),
    });
    push(dates.retained, {
      kind: 'RETAINED',
      member: by(/\/(accept|retain)$/),
    });
    push(dates.refused, {
      kind: 'REFUSED',
      member: by(/\/(reject|refuse)$/),
    });
    push(dates.withdrawn, {
      kind: 'WITHDRAWN',
      cancelledBy: dates.cancelledBy,
    });
    for (const i of interviews) {
      push(i.created_at, {
        kind: 'INTERVIEW',
        interview: { startsAt: i.starts_at.toISOString(), status: i.status },
      });
      // « Compte rendu rédigé »: the team wrote one up after the interview.
      push(i.report?.generated_at, {
        kind: 'REPORT',
        interview: { startsAt: i.starts_at.toISOString(), status: i.status },
      });
    }
    for (const n of notes)
      push(n.created_at, { kind: 'NOTE', member: n.member });
    for (const o of opinions) {
      push(o.updated_at, {
        kind: 'OPINION',
        member: o.member,
        verdict: o.verdict,
      });
    }
    return events.sort((a, b) => a.at.localeCompare(b.at));
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /** The application, if it is on one of this business's offers. */
  private async target(
    actor: TeamActor,
    kind: ApplicationKind,
    id: string,
  ): Promise<Target> {
    if (kind === 'rabotka') {
      const app = await this.prisma.application.findFirst({
        where: {
          id,
          deleted_at: null,
          job_offer: { employer_id: actor.profileId },
        },
        select: { id: true },
      });
      if (!app) throw new NotFoundException('Candidature introuvable.');
      return { kind, id, cvResumeId: null, where: { application_id: id } };
    }
    if (kind === 'external') {
      const app = await this.prisma.externalApplication.findFirst({
        where: { id, job_offer: { employer_id: actor.profileId } },
        select: { id: true, cv_resume_id: true },
      });
      if (!app) throw new NotFoundException('Candidature introuvable.');
      return {
        kind,
        id,
        cvResumeId: app.cv_resume_id,
        where: { external_application_id: id },
      };
    }
    throw new BadRequestException('Type de candidature inconnu.');
  }

  private async dates(target: Target) {
    if (target.kind === 'rabotka') {
      const a = await this.prisma.application.findUniqueOrThrow({
        where: { id: target.id },
        select: {
          created_at: true,
          viewed_at: true,
          shortlisted_at: true,
          accepted_at: true,
          rejected_at: true,
          cancelled_at: true,
          cancelled_by: true,
        },
      });
      return {
        applied: a.created_at,
        viewed: a.viewed_at,
        shortlisted: a.shortlisted_at,
        retained: a.accepted_at,
        refused: a.rejected_at,
        withdrawn: a.cancelled_at,
        // « A retiré sa candidature » only when it was the worker.
        cancelledBy: a.cancelled_by,
      };
    }
    const a = await this.prisma.externalApplication.findUniqueOrThrow({
      where: { id: target.id },
      select: {
        created_at: true,
        viewed_at: true,
        shortlisted_at: true,
        retained_at: true,
        refused_at: true,
      },
    });
    return {
      applied: a.created_at,
      viewed: a.viewed_at,
      shortlisted: a.shortlisted_at,
      retained: a.retained_at,
      refused: a.refused_at,
      withdrawn: null,
      cancelledBy: null,
    };
  }

  private async opinionsOf(actor: TeamActor, target: Target) {
    const rows = await this.prisma.candidateOpinion.findMany({
      where: target.where,
      orderBy: { updated_at: 'asc' },
      include: { member: author },
    });
    return {
      mine: rows.find((r) => r.member_id === actor.member.id)?.verdict ?? null,
      all: rows.map((r) => ({
        member: r.member,
        verdict: r.verdict,
        at: r.updated_at.toISOString(),
      })),
      summary: {
        YES: rows.filter((r) => r.verdict === 'YES').length,
        MAYBE: rows.filter((r) => r.verdict === 'MAYBE').length,
        NO: rows.filter((r) => r.verdict === 'NO').length,
      },
    };
  }

  private async ownNote(
    actor: TeamActor,
    kind: ApplicationKind,
    id: string,
    noteId: string,
  ) {
    const target = await this.target(actor, kind, id);
    const note = await this.prisma.candidateNote.findFirst({
      where: { id: noteId, ...target.where, deleted_at: null },
      select: { member_id: true },
    });
    if (!note) throw new NotFoundException('Note introuvable.');
    if (note.member_id !== actor.member.id) {
      throw new ForbiddenException('Seul son auteur modifie une note.');
    }
  }

  private body(raw: string) {
    const body = raw.trim();
    if (!body) throw new BadRequestException('La note est vide.');
    if (body.length > MAX_NOTE) {
      throw new BadRequestException(
        `Une note fait ${MAX_NOTE} caractères au plus.`,
      );
    }
    return body;
  }
}
