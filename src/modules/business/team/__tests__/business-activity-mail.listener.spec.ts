import {
  APPLICATION_MAIL_PACE_S,
  BusinessActivityMailListener,
  MESSAGE_MAIL_PACE_S,
} from '../business-activity-mail.listener';

function make({ business = true } = {}) {
  const prisma: any = {
    profile: {
      findUnique: jest.fn().mockResolvedValue({ is_business: business }),
    },
    business: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'b1',
        profile: { email: 'boss@zua.cg', first_name: 'Awa' },
      }),
    },
    businessMember: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { email: 'rh@zua.cg', name: 'Paul Mbemba', is_owner: false },
        ]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const mail: any = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const layout: any = {
    wrap: jest.fn((html: string) => Promise.resolve(html)),
  };
  // A real NX: the first set of a key wins until it expires.
  const keys = new Set<string>();
  const redis: any = {
    set: jest.fn((key: string) => {
      if (keys.has(key)) return Promise.resolve(null);
      keys.add(key);
      return Promise.resolve('OK');
    }),
  };
  return {
    listener: new BusinessActivityMailListener(prisma, mail, layout, redis),
    mail,
    redis,
  };
}

const application = (applicationId: string) => ({
  recipientId: 'p1',
  input: {
    type: 'NEW_APPLICATION' as const,
    applicationId,
    jobOfferId: 'o1',
    jobTitle: 'Caissier',
    workerName: 'Grâce Mavoungou',
  },
});

describe('BusinessActivityMailListener', () => {
  it('e-mails the team of a business about a new applicant, once per offer for a while', async () => {
    const { listener, mail, redis } = make();

    await listener.handle(application('a1'));
    await listener.handle(application('a2'));

    expect(mail.sendMail.mock.calls.map(([m]: any[]) => m.to)).toEqual([
      'boss@zua.cg',
      'rh@zua.cg',
    ]);
    expect(mail.sendMail.mock.calls[0][0].subject).toBe(
      'Nouvelle candidature : Caissier',
    );
    expect(mail.sendMail.mock.calls[0][0].html).toContain('/espace/offres/o1');
    expect(redis.set.mock.calls[0]).toEqual([
      expect.stringContaining('business-mail:p1:app:o1'),
      '1',
      'EX',
      APPLICATION_MAIL_PACE_S,
      'NX',
    ]);
  });

  it('e-mails a new message, linking the conversation', async () => {
    const { listener, mail, redis } = make();
    await listener.handle({
      recipientId: 'p1',
      input: {
        type: 'NEW_MESSAGE',
        conversationId: 'c1',
        senderName: 'Grâce',
        jobTitle: null,
      },
    });
    expect(mail.sendMail).toHaveBeenCalledTimes(2);
    expect(mail.sendMail.mock.calls[0][0].html).toContain(
      '/espace/discussions/c1',
    );
    expect(redis.set.mock.calls[0][3]).toBe(MESSAGE_MAIL_PACE_S);
  });

  it('leaves alone anyone who is not a business, and other notifications', async () => {
    const worker = make({ business: false });
    await worker.listener.handle(application('a1'));
    expect(worker.mail.sendMail).not.toHaveBeenCalled();

    const other = make();
    await other.listener.handle({
      recipientId: 'p1',
      input: { type: 'APPLICATION_CANCELLED' } as any,
    });
    expect(other.mail.sendMail).not.toHaveBeenCalled();
  });

  it('never throws: the notification is already saved', async () => {
    const { listener, mail } = make();
    mail.sendMail.mockRejectedValue(new Error('smtp down'));
    await expect(listener.handle(application('a1'))).resolves.toBeUndefined();
  });
});
