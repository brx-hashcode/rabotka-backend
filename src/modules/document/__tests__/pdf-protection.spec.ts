import { protectPdf, qpdfEncryptArgs } from '../pdf-protection';

const logger = () => ({ warn: jest.fn(), error: jest.fn() });

describe('qpdfEncryptArgs', () => {
  it('opens for anyone, prints, but cannot be edited or copied from', () => {
    expect(
      qpdfEncryptArgs('owner-secret', '/tmp/in.pdf', '/tmp/out.pdf'),
    ).toEqual([
      '--encrypt',
      // No user password: the recipient opens it like any other PDF.
      '',
      'owner-secret',
      '256',
      '--print=full',
      '--modify=none',
      '--extract=n',
      '--',
      '/tmp/in.pdf',
      '/tmp/out.pdf',
    ]);
  });
});

describe('protectPdf', () => {
  const original = Buffer.from('%PDF-1.4 original');

  it('runs qpdf with a fresh random owner password each time', async () => {
    const run = jest.fn().mockResolvedValue(undefined);

    await protectPdf(original, logger(), run);
    await protectPdf(original, logger(), run);

    const owners = run.mock.calls.map(([, args]) => (args as string[])[2]);
    expect(run.mock.calls[0][0]).toBe('qpdf');
    expect(owners[0]).toMatch(/^[\w-]{32}$/);
    expect(owners[0]).not.toBe(owners[1]);
  });

  it('hands the PDF back unprotected when qpdf is not installed', async () => {
    const log = logger();
    const run = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('spawn qpdf ENOENT'), { code: 'ENOENT' }),
      );

    await expect(protectPdf(original, log, run)).resolves.toBe(original);
    expect(log.warn).toHaveBeenCalled();
  });

  it('delivers the PDF rather than failing when qpdf rejects it', async () => {
    // What the old call did with qpdf installed: an invalid option, exit 2.
    const log = logger();
    const run = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('qpdf: bad option'), { code: 2 }),
      );

    await expect(protectPdf(original, log, run)).resolves.toBe(original);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('qpdf: bad option'),
    );
  });
});
