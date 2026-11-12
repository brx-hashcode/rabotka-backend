import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InterviewMode, InterviewStatus } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
import { frWhen } from './interview-emails';
import { hashToken } from './interview.service';
import { visioUrl } from './interview-visio.service';

/** A sentence, as one recognition result: never a speech. */
export const MAX_LINE_CHARS = 500;
/** Lines sent at once: the browser sends every few seconds. */
export const MAX_LINES_PER_POST = 20;
/** About three hours of conversation: past it, the call is not an interview. */
export const MAX_LINES_PER_INTERVIEW = 4000;
/** What the report reads of the transcript. */
export const MAX_TRANSCRIPT_CHARS = 20_000;

const ROOM = /^Rabotka-[A-Za-z0-9]{6,32}$/;
const EARLY_MS = 24 * 60 * 60 * 1000;
const LATE_MS = 2 * 60 * 60 * 1000;

export type TranscriptRole = 'HOST' | 'CANDIDATE' | 'GUEST';
export type TranscriptConsent = 'ACCEPTED' | 'DECLINED';
export type LineInput = { text: string; at?: string };

type Actor = { profileId: string; memberId?: string };

export type TranscriptView = {
  transcribe: boolean;
  consent: TranscriptConsent | null;
  lines: { at: string; speaker: string; role: TranscriptRole; text: string }[];
};

/**
 * « Transcrire l'entretien »: during the visio, each person's own browser
 * turns their own voice into text (the browser hears no one else) and sends
 * the finished sentences here. Merged by time, they are the transcript the
 * « Compte rendu » is written from. Nothing of the sound is kept, and the
 * candidate's voice only once they accepted.
 */
@Injectable()
export class InterviewTranscriptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: BusinessSubscriptionService,
  ) {}

  // ── The business ─────────────────────────────────────────────────────

  async get(actor: Actor, interviewId: string): Promise<TranscriptView> {
    const interview = await this.owned(actor, interviewId);
    const lines = await this.prisma.interviewTranscriptLine.findMany({
      where: { interview_id: interview.id },
      orderBy: { spoken_at: 'asc' },
      take: MAX_LINES_PER_INTERVIEW,
    });
    return {
      transcribe: interview.transcribe,
      consent: consentOf(interview.transcript_consent),
      lines: lines.map((l) => ({
        at: l.spoken_at.toISOString(),
        speaker: l.speaker,
        role: l.role as TranscriptRole,
        text: l.text,
      })),
    };
  }

  /** Switched on or off by the business, before or during the call. */
  async setTranscribe(actor: Actor, interviewId: string, on: boolean) {
    const interview = await this.owned(actor, interviewId);
    if (on && !isRabotkaVisio(interview)) {
      throw new BadRequestException(
        'La transcription se fait dans une visio Rabotka : créez un lien de visio pour cet entretien.',
      );
    }
    await this.prisma.interview.update({
      where: { id: interview.id },
      data: { transcribe: on },
    });
    return this.get(actor, interviewId);
  }

  /** The organiser's own sentences, from the business call page. */
  async addHostLines(actor: Actor, interviewId: string, lines: LineInput[]) {
    const interview = await this.owned(actor, interviewId);
    this.open(interview);
    const who = actor.memberId
      ? await this.prisma.businessMember.findFirst({
          where: { id: actor.memberId, business_id: interview.business_id },
          select: { name: true },
        })
      : null;
    return this.store(
      interview.id,
      who?.name || interview.business.name,
      'HOST',
      lines,
    );
  }

  // ── The guests, by their link ─────────────────────────────────────────

  /** Whether the call is transcribed: the guest page asks while in the call. */
  async status(room: string) {
    const interview = await this.byRoom(room);
    return {
      transcribe: interview.transcribe,
      consent: consentOf(interview.transcript_consent),
    };
  }

  /**
   * The candidate's answer, from their call page. An invited person answers
   * for themselves on their page only: nothing to keep for them.
   */
  async answer(room: string, accepted: boolean, guestToken?: string) {
    const interview = await this.byRoom(room);
    if (!guestToken) {
      await this.prisma.interview.update({
        where: { id: interview.id },
        data: { transcript_consent: accepted ? 'ACCEPTED' : 'DECLINED' },
      });
    }
    return { transcribe: interview.transcribe, accepted };
  }

  /** The sentences of the candidate, or of an invited person (`guestToken`). */
  async addGuestLines(room: string, lines: LineInput[], guestToken?: string) {
    const interview = await this.byRoom(room);
    this.open(interview);
    if (guestToken) {
      const guest = await this.prisma.interviewGuest.findFirst({
        where: {
          token_hash: hashToken(guestToken),
          interview_id: interview.id,
        },
        select: { name: true },
      });
      if (!guest) throw new NotFoundException('Invitation introuvable.');
      return this.store(interview.id, guest.name, 'GUEST', lines);
    }
    if (interview.transcript_consent !== 'ACCEPTED') {
      throw new ForbiddenException(
        'Vous n’avez pas accepté la transcription de l’entretien.',
      );
    }
    return this.store(
      interview.id,
      interview.candidate_name,
      'CANDIDATE',
      lines,
    );
  }

  // ── For the « Compte rendu » ──────────────────────────────────────────

  /** Both sides merged by time, as the report reads them; "" when none. */
  async merged(interviewId: string): Promise<string> {
    const lines = await this.prisma.interviewTranscriptLine.findMany({
      where: { interview_id: interviewId },
      orderBy: { spoken_at: 'asc' },
      take: MAX_LINES_PER_INTERVIEW,
    });
    return mergeTranscript(lines);
  }

  // ── Inside ───────────────────────────────────────────────────────────

  private async store(
    interviewId: string,
    speaker: string,
    role: TranscriptRole,
    input: LineInput[],
  ) {
    const now = Date.now();
    const rows = (Array.isArray(input) ? input : [])
      .slice(0, MAX_LINES_PER_POST)
      .map((l) => ({
        text: String(l?.text ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, MAX_LINE_CHARS),
        at: spokenAt(l?.at, now),
      }))
      .filter((l) => l.text.length > 0);
    if (rows.length === 0) return { added: 0 };
    const count = await this.prisma.interviewTranscriptLine.count({
      where: { interview_id: interviewId },
    });
    const room = Math.max(0, MAX_LINES_PER_INTERVIEW - count);
    if (room === 0) return { added: 0 };
    const kept = rows.slice(0, room);
    await this.prisma.interviewTranscriptLine.createMany({
      data: kept.map((l) => ({
        interview_id: interviewId,
        spoken_at: l.at,
        speaker: speaker.slice(0, 80),
        role,
        text: l.text,
      })),
    });
    return { added: kept.length };
  }

  /** Transcribed only when switched on, and around the interview's time. */
  private open(i: {
    transcribe: boolean;
    status: InterviewStatus;
    starts_at: Date;
    duration_minutes: number;
  }) {
    if (!i.transcribe) {
      throw new BadRequestException(
        'La transcription n’est pas activée pour cet entretien.',
      );
    }
    if (
      i.status === InterviewStatus.CANCELLED ||
      i.status === InterviewStatus.DECLINED
    ) {
      throw new BadRequestException('Cet entretien n’a plus lieu.');
    }
    const now = Date.now();
    const end = i.starts_at.getTime() + i.duration_minutes * 60_000;
    if (now < i.starts_at.getTime() - EARLY_MS || now > end + LATE_MS) {
      throw new BadRequestException(
        'La transcription se fait pendant l’entretien.',
      );
    }
  }

  private async byRoom(room: string) {
    if (!ROOM.test(room)) throw new NotFoundException('Visio introuvable.');
    const interview = await this.prisma.interview.findFirst({
      where: { location: visioUrl(room), mode: InterviewMode.VIDEO },
      orderBy: { starts_at: 'desc' },
    });
    if (!interview) throw new NotFoundException('Visio introuvable.');
    return interview;
  }

  private async owned(actor: Actor, interviewId: string) {
    const businessId = await this.subscriptions.businessOf(actor.profileId);
    if (!businessId)
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    const interview = await this.prisma.interview.findFirst({
      where: { id: interviewId, business_id: businessId },
      include: { business: { select: { name: true } } },
    });
    if (!interview) throw new NotFoundException('Entretien introuvable.');
    return interview;
  }
}

function isRabotkaVisio(i: { mode: InterviewMode; location: string | null }) {
  return (
    i.mode === InterviewMode.VIDEO &&
    !!i.location &&
    /\/visio\/Rabotka-[A-Za-z0-9]{6,32}$/.test(i.location)
  );
}

function consentOf(v: string | null): TranscriptConsent | null {
  return v === 'ACCEPTED' || v === 'DECLINED' ? v : null;
}

/** The browser's time of the sentence, unless it is far from ours. */
function spokenAt(at: string | undefined, now: number): Date {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) && t > now - 5 * 60_000 && t < now + 60_000
    ? new Date(t)
    : new Date(now);
}

/**
 * « [10:03] Antoine Levassor : … », one line per sentence, in the order they
 * were spoken. A speaker's sentences in a row join up to a minute, so the
 * report reads turns, not fragments.
 */
export function mergeTranscript(
  lines: { spoken_at: Date; speaker: string; text: string }[],
): string {
  const turns: { at: Date; speaker: string; text: string }[] = [];
  for (const l of [...lines].sort(
    (a, b) => a.spoken_at.getTime() - b.spoken_at.getTime(),
  )) {
    const last = turns.at(-1);
    if (
      last &&
      last.speaker === l.speaker &&
      l.spoken_at.getTime() - last.at.getTime() < 60_000
    ) {
      last.text = `${last.text} ${l.text}`;
    } else {
      turns.push({ at: l.spoken_at, speaker: l.speaker, text: l.text });
    }
  }
  const out = turns
    .map(
      (t) => `[${frWhen(t.at).split(' à ')[1] ?? ''}] ${t.speaker} : ${t.text}`,
    )
    .join('\n');
  return out.slice(0, MAX_TRANSCRIPT_CHARS);
}
