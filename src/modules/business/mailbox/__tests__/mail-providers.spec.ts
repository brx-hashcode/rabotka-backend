import { GmailProvider } from '../providers/gmail.provider';
import { MailboxAuthError } from '../providers/mail-provider';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('mail providers', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  describe('Gmail', () => {
    const gmail = new GmailProvider('id', 'secret');

    it('lists mails with a CV, nested parts included, by name only', async () => {
      fetchMock
        .mockResolvedValueOnce(
          json({ messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'p2' }),
        )
        .mockResolvedValueOnce(
          json({
            id: 'm1',
            internalDate: '1761609600000',
            payload: {
              headers: [
                { name: 'From', value: 'Awa Mbemba <awa@example.com>' },
                { name: 'Subject', value: 'Candidature serveuse' },
              ],
              parts: [
                { partId: '0', mimeType: 'text/plain', body: { size: 20 } },
                {
                  partId: '1',
                  mimeType: 'multipart/mixed',
                  parts: [
                    {
                      partId: '1.1',
                      filename: 'CV Awa.pdf',
                      mimeType: 'application/pdf',
                      body: { attachmentId: 'att-x', size: 120_000 },
                    },
                    {
                      partId: '1.2',
                      filename: 'signature.png',
                      mimeType: 'image/png',
                      body: { attachmentId: 'att-y', size: 4_000 },
                    },
                  ],
                },
              ],
            },
          }),
        )
        .mockResolvedValueOnce(
          json({
            id: 'm2',
            payload: {
              headers: [{ name: 'From', value: 'x@example.com' }],
              parts: [
                {
                  partId: '1',
                  filename: 'facture.xlsx',
                  body: { attachmentId: 'a', size: 9_000 },
                },
              ],
            },
          }),
        );

      const r = await gmail.listCvMails('tok', { q: 'serveuse' });
      expect(r.next).toBe('p2');
      expect(r.mails).toEqual([
        {
          id: 'm1',
          fromName: 'Awa Mbemba',
          subject: 'Candidature serveuse',
          date: new Date(1761609600000).toISOString(),
          attachments: [
            {
              id: '1.1',
              name: 'CV Awa.pdf',
              size: 120_000,
              mime: 'application/pdf',
            },
          ],
        },
      ]);
      const listUrl = new URL(fetchMock.mock.calls[0][0]);
      expect(listUrl.searchParams.get('q')).toContain('has:attachment');
      expect(listUrl.searchParams.get('q')).toContain('serveuse');
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
        'Bearer tok',
      );
    });

    it('counts a picture only in a large mail (signatures are not CVs)', async () => {
      fetchMock.mockResolvedValueOnce(json({ messages: [] }));
      await gmail.listCvMails('tok', {});
      const q = new URL(fetchMock.mock.calls[0][0]).searchParams.get('q')!;
      expect(q).toContain('filename:pdf filename:docx');
      expect(q).toContain('(filename:png larger:100K)');
      expect(q).toContain('newer_than:120d');
    });

    const logoOnly = (id: string) =>
      json({
        id,
        payload: {
          parts: [
            {
              partId: '1',
              filename: 'logo.png',
              mimeType: 'image/png',
              body: { attachmentId: 'l', size: 5_000 },
            },
          ],
        },
      });

    it('reads on when a page holds no CV, rather than answering empty', async () => {
      fetchMock
        .mockResolvedValueOnce(
          json({ messages: [{ id: 'a' }], nextPageToken: 'p2' }),
        )
        .mockResolvedValueOnce(logoOnly('a'))
        .mockResolvedValueOnce(
          json({ messages: [{ id: 'b' }], nextPageToken: 'p3' }),
        )
        .mockResolvedValueOnce(
          json({
            id: 'b',
            payload: {
              parts: [
                {
                  partId: '2',
                  filename: 'cv.pdf',
                  mimeType: 'application/pdf',
                  body: { attachmentId: 'c', size: 90_000 },
                },
              ],
            },
          }),
        );
      const r = await gmail.listCvMails('tok', {});
      expect(r.mails.map((m) => m.id)).toEqual(['b']);
      expect(r.next).toBe('p3');
      expect(
        new URL(fetchMock.mock.calls[2][0]).searchParams.get('pageToken'),
      ).toBe('p2');
    });

    it('stops reading on after a few pages, and says where to go on', async () => {
      for (let i = 1; i <= 4; i++) {
        fetchMock
          .mockResolvedValueOnce(
            json({ messages: [{ id: `m${i}` }], nextPageToken: `p${i + 1}` }),
          )
          .mockResolvedValueOnce(logoOnly(`m${i}`));
      }
      const r = await gmail.listCvMails('tok', {});
      expect(r).toEqual({ mails: [], next: 'p5' });
      expect(fetchMock).toHaveBeenCalledTimes(8);
    });

    it('reads an attachment by its part, with a fresh attachment id', async () => {
      fetchMock
        .mockResolvedValueOnce(
          json({
            id: 'm1',
            payload: {
              parts: [
                {
                  partId: '2',
                  filename: 'cv.pdf',
                  mimeType: 'application/pdf',
                  body: { attachmentId: 'fresh', size: 8 },
                },
              ],
            },
          }),
        )
        .mockResolvedValueOnce(
          json({ data: Buffer.from('%PDF-1.7').toString('base64url') }),
        );
      const f = await gmail.attachment('tok', 'm1', '2');
      expect(f.buffer.toString()).toBe('%PDF-1.7');
      expect(fetchMock.mock.calls[1][0]).toContain('/attachments/fresh');
    });

    it('calls a 401 the token’s fault', async () => {
      fetchMock.mockResolvedValueOnce(json({}, 401));
      await expect(gmail.listCvMails('tok', {})).rejects.toBeInstanceOf(
        MailboxAuthError,
      );
    });

    it('calls a refused refresh token gone', async () => {
      fetchMock.mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400));
      await expect(gmail.refresh('r')).rejects.toBeInstanceOf(MailboxAuthError);
    });
  });
});
