import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MailboxCrypto } from '../mailbox-crypto';
import { cvKind, isCvAttachment, senderName } from '../cv-attachments';
import { callbackPage } from '../mailbox-callback-page';
import { MailboxService, redirectUri } from '../mailbox.service';
import { MailboxAuthError } from '../providers/mail-provider';

const KEY = randomBytes(32).toString('base64');

describe('MailboxCrypto', () => {
  it('opens what it sealed, and nothing altered', () => {
    const c = new MailboxCrypto(KEY);
    const sealed = c.seal('1//refresh-token');
    expect(sealed).not.toContain('refresh');
    expect(c.open(sealed)).toBe('1//refresh-token');
    // Two seals of the same token differ (fresh iv).
    expect(c.seal('x')).not.toBe(c.seal('x'));

    const [iv, tag, data] = sealed.split('.');
    const flipped = Buffer.from(data, 'base64url');
    flipped[0] ^= 1;
    expect(() =>
      c.open([iv, tag, flipped.toString('base64url')].join('.')),
    ).toThrow();
    expect(() =>
      new MailboxCrypto(randomBytes(32).toString('base64')).open(sealed),
    ).toThrow();
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => new MailboxCrypto('c2hvcnQ=')).toThrow(/32 bytes/);
  });
});

describe('CV attachments', () => {
  it('keeps the types an analysis reads', () => {
    expect(cvKind('CV Awa.PDF')).toBe('pdf');
    expect(cvKind('cv.docx')).toBe('word');
    expect(cvKind('scan.jpeg')).toBe('photo');
    expect(cvKind('cv.doc')).toBeNull();
    expect(cvKind('notes.txt')).toBeNull();
  });

  it('leaves out signatures and logos', () => {
    expect(isCvAttachment({ name: 'cv.pdf', size: 12_000 })).toBe(true);
    expect(isCvAttachment({ name: 'logo.png', size: 8_000 })).toBe(false);
    expect(
      isCvAttachment({ name: 'scan.jpg', size: 400_000, inline: true }),
    ).toBe(false);
    expect(isCvAttachment({ name: 'scan.jpg', size: 400_000 })).toBe(true);
    expect(isCvAttachment({ name: 'cv.pdf', size: 0 })).toBe(false);
  });

  it('shows a sender by name, never by address', () => {
    expect(senderName('"Awa Mbemba" <awa@example.com>')).toBe('Awa Mbemba');
    expect(senderName('Jean <jean@example.com>')).toBe('Jean');
    expect(senderName('<jean.k@example.com>')).toBe('jean.k');
    expect(senderName('jean.k@example.com')).toBe('jean.k');
    expect(senderName(undefined)).toBe('');
  });
});

describe('callbackPage', () => {
  it('tells its opener, on its own origin only', () => {
    const html = callbackPage('connected');
    expect(html).toContain('{ rabotkaMailbox: "connected" }');
    expect(html).toContain('window.location.origin');
    expect(callbackPage('denied')).toContain('Connexion annulée');
  });
});

describe('MailboxService', () => {
  const crypto = new MailboxCrypto(KEY);
  const jwt = new JwtService({ secret: 'test-secret' });

  function make(env: Record<string, string | undefined> = {}) {
    const config = {
      get: (k: string) =>
        ({
          MAILBOX_TOKEN_KEY: KEY,
          GOOGLE_MAIL_CLIENT_ID: 'gid',
          GOOGLE_MAIL_CLIENT_SECRET: 'gsecret',
          MS_MAIL_CLIENT_ID: undefined,
          MS_MAIL_CLIENT_SECRET: undefined,
          ...env,
        })[k],
    };
    const prisma: any = {
      businessMailbox: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    const subscriptions: any = {
      businessOf: jest.fn().mockResolvedValue('biz-1'),
    };
    const service = new MailboxService(
      prisma,
      jwt,
      subscriptions,
      config as any,
    );
    const gmail = (service as any).providers.GMAIL;
    return { service, prisma, subscriptions, gmail };
  }

  const box = (over: Record<string, unknown> = {}) => ({
    id: 'mb-1',
    business_id: 'biz-1',
    provider: 'GMAIL',
    email: 'rh@zuafood.cg',
    refresh_token_enc: crypto.seal('refresh-1'),
    access_token_enc: crypto.seal('access-1'),
    access_expires_at: new Date(Date.now() + 3_600_000),
    expired_at: null,
    ...over,
  });

  it('says which providers can be connected', async () => {
    const { service } = make();
    const r = await service.list('p-1');
    expect(r.available).toEqual({ gmail: true, outlook: false });
    expect(
      make({ MAILBOX_TOKEN_KEY: undefined }).service.available('GMAIL' as any),
    ).toBe(false);
  });

  it('refuses to connect a provider that is not configured', async () => {
    const { service } = make();
    await expect(service.connectUrl('p-1', 'outlook')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('signs the business into the state and keeps the tokens sealed', async () => {
    const { service, prisma, gmail } = make();
    const { url } = await service.connectUrl('p-1', 'gmail');
    const u = new URL(url);
    expect(u.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/gmail.readonly',
    );
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('redirect_uri')).toBe(redirectUri('gmail'));
    const state = u.searchParams.get('state')!;

    gmail.exchange = jest.fn().mockResolvedValue({
      access: 'access-new',
      refresh: 'refresh-new',
      expiresAt: new Date(),
      email: 'RH@ZuaFood.cg',
    });
    await expect(service.complete('gmail', 'code', state)).resolves.toEqual({
      email: 'rh@zuafood.cg',
    });
    const arg = prisma.businessMailbox.upsert.mock.calls[0][0];
    expect(arg.where.business_id_provider_email).toEqual({
      business_id: 'biz-1',
      provider: 'GMAIL',
      email: 'rh@zuafood.cg',
    });
    expect(arg.create.connected_by_profile_id).toBe('p-1');
    expect(arg.create.refresh_token_enc).not.toContain('refresh-new');
    expect(crypto.open(arg.create.refresh_token_enc)).toBe('refresh-new');
  });

  it('refuses a forged, foreign or expired state', async () => {
    const { service, prisma } = make();
    await expect(
      service.complete('gmail', 'code', 'not-a-jwt'),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Signed for another purpose (no mailbox audience).
    const other = await jwt.signAsync({ b: 'biz-1', p: 'p-1', v: 'gmail' });
    await expect(
      service.complete('gmail', 'code', other),
    ).rejects.toBeInstanceOf(BadRequestException);
    const expired = await jwt.signAsync(
      { b: 'biz-1', p: 'p-1', v: 'gmail', n: 'x' },
      { audience: 'rabotka-mailbox-connect', expiresIn: -10 },
    );
    await expect(
      service.complete('gmail', 'code', expired),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.businessMailbox.upsert).not.toHaveBeenCalled();
  });

  it('reads only its own mailboxes', async () => {
    const { service, prisma } = make();
    prisma.businessMailbox.findFirst.mockResolvedValue(null);
    await expect(service.mails('p-1', 'mb-x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.businessMailbox.findFirst).toHaveBeenCalledWith({
      where: { id: 'mb-x', business_id: 'biz-1' },
    });

    prisma.businessMailbox.findMany.mockResolvedValue([]);
    await expect(
      service.download('p-1', [
        { mailboxId: 'mb-x', messageId: 'm', attachmentId: 'a' },
      ]),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reads the ticked attachments into files', async () => {
    const { service, prisma, gmail } = make();
    prisma.businessMailbox.findMany.mockResolvedValue([box()]);
    gmail.attachment = jest.fn().mockResolvedValue({
      name: 'CV Awa.pdf',
      mime: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7'),
    });
    const files = await service.download('p-1', [
      { mailboxId: 'mb-1', messageId: 'm1', attachmentId: '2' },
    ]);
    expect(gmail.attachment).toHaveBeenCalledWith('access-1', 'm1', '2');
    expect(files).toEqual([
      {
        originalname: 'CV Awa.pdf',
        mimetype: 'application/pdf',
        size: 8,
        buffer: Buffer.from('%PDF-1.7'),
      },
    ]);
  });

  it('previews a PDF or a photo, by its bytes, and nothing else', async () => {
    const { service, prisma, gmail } = make();
    prisma.businessMailbox.findFirst.mockResolvedValue(box());
    gmail.attachment = jest.fn().mockResolvedValue({
      name: 'CV Awa.pdf',
      mime: 'application/octet-stream',
      buffer: Buffer.from('%PDF-1.7 a real enough cv'),
    });
    await expect(
      service.preview('p-1', 'mb-1', 'm1', '2'),
    ).resolves.toMatchObject({ name: 'CV Awa.pdf', type: 'application/pdf' });

    // A .docx is a zip: no preview in a browser.
    gmail.attachment.mockResolvedValue({
      name: 'cv.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.alloc(30),
      ]),
    });
    await expect(
      service.preview('p-1', 'mb-1', 'm1', '3'),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);

    // A page dressed up as a PDF is not served.
    gmail.attachment.mockResolvedValue({
      name: 'cv.pdf',
      mime: 'application/pdf',
      buffer: Buffer.from('<html><script>alert(1)</script>'),
    });
    await expect(
      service.preview('p-1', 'mb-1', 'm1', '4'),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);

    prisma.businessMailbox.findFirst.mockResolvedValue(null);
    await expect(
      service.preview('p-1', 'mb-x', 'm1', '2'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('takes at most 5 attachments', async () => {
    const { service } = make();
    const ref = { mailboxId: 'mb-1', messageId: 'm', attachmentId: 'a' };
    await expect(
      service.download('p-1', Array(6).fill(ref)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refreshes an expired access token and keeps the new one', async () => {
    const { service, prisma, gmail } = make();
    prisma.businessMailbox.findFirst.mockResolvedValue(
      box({ access_expires_at: new Date(Date.now() - 1000) }),
    );
    gmail.refresh = jest.fn().mockResolvedValue({
      access: 'access-2',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    gmail.listCvMails = jest.fn().mockResolvedValue({ mails: [], next: null });
    await service.mails('p-1', 'mb-1', 'serveur');
    expect(gmail.refresh).toHaveBeenCalledWith('refresh-1');
    expect(gmail.listCvMails).toHaveBeenCalledWith('access-2', {
      q: 'serveur',
      page: undefined,
    });
    const saved = prisma.businessMailbox.update.mock.calls[0][0].data;
    expect(crypto.open(saved.access_token_enc)).toBe('access-2');
  });

  it('tries a refused access token once more after a refresh', async () => {
    const { service, prisma, gmail } = make();
    prisma.businessMailbox.findFirst.mockResolvedValue(box());
    gmail.refresh = jest.fn().mockResolvedValue({
      access: 'access-2',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    gmail.listCvMails = jest
      .fn()
      .mockRejectedValueOnce(new MailboxAuthError())
      .mockResolvedValueOnce({ mails: [], next: null });
    await expect(service.mails('p-1', 'mb-1')).resolves.toEqual({
      mails: [],
      next: null,
    });
    expect(gmail.listCvMails).toHaveBeenLastCalledWith('access-2', {
      q: undefined,
      page: undefined,
    });
  });

  it('asks to reconnect when the refresh token is refused', async () => {
    const { service, prisma, gmail } = make();
    prisma.businessMailbox.findFirst.mockResolvedValue(
      box({ access_expires_at: new Date(0) }),
    );
    gmail.refresh = jest.fn().mockRejectedValue(new MailboxAuthError());
    await expect(service.mails('p-1', 'mb-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.businessMailbox.update).toHaveBeenCalledWith({
      where: { id: 'mb-1' },
      data: { expired_at: expect.any(Date), access_token_enc: null },
    });
    // Once expired, it is not tried again.
    prisma.businessMailbox.findFirst.mockResolvedValue(
      box({ expired_at: new Date() }),
    );
    gmail.refresh.mockClear();
    await expect(service.mails('p-1', 'mb-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(gmail.refresh).not.toHaveBeenCalled();
  });

  it('revokes, then forgets, a disconnected mailbox', async () => {
    const { service, prisma, gmail } = make();
    prisma.businessMailbox.findFirst.mockResolvedValue(box());
    gmail.revoke = jest.fn().mockRejectedValue(new Error('network'));
    await expect(service.disconnect('p-1', 'mb-1')).resolves.toEqual({
      ok: true,
    });
    expect(gmail.revoke).toHaveBeenCalledWith('refresh-1');
    expect(prisma.businessMailbox.delete).toHaveBeenCalledWith({
      where: { id: 'mb-1' },
    });
  });
});

describe('connection failures with a reason', () => {
  const fetchMock = jest.fn();
  const realFetch = global.fetch;
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  it('Gmail: the mail permission unticked on the consent screen', async () => {
    const { GmailProvider } = await import('../providers/gmail.provider');
    fetchMock.mockResolvedValueOnce(
      json({
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 3600,
        scope: 'openid',
      }),
    );
    await expect(
      new GmailProvider('id', 'secret').exchange('code', 'https://x/cb'),
    ).rejects.toMatchObject({ name: 'MailboxConnectError', reason: 'scope' });
  });

  it('Gmail: the API not turned on for the project', async () => {
    const { GmailProvider } = await import('../providers/gmail.provider');
    fetchMock
      .mockResolvedValueOnce(
        json({
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/gmail.readonly',
        }),
      )
      .mockResolvedValueOnce(
        json(
          {
            error: {
              code: 403,
              message:
                'Gmail API has not been used in project 123 before or it is disabled.',
              status: 'PERMISSION_DENIED',
              details: [{ reason: 'SERVICE_DISABLED' }],
            },
          },
          403,
        ),
      );
    await expect(
      new GmailProvider('id', 'secret').exchange('code', 'https://x/cb'),
    ).rejects.toMatchObject({ reason: 'api_disabled' });
  });

  it('Outlook: Mail.Read not granted', async () => {
    const { OutlookProvider } = await import('../providers/outlook.provider');
    fetchMock.mockResolvedValueOnce(
      json({
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 3600,
        scope: 'User.Read openid profile',
      }),
    );
    await expect(
      new OutlookProvider('id', 'secret').exchange('code', 'https://x/cb'),
    ).rejects.toMatchObject({ reason: 'scope' });
  });

  it('keeps a failure open and says why', () => {
    const page = callbackPage('scope');
    expect(page).toContain('cochez la case');
    expect(page).toContain('{ rabotkaMailbox: "scope" }');
    expect(page).not.toContain('window.close');
    expect(callbackPage('connected')).toContain('window.close');
  });
});
