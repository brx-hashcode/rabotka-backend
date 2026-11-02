import { BulkRefuseService } from '../bulk-refuse.service';
import { refusalMessage } from '../../../application/application.service';
import { renderNotification } from '../../../profile-notification/notification-catalog';

function make(targets = [{ id: 'a1' }, { id: 'a2' }]) {
  const prisma: any = {
    jobOffer: { findFirst: jest.fn().mockResolvedValue({ id: 'o1' }) },
    application: { findMany: jest.fn().mockResolvedValue(targets) },
  };
  const applications: any = { reject: jest.fn().mockResolvedValue({}) };
  return {
    service: new BulkRefuseService(prisma, applications),
    prisma,
    applications,
  };
}

describe('refusalMessage', () => {
  it('keeps the words, trimmed and bounded; nothing for none', () => {
    expect(refusalMessage('  Merci pour votre candidature.  ')).toBe(
      'Merci pour votre candidature.',
    );
    expect(refusalMessage('x'.repeat(800))).toHaveLength(500);
    expect(refusalMessage('   ')).toBeNull();
    expect(refusalMessage(undefined)).toBeNull();
  });

  it('refuses contact details', () => {
    expect(() => refusalMessage('Appelez-moi au 06 991 33 44')).toThrow(
      /coordonnées/,
    );
    expect(() => refusalMessage('Écrivez à rh@zuafood.cg')).toThrow(
      /coordonnées/,
    );
  });
});

describe('BulkRefuseService', () => {
  it('refuses the waiting applications picked, each the usual way, with the message', async () => {
    const { service, prisma, applications } = make();
    await expect(
      service.refuse('biz', 'o1', {
        applicationIds: ['a1', 'a2', 'a3'],
        message: 'Poste pourvu, merci.',
      }),
    ).resolves.toEqual({ refused: 2, skipped: 1 });
    expect(prisma.application.findMany.mock.calls[0][0].where).toEqual({
      job_offer_id: 'o1',
      status: { in: ['PENDING', 'VIEWED'] },
      id: { in: ['a1', 'a2', 'a3'] },
    });
    expect(applications.reject).toHaveBeenCalledWith(
      'a1',
      'biz',
      'Poste pourvu, merci.',
    );
  });

  it('refuses every application still waiting with `remaining`', async () => {
    const { service, prisma } = make();
    await expect(
      service.refuse('biz', 'o1', { remaining: true }),
    ).resolves.toEqual({ refused: 2, skipped: 0 });
    expect(
      prisma.application.findMany.mock.calls[0][0].where,
    ).not.toHaveProperty('id');
  });

  it('checks the message before refusing anyone, and counts one answered meanwhile as skipped', async () => {
    const { service, applications } = make();
    await expect(
      service.refuse('biz', 'o1', {
        remaining: true,
        message: 'mon 06 991 33 44',
      }),
    ).rejects.toThrow(/coordonnées/);
    expect(applications.reject).not.toHaveBeenCalled();

    applications.reject.mockRejectedValueOnce(
      new Error("Cette candidature n'est plus en attente"),
    );
    await expect(
      service.refuse('biz', 'o1', { remaining: true }),
    ).resolves.toEqual({ refused: 1, skipped: 1 });
  });

  it('is only for the offer’s owner, and needs something to refuse', async () => {
    const { service, prisma } = make();
    await expect(service.refuse('biz', 'o1', {})).rejects.toThrow(/Choisissez/);
    prisma.jobOffer.findFirst.mockResolvedValue(null);
    await expect(
      service.refuse('other', 'o1', { remaining: true }),
    ).rejects.toThrow('Offre introuvable.');
  });
});

describe('the candidate’s notification', () => {
  it('carries the employer’s message', () => {
    const n = renderNotification({
      type: 'APPLICATION_REJECTED',
      jobTitle: 'Hôtesse',
      automatic: false,
      message: 'Poste pourvu, merci.',
    });
    expect(n.body).toContain('« Poste pourvu, merci. »');
  });
});
