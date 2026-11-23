import { BadRequestException } from '@nestjs/common';
import { htmlToImage, htmlToPdf } from '../../../../common/utils/puppeteer';
import { CareersPageController } from '../careers-page.controller';
import { CareersPageService } from '../careers-page.service';
import { clip, posterContent, posterHtml, type PosterInput } from '../poster';

jest.mock('../../../../common/utils/puppeteer', () => ({
  htmlToPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
  htmlToImage: jest.fn().mockResolvedValue(Buffer.from('PNG')),
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
      mime: 'application/pdf',
    });
    // One full-bleed page: no running footer, no margins.
    expect(jest.mocked(htmlToPdf).mock.calls.at(-1)?.[2]).toEqual({
      pageNumbers: false,
      margin: '0',
    });

    await expect(service.poster('p1', 'o1', 'story')).resolves.toMatchObject({
      filename: 'affiche-RBT-1-story.png',
      mime: 'image/png',
    });
    expect(jest.mocked(htmlToImage).mock.calls.at(-1)?.[1]).toEqual({
      width: 1080,
      height: 1920,
    });
  });
});

describe('CareersPageController', () => {
  it('refuses an image format it does not make', async () => {
    const pages = { poster: jest.fn() };
    const controller = new CareersPageController(pages as never);
    const req = { user: { profileId: 'p1' } } as never;
    const res = { setHeader: jest.fn(), send: jest.fn() } as never;
    await expect(
      controller.posterImage(req, 'o1', 'a4', res),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.posterImage(req, 'o1', 'gif', res)).rejects.toThrow(
      'Format inconnu.',
    );
    expect(pages.poster).not.toHaveBeenCalled();
  });
});

describe('clip', () => {
  const text =
    'ZuaFood œuvre à Kinshasa depuis 2015. Elle nourrit les enfants des quartiers populaires chaque semaine.';

  it('keeps a text that fits', () => {
    expect(clip('  Court   texte ', 40)).toBe('Court texte');
  });

  it('cuts at a sentence end when it keeps at least half', () => {
    expect(clip(text, 60)).toBe('ZuaFood œuvre à Kinshasa depuis 2015…');
  });

  it('else cuts at the last word, never inside one', () => {
    const out = clip(text, 30);
    expect(out).toBe('ZuaFood œuvre à Kinshasa…');
    expect(out.length).toBeLessThanOrEqual(30);
    const bare = (t: string) =>
      t
        .replace(/…$/, '')
        .split(' ')
        .map((w) => w.replace(/[.,;:!?]+$/, ''));
    for (const max of [12, 25, 47, 71, 90]) {
      // Whole words only (a sentence's final stop gives way to « … »).
      expect(bare(text)).toEqual(expect.arrayContaining(bare(clip(text, max))));
    }
  });
});

describe('posterContent', () => {
  const zua = `Qui sommes-nous
ZuaFood est une association œuvrant à Kinshasa.

Le poste
L'organisation recherche un dirigeant pour l'école du dimanche.

Vos missions :
- Concevoir le programme hebdomadaire
- Encadrer les bénévoles
• Accueillir les enfants
1. Tenir le registre`;

  it('drops the presentation, takes the intro and the first list', () => {
    expect(posterContent(zua, { intro: 220, points: 3 })).toEqual({
      intro: "L'organisation recherche un dirigeant pour l'école du dimanche.",
      label: 'Vos missions',
      points: [
        'Concevoir le programme hebdomadaire',
        'Encadrer les bénévoles',
        'Accueillir les enfants',
      ],
    });
  });

  it('names a list of benefits « Au programme »', () => {
    const text = 'Le poste\nVendre.\n\nAvantages\n- Repas\n- Transport';
    expect(posterContent(text, { intro: 100, points: 4 })).toMatchObject({
      label: 'Au programme',
      points: ['Repas', 'Transport'],
    });
  });

  it('keeps one block of text as the intro, with no list', () => {
    const block =
      'Nous recherchons un comptable rigoureux pour tenir la comptabilité générale et préparer les déclarations fiscales.';
    expect(posterContent(block, { intro: 60, points: 3 })).toEqual({
      intro: 'Nous recherchons un comptable rigoureux pour tenir la…',
      label: 'Au programme',
      points: [],
    });
  });

  it('copes with no description', () => {
    for (const d of ['', null, undefined, '\n\n']) {
      expect(posterContent(d, { intro: 100, points: 3 })).toEqual({
        intro: null,
        label: 'Au programme',
        points: [],
      });
    }
  });

  it('keeps everything when the presentation is all there is', () => {
    const text = 'Qui sommes-nous\nUne association de Kinshasa.';
    expect(posterContent(text, { intro: 100, points: 3 }).intro).toBe(
      'Une association de Kinshasa.',
    );
  });
});

describe('posterHtml', () => {
  const offer: PosterInput = {
    company: 'KAMOA <b> & Co',
    logoUrl: null,
    title: 'Comptable',
    description: 'Tenir les comptes.',
    employmentType: 'CDI',
    closesAt: new Date('2026-12-01T09:00:00Z'),
    place: null,
    amount: null,
    paymentFlow: null,
    qrDataUrl: 'data:image/png;base64,AAA',
    url: 'business.rabotka.work/carrieres/kamoa/RBT-1',
  };

  it('sizes each format, and breaks the URL only after a slash', () => {
    const story = posterHtml(offer, 'story');
    expect(story).toContain('class="page story"');
    expect(story).toContain('width:1080px;height:1920px');
    expect(posterHtml(offer)).toContain('width:210mm;height:296.5mm');
    expect(story).toContain(
      '<span>business.rabotka.work/</span><wbr><span>carrieres/</span>',
    );
    // An ongoing contract runs until its date; no fonts fetched online.
    expect(story).toContain("Jusqu'au 1 décembre");
    expect(story).not.toContain('fonts.googleapis');
  });

  it('shows the offer and a code to apply, with nothing unescaped', () => {
    const html = posterHtml({
      company: 'KAMOA <b> & Co',
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
    expect(html).toContain('KAMOA &lt;b&gt; &amp; Co recrute');
    expect(html).not.toContain('<b>');
    expect(html).toContain('Scannez pour postuler');
    expect(html).toContain('Le 1 décembre');
    expect(html).toContain('7\u00a0500 FCFA / jour');
  });
});
