import { GmailProvider } from '../providers/gmail.provider';
import { OutlookProvider } from '../providers/outlook.provider';
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

  describe('Outlook', () => {
    const outlook = new OutlookProvider('id', 'secret');

    it('keeps file attachments that can be CVs', async () => {
      fetchMock.mockResolvedValueOnce(
        json({
          value: [
            {
              id: 'o1',
              subject: 'CV',
              receivedDateTime: new Date().toISOString(),
              hasAttachments: true,
              from: { emailAddress: { name: '', address: 'jean@x.cg' } },
              attachments: [
                {
                  '@odata.type': '#microsoft.graph.fileAttachment',
                  id: 'a1',
                  name: 'cv.docx',
                  contentType: '',
                  size: 50_000,
                  isInline: false,
                },
                {
                  '@odata.type': '#microsoft.graph.itemAttachment',
                  id: 'a2',
                  name: 'fwd.pdf',
                  contentType: 'application/pdf',
                  size: 50_000,
                  isInline: false,
                },
              ],
            },
          ],
          '@odata.nextLink':
            'https://graph.microsoft.com/v1.0/me/messages?$skip=15',
        }),
      );
      const r = await outlook.listCvMails('tok', {});
      expect(r.mails).toEqual([
        {
          id: 'o1',
          fromName: 'jean',
          subject: 'CV',
          date: expect.any(String),
          attachments: [
            {
              id: 'a1',
              name: 'cv.docx',
              size: 50_000,
              mime: 'application/octet-stream',
            },
          ],
        },
      ]);
      expect(r.next).toContain('$skip=15');
    });

    it('follows only its own next links', async () => {
      await expect(
        outlook.listCvMails('tok', { page: 'https://evil.example/steal' }),
      ).rejects.toThrow(/page link/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
