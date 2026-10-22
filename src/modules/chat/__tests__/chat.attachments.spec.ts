import { BadRequestException } from '@nestjs/common';
import { ChatController } from '../chat.controller';

/**
 * Pentest A2-NV01 (#877): chat attachments went to the public bucket under
 * the client's own Content-Type and extension — an .html or .svg served from
 * our storage host.
 */
describe('ChatController — attachments', () => {
  const uploadToStorage = jest.fn().mockResolvedValue({
    url: 'https://files.rabotka.work/chat/x.png',
    key: 'chat/x.png',
    originalFilename: 'attachment.png',
    mimeType: 'image/png',
    size: 3,
  });
  const controller = new ChatController(
    {} as never,
    {} as never,
    { uploadToStorage } as never,
  );
  const file = (originalname: string, mimetype: string) =>
    ({
      originalname,
      mimetype,
      buffer: Buffer.from('abc'),
      size: 3,
    }) as Express.Multer.File;

  beforeEach(() => uploadToStorage.mockClear());

  it.each([
    ['an HTML page', 'page.html', 'text/html'],
    ['an SVG', 'logo.svg', 'image/svg+xml'],
    ['HTML disguised as an image', 'photo.png', 'text/html'],
  ])('refuses %s', async (_what, name, type) => {
    await expect(controller.uploadAttachment(file(name, type))).rejects.toThrow(
      BadRequestException,
    );
    expect(uploadToStorage).not.toHaveBeenCalled();
  });

  it('stores an accepted file under the validated type, not the client’s', async () => {
    const result = await controller.uploadAttachment(
      file('Ma Photo.PNG', 'image/png'),
    );

    expect(uploadToStorage).toHaveBeenCalledWith(
      expect.objectContaining({
        mimetype: 'image/png',
        originalname: 'attachment.png',
      }),
      { folder: 'chat', access: 'public' },
    );
    // The picked name is kept for display only.
    expect(result.name).toBe('Ma Photo.PNG');
  });
});
