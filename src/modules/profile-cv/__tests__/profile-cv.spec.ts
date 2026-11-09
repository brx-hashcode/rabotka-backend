import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ApplicationStatus, CvChoice, ProfileType } from '@prisma/client';
import { cvForApplication, cvOpen } from '../profile-cv.rules';
import { cleanName, ProfileCvService } from '../profile-cv.service';
import { stripContacts } from '../strip-contacts';

jest.mock('../../../common/services/storage/kyc-bucket', () => ({
  kycBucket: jest.fn().mockResolvedValue('private-bucket'),
}));
jest.mock('../../business/cv-screening/cv-files', () => ({
  ...jest.requireActual('../../business/cv-screening/cv-files'),
  extractCvText: jest
    .fn()
    .mockResolvedValue('Comptable 5 ans. Tel +242 06 123 45 67, a@b.cg'),
}));

const PDF = Buffer.from('%PDF-1.7\n%stuff');
const file = (buffer = PDF, name = 'Mon CV.pdf') =>
  ({
    buffer,
    mimetype: 'application/pdf',
    originalname: name,
    size: buffer.length,
  }) as Express.Multer.File;

function setup(
  opts: {
    profile?: Partial<{ profile_type: ProfileType; is_business: boolean }>;
    live?: object | null;
  } = {},
) {
  const profile = {
    profile_type: ProfileType.WORKER,
    is_business: false,
    preferred_cv: CvChoice.RABOTKA,
    ...opts.profile,
  };
  const live =
    opts.live === undefined
      ? null
      : opts.live && {
          id: 'cv-1',
          file_name: 'Mon CV.pdf',
          size_bytes: 10,
          mime_type: 'application/pdf',
          created_at: new Date('2026-11-01T00:00:00Z'),
          storage_key: 'k',
          storage_bucket: 'b',
          ...opts.live,
        };
  const tx = {
    profileCv: {
      findMany: jest.fn().mockResolvedValue([{ id: 'old' }]),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    profile: { update: jest.fn() },
  };
  const prisma = {
    profile: {
      findUnique: jest.fn().mockResolvedValue(profile),
      update: jest.fn(),
    },
    profileCv: {
      findFirst: jest.fn().mockResolvedValue(live),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    application: { findFirst: jest.fn() },
    contactRecord: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (t: typeof tx) => unknown)(tx)
        : Promise.all(arg as unknown[]),
    ),
  };
  const storage = {
    upload: jest.fn().mockResolvedValue({ key: 'new-key' }),
    delete: jest.fn().mockResolvedValue(undefined),
    download: jest.fn().mockResolvedValue({ body: 'stream' }),
  };
  const events = { emit: jest.fn() };
  const service = new ProfileCvService(
    prisma as never,
    storage as never,
    {} as never,
    {} as never,
    events as never,
  );
  return { service, prisma, storage, tx, events };
}

describe('stripContacts', () => {
  it('removes phones and e-mails, past the detector’s 4 000-character window too', () => {
    const filler = 'expérience '.repeat(600);
    const out = stripContacts(
      `${filler} joindre au +242 06 123 45 67 ou jean@mail.cg fin`,
    );
    expect(out).not.toContain('123 45 67');
    expect(out).not.toContain('jean@mail.cg');
    expect(out).toContain('fin');
  });
});

describe('cvForApplication', () => {
  const db = (preferred: CvChoice, live: { id: string } | null) =>
    ({
      profile: {
        findUnique: jest.fn().mockResolvedValue({ preferred_cv: preferred }),
      },
      profileCv: { findFirst: jest.fn().mockResolvedValue(live) },
    }) as never;

  it('uses the default when nothing is chosen (WhatsApp, agents)', async () => {
    expect(
      await cvForApplication(db(CvChoice.UPLOADED, { id: 'cv' }), 'w'),
    ).toBe('cv');
    expect(
      await cvForApplication(db(CvChoice.RABOTKA, { id: 'cv' }), 'w'),
    ).toBeNull();
  });

  it('follows the choice made while applying', async () => {
    expect(
      await cvForApplication(
        db(CvChoice.UPLOADED, { id: 'cv' }),
        'w',
        CvChoice.RABOTKA,
      ),
    ).toBeNull();
  });

  it('falls back to the Rabotka CV when no CV is live', async () => {
    expect(
      await cvForApplication(
        db(CvChoice.UPLOADED, null),
        'w',
        CvChoice.UPLOADED,
      ),
    ).toBeNull();
  });
});

describe('cvOpen', () => {
  it('opens once retained, or once the contact is unlocked', () => {
    expect(cvOpen(ApplicationStatus.PENDING, 'w', new Set())).toBe(false);
    expect(cvOpen(ApplicationStatus.ACCEPTED, 'w', new Set())).toBe(true);
    expect(cvOpen(ApplicationStatus.PENDING, 'w', new Set(['w']))).toBe(true);
  });
});

describe('ProfileCvService', () => {
  it('stores the CV privately, text without contacts, and makes it the default', async () => {
    const { service, storage, tx } = setup();
    await service.upload('w', file());
    expect(storage.upload).toHaveBeenCalledWith(
      PDF,
      expect.stringMatching(/\.pdf$/),
      expect.objectContaining({ access: 'private', bucket: 'private-bucket' }),
    );
    const data = tx.profileCv.create.mock.calls[0][0].data;
    expect(data.cv_text).toContain('Comptable 5 ans');
    expect(data.cv_text).not.toContain('a@b.cg');
    expect(tx.profileCv.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['old'] } },
      data: { deleted_at: expect.any(Date) },
    });
    expect(tx.profile.update).toHaveBeenCalledWith({
      where: { id: 'w' },
      data: { preferred_cv: CvChoice.UPLOADED },
    });
  });

  it('refuses anything but PDF or Word', async () => {
    const { service } = setup();
    await expect(
      service.upload('w', file(Buffer.from('GIF89a....'), 'x.gif')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is for workers only', async () => {
    const { service } = setup({ profile: { is_business: true } });
    await expect(service.get('w')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cannot default to a CV that is not there', async () => {
    const { service } = setup({ live: null });
    await expect(
      service.setPreference('w', CvChoice.UPLOADED),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removing it sends applications back to the Rabotka CV', async () => {
    const { service, prisma } = setup({ live: {} });
    await service.remove('w');
    expect(prisma.profile.update).toHaveBeenCalledWith({
      where: { id: 'w' },
      data: { preferred_cv: CvChoice.RABOTKA },
    });
  });

  describe('fileForEmployer', () => {
    const cv = {
      id: 'cv-1',
      storage_key: 'k',
      storage_bucket: 'b',
      mime_type: 'application/pdf',
      purged_at: null,
    };

    it('stays closed while the contact is locked', async () => {
      const { service, prisma } = setup();
      prisma.application.findFirst.mockResolvedValue({
        status: ApplicationStatus.PENDING,
        worker_id: 'w',
        profile_cv: cv,
      });
      await expect(service.fileForEmployer('e', 'a')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('opens once the contact is unlocked, and marks the application « Vue »', async () => {
      const { service, prisma, storage, events } = setup();
      prisma.application.findFirst.mockResolvedValue({
        status: ApplicationStatus.PENDING,
        worker_id: 'w',
        profile_cv: cv,
      });
      prisma.contactRecord.findMany.mockResolvedValue([{ worker_id: 'w' }]);
      const out = await service.fileForEmployer('e', 'a');
      expect(storage.download).toHaveBeenCalledWith('k', { bucket: 'b' });
      expect(events.emit).toHaveBeenCalledWith('application.candidate-viewed', {
        employerId: 'e',
        workerId: 'w',
        applicationId: 'a',
      });
      expect(out.filename).toBe('cv-cv-1.pdf');
    });

    it('is not found when the application went with the Rabotka CV', async () => {
      const { service, prisma } = setup();
      prisma.application.findFirst.mockResolvedValue({
        status: ApplicationStatus.ACCEPTED,
        worker_id: 'w',
        profile_cv: null,
      });
      await expect(service.fileForEmployer('e', 'a')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});

describe('cleanName', () => {
  it('keeps their name, with its extension', () => {
    expect(cleanName('Mon CV', 'pdf')).toBe('Mon CV.pdf');
    expect(cleanName('cv.PDF', 'pdf')).toBe('cv.PDF');
    expect(cleanName('', 'docx')).toBe('mon-cv.docx');
  });
});

describe('ProfileCvService — the candidate sheet and the admin', () => {
  function candidate(
    opts: { unlocked?: boolean; retained?: number; sendable?: boolean } = {},
  ) {
    const s = setup();
    const cv = {
      id: 'cv-1',
      profile_id: 'w1',
      file_name: 'CV Awa.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1234,
      created_at: new Date('2026-11-01T00:00:00Z'),
      storage_key: 'k',
      storage_bucket: 'b',
    };
    s.prisma.profileCv.findMany.mockResolvedValue(
      opts.sendable === false ? [] : [{ id: 'cv-1', profile_id: 'w1' }],
    );
    (s.prisma.profileCv as Record<string, jest.Mock>).findUnique = jest
      .fn()
      .mockResolvedValue(cv);
    s.prisma.contactRecord.findMany.mockResolvedValue(
      opts.unlocked ? [{ worker_id: 'w1' }] : [],
    );
    (s.prisma.application as Record<string, jest.Mock>).count = jest
      .fn()
      .mockResolvedValue(opts.retained ?? 0);
    return { ...s, cv };
  }

  it('shows the CV as there but shut before the contact is obtained', async () => {
    const { service, storage } = candidate();
    await expect(service.forCandidate('e1', 'w1')).resolves.toEqual({
      fileName: 'CV Awa.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1234,
      uploadedAt: '2026-11-01T00:00:00.000Z',
      available: false,
    });
    await expect(service.candidateFile('e1', 'w1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(storage.download).not.toHaveBeenCalled();
  });

  it('opens it once the contact is unlocked, or an application retained', async () => {
    const unlocked = candidate({ unlocked: true });
    await expect(
      unlocked.service.candidateFile('e1', 'w1'),
    ).resolves.toMatchObject({
      contentType: 'application/pdf',
    });

    const retained = candidate({ retained: 1 });
    await expect(
      retained.service.forCandidate('e1', 'w1'),
    ).resolves.toMatchObject({
      available: true,
    });
  });

  it('has nothing to show when the candidate sends the Rabotka CV', async () => {
    const { service } = candidate({ sendable: false });
    await expect(service.forCandidate('e1', 'w1')).resolves.toBeNull();
    await expect(service.candidateFile('e1', 'w1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('gives the admin the live CV, whatever the worker sends', async () => {
    const { service, storage } = setup({ live: {} });
    await expect(service.forAdmin('w1')).resolves.toMatchObject({
      fileName: 'Mon CV.pdf',
    });
    await service.adminFile('w1');
    expect(storage.download).toHaveBeenCalledWith('k', { bucket: 'b' });

    const none = setup();
    await expect(none.service.forAdmin('w1')).resolves.toBeNull();
    await expect(none.service.adminFile('w1')).rejects.toThrow(
      NotFoundException,
    );
  });
});
