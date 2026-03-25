import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { ListEventsDto } from './dto/list-events.dto';

const eventInclude = {
  created_by: { select: { id: true, first_name: true, last_name: true } },
  profiles: {
    select: { id: true, first_name: true, last_name: true, avatar_url: true, email: true },
  },
  assigned_users: { select: { id: true, first_name: true, last_name: true, email: true } },
} as const;

function parseIsoDate(value: unknown): Date | undefined {
  // DTOs are expected to provide ISO-8601 strings; this helper makes that explicit for TS/ESLint.
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
    const startDate = mapped.startDate;
    const endDate = mapped.endDate;

    for (const p of event.profiles) {
      void this.notification.notifyEventCreated(
        p.email,
        `${p.first_name} ${p.last_name}`.trim(),
        dto.title,
        startDate,
        endDate,
        dto.description,
        dto.location,
      );
    }
    for (const u of event.assigned_users) {
      void this.notification.notifyEventCreated(
        u.email,
        `${u.first_name} ${u.last_name}`.trim(),
        dto.title,
        startDate,
        endDate,
        dto.description,
        dto.location,
      );
    }

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

    if (datesChanged) {
      const startDate = mapped.startDate;
      const endDate = mapped.endDate;
      const title = mapped.title;
      const location = mapped.location;

      for (const p of event.profiles) {
        void this.notification.notifyEventUpdated(
          p.email,
          `${p.first_name} ${p.last_name}`.trim(),
          title,
          startDate,
          endDate,
          mapped.description,
          location,
        );
      }
      for (const u of event.assigned_users) {
        void this.notification.notifyEventUpdated(
          u.email,
          `${u.first_name} ${u.last_name}`.trim(),
          title,
          startDate,
          endDate,
          mapped.description,
          location,
        );
      }
    }

    return mapped;
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.event.delete({ where: { id } });
  }
}
