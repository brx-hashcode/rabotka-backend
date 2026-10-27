import { DOCX_MIME, cvFileType, foldWhitespace } from '../cv-files';

const pad = (head: number[]) =>
  Buffer.concat([Buffer.from(head), Buffer.alloc(16)]);

describe('cvFileType', () => {
  it('trusts the bytes, not the declared type', () => {
    expect(cvFileType(Buffer.from('%PDF-1.7 xxxxxxxxxx'), 'image/png')).toBe(
      'application/pdf',
    );
    expect(cvFileType(pad([0xff, 0xd8, 0xff]), 'application/pdf')).toBe(
      'image/jpeg',
    );
  });

  it('takes a zip as Word only when declared as Word', () => {
    const zip = pad([0x50, 0x4b, 0x03, 0x04]);
    expect(cvFileType(zip, DOCX_MIME)).toBe(DOCX_MIME);
    expect(cvFileType(zip, 'application/zip')).toBeNull();
  });

  it('refuses anything else', () => {
    expect(cvFileType(Buffer.from('hello world, a text'), 'text/plain')).toBe(
      null,
    );
  });
});

describe('foldWhitespace', () => {
  it('folds runs of spaces and blank lines', () => {
    expect(foldWhitespace('  Nom :  Awa \n\n\n\n Ville  ')).toBe(
      'Nom : Awa\n\nVille',
    );
  });
});
