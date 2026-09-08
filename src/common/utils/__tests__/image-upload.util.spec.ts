import { BadRequestException } from '@nestjs/common';
import { imageMulterOptions, withSafeImageName } from '../image-upload.util';
import {
  hasAllowedImageExtension,
  isAllowedImageMimeType,
} from '../../constants/image-upload';

const file = (over: Partial<Express.Multer.File>) =>
  ({
    fieldname: 'files',
    originalname: 'photo.jpg',
    mimetype: 'image/jpeg',
    size: 1024,
    buffer: Buffer.from('x'),
    ...over,
  }) as Express.Multer.File;

/** Runs the filter and reports what it handed back. */
function runFilter(f: Express.Multer.File) {
  let error: Error | null = null;
  let accepted: boolean | undefined;
  imageMulterOptions().fileFilter(null, f, (e, ok) => {
    error = e;
    accepted = ok;
  });
  return { error, accepted };
}

describe('imageMulterOptions', () => {
  it('accepts the three allowed types', () => {
    for (const mimetype of ['image/jpeg', 'image/png', 'image/webp']) {
      const { error, accepted } = runFilter(file({ mimetype }));
      expect(error).toBeNull();
      expect(accepted).toBe(true);
    }
  });

  it('throws rather than dropping the file silently', () => {
    // The distinction that matters: the avatar and portfolio routes answer
    // `cb(null, false)`, so the request succeeds with the file missing and the
    // uploader is told nothing.
    const { error, accepted } = runFilter(
      file({ mimetype: 'application/pdf' }),
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect(accepted).toBe(false);
  });

  it('refuses an SVG', () => {
    const { error } = runFilter(file({ mimetype: 'image/svg+xml' }));
    expect(error).toBeInstanceOf(BadRequestException);
  });

  it('refuses HEIC, which sharp would transcode behind the key', () => {
    const { error } = runFilter(file({ mimetype: 'image/heic' }));
    expect(error).toBeInstanceOf(BadRequestException);
  });

  it('carries the requested size limit through', () => {
    expect(imageMulterOptions(123).limits.fileSize).toBe(123);
  });
});

describe('withSafeImageName', () => {
  it('pins the extension to the mime type, not the filename', () => {
    // The attack this closes: `uploadToStorage` builds the stored key from
    // `originalname`, so without this a file declared `image/jpeg` but named
    // `.svg` is stored — and later served — as an SVG.
    const safe = withSafeImageName(
      file({ originalname: 'payload.svg', mimetype: 'image/jpeg' }),
    );
    expect(safe.originalname).toBe('image.jpg');
    expect(
      hasAllowedImageExtension(`claim-attachments/${safe.originalname}`),
    ).toBe(true);
  });

  it('normalises a name with no extension', () => {
    const safe = withSafeImageName(
      file({ originalname: 'photo', mimetype: 'image/png' }),
    );
    expect(safe.originalname).toBe('image.png');
  });

  it('maps webp to its own extension', () => {
    const safe = withSafeImageName(
      file({ originalname: 'x.jpg', mimetype: 'image/webp' }),
    );
    expect(safe.originalname).toBe('image.webp');
  });

  it('leaves the original object untouched', () => {
    const original = file({ originalname: 'payload.svg' });
    withSafeImageName(original);
    expect(original.originalname).toBe('payload.svg');
  });

  it('refuses a type the filter should already have stopped', () => {
    expect(() =>
      withSafeImageName(file({ mimetype: 'application/pdf' })),
    ).toThrow(BadRequestException);
  });
});

describe('hasAllowedImageExtension', () => {
  it('reads the last dot segment', () => {
    expect(hasAllowedImageExtension('a/b/c.tar.jpg')).toBe(true);
    expect(hasAllowedImageExtension('a/b/c.jpg.pdf')).toBe(false);
  });

  it('treats a dotless name as failing', () => {
    expect(hasAllowedImageExtension('photo')).toBe(false);
  });

  it('does not read a dotfile as an extension', () => {
    expect(hasAllowedImageExtension('.jpg')).toBe(false);
  });
});

describe('isAllowedImageMimeType', () => {
  it('is exact, not prefix-based', () => {
    // `startsWith('image/')` would admit svg+xml and every future format.
    expect(isAllowedImageMimeType('image/png')).toBe(true);
    expect(isAllowedImageMimeType('image/svg+xml')).toBe(false);
    expect(isAllowedImageMimeType('image/gif')).toBe(false);
  });
});
