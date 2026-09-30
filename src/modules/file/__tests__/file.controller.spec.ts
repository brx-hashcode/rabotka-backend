import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { FileController } from '../file.controller';

function makeStorage() {
  return {
    upload: jest
      .fn()
      .mockResolvedValue({ url: 'https://cdn.example.com/file.jpg' }),
  };
}

function makeFile(
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  return {
    buffer: Buffer.from('data'),
    originalname: 'test.jpg',
    mimetype: 'image/jpeg',
    fieldname: 'files',
    encoding: '7bit',
    size: 4,
    stream: null as any,
    destination: '',
    filename: '',
    path: '',
    ...overrides,
  };
}

const mockConfigService = { get: jest.fn().mockReturnValue(undefined) };

describe('FileController', () => {
  let controller: FileController;
  let storage: ReturnType<typeof makeStorage>;

  beforeEach(() => {
    storage = makeStorage();
    mockConfigService.get.mockReturnValue(undefined);
    controller = new FileController(storage as any, mockConfigService as any);
  });

  it('throws when no files provided', async () => {
    await expect(controller.uploadFile([], undefined)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('throws when files is null', async () => {
    await expect(controller.uploadFile(null as any, undefined)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('uploads single file and returns file_url', async () => {
    const result = await controller.uploadFile([makeFile()], undefined);
    expect(result).toEqual({ file_url: 'https://cdn.example.com/file.jpg' });
    expect(storage.upload).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.stringMatching(/\.jpg$/),
      expect.objectContaining({ mimeType: 'image/jpeg', folder: 'files' }),
    );
  });

  it('throws when multiple files provided without is_multipl=true', async () => {
    await expect(
      controller.uploadFile([makeFile(), makeFile()], undefined),
    ).rejects.toThrow(BadRequestException);
  });

  it('uploads multiple files when is_multipl=true', async () => {
    const result = await controller.uploadFile(
      [makeFile(), makeFile({ originalname: 'b.jpg' })],
      'true',
    );
    expect(result).toHaveProperty('files');
    expect((result as any).files).toHaveLength(2);
    expect(storage.upload).toHaveBeenCalledTimes(2);
  });

  it('throws when file buffer missing (multi mode)', async () => {
    await expect(
      controller.uploadFile([makeFile({ buffer: undefined as any })], 'true'),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws when file buffer missing (single mode)', async () => {
    await expect(
      controller.uploadFile(
        [makeFile({ buffer: undefined as any })],
        undefined,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('uploads single non-image file with private access', async () => {
    const result = await controller.uploadFile(
      [makeFile({ mimetype: 'application/pdf', originalname: 'doc.pdf' })],
      undefined,
    );
    expect(storage.upload).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.stringMatching(/\.pdf$/),
      expect.objectContaining({ access: 'private' }),
    );
  });

  it('uses public access override', async () => {
    await controller.uploadFile(
      [makeFile({ mimetype: 'application/pdf', originalname: 'doc.pdf' })],
      undefined,
      'public',
    );
    expect(storage.upload).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.any(String),
      expect.objectContaining({ access: 'public' }),
    );
  });

  it('uses private access override', async () => {
    await controller.uploadFile(
      [makeFile({ mimetype: 'image/png', originalname: 'logo.png' })],
      undefined,
      'private',
    );
    expect(storage.upload).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.any(String),
      expect.objectContaining({ access: 'private' }),
    );
  });

  describe('accepted types', () => {
    it.each([
      ['page.html', 'text/html'],
      ['logo.svg', 'image/svg+xml'],
      ['run.exe', 'application/octet-stream'],
      ['noextension', 'image/jpeg'],
    ])('refuses %s', async (originalname, mimetype) => {
      await expect(
        controller.uploadFile(
          [makeFile({ originalname, mimetype })],
          undefined,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('refuses a file whose name and declared type disagree', async () => {
      // `payload.html` sent as image/jpeg used to be stored as `.html`.
      await expect(
        controller.uploadFile(
          [makeFile({ originalname: 'payload.html', mimetype: 'image/jpeg' })],
          undefined,
          'public',
        ),
      ).rejects.toThrow(BadRequestException);

      await expect(
        controller.uploadFile(
          [makeFile({ originalname: 'photo.jpg', mimetype: 'text/html' })],
          undefined,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('stores the type it decided on, not the one it was told', async () => {
      await controller.uploadFile(
        [makeFile({ originalname: 'NOTES.MD', mimetype: '' })],
        undefined,
        'public',
      );

      expect(storage.upload).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.stringMatching(/^\d+_[0-9a-f]{16}\.md$/),
        expect.objectContaining({ mimeType: 'text/plain; charset=utf-8' }),
      );
    });

    it('stores nothing from a batch that contains a refused file', async () => {
      await expect(
        controller.uploadFile(
          [
            makeFile(),
            makeFile({ originalname: 'x.html', mimetype: 'text/html' }),
          ],
          'true',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(storage.upload).not.toHaveBeenCalled();
    });
  });

  describe('proxyFile()', () => {
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
      mockConfigService.get.mockImplementation((key: string) =>
        key === 'CLOUDFLARE_PUBLIC_BASE_URL'
          ? 'https://cdn.example.com'
          : undefined,
      );
    });

    afterEach(() => {
      fetchSpy?.mockRestore();
      mockConfigService.get.mockReset();
    });

    const makeRes = () =>
      ({
        setHeader: jest.fn(),
        send: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      }) as any;

    it.each([
      'https://evil.example.org/x.pdf',
      'https://cdn.example.com.evil.org/x.pdf',
      'http://169.254.169.254/latest/meta-data/',
      'http://redis:6379/',
      'http://[::1]:5500/api/v1/metrics',
      'https://user:pass@cdn.example.com/x.pdf',
      'file:///etc/passwd',
    ])('refuses %s', async (url) => {
      fetchSpy = jest.spyOn(global, 'fetch' as any);
      await expect(controller.proxyFile(url, makeRes())).rejects.toThrow(
        ForbiddenException,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('refuses everything when no storage host is configured', async () => {
      mockConfigService.get.mockReturnValue(undefined);
      fetchSpy = jest.spyOn(global, 'fetch' as any);
      await expect(
        controller.proxyFile('https://cdn.example.com/img.jpg', makeRes()),
      ).rejects.toThrow(ForbiddenException);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does not follow redirects', async () => {
      fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: jest.fn().mockReturnValue(null) },
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1)),
      } as any);
      await controller.proxyFile('https://cdn.example.com/img.jpg', makeRes());
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://cdn.example.com/img.jpg',
        expect.objectContaining({ redirect: 'error' }),
      );
    });

    it('answers 502 when the fetch itself fails', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch' as any)
        .mockRejectedValueOnce(new TypeError('redirect mode is set to error'));
      const res = makeRes();
      await controller.proxyFile('https://cdn.example.com/img.jpg', res);
      expect(res.status).toHaveBeenCalledWith(502);
    });

    it('refuses a body larger than the ceiling', async () => {
      fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: jest
            .fn()
            .mockImplementation((h: string) =>
              h === 'content-length' ? String(31 * 1024 * 1024) : null,
            ),
        },
        arrayBuffer: jest.fn(),
      } as any);
      const res = makeRes();
      await controller.proxyFile('https://cdn.example.com/big.pdf', res);
      expect(res.status).toHaveBeenCalledWith(413);
      expect(res.send).not.toHaveBeenCalled();
    });

    it('cannot be made to break out of the filename header', async () => {
      fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: jest.fn().mockReturnValue(null) },
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1)),
      } as any);
      const res = makeRes();
      await controller.proxyFile(
        'https://cdn.example.com/a%22%0d%0aX-Evil:%201.pdf',
        res,
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        // The quote, CR and LF are gone: nothing can end the value early.
        'attachment; filename="a_X-Evil__1.pdf"',
      );
    });

    it('returns 400 when no url provided', async () => {
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;
      await controller.proxyFile('', res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for blob: url', async () => {
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;
      await controller.proxyFile('blob:http://localhost/something', res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('proxies file successfully', async () => {
      fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: jest
            .fn()
            .mockImplementation((h: string) =>
              h === 'content-type' ? 'image/jpeg' : null,
            ),
        },
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10)),
      } as any);
      const res = {
        setHeader: jest.fn(),
        send: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;
      await controller.proxyFile('https://cdn.example.com/img.jpg', res);
      expect(res.send).toHaveBeenCalled();
    });

    it('returns error status when upstream fails', async () => {
      fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: { get: jest.fn() },
      } as any);
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;
      await controller.proxyFile('https://cdn.example.com/notfound.jpg', res);
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});
