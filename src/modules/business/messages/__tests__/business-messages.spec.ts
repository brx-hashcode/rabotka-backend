import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  BusinessMessagesService,
  MAX_TEMPLATES,
} from '../business-messages.service';
import { renderTemplate } from '../render-template';

describe('renderTemplate', () => {
  it('fills the placeholders, any case, spaces in the braces, and leaves the rest', () => {
    expect(
      renderTemplate(
        'Bonjour {prenom}, pour « {Poste} » chez { entreprise } — {autre}',
        {
          prenom: 'Awa',
          poste: 'Caissière',
          entreprise: 'KAMOA',
        },
      ),
    ).toBe('Bonjour Awa, pour « Caissière » chez KAMOA — {autre}');
    expect(
      renderTemplate('{prénom}', { prenom: 'Élie', poste: '', entreprise: '' }),
    ).toBe('Élie');
  });
});

function make() {
  const prisma: any = {
    business: { findUnique: jest.fn().mockResolvedValue({ id: 'b1' }) },
    businessMessageTemplate: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 't1' }),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    jobOffer: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'o1',
        title: 'Caissière',
        employer: { business: { name: 'KAMOA' } },
      }),
    },
    application: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'a1', worker: { first_name: 'Awa' } }]),
    },
    externalApplication: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'e1', first_name: 'Jean', email: 'jean@example.com' },
        ]),
    },
    businessMember: {
      findUnique: jest.fn().mockResolvedValue({ email: 'rh@kamoa.cg' }),
    },
    profile: {
      findUnique: jest.fn().mockResolvedValue({ email: 'contact@kamoa.cg' }),
    },
  };
  const chat: any = {
    openForApplication: jest.fn().mockResolvedValue({ id: 'c1' }),
    sendMessage: jest.fn().mockResolvedValue({}),
  };
  const mail: any = { sendMail: jest.fn().mockResolvedValue({ jobId: 'j' }) };
  const layout: any = {
    wrap: jest.fn((html: string) => Promise.resolve(html)),
  };
  return {
    service: new BusinessMessagesService(prisma, chat, mail, layout),
    prisma,
    chat,
    mail,
  };
}

describe('BusinessMessagesService templates', () => {
  it('offers ready-made ones for the kinds the business has not written', async () => {
    const { service, prisma } = make();
    prisma.businessMessageTemplate.findMany.mockResolvedValue([
      {
        id: 't1',
        kind: 'REFUSAL',
        title: 'Mon refus',
        body: 'Merci.',
        updated_at: new Date(),
        member: null,
      },
    ]);
    const { templates, suggested } = await service.list('biz');
    expect(templates).toHaveLength(1);
    expect(suggested.every((t) => t.kind !== 'REFUSAL')).toBe(true);
    expect(suggested.map((t) => t.kind)).toEqual(['INVITATION', 'INFORMATION']);
  });

  it('caps the templates, and only touches the business own', async () => {
    const { service, prisma } = make();
    prisma.businessMessageTemplate.count.mockResolvedValue(MAX_TEMPLATES);
    await expect(
      service.create(
        { profileId: 'biz' },
        { kind: 'OTHER', title: 'x', body: 'y' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    prisma.businessMessageTemplate.findFirst.mockResolvedValue(null);
    await expect(service.remove('biz', 't9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(
      prisma.businessMessageTemplate.findFirst.mock.calls[0][0].where,
    ).toEqual({
      id: 't9',
      business_id: 'b1',
    });
  });
});

describe('BusinessMessagesService.send', () => {
  it('writes to a Rabotka candidate in the conversation and e-mails a careers one, filled in', async () => {
    const { service, chat, mail } = make();
    await expect(
      service.send({ profileId: 'biz', memberId: 'm1' }, 'o1', {
        rabotka: ['a1'],
        external: ['e1'],
        body: 'Bonjour {prenom}, pour {poste} chez {entreprise}.',
      }),
    ).resolves.toEqual({ sent: 2, skipped: 0 });
    expect(chat.openForApplication).toHaveBeenCalledWith('a1', 'biz');
    expect(chat.sendMessage).toHaveBeenCalledWith(
      'c1',
      'biz',
      'Bonjour Awa, pour Caissière chez KAMOA.',
    );
    const email = mail.sendMail.mock.calls[0][0];
    expect(email.to).toBe('jean@example.com');
    expect(email.html).toContain('Bonjour Jean, pour Caissière chez KAMOA.');
    expect(email.html).toContain('mailto:rh@kamoa.cg');
  });

  it('refuses contact details when a Rabotka candidate is among them, before writing to anyone', async () => {
    const { service, chat, mail } = make();
    await expect(
      service.send({ profileId: 'biz' }, 'o1', {
        rabotka: ['a1'],
        external: ['e1'],
        body: 'Appelez le 06 991 33 44',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('allows them to careers-page candidates only, and counts a failure as skipped', async () => {
    const { service, mail } = make();
    mail.sendMail.mockRejectedValueOnce(new Error('smtp'));
    await expect(
      service.send({ profileId: 'biz' }, 'o1', {
        external: ['e1'],
        body: 'Appelez le 06 991 33 44',
      }),
    ).resolves.toEqual({ sent: 0, skipped: 1 });
  });

  it("refuses another business's offer", async () => {
    const { service, prisma } = make();
    prisma.jobOffer.findFirst.mockResolvedValue(null);
    await expect(
      service.send({ profileId: 'other' }, 'o1', {
        rabotka: ['a1'],
        body: 'Bonjour',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
