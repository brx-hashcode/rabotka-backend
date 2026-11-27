import {
  DOCX_MIME,
  TEXT_MIME,
  cvFileType,
  extractCvText,
  foldWhitespace,
} from '../cv-files';
import {
  buildZip,
  minimalDocx,
} from '../../../../common/utils/__tests__/zip-fixture';

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
    const zip = minimalDocx();
    expect(cvFileType(zip, DOCX_MIME)).toBe(DOCX_MIME);
    expect(cvFileType(zip, 'application/zip')).toBeNull();
  });

  it('refuses a Word file that inflates past the parser bounds', () => {
    const bomb = buildZip({
      'word/document.xml': 'a'.repeat(10 * 1024 * 1024),
    });
    expect(cvFileType(bomb, DOCX_MIME)).toBeNull();
    // Only a zip signature, no readable zip behind it.
    expect(cvFileType(pad([0x50, 0x4b, 0x03, 0x04]), DOCX_MIME)).toBeNull();
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

describe('the internal text CV', () => {
  it('is never taken from an upload, whatever it declares', () => {
    expect(
      cvFileType(Buffer.from('Awa Ngoma, comptable'), TEXT_MIME),
    ).toBeNull();
  });

  it('is read as it is', async () => {
    expect(
      await extractCvText(
        Buffer.from('Awa  Ngoma\ncomptable', 'utf8'),
        TEXT_MIME,
      ),
    ).toBe('Awa Ngoma\ncomptable');
  });
});

describe('extractCvText on Word files', () => {
  it('reads an ordinary Word file', async () => {
    expect(await extractCvText(minimalDocx('Awa Ngoma'), DOCX_MIME)).toBe(
      'Awa Ngoma',
    );
  });

  it('never hands an oversized one to mammoth', async () => {
    const bomb = buildZip({
      'word/document.xml': 'a'.repeat(10 * 1024 * 1024),
    });
    expect(await extractCvText(bomb, DOCX_MIME)).toBe('');
  });
});
