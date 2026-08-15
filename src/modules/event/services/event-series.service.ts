import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DeliveryChannel,
  Prisma,
  RecurrenceFrequency,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { CreateEventDto } from '../dto/create-event.dto';
import { RecurrenceDto } from '../dto/recurrence.dto';
import { UpdateEventDto } from '../dto/update-event.dto';
import { EventEditScope } from '../enums/event-edit-scope.enum';
import { resolveEventWindow } from '../utils/event-window.util';
import {
  MAX_MATERIALISED_PER_REQUEST,
  RecurrenceExpanderService,
} from './recurrence-expander.service';

/** How each frequency reads in an error message: "repeats weekly", "at most a week". */
const FREQUENCY_WORDS: Record<
  RecurrenceFrequency,
  { adverb: string; period: string }
> = {
  DAILY: { adverb: 'daily', period: 'a day' },
  WEEKLY: { adverb: 'weekly', period: 'a week' },
  MONTHLY: { adverb: 'monthly', period: 'a month' },
  YEARLY: { adverb: 'yearly', period: 'a year' },
};

/** Everything a created series hands back to the caller. */
export type CreatedSeries = {
  /** The first occurrence — what the API returns and what the email describes. */
  masterId: number;
  seriesId: string;
  occurrenceCount: number;
};

/**
 * Operations that span more than one occurrence row.
 *
 * Kept out of `EventService` so the notification dispatch stays in one place:
 * this service writes rows and never sends anything, which is what makes "one
 * message per series, not per occurrence" a structural property rather than a
 * rule someone has to remember.
 */
@Injectable()
export class EventSeriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly expander: RecurrenceExpanderService,
  ) {}

  /**
   * Creates the rule and its occurrence rows in one transaction.
   *
   * Rows go in one `create` at a time rather than through `createMany`, because
   * `createMany` cannot write the implicit many-to-many join tables that carry
   * an event's profiles and assigned users.
   */
  async createSeries(
    dto: CreateEventDto,
    rule: RecurrenceDto,
    createdById: string,
  ): Promise<CreatedSeries> {
    const { start: anchorStart, end: anchorEnd } = resolveEventWindow(
      dto.startDate,
      dto.endDate,
    );
    this.assertOccurrenceFitsInterval(anchorStart, anchorEnd, rule.frequency);

    const until = rule.until ? new Date(rule.until) : null;
    const horizonEnd = until ?? this.expander.openEndedHorizon(anchorStart);

    const occurrences = this.expander.expand({
      anchorStart,
      anchorEnd,
      frequency: rule.frequency,
      until,
      count: rule.count ?? null,
      horizonEnd,
      maxRows: MAX_MATERIALISED_PER_REQUEST,
    });

    return this.prisma.$transaction(
      async (tx) => {
        const series = await tx.eventSeries.create({
          data: {
            frequency: rule.frequency,
            anchor_start: anchorStart,
            anchor_end: anchorEnd,
            until,
            count: rule.count ?? null,
            // How far the rows below actually reach — not how far the rule
            // does. The gap is what the lazy top-up later fills in.
            materialised_until:
              occurrences.at(-1)?.start ?? anchorStart,
          },
        });

        let masterId = 0;
        for (const occurrence of occurrences) {
          const row = await tx.event.create({
            data: {
              ...this.occurrenceData(dto, createdById),
              start_date: occurrence.start,
              end_date: occurrence.end,
              series_id: series.id,
              occurrence_index: occurrence.index,
            },
            select: { id: true },
          });
          if (occurrence.index === 0) masterId = row.id;
        }

        return {
          masterId,
          seriesId: series.id,
          occurrenceCount: occurrences.length,
        };
      },
      // A 120-row series is 120 inserts plus their join-table writes; the
      // default 5s timeout is not enough headroom on a cold connection.
      { timeout: 30_000 },
    );
  }

  /**
   * Rejects an occurrence that is still running when the next one starts.
   *
   * This is the shape behind "my repeating event is duplicated on every day".
   * An occurrence lasting longer than its own repeat interval overlaps its
   * successor, and the overlap accumulates: forty weeks into a weekly series
   * whose occurrences each run for years, every single day carries forty bars —
   * one per occurrence that has started and not yet finished. Nothing is
   * actually duplicated, but nothing about the calendar says so either.
   *
   * The rule is almost always a misreading of the two "ends" in the form: the
   * event's own end (when this occurrence finishes) versus the repeat's end
   * (when the series stops). Someone wanting a series that never stops sets the
   * occurrence to end far in the future, when what they wanted was to leave the
   * repeat's end condition empty — which is already the default.
   */
  private assertOccurrenceFitsInterval(
    anchorStart: Date,
    anchorEnd: Date,
    frequency: RecurrenceFrequency,
  ): void {
    const durationMs = anchorEnd.getTime() - anchorStart.getTime();
    if (durationMs < this.expander.intervalMs(anchorStart, frequency)) return;

    const { adverb, period } = FREQUENCY_WORDS[frequency];
    throw new BadRequestException(
      `An event that repeats ${adverb} must finish before it repeats, so it can last at most ${period}. ` +
        'Shorten the event\'s end date — to make the repetition itself never stop, leave the recurrence without an "until" or a "count".',
    );
  }

  /**
   * Applies an edit to one occurrence, the tail of a series, or all of it.
   *
   * A scope wider than THIS always splits: the affected occurrences move to a
   * new series row, so the two halves can diverge later without one silently
   * rewriting the other. The pivot's own id changes as a result, which is why
   * the client must refetch rather than patch its cache in place.
   */
  async applyScopedUpdate(
    pivotId: number,
    dto: UpdateEventDto,
    scope: EventEditScope,
  ): Promise<number> {
    const pivot = await this.prisma.event.findUnique({
      where: { id: pivotId },
      include: { series: true },
    });
    if (!pivot) throw new NotFoundException('Event not found');
    // A one-off, or a caller that asked for one occurrence: nothing to widen.
    if (!pivot.series || scope === EventEditScope.THIS) return pivotId;

    const series = pivot.series;
    const from =
      scope === EventEditScope.ALL ? series.anchor_start : pivot.start_date;

    const reschedules =
      dto.startDate !== undefined ||
      dto.endDate !== undefined ||
      dto.recurrence !== undefined;

    if (!reschedules) {
      // Dates untouched, so the existing rows stay where they are and only
      // their contents change.
      await this.updateTailInPlace(series.id, from, dto);
      return pivotId;
    }

    return this.regenerateTail(pivot, series, dto, from);
  }

  /**
   * Rewrites the scalar fields of every occurrence from `from` onwards.
   *
   * Relations need a second pass: `updateMany` cannot write the implicit
   * many-to-many join tables, so profiles and assigned users are set row by row
   * — and only when the caller actually sent them.
   */
  private async updateTailInPlace(
    seriesId: string,
    from: Date,
    dto: UpdateEventDto,
  ): Promise<void> {
    const where = { series_id: seriesId, start_date: { gte: from } };

    await this.prisma.$transaction(async (tx) => {
      await tx.event.updateMany({
        where,
        data: {
          ...(dto.title !== undefined && { title: dto.title }),
          ...(dto.description !== undefined && {
            description: dto.description,
          }),
          ...(dto.color !== undefined && { color: dto.color }),
          ...(dto.channel !== undefined && { channel: dto.channel }),
          ...(dto.location !== undefined && { location: dto.location }),
        },
      });

      if (dto.profileIds === undefined && dto.userIds === undefined) return;

      const rows = await tx.event.findMany({ where, select: { id: true } });
      for (const row of rows) {
        await tx.event.update({
          where: { id: row.id },
          data: {
            ...(dto.profileIds !== undefined && {
              profiles: { set: dto.profileIds.map((id) => ({ id })) },
            }),
            ...(dto.userIds !== undefined && {
              assigned_users: { set: dto.userIds.map((id) => ({ id })) },
            }),
          },
        });
      }
    });
  }

  /**
   * Drops the occurrences from the pivot onwards and regenerates them under a
   * new series, from the new dates and/or the new rule.
   *
   * Regenerating rather than shifting each row keeps one code path for "the
   * rule changed" and "the time changed" — and a shift cannot express a change
   * of frequency at all.
   */
  private async regenerateTail(
    pivot: { id: number; start_date: Date; end_date: Date },
    series: {
      id: string;
      frequency: RecurrenceFrequency;
      until: Date | null;
      count: number | null;
    },
    dto: UpdateEventDto,
    from: Date,
  ): Promise<number> {
    const template = await this.tailTemplate(pivot.id, dto);
    const { start: anchorStart, end: anchorEnd } = resolveEventWindow(
      dto.startDate ?? pivot.start_date,
      dto.endDate ?? pivot.end_date,
    );

    // A new rule replaces the old one wholesale — including its end condition,
    // so switching from "10 times" to "until March" does not leave the count
    // behind to fight with the date.
    const rule = dto.recurrence
      ? {
          frequency: dto.recurrence.frequency,
          until: dto.recurrence.until ? new Date(dto.recurrence.until) : null,
          count: dto.recurrence.count ?? null,
        }
      : {
          frequency: series.frequency,
          until: series.until,
          count: series.count,
        };
    const { frequency, until, count } = rule;
    this.assertOccurrenceFitsInterval(anchorStart, anchorEnd, frequency);

    const horizonEnd = until ?? this.expander.openEndedHorizon(anchorStart);
    const occurrences = this.expander.expand({
      anchorStart,
      anchorEnd,
      frequency,
      until,
      count,
      horizonEnd,
      maxRows: MAX_MATERIALISED_PER_REQUEST,
    });

    return this.prisma.$transaction(
      async (tx) => {
        const successor = await tx.eventSeries.create({
          data: {
            frequency,
            anchor_start: anchorStart,
            anchor_end: anchorEnd,
            until,
            count,
            materialised_until: occurrences.at(-1)?.start ?? anchorStart,
          },
        });

        await tx.event.deleteMany({
          where: { series_id: series.id, start_date: { gte: from } },
        });

        let newPivotId = 0;
        for (const occurrence of occurrences) {
          const row = await tx.event.create({
            data: {
              ...template,
              start_date: occurrence.start,
              end_date: occurrence.end,
              series_id: successor.id,
              occurrence_index: occurrence.index,
            },
            select: { id: true },
          });
          if (occurrence.index === 0) newPivotId = row.id;
        }

        // What is left of the original series now ends where the split began.
        // Nothing left means the split covered everything, so the old rule has
        // no occurrences to describe.
        const remaining = await tx.event.findFirst({
          where: { series_id: series.id },
          orderBy: { start_date: 'desc' },
          select: { start_date: true },
        });
        if (remaining) {
          await tx.eventSeries.update({
            where: { id: series.id },
            data: { until: remaining.start_date, count: null },
          });
        } else {
          await tx.eventSeries.delete({ where: { id: series.id } });
        }

        return newPivotId;
      },
      { timeout: 30_000 },
    );
  }

  /** The shared fields for a regenerated tail: the pivot's, with the edit applied. */
  private async tailTemplate(pivotId: number, dto: UpdateEventDto) {
    const source = await this.prisma.event.findUnique({
      where: { id: pivotId },
      include: {
        profiles: { select: { id: true } },
        assigned_users: { select: { id: true } },
      },
    });
    if (!source) throw new NotFoundException('Event not found');

    const profileIds = dto.profileIds ?? source.profiles.map((p) => p.id);
    const userIds = dto.userIds ?? source.assigned_users.map((u) => u.id);

    return {
      title: dto.title ?? source.title,
      description: dto.description ?? source.description,
      color: dto.color ?? source.color,
      channel: dto.channel ?? source.channel,
      location: dto.location ?? source.location,
      created_by_id: source.created_by_id,
      profiles: profileIds.length
        ? { connect: profileIds.map((id) => ({ id })) }
        : undefined,
      assigned_users: userIds.length
        ? { connect: userIds.map((id) => ({ id })) }
        : undefined,
    };
  }

  /**
   * Deletes one occurrence, the tail, or the whole series.
   *
   * ALL deletes the rule row and lets the foreign key cascade take the
   * occurrences with it — one statement instead of a hundred.
   */
  async applyScopedDelete(
    pivotId: number,
    scope: EventEditScope,
  ): Promise<void> {
    const pivot = await this.prisma.event.findUnique({
      where: { id: pivotId },
      select: { id: true, series_id: true, start_date: true },
    });
    if (!pivot) throw new NotFoundException('Event not found');

    if (!pivot.series_id) {
      await this.prisma.event.delete({ where: { id: pivotId } });
      return;
    }

    if (scope === EventEditScope.ALL) {
      await this.prisma.eventSeries.delete({ where: { id: pivot.series_id } });
      return;
    }

    const where =
      scope === EventEditScope.THIS_AND_FOLLOWING
        ? { series_id: pivot.series_id, start_date: { gte: pivot.start_date } }
        : { id: pivotId };

    await this.prisma.$transaction(async (tx) => {
      await tx.event.deleteMany({ where });

      // A rule with no occurrences left describes nothing; drop it rather than
      // leave a row the top-up would keep trying to extend.
      const remaining = await tx.event.findFirst({
        where: { series_id: pivot.series_id },
        orderBy: { start_date: 'desc' },
        select: { start_date: true },
      });
      if (!remaining) {
        await tx.eventSeries.delete({ where: { id: pivot.series_id! } });
      } else if (scope === EventEditScope.THIS_AND_FOLLOWING) {
        await tx.eventSeries.update({
          where: { id: pivot.series_id! },
          data: { until: remaining.start_date, count: null },
        });
      }
    });
  }

  /**
   * Extends open-ended series far enough to cover what someone is looking at.
   *
   * A series with no end date cannot be materialised forever, and there is no
   * scheduler for events — so the calendar's own read is what pulls the next
   * batch of rows into existence, bounded by the window being viewed.
   *
   * Costs nothing on the common path: series already covering the window are
   * excluded by the query, so browsing this month issues one SELECT and no
   * writes.
   */
  async ensureMaterialised(upTo: Date): Promise<void> {
    const stale = await this.prisma.eventSeries.findMany({
      where: {
        materialised_until: { lt: upTo },
        // A finished series has nothing left to generate: its last date has
        // passed, or its occurrences are all written.
        OR: [{ until: null }, { until: { gt: new Date() } }],
      },
      select: {
        id: true,
        frequency: true,
        anchor_start: true,
        anchor_end: true,
        until: true,
        count: true,
      },
    });

    for (const series of stale) {
      await this.extendSeries(series, upTo);
    }
  }

  /** One transaction per series, so a slow extension cannot hold up the others. */
  private async extendSeries(
    series: {
      id: string;
      frequency: RecurrenceFrequency;
      anchor_start: Date;
      anchor_end: Date;
      until: Date | null;
      count: number | null;
    },
    upTo: Date,
  ): Promise<void> {
    const written = await this.prisma.event.count({
      where: { series_id: series.id },
    });
    if (series.count !== null && written >= series.count) return;

    const occurrences = this.expander.expand({
      anchorStart: series.anchor_start,
      anchorEnd: series.anchor_end,
      frequency: series.frequency,
      until: series.until,
      count: series.count,
      horizonEnd: upTo,
      maxRows: MAX_MATERIALISED_PER_REQUEST,
      // Resume where the last write stopped. Indices are dense because the only
      // things that delete occurrences also truncate or drop the series.
      startIndex: written,
    });
    if (occurrences.length === 0) return;

    // The template comes from an existing occurrence rather than being carried
    // on the series: an edit to the series' contents has already been written
    // to those rows, and new occurrences must match what people can see.
    const template = await this.prisma.event.findFirst({
      where: { series_id: series.id },
      orderBy: { start_date: 'desc' },
      include: {
        profiles: { select: { id: true } },
        assigned_users: { select: { id: true } },
      },
    });
    if (!template) return;

    await this.prisma.$transaction(
      async (tx) => {
        for (const occurrence of occurrences) {
          await tx.event.create({
            data: {
              title: template.title,
              description: template.description,
              color: template.color,
              channel: template.channel,
              location: template.location,
              created_by_id: template.created_by_id,
              start_date: occurrence.start,
              end_date: occurrence.end,
              series_id: series.id,
              occurrence_index: occurrence.index,
              profiles: template.profiles.length
                ? { connect: template.profiles.map((p) => ({ id: p.id })) }
                : undefined,
              assigned_users: template.assigned_users.length
                ? { connect: template.assigned_users.map((u) => ({ id: u.id })) }
                : undefined,
            },
          });
        }

        await tx.eventSeries.update({
          where: { id: series.id },
          data: { materialised_until: occurrences.at(-1)!.start },
        });
      },
      { timeout: 30_000 },
    );
  }

  /** The fields every occurrence of a series shares. */
  private occurrenceData(
    dto: CreateEventDto,
    createdById: string,
  ): Omit<Prisma.EventUncheckedCreateInput, 'start_date' | 'end_date'> &
    Pick<Prisma.EventCreateInput, 'profiles' | 'assigned_users'> {
    return {
      title: dto.title,
      description: dto.description,
      color: dto.color,
      channel: dto.channel ?? DeliveryChannel.EMAIL,
      location: dto.location ?? null,
      created_by_id: createdById,
      profiles: dto.profileIds?.length
        ? { connect: dto.profileIds.map((id) => ({ id })) }
        : undefined,
      assigned_users: dto.userIds?.length
        ? { connect: dto.userIds.map((id) => ({ id })) }
        : undefined,
    };
  }
}
