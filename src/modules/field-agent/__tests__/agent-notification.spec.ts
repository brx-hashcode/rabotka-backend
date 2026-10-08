import { AgentStatus, Prisma } from '@prisma/client';
import { AgentEventsConsumer } from '../agent-events.consumer';
import {
  listCities,
  renderAgentNotification,
} from '../agent-notification-catalog';
import { AgentNotificationService } from '../agent-notification.service';

describe('agent notification catalog', () => {
  it('names the money and links to the wallet', () => {
    expect(
      renderAgentNotification({
        type: 'WITHDRAWAL_PAID',
        amount: 12500,
        reference: 'MP123',
      }),
    ).toEqual({
      type: 'WITHDRAWAL_PAID',
      title: 'Retrait versé',
      body: 'Votre retrait de 12 500 FCFA a été envoyé (réf. MP123).',
      link: '/profile?tab=portefeuille',
    });
  });

  it('opens the job itself when one new job arrived', () => {
    expect(
      renderAgentNotification({
        type: 'NEW_JOBS_IN_ZONE',
        count: 1,
        job: { id: 'job-1', title: 'Plombier', city: 'Brazzaville' },
        cities: ['Brazzaville'],
      }),
    ).toMatchObject({
      title: 'Nouvelle offre à Brazzaville',
      body: 'Plombier',
      link: '/jobs/job-1',
    });
  });

  it('counts several new jobs and opens the feed', () => {
    expect(
      renderAgentNotification({
        type: 'NEW_JOBS_IN_ZONE',
        count: 3,
        job: null,
        cities: ['Brazzaville', 'Douala', 'Brazzaville'],
      }),
    ).toMatchObject({
      title: '3 nouvelles offres dans vos zones',
      body: 'À Brazzaville et Douala. Trouvez les travailleurs à placer.',
      link: '/',
    });
  });

  it('lists cities the French way', () => {
    expect(listCities(['A'])).toBe('A');
    expect(listCities(['A', 'B', 'C'])).toBe('A, B et C');
    expect(listCities([])).toBe('');
  });

  it('suspension falls back to a generic message without a reason', () => {
    expect(
      renderAgentNotification({ type: 'ACCOUNT_SUSPENDED', reason: null }).body,
    ).toContain("Contactez l'équipe Rabotka");
  });
});

describe('AgentNotificationService.notify', () => {
  const row = {
    id: 'n-1',
    type: 'WITHDRAWAL_REJECTED',
    title: 'Retrait refusé',
    body: '…',
    link: '/profile?tab=portefeuille',
    metadata: {},
    created_at: new Date('2026-10-06T10:00:00Z'),
    read_at: null,
  };

  function make(create: jest.Mock) {
    const stream = { publish: jest.fn().mockResolvedValue(undefined) };
    const push = { send: jest.fn().mockResolvedValue(undefined) };
    const service = new AgentNotificationService(
      { agentNotification: { create } } as any,
      stream as any,
      push as any,
    );
    return { service, stream, push };
  }

  it('stores it, publishes it live and pushes it', async () => {
    const create = jest.fn().mockResolvedValue(row);
    const { service, stream, push } = make(create);

    const dto = await service.notify(
      'agent-1',
      { type: 'WITHDRAWAL_REJECTED', amount: 2000, reason: 'Numéro invalide' },
      'withdrawal:wd-1:rejected',
    );

    expect(create.mock.calls[0][0].data).toMatchObject({
      agent_id: 'agent-1',
      type: 'WITHDRAWAL_REJECTED',
      dedupe_key: 'withdrawal:wd-1:rejected',
      metadata: { amount: 2000, reason: 'Numéro invalide' },
    });
    expect(stream.publish).toHaveBeenCalledWith('agent-1', dto);
    expect(push.send).toHaveBeenCalledWith('agent-1', {
      id: 'n-1',
      title: 'Retrait refusé',
      body: '…',
      link: '/profile?tab=portefeuille',
    });
  });

  it('skips a duplicate quietly', async () => {
    const create = jest.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    const { service, stream, push } = make(create);

    await expect(
      service.notify('agent-1', { type: 'ACCOUNT_REACTIVATED' }, 'k'),
    ).resolves.toBeNull();
    expect(stream.publish).not.toHaveBeenCalled();
    expect(push.send).not.toHaveBeenCalled();
  });

  it('never throws into the business event that caused it', async () => {
    const { service } = make(jest.fn().mockRejectedValue(new Error('db down')));
    await expect(
      service.notify('agent-1', { type: 'ACCOUNT_REACTIVATED' }),
    ).resolves.toBeNull();
  });
});

describe('AgentEventsConsumer', () => {
  function make(prisma: any) {
    const notifications = { notify: jest.fn().mockResolvedValue(null) };
    const events = { emit: jest.fn() };
    const consumer = new AgentEventsConsumer(
      prisma,
      { get: () => undefined } as any,
      notifications as any,
      events as any,
    );
    return { consumer, notifications, events };
  }

  /** The claim returns `rows` once, then nothing. */
  const outbox = (rows: unknown[]) =>
    jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]);

  it('tells the agent their placed worker started, once per status', async () => {
    const prisma = {
      $queryRaw: outbox([
        {
          id: 1n,
          kind: 'placement_status',
          entity_id: 'app-1',
          payload: { agentId: 'agent-1', from: 'ACCEPTED', to: 'STARTED' },
        },
        {
          id: 2n,
          kind: 'placement_status',
          entity_id: 'app-2',
          payload: { agentId: 'agent-1', from: 'PENDING', to: 'VIEWED' },
        },
      ]),
      $executeRaw: jest.fn().mockResolvedValue(0),
      application: {
        findUnique: jest.fn().mockResolvedValue({
          agent_id: 'agent-1',
          job_offer: { id: 'job-1', title: 'Plombier' },
          worker: { first_name: 'Awa', last_name: 'Ngoma' },
        }),
      },
    };
    const { consumer, notifications } = make(prisma);

    consumer.wake();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // VIEWED is not something the agent is told about.
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledWith(
      'agent-1',
      {
        type: 'PLACEMENT_STARTED',
        workerName: 'Awa Ngoma',
        jobTitle: 'Plombier',
        jobId: 'job-1',
      },
      'placement:app-1:STARTED',
    );
  });

  it('sends each agent one notification for a batch of new jobs in their zones', async () => {
    const jobs = [
      { id: 'j1', title: 'Plombier', city: 'Brazzaville', country_code: 'CG' },
      { id: 'j2', title: 'Maçon', city: 'Brazzaville', country_code: 'CG' },
      { id: 'j3', title: 'Cuisinier', city: 'Douala', country_code: 'CM' },
    ];
    const prisma = {
      $queryRaw: outbox(
        jobs.map((j, i) => ({
          id: BigInt(i + 1),
          kind: 'job_active',
          entity_id: j.id,
          payload: { countryCode: j.country_code, city: j.city },
        })),
      ),
      $executeRaw: jest.fn().mockResolvedValue(0),
      jobOffer: { findMany: jest.fn().mockResolvedValue(jobs) },
      agentZone: {
        findMany: jest.fn().mockResolvedValue([
          { agent_id: 'a-bzv', country_code: 'CG', city: 'Brazzaville' },
          { agent_id: 'a-dla', country_code: 'CM', city: 'Douala' },
        ]),
      },
    };
    const { consumer, notifications } = make(prisma);

    consumer.wake();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(prisma.agentZone.findMany.mock.calls[0][0].where.agent).toEqual({
      status: AgentStatus.ACTIVE,
    });
    expect(notifications.notify).toHaveBeenCalledTimes(2);
    expect(notifications.notify).toHaveBeenCalledWith(
      'a-bzv',
      {
        type: 'NEW_JOBS_IN_ZONE',
        count: 2,
        job: null,
        cities: ['Brazzaville', 'Brazzaville'],
      },
      undefined,
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      'a-dla',
      {
        type: 'NEW_JOBS_IN_ZONE',
        count: 1,
        job: { id: 'j3', title: 'Cuisinier', city: 'Douala' },
        cities: ['Douala'],
      },
      'job:j3:a-dla',
    );
  });

  it('hands an accepted application to the listeners, not to agents', async () => {
    const prisma = {
      $queryRaw: outbox([
        {
          id: 9n,
          kind: 'application_accepted',
          entity_id: 'app-9',
          payload: { workerId: 'w-9', jobOfferId: 'job-9' },
        },
      ]),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    const { consumer, notifications, events } = make(prisma);

    consumer.wake();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(events.emit).toHaveBeenCalledWith('application.accepted', {
      applicationId: 'app-9',
      workerId: 'w-9',
      jobOfferId: 'job-9',
    });
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});
