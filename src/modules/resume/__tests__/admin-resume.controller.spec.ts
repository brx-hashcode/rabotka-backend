import { NotFoundException } from '@nestjs/common';
import { AdminResumeController } from '../admin-resume.controller';

function makeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: jest.fn((k: string, v: string) => (headers[k] = v)),
    send: jest.fn(),
  };
}

describe('AdminResumeController', () => {
  it('streams the profile CV inline, never cached', async () => {
    const buffer = Buffer.from('%PDF');
    const service = {
      download: jest
        .fn()
        .mockResolvedValue({ buffer, filename: 'Marie_Test_CV.pdf' }),
    };
    const res = makeRes();
    await new AdminResumeController(service as any).view('p1', res as any);

    expect(service.download).toHaveBeenCalledWith('p1');
    expect(res.headers['Content-Type']).toBe('application/pdf');
    expect(res.headers['Content-Disposition']).toBe(
      'inline; filename="Marie_Test_CV.pdf"',
    );
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(res.send).toHaveBeenCalledWith(buffer);
  });

  it('lets a missing profile through as a 404', async () => {
    const service = {
      download: jest
        .fn()
        .mockRejectedValue(new NotFoundException('Profil introuvable')),
    };
    const res = makeRes();
    await expect(
      new AdminResumeController(service as any).view('nope', res as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(res.send).not.toHaveBeenCalled();
  });
});
