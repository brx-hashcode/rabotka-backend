import { resolveUploadType } from '../upload-types';

describe('resolveUploadType', () => {
  it.each([
    ['photo.jpg', 'image/jpeg', 'jpg', 'image/jpeg'],
    ['photo.JPEG', 'image/jpeg', 'jpg', 'image/jpeg'],
    ['logo.png', 'image/png', 'png', 'image/png'],
    ['banner.webp', 'image/webp', 'webp', 'image/webp'],
    ['anim.gif', 'image/gif', 'gif', 'image/gif'],
    ['terms.pdf', 'application/pdf', 'pdf', 'application/pdf'],
    [
      'contract.docx',
      'application/octet-stream',
      'docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    ['help.md', '', 'md', 'text/plain; charset=utf-8'],
    [
      'help.md',
      'text/markdown; charset=utf-8',
      'md',
      'text/plain; charset=utf-8',
    ],
  ])('accepts %s sent as "%s"', (name, declared, extension, contentType) => {
    expect(resolveUploadType(name, declared)).toMatchObject({
      extension,
      contentType,
    });
  });

  it('says which accepted types are images', () => {
    expect(resolveUploadType('a.png', 'image/png')?.isImage).toBe(true);
    expect(resolveUploadType('a.pdf', 'application/pdf')?.isImage).toBe(false);
  });

  it.each([
    ['page.html', 'text/html'],
    ['logo.svg', 'image/svg+xml'],
    ['script.js', 'application/javascript'],
    ['archive.zip', 'application/zip'],
    ['noextension', 'image/png'],
    // Right extension, wrong declared type — and the reverse.
    ['photo.jpg', 'text/html'],
    ['page.html', 'image/jpeg'],
    ['photo.jpg', 'image/png'],
    // The last extension is the one that counts.
    ['photo.jpg.html', 'image/jpeg'],
  ])('refuses %s sent as "%s"', (name, declared) => {
    expect(resolveUploadType(name, declared)).toBeNull();
  });
});
