import { BadRequestException } from '@nestjs/common';
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
      'test.jpg',
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
      'doc.pdf',
      expect.objectContaining({ access: 'private' }),
    );
  });

  it('uses public access override', async () => {
    await controller.uploadFile(
      [makeFile({ mimetype: 'application/pdf' })],
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
      [makeFile({ mimetype: 'image/png' })],
      undefined,
      'private',
    );
    expect(storage.upload).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.any(String),
      expect.objectContaining({ access: 'private' }),
    );
  });

  describe('proxyFile()', () => {
    let fetchSpy: jest.SpyInstance;

    afterEach(() => {
      fetchSpy?.mockRestore();
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
