import {
  CLAIM_ATTACHMENT_PREFIX,
  LEGACY_CLAIM_ATTACHMENT_PREFIX,
  isClaimAttachmentKey,
} from '../claim-attachment-key';

/**
 * This is the whole of the server-side guarantee that a claim attachment is an
 * image we stored. `assertValidUrls` derives a key and asks this one question,
 * so anything this accepts is rendered by both frontends.
 */
describe('isClaimAttachmentKey', () => {
  it('accepts a key written by the upload route', () => {
    expect(
      isClaimAttachmentKey('claim-attachments/1757000000_ab12cd.jpg'),
    ).toBe(true);
    expect(isClaimAttachmentKey('claim-attachments/x.jpeg')).toBe(true);
    expect(isClaimAttachmentKey('claim-attachments/x.png')).toBe(true);
    expect(isClaimAttachmentKey('claim-attachments/x.webp')).toBe(true);
  });

  it('is case insensitive about the extension', () => {
    expect(isClaimAttachmentKey('claim-attachments/PHOTO.JPG')).toBe(true);
  });

  it('accepts the legacy generic-upload folder during the deploy window', () => {
    // Remove this expectation together with LEGACY_CLAIM_ATTACHMENT_PREFIX.
    expect(isClaimAttachmentKey('files/1757000000_ab12cd.jpg')).toBe(true);
  });

  describe('rejects', () => {
    it('an SVG, whatever folder it sits in', () => {
      // Served from the public bucket, so an SVG is executable content on the
      // CDN origin. This is the case the extension allowlist exists for.
      expect(isClaimAttachmentKey('claim-attachments/payload.svg')).toBe(false);
    });

    it('a non-image extension', () => {
      expect(isClaimAttachmentKey('claim-attachments/contract.pdf')).toBe(
        false,
      );
      expect(isClaimAttachmentKey('claim-attachments/notes.doc')).toBe(false);
      expect(isClaimAttachmentKey('claim-attachments/run.sh')).toBe(false);
    });

    it('a key with no extension at all', () => {
      // `'photo'.split('.').pop()` is `'photo'` — a naive reader treats the
      // whole name as an extension and lets this through.
      expect(isClaimAttachmentKey('claim-attachments/photo')).toBe(false);
      expect(isClaimAttachmentKey('claim-attachments/photo.')).toBe(false);
    });

    it('path traversal out of the folder', () => {
      expect(isClaimAttachmentKey('claim-attachments/../secret.jpg')).toBe(
        false,
      );
      expect(isClaimAttachmentKey('claim-attachments/./x.jpg')).toBe(false);
      expect(isClaimAttachmentKey('claim-attachments//x.jpg')).toBe(false);
    });

    it('another folder, however image-like the name', () => {
      expect(isClaimAttachmentKey('kyc-documents/passport.jpg')).toBe(false);
      expect(isClaimAttachmentKey('avatars/me.jpg')).toBe(false);
      expect(isClaimAttachmentKey('portfolio/shot.png')).toBe(false);
    });

    it('a prefix that only looks like ours', () => {
      expect(isClaimAttachmentKey('not-claim-attachments/x.jpg')).toBe(false);
    });

    it('an absolute key and an empty one', () => {
      expect(isClaimAttachmentKey('/claim-attachments/x.jpg')).toBe(false);
      expect(isClaimAttachmentKey('')).toBe(false);
    });
  });

  it('names the prefixes it checks', () => {
    // Guards against a rename on one side only: the service builds the upload
    // folder from CLAIM_ATTACHMENT_PREFIX, and this function reads it back.
    expect(CLAIM_ATTACHMENT_PREFIX).toBe('claim-attachments/');
    expect(LEGACY_CLAIM_ATTACHMENT_PREFIX).toBe('files/');
  });
});
