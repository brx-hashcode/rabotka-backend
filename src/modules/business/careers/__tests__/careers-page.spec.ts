import { CareersPageService } from '../careers-page.service';
import { posterHtml } from '../poster';

jest.mock('../../../../common/utils/puppeteer', () => ({
  htmlToPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
}));
// The PNG encoding behind a real QR code takes ~2 s inside Jest's sandbox
// (20 ms in plain Node): enough to time this test out on a busy CI runner.
jest.mock('qrcode', () => ({
  toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,QR'),
}));

const business = {
  name: 'KAMOA',
  public_slug: 'kamoa',
  cover_url: null,
  photos: ['a.jpg', 'b.jpg'],
  benefits: [],
  profile: { avatar_url: 'https://cdn/logo.png' },
};

function make(overrides: Record<string, unknown> = {}) {
  const prisma = {
    business: {
      findUnique: jest.fn().mockResolvedValue({ ...business, ...overrides }),
      update: jest.fn().mockResolvedValue({}),
    },
    jobOffer: { findFirst: jest.fn() },
  };
  const files = {
    uploadToStorage: jest
      .fn()
      .mockResolvedValue({ url: 'https://cdn/new.jpg' }),
  };
  return {
    prisma,
    files,
    service: new CareersPageService(prisma as never, files as never),
  };
}

const image = {
  originalname: 'photo.png',
  mimetype: 'image/png',
  buffer: Buffer.from('x'),
} as Express.Multer.File;

describe('CareersPageService', () => {
  it('keeps benefits clean and refuses too many', async () => {
    const { service, prisma } = make();
    await service.setBenefits('p1', ['  Repas offert ', 'Repas offert', '']);
    expect(prisma.business.update.mock.calls[0][0].data.benefits).toEqual([
      'Repas offert',
    ]);
    await expect(
      service.setBenefits(
        'p1',
        Array.from({ length: 9 }, (_, i) => `A${i}`),
      ),
    ).rejects.toThrow('8 avantages');
  });

  it('adds a photo without the Rabotka mark, up to six', async () => {
    const { service, files } = make();
    await service.addPhoto('p1', image);
    expect(files.uploadToStorage.mock.calls[0][1]).toMatchObject({
      access: 'public',
      watermark: false,
    });

    const full = make({ photos: ['1', '2', '3', '4', '5', '6'] });
    await expect(full.service.addPhoto('p1', image)).rejects.toThrow(
      '6 photos',
    );
  });

  it('removes the photo asked for, and nothing else', async () => {
    const { service, prisma } = make();
    await service.removePhoto('p1', 0);
    expect(prisma.business.update.mock.calls[0][0].data.photos).toEqual([
      'b.jpg',
    ]);
    await expect(service.removePhoto('p1', 5)).rejects.toThrow('introuvable');
  });

  it('prints a poster only for an offer still online', async () => {
    const { service, prisma } = make();
    prisma.jobOffer.findFirst.mockResolvedValue(null);
    await expect(service.poster('p1', 'o1')).rejects.toThrow('en ligne');

    prisma.jobOffer.findFirst.mockResolvedValue({
      reference: 'RBT-1',
      title: 'Comptable',
      description: 'Le poste',
      employment_type: 'CDI',
      scheduled_at: null,
      is_remote: false,
      city: 'Brazzaville',
      amount: null,
      payment_flow: null,
    });
    await expect(service.poster('p1', 'o1')).resolves.toMatchObject({
      filename: 'affiche-RBT-1.pdf',
    });
  });
});

describe('posterHtml', () => {
  it('shows the offer and a code to apply, with nothing unescaped', () => {
    const html = posterHtml({
      company: 'KAMOA <b>',
      logoUrl: null,
      title: 'Comptable',
      description: 'Tenir les comptes.',
      employmentType: 'MISSION',
      closesAt: new Date('2026-12-01T09:00:00Z'),
      place: 'Brazzaville',
      amount: 7500,
      paymentFlow: 'DAILY',
      qrDataUrl: 'data:image/png;base64,AAA',
      url: 'business.rabotka.work/carrieres/kamoa/RBT-1',
    });
    expect(html).toContain('KAMOA &lt;b&gt; recrute');
    expect(html).toContain('Scannez pour postuler');
    expect(html).toContain('Le 1 décembre');
    expect(html).toContain('FCFA / jour');
  });
});
