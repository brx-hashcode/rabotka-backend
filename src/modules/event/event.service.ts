import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminNotificationEvent } from '../../common/events/admin-notification.events';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { ListEventsDto } from './dto/list-events.dto';
import { RecurrenceDto } from './dto/recurrence.dto';
import { EventEditScope } from './enums/event-edit-scope.enum';
import { EventSeriesService } from './services/event-series.service';
import { resolveEventWindow } from './utils/event-window.util';
import { DeliveryChannel, Prisma } from '@prisma/client';
import { NotificationService } from '../notification/notification.service';
import { EventNotificationDispatcher } from './services/event-notification.dispatcher';
import type { EventNotificationRecipient } from './interfaces/event-notification.interfaces';

const eventInclude = {
  series: true,
  created_by: { select: { id: true, first_name: true, last_name: true } },
  profiles: {
    select: {
      id: true,
      first_name: true,
      last_name: true,
      avatar_url: true,
      email: true,
      phone: true,
    },
  },
  assigned_users: {
    select: { id: true, first_name: true, last_name: true, email: true },
  },
} as const;

function parseIsoDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function mapEvent(event: any) {
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    startDate: event.start_date.toISOString(),
    endDate: event.end_date.toISOString(),
    color: event.color,
    channel: event.channel,
    location: event.location ?? null,
    createdAt: event.created_at.toISOString(),
    updatedAt: event.updated_at.toISOString(),
    // Null on every event that predates recurrence, and on every one-off since.
    seriesId: event.series_id ?? null,
    occurrenceIndex: event.occurrence_index ?? null,
    recurrence: event.series
      ? {
          frequency: event.series.frequency,
          until: event.series.until?.toISOString() ?? null,
          count: event.series.count ?? null,
        }
      : null,
    user: {
      id: event.created_by.id,
      name: `${event.created_by.first_name} ${event.created_by.last_name}`.trim(),
      picturePath: null,
    },
    profiles: event.profiles.map((p: any) => ({
      id: p.id,
      name: `${p.first_name} ${p.last_name}`.trim(),
      avatarUrl: p.avatar_url ?? null,
    })),
    assignedUsers: event.assigned_users.map((u: any) => ({
      id: u.id,
      name: `${u.first_name} ${u.last_name}`.trim(),
      picturePath: null,
    })),
  };
}

@Injectable()
export class EventService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notification: NotificationService,
    private readonly dispatcher: EventNotificationDispatcher,
    private readonly eventEmitter: EventEmitter2,
    private readonly series: EventSeriesService,
  ) {}

  async list(dto: ListEventsDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 500;
    const skip = (page - 1) * limit;

    // Interval overlap, not containment: an event that starts before the window
    // and ends after it still shows on every day in between. Same predicate the
    // client used to apply in helpers.ts (`getEventsForMonth`), moved to SQL so
    // the calendar stops downloading the whole table on every page load.
    const from = dto.from ? new Date(dto.from) : undefined;
    const to = dto.to ? new Date(dto.to) : undefined;

    // An open-ended series only exists as rows up to a horizon. Browsing past
    // that horizon is what extends it — there is no scheduler doing it in the
    // background, and without a window there is nothing to extend towards.
    if (to) await this.series.ensureMaterialised(to);
    const where: Prisma.EventWhereInput =
      from && to
        ? { start_date: { lte: to }, end_date: { gte: from } }
        : {};

    const [events, total] = await Promise.all([
      this.prisma.event.findMany({
        where,
        skip,
        take: limit,
        orderBy: { start_date: 'asc' },
        include: eventInclude,
      }),
      // The same `where` — counting the whole table while returning a window
      // makes `total` describe a different result set than `data`.
      this.prisma.event.count({ where }),
    ]);

    return { data: events.map(mapEvent), total, page, limit };
  }

  async findOne(id: number) {
    const event = await this.prisma.event.findUnique({
      where: { id },
      include: eventInclude,
    });
    if (!event) throw new NotFoundException('Event not found');
    return mapEvent(event);
  }

  async create(dto: CreateEventDto, createdById: string) {
    // A repeating event writes N rows and one rule; a one-off writes the single
    // row it always has. Either way exactly one event object comes back — the
    // first occurrence — so everything below this point is shared, and the
    // notification cannot accidentally fire per occurrence.
    // The same resolution the series path applies, so a one-off and the first
    // occurrence of a series treat an omitted end date identically.
    const window = resolveEventWindow(dto.startDate, dto.endDate);

    const event = dto.recurrence
      ? await this.createSeriesMaster(dto, dto.recurrence, createdById)
      : await this.prisma.event.create({
          data: {
            title: dto.title,
            description: dto.description,
            start_date: window.start,
            end_date: window.end,
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
          },
          include: eventInclude,
        });

    const mapped = mapEvent(event);

    this.eventEmitter.emit(AdminNotificationEvent.EVENT_CREATED, {
      event: AdminNotificationEvent.EVENT_CREATED,
      title: 'Nouvel événement',
      message: `Nouvel événement créé : ${dto.title}`,
      entityType: 'event',
      entityId: String(event.id),
      timestamp: new Date().toISOString(),
    });

    const recipients: EventNotificationRecipient[] = [
      ...event.profiles.map((p: any) => ({
        email: p.email,
        phone: p.phone,
        name: `${p.first_name} ${p.last_name}`.trim(),
      })),
      ...event.assigned_users.map((u: any) => ({
        email: u.email,
        name: `${u.first_name} ${u.last_name}`.trim(),
      })),
    ];

    // One dispatch, whether this created 1 row or 120. It sits here rather than
    // inside the series writer precisely so it cannot end up inside the loop.
    void this.dispatcher.dispatchEventCreated(
      recipients,
      {
        eventId: String(event.id),
        seriesId: mapped.seriesId,
        recurrence: mapped.recurrence,
        title: dto.title,
        startDate: mapped.startDate,
        endDate: mapped.endDate,
        description: dto.description,
        location: dto.location,
      },
      dto.channel ?? DeliveryChannel.EMAIL,
    );

    return mapped;
  }

  /**
   * Writes a series and returns its first occurrence, shaped exactly like the
   * row `create()` would have made for a one-off — so the caller never has to
   * care which kind it built.
   */
  private async createSeriesMaster(
    dto: CreateEventDto,
    rule: RecurrenceDto,
    createdById: string,
  ) {
    const { masterId } = await this.series.createSeries(dto, rule, createdById);

    const master = await this.prisma.event.findUnique({
      where: { id: masterId },
      include: eventInclude,
    });
    if (!master) throw new NotFoundException('Event not found');
    return master;
  }

  async update(id: number, dto: UpdateEventDto) {
    const existing = await this.findOne(id);
    const datesChanged =
      (dto.startDate !== undefined && dto.startDate !== existing.startDate) ||
      (dto.endDate !== undefined && dto.endDate !== existing.endDate);

    const scope = dto.scope ?? EventEditScope.THIS;
    // Anything wider than one occurrence is the series service's problem: it
    // may split the series and renumber rows, which the single-row update below
    // cannot express. A plain edit to a plain event never reaches it.
    if (scope !== EventEditScope.THIS || dto.recurrence !== undefined) {
      const pivotId = await this.series.applyScopedUpdate(id, dto, scope);
      const pivot = await this.prisma.event.findUnique({
        where: { id: pivotId },
        include: eventInclude,
      });
      if (!pivot) throw new NotFoundException('Event not found');

      const mapped = mapEvent(pivot);
      this.emitUpdated(mapped);
      if (datesChanged) this.dispatchUpdated(pivot, mapped, dto);
      return mapped;
    }

    this.assertDatesStillOrdered(dto, existing, datesChanged);

    const newStartDate = parseIsoDate(dto.startDate);
    const newEndDate = parseIsoDate(dto.endDate);

    const event = await this.prisma.event.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(newStartDate !== undefined && { start_date: newStartDate }),
        ...(newEndDate !== undefined && { end_date: newEndDate }),
        ...(dto.color !== undefined && { color: dto.color }),
        ...(dto.channel !== undefined && { channel: dto.channel }),
        ...(dto.location !== undefined && { location: dto.location }),
        ...(dto.profileIds !== undefined && {
          profiles: { set: dto.profileIds.map((pid) => ({ id: pid })) },
        }),
        ...(dto.userIds !== undefined && {
          assigned_users: { set: dto.userIds.map((uid) => ({ id: uid })) },
        }),
      },
      include: eventInclude,
    });

    const mapped = mapEvent(event);

    this.emitUpdated(mapped);
    if (datesChanged) this.dispatchUpdated(event, mapped, dto);

    return mapped;
  }

  async remove(id: number, scope: EventEditScope = EventEditScope.THIS) {
    await this.findOne(id);
    await this.series.applyScopedDelete(id, scope);
  }

  /**
   * Checks the row's dates as they will be *after* the edit, not as the request
   * carries them: moving only the start still has to land before the end that
   * was stored last time.
   *
   * Skipped when the edit leaves both alone, so a row that predates this check
   * can still have its title fixed.
   */
  private assertDatesStillOrdered(
    dto: UpdateEventDto,
    existing: { startDate: string; endDate: string },
    datesChanged: boolean,
  ): void {
    if (!datesChanged) return;
    resolveEventWindow(
      dto.startDate ?? existing.startDate,
      dto.endDate ?? existing.endDate,
    );
  }

  private emitUpdated(mapped: ReturnType<typeof mapEvent>) {
    this.eventEmitter.emit(AdminNotificationEvent.EVENT_UPDATED, {
      event: AdminNotificationEvent.EVENT_UPDATED,
      title: 'Événement modifié',
      message: `L'événement a été modifié : ${mapped.title}`,
      entityType: 'event',
      entityId: String(mapped.id),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * One message per edit, whatever it touched.
   *
   * Shared by both update paths so that rescheduling thirty occurrences mails
   * each participant once, not thirty times — the same reason `create` keeps
   * its dispatch outside the row-writing loop.
   */
  private dispatchUpdated(
    // The raw row, not the mapped one: `mapEvent` drops emails and phones on
    // purpose, since they must not travel in an API response.
    event: any,
    mapped: ReturnType<typeof mapEvent>,
    dto: UpdateEventDto,
  ) {
    const recipients: EventNotificationRecipient[] = [
      ...event.profiles.map((p: any) => ({
        email: p.email,
        phone: p.phone,
        name: `${p.first_name} ${p.last_name}`.trim(),
      })),
      ...event.assigned_users.map((u: any) => ({
        email: u.email,
        name: `${u.first_name} ${u.last_name}`.trim(),
      })),
    ];

    void this.dispatcher.dispatchEventUpdated(
      recipients,
      {
        eventId: String(event.id),
        seriesId: mapped.seriesId,
        recurrence: mapped.recurrence,
        title: mapped.title,
        startDate: mapped.startDate,
        endDate: mapped.endDate,
        description: mapped.description,
        location: mapped.location,
      },
      dto.channel ?? DeliveryChannel.EMAIL,
    );
  }
}
