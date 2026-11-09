import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminNotificationEvent } from '../../../../common/events/admin-notification.events';
import type { PrismaService } from '../../../../common/services/prisma/prisma.service';
import { CreateDemoRequestDto } from '../demo-request.dto';
import { DemoRequestService } from '../demo-request.service';

const input = {
  firstName: 'Awa',
  lastName: 'Mboko',
  email: 'Awa@Example.com ',
  phone: '+242 06 123 45 67',
  company: 'Boulangerie du Plateau',
  jobTitle: 'Gérante',
  country: 'cg',
  companySize: '6-20',
  interests: ['analyse-cv', 'entretiens', 'analyse-cv'],
};

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'demo-1',
    created_at: new Date('2026-11-09T10:00:00Z'),
    updated_at: new Date('2026-11-09T10:00:00Z'),
    first_name: 'Awa',
    last_name: 'Mboko',
    email: 'awa@example.com',
    phone: '+242 06 123 45 67',
    company: 'Boulangerie du Plateau',
    job_title: 'Gérante',
    country_code: 'CG',
    company_size: '6-20',
    interests: ['analyse-cv'],
    message: null,
    status: 'NEW',
    notes: null,
    handled_by_id: null,
    ip: null,
    user_agent: null,
    ...over,
  };
}

function setup(opts: { recent?: unknown; found?: unknown } = {}) {
  const prisma = {
    demoRequest: {
      findFirst: jest.fn().mockResolvedValue(opts.recent ?? null),
      findUnique: jest
        .fn()
        .mockResolvedValue('found' in opts ? opts.found : row()),
      findMany: jest.fn().mockResolvedValue([row()]),
      count: jest.fn().mockResolvedValue(1),
      create: jest.fn().mockImplementation(({ data }) => row(data)),
      update: jest.fn().mockResolvedValue(row()),
    },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'u1', first_name: 'Bruno', last_name: 'K' }),
    },
  };
  const events = { emit: jest.fn() };
  const service = new DemoRequestService(
    prisma as unknown as PrismaService,
    events as unknown as EventEmitter2,
  );
  return { service, prisma, events };
}

describe('DemoRequestService.create', () => {
  it('saves the request, lower-cased and deduplicated, and alerts staff', async () => {
    const { service, prisma, events } = setup();

    await expect(
      service.create(input as CreateDemoRequestDto, { ip: '203.0.113.1' }),
    ).resolves.toEqual({ ok: true });

    const data = prisma.demoRequest.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      email: 'awa@example.com',
      country_code: 'CG',
      interests: ['analyse-cv', 'entretiens'],
      ip: '203.0.113.1',
    });
    expect(events.emit).toHaveBeenCalledWith(
      AdminNotificationEvent.DEMO_REQUEST_CREATED,
      expect.objectContaining({
        entityType: 'demo-request',
        entityId: 'demo-1',
      }),
    );
  });

  it('saves nothing when the honeypot is filled, and answers the same', async () => {
    const { service, prisma, events } = setup();

    await expect(
      service.create({
        ...input,
        website: 'spam.example',
      }),
    ).resolves.toEqual({ ok: true });
    expect(prisma.demoRequest.create).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('updates a request from the same e-mail within a day, without a second alert', async () => {
    const { service, prisma, events } = setup({ recent: { id: 'demo-0' } });

    await service.create(input);

    expect(prisma.demoRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'demo-0' } }),
    );
    expect(prisma.demoRequest.create).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('refuses a country Rabotka Business is not open in', async () => {
    const { service } = setup();

    await expect(
      service.create({ ...input, country: 'FR' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CreateDemoRequestDto', () => {
  it('accepts the form as sent', async () => {
    const dto = plainToInstance(CreateDemoRequestDto, input);
    expect(await validate(dto)).toEqual([]);
  });

  it('refuses an unknown size, an unknown interest and a bad phone', async () => {
    const dto = plainToInstance(CreateDemoRequestDto, {
      ...input,
      companySize: '5000',
      interests: ['paie'],
      phone: 'call me',
    });
    const fields = (await validate(dto)).map((e) => e.property).sort();
    expect(fields).toEqual(['companySize', 'interests', 'phone']);
  });
});

describe('DemoRequestService admin', () => {
  it('lists with filters and a page', async () => {
    const { service, prisma } = setup();

    const res = await service.listForAdmin({
      page: 2,
      limit: 10,
      q: 'plateau',
      status: ['NEW'],
      country: 'cg',
    });

    const args = prisma.demoRequest.findMany.mock.calls[0][0];
    expect(args.skip).toBe(10);
    expect(args.where).toMatchObject({
      status: { in: ['NEW'] },
      country_code: 'CG',
    });
    expect(res).toMatchObject({ total: 1, page: 2, limit: 10 });
    expect(res.data[0]).toMatchObject({
      company: 'Boulangerie du Plateau',
      countryName: 'Congo-Brazzaville',
    });
  });

  it('saves the follow-up and who made it', async () => {
    const { service, prisma } = setup();

    await service.updateForAdmin(
      'demo-1',
      { status: 'CONTACTED', notes: '  Rappel lundi  ' },
      'u1',
    );

    expect(prisma.demoRequest.update).toHaveBeenCalledWith({
      where: { id: 'demo-1' },
      data: { status: 'CONTACTED', notes: 'Rappel lundi', handled_by_id: 'u1' },
    });
  });

  it('answers 404 for an unknown request', async () => {
    const { service } = setup({ found: null });

    await expect(service.getForAdmin('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
