import { BadRequestException } from '@nestjs/common';
import { GoogleDocsService } from '../google-docs.service';
import * as fetchUtil from '../../../common/utils/fetch-with-timeout.util';

jest.mock('../../../common/utils/fetch-with-timeout.util');

const mockFetch = fetchUtil.fetchWithTimeout as jest.Mock;

describe('GoogleDocsService', () => {
  let service: GoogleDocsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GoogleDocsService();
  });

  it('returns a Buffer on successful export', async () => {
    const fakeData = Buffer.from('docx-content');
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      arrayBuffer: () => Promise.resolve(fakeData.buffer),
    });

    const result = await service.exportGoogleDocAsDocx('doc-id-123');
    expect(result).toBeInstanceOf(Buffer);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('doc-id-123'),
      expect.any(Object),
      15_000,
    );
  });

  it('throws BadRequestException when HTTP response is not ok', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: () => 'text/plain' },
    });

    await expect(service.exportGoogleDocAsDocx('private-doc')).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.exportGoogleDocAsDocx('private-doc')).rejects.toThrow(
      'HTTP 403',
    );
  });

  it('throws BadRequestException when content-type is text/html (private doc)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html; charset=utf-8' },
    });

    await expect(service.exportGoogleDocAsDocx('private-doc')).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.exportGoogleDocAsDocx('private-doc')).rejects.toThrow(
      'private or not accessible',
    );
  });

  it('treats null content-type as non-html and returns buffer', async () => {
    const fakeData = Buffer.from('docx');
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: () => Promise.resolve(fakeData.buffer),
    });

    const result = await service.exportGoogleDocAsDocx('doc-no-ct');
    expect(result).toBeInstanceOf(Buffer);
  });
});
