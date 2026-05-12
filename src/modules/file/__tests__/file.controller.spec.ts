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

describe('FileController', () => {
  let controller: FileController;
  let storage: ReturnType<typeof makeStorage>;

  beforeEach(() => {
    storage = makeStorage();
    controller = new FileController(storage as any);
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
});
