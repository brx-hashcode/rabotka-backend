import {
  DOCUMENT_DELIVERY_CONFIG_KEY,
  WhatsAppDocumentService,
} from '../whatsapp-document.service';

/**
 * The plumbing behind a WhatsApp document attachment: upload the PDF, presign
 * it, send the template.
 *
 * The properties worth pinning are the ones whose failure is invisible — a
 * PDF rendered for a provider that cannot send it, a URL signed against the
 * wrong bucket, or a signed credential written into the chat transcript.
 */
describe('WhatsAppDocumentService', () => {
  let whatsApp: {
    supports: jest.Mock;
    sendTemplateMessage: jest.Mock;
  };
  let fileService: { uploadBuffer: jest.Mock; getPresignedUrl: jest.Mock };
  let systemConfig: { get: jest.Mock };
  let config: { get: jest.Mock };
  let service: WhatsAppDocumentService;

  const PDF = Buffer.from('%PDF-1.7 fake');
  const SIGNED = 'https://r2/whatsapp-documents/agreement/p1.pdf?X-Amz-Sig=abc';

  const input = () => ({
    phone: '+242069917686',
    profileId: 'p1',
    template: 'kycAgreementDocument' as const,
    params: { firstName: 'Jean' },
    pdf: PDF,
    filename: 'accord_Okemba.pdf',
    storageKey: 'agreement/p1.pdf',
  });

  beforeEach(() => {
    whatsApp = {
      supports: jest.fn().mockReturnValue(true),
      sendTemplateMessage: jest.fn().mockResolvedValue(true),
    };
    fileService = {
      uploadBuffer: jest.fn().mockResolvedValue({ key: 'k' }),
      getPresignedUrl: jest.fn().mockResolvedValue(SIGNED),
    };
    // `privateBucket` reads this key; anything non-empty keeps it from throwing.
    systemConfig = {
      get: jest
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(
            key === DOCUMENT_DELIVERY_CONFIG_KEY ? 'true' : 'rabotka-private',
          ),
        ),
    };
    config = { get: jest.fn().mockReturnValue('') };

    service = new WhatsAppDocumentService(
      whatsApp as never,
      fileService as never,
      config as never,
      systemConfig as never,
    );
  });

  it('uploads privately as a PDF, under the whatsapp-documents prefix', async () => {
    await service.send(input());

    expect(fileService.uploadBuffer).toHaveBeenCalledWith(
      PDF,
      'whatsapp-documents/agreement/p1.pdf',
      expect.objectContaining({
        mimeType: 'application/pdf',
        access: 'private',
      }),
    );
  });

  it('presigns against the SAME bucket it uploaded to', async () => {
    // Signing against the default bucket yields a URL that resolves to nothing
    // — a mistake this codebase has already made once, per the note in
    // `cloudflare-storage.provider.ts`.
    await service.send(input());

    const uploadBucket = fileService.uploadBuffer.mock.calls[0][2].bucket;
    const presignBucket = fileService.getPresignedUrl.mock.calls[0][1];

    expect(presignBucket).toBe(uploadBucket);
    expect(presignBucket).toBeTruthy();
  });

  it('sends the template with the presigned URL and the filename', async () => {
    await service.send(input());

    expect(whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
      '+242069917686',
      'kycAgreementDocument',
      expect.objectContaining({
        firstName: 'Jean',
        documentUrl: SIGNED,
        documentFilename: 'accord_Okemba.pdf',
      }),
      'p1',
      expect.any(String),
    );
  });

  it('writes a transcript marker that never contains the URL', async () => {
    await service.send(input());

    const body = whatsApp.sendTemplateMessage.mock.calls[0][4] as string;
    expect(body).toBe('[DOC:accord_Okemba.pdf]');
    expect(body).not.toContain('X-Amz-Sig');
  });

  describe('short circuits before doing any work', () => {
    it('does not render or upload when the provider has no document header', async () => {
      // Twilio drops `kind` and `filename` outright, so the PDF, the upload and
      // the presign would all be spent on a message nobody can receive.
      whatsApp.supports.mockReturnValue(false);

      await expect(service.send(input())).resolves.toBe(false);
      expect(fileService.uploadBuffer).not.toHaveBeenCalled();
      expect(whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('does not upload when the kill switch is off', async () => {
      systemConfig.get.mockImplementation((key: string) =>
        Promise.resolve(
          key === DOCUMENT_DELIVERY_CONFIG_KEY ? 'false' : 'rabotka-private',
        ),
      );

      await expect(service.send(input())).resolves.toBe(false);
      expect(fileService.uploadBuffer).not.toHaveBeenCalled();
    });
  });

  it('propagates an upload failure rather than swallowing it', async () => {
    // The caller holds an idempotency claim it has to release, so this one
    // must NOT be converted into a quiet `false`.
    fileService.uploadBuffer.mockRejectedValue(new Error('r2 down'));

    await expect(service.send(input())).rejects.toThrow('r2 down');
  });

  describe('sendPreferringWindow()', () => {
    const asked = () => ({ ...input(), caption: 'Votre reçu' });

    beforeEach(() => {
      Object.assign(whatsApp, {
        isServiceWindowOpen: jest.fn(),
        sendDocumentMessage: jest.fn().mockResolvedValue(true),
      });
    });

    it('sends a plain document while the 24h window is open, no template', async () => {
      (whatsApp as any).isServiceWindowOpen.mockResolvedValue({ open: true });
      // The switch only gates templates: a plain document needs no approval.
      systemConfig.get.mockImplementation((key: string) =>
        Promise.resolve(
          key === DOCUMENT_DELIVERY_CONFIG_KEY ? '' : 'rabotka-private',
        ),
      );

      await expect(service.sendPreferringWindow(asked())).resolves.toBe(true);

      expect((whatsApp as any).sendDocumentMessage).toHaveBeenCalledWith(
        '+242069917686',
        SIGNED,
        'accord_Okemba.pdf',
        'Votre reçu',
      );
      expect(whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('falls back to the template when the window is closed', async () => {
      (whatsApp as any).isServiceWindowOpen.mockResolvedValue({ open: false });

      await service.sendPreferringWindow(asked());

      expect(whatsApp.sendTemplateMessage).toHaveBeenCalled();
      expect((whatsApp as any).sendDocumentMessage).not.toHaveBeenCalled();
    });
  });
});
