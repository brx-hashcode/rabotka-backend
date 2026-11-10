import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DemoRequestStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import {
  AdminNotificationEvent,
  type AdminNotificationPayload,
} from '../../../common/events/admin-notification.events';
import {
  BUSINESS_COUNTRIES_SENTENCE,
  BUSINESS_COUNTRY_NAMES,
  isBusinessCountry,
} from '../business-catalog';
import { DEMO_REQUEST_DEDUPE_MS } from './demo-request.constants';
import type {
  CreateDemoRequestDto,
  UpdateDemoRequestDto,
} from './demo-request.dto';

export type DemoRequestMeta = { ip?: string; userAgent?: string };

@Injectable()
export class DemoRequestService {
  private readonly logger = new Logger(DemoRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Saves a request and tells staff. A filled honeypot answers the same as a
   * real request and saves nothing; the same e-mail again within a day
   * updates the first request instead of alerting staff twice.
   */
  async create(
    dto: CreateDemoRequestDto,
    meta: DemoRequestMeta = {},
  ): Promise<{ ok: true }> {
    if (dto.website?.trim()) {
      this.logger.warn('Demo request honeypot filled — ignored');
      return { ok: true };
    }
    const country = dto.country.toUpperCase();
    if (!isBusinessCountry(country)) {
      throw new BadRequestException(BUSINESS_COUNTRIES_SENTENCE);
    }

    const email = dto.email.trim().toLowerCase();
    const data = {
      first_name: dto.firstName,
      last_name: dto.lastName,
      email,
      phone: dto.phone,
      company: dto.company,
      job_title: dto.jobTitle,
      country_code: country,
      company_size: dto.companySize,
      interests: [...new Set(dto.interests ?? [])],
      message: dto.message || null,
      ip: meta.ip?.slice(0, 64) ?? null,
      user_agent: meta.userAgent?.slice(0, 512) ?? null,
    };

    const recent = await this.prisma.demoRequest.findFirst({
      where: {
        email,
        created_at: { gte: new Date(Date.now() - DEMO_REQUEST_DEDUPE_MS) },
      },
      orderBy: { created_at: 'desc' },
      select: { id: true },
    });
    if (recent) {
      await this.prisma.demoRequest.update({ where: { id: recent.id }, data });
      return { ok: true };
    }

    const created = await this.prisma.demoRequest.create({ data });
    const payload: AdminNotificationPayload = {
      event: AdminNotificationEvent.DEMO_REQUEST_CREATED,
      title: 'Demande de démo',
      message: `${created.company} (${BUSINESS_COUNTRY_NAMES[country]}) — ${created.first_name} ${created.last_name}, ${created.job_title}`,
      entityType: 'demo-request',
      entityId: created.id,
      metadata: { country, companySize: created.company_size },
      timestamp: new Date().toISOString(),
    };
    this.events.emit(AdminNotificationEvent.DEMO_REQUEST_CREATED, payload);
    return { ok: true };
  }

  async listForAdmin(params: {
    page: number;
    limit: number;
    q?: string;
    status?: DemoRequestStatus[];
    country?: string;
  }) {
    const q = params.q?.trim();
    const where: Prisma.DemoRequestWhereInput = {
      ...(params.status?.length ? { status: { in: params.status } } : {}),
      ...(params.country ? { country_code: params.country.toUpperCase() } : {}),
      ...(q
        ? {
            OR: [
              { company: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
              { first_name: { contains: q, mode: 'insensitive' } },
              { last_name: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.demoRequest.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      this.prisma.demoRequest.count({ where }),
    ]);
    return {
      data: rows.map(toView),
      total,
      page: params.page,
      limit: params.limit,
    };
  }

  async getForAdmin(id: string) {
    const row = await this.prisma.demoRequest.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Demande introuvable');
    const handledBy = row.handled_by_id
      ? await this.prisma.user.findUnique({
          where: { id: row.handled_by_id },
          select: { id: true, first_name: true, last_name: true },
        })
      : null;
    return {
      ...toView(row),
      handledBy: handledBy
        ? {
            id: handledBy.id,
            name: `${handledBy.first_name} ${handledBy.last_name}`.trim(),
          }
        : null,
    };
  }

  async updateForAdmin(
    id: string,
    dto: UpdateDemoRequestDto,
    userId: string | undefined,
  ) {
    const exists = await this.prisma.demoRequest.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Demande introuvable');
    await this.prisma.demoRequest.update({
      where: { id },
      data: {
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes.trim() || null } : {}),
        handled_by_id: userId ?? null,
      },
    });
    return this.getForAdmin(id);
  }
}

type Row = Prisma.DemoRequestGetPayload<object>;

function toView(r: Row) {
  return {
    id: r.id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    phone: r.phone,
    company: r.company,
    jobTitle: r.job_title,
    country: r.country_code,
    countryName:
      BUSINESS_COUNTRY_NAMES[
        r.country_code as keyof typeof BUSINESS_COUNTRY_NAMES
      ] ?? r.country_code,
    companySize: r.company_size,
    interests: r.interests,
    message: r.message,
    status: r.status,
    notes: r.notes,
  };
}
