import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * The mailbox tokens at rest: AES-256-GCM under MAILBOX_TOKEN_KEY (32 bytes,
 * base64), stored as `iv.tag.cipher` in base64url. A token that was altered,
 * or sealed under another key, does not open.
 */
export class MailboxCrypto {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32) {
      throw new Error('MAILBOX_TOKEN_KEY must be 32 bytes, base64');
    }
    this.key = key;
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data]
      .map((b) => b.toString('base64url'))
      .join('.');
  }

  open(sealed: string): string {
    const [iv, tag, data] = sealed
      .split('.')
      .map((p) => Buffer.from(p, 'base64url'));
    if (!iv || !tag || !data) throw new Error('Malformed sealed token');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      'utf8',
    );
  }
}
