import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminNotificationEvent } from '../../common/events/admin-notification.events';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { ListEventsDto } from './dto/list-events.dto';
import { DeliveryChannel } from '@prisma/client';
import { NotificationService } from '../notification/notification.service';
import { EventNotificationDispatcher } from './services/event-notification.dispatcher';
import type { EventNotificationRecipient } from './interfaces/event-notification.interfaces';

const eventInclude = {
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
  ) {}

  async list(dto: ListEventsDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 500;
    const skip = (page - 1) * limit;

    const [events, total] = await Promise.all([
      this.prisma.event.findMany({
        skip,
        take: limit,
        orderBy: { start_date: 'asc' },
        include: eventInclude,
      }),
      this.prisma.event.count(),
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
    const event = await this.prisma.event.create({
      data: {
        title: dto.title,
        description: dto.description,
        start_date: parseIsoDate(dto.startDate) ?? new Date(dto.startDate),
        end_date: parseIsoDate(dto.endDate) ?? new Date(dto.endDate),
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

    void this.dispatcher.dispatchEventCreated(
      recipients,
      {
        eventId: String(event.id),
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

  async update(id: number, dto: UpdateEventDto) {
    const existing = await this.findOne(id);
    const datesChanged =
      (dto.startDate !== undefined && dto.startDate !== existing.startDate) ||
      (dto.endDate !== undefined && dto.endDate !== existing.endDate);

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

    this.eventEmitter.emit(AdminNotificationEvent.EVENT_UPDATED, {
      event: AdminNotificationEvent.EVENT_UPDATED,
      title: 'Événement modifié',
      message: `L'événement a été modifié : ${mapped.title}`,
      entityType: 'event',
      entityId: String(event.id),
      timestamp: new Date().toISOString(),
    });

    if (datesChanged) {
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
          title: mapped.title,
          startDate: mapped.startDate,
          endDate: mapped.endDate,
          description: mapped.description,
          location: mapped.location,
        },
        dto.channel ?? DeliveryChannel.EMAIL,
      );
    }

    return mapped;
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.event.delete({ where: { id } });
  }
}
