import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  constants,
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { fetchWithTimeout } from '../../../utils/fetch-with-timeout.util';

export type SignedCallback = {
  method: string;
  authority: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer | undefined;
};

const MAX_SKEW_SECONDS = 5 * 60;
const KEYS_TTL_MS = 60 * 60 * 1000;
const UNKNOWN_KEY_REFRESH_MS = 60 * 1000;

const DIGESTS: Record<string, string> = {
  'sha-256': 'sha256',
  'sha-512': 'sha512',
};

@Injectable()
export class PawapaySignatureVerifier {
  private readonly logger = new Logger(PawapaySignatureVerifier.name);
  private keys: { byId: Map<string, KeyObject>; at: number } | null = null;
  private lastUnknownKeyRefresh = 0;

  constructor(private readonly configService: ConfigService) {}

  async verify(callback: SignedCallback): Promise<void> {
    const header = (name: string): string => {
      const value = callback.headers[name];
      return (Array.isArray(value) ? value[0] : value) ?? '';
    };

    const signatureInput = header('signature-input');
    const signature = header('signature');
    const contentDigest = header('content-digest');
    const missing = [
      'signature',
      'signature-input',
      'signature-date',
      'content-digest',
    ].filter((name) => !header(name));
    if (missing.length > 0) {
      // All four missing almost always means signing is off for the account:
      // "Sign all callbacks" in the pawaPay dashboard (Developers > API Security).
      throw this.refuse(
        missing.length === 4
          ? 'unsigned callback — enable "Sign all callbacks" in the pawaPay dashboard'
          : `missing signature headers: ${missing.join(', ')}`,
      );
    }
    if (!callback.rawBody) {
      throw this.refuse('raw body unavailable');
    }

    this.checkDigest(contentDigest, callback.rawBody);

    const input = parseSignatureInput(signatureInput);
    if (!input) throw this.refuse('malformed Signature-Input');

    const sig = parseSignature(signature, input.label);
    if (!sig) throw this.refuse('malformed Signature');

    this.checkFreshness(input.params);

    const base = signatureBase(input, (component) => {
      switch (component) {
        case '@method':
          return callback.method.toUpperCase();
        case '@authority':
          return callback.authority.toLowerCase();
        case '@path':
          return callback.path;
        default:
          return component.startsWith('@') ? null : header(component) || null;
      }
    });
    if (base === null) throw this.refuse('signed component missing');

    const keyId = input.params['keyid'];
    const key = typeof keyId === 'string' ? await this.publicKey(keyId) : null;
    if (!key) throw this.refuse(`unknown key ${String(keyId)}`);

    if (!verifySignature(String(input.params['alg'] ?? ''), key, base, sig)) {
      throw this.refuse('signature does not verify');
    }
  }

  private checkDigest(header: string, body: Buffer): void {
    let checked = 0;
    for (const part of header.split(',')) {
      const match = /^\s*([a-z0-9-]+)=:([^:]*):\s*$/i.exec(part);
      if (!match) continue;
      const algorithm = DIGESTS[match[1].toLowerCase()];
      if (!algorithm) continue;
      const expected = createHash(algorithm).update(body).digest();
      const given = Buffer.from(match[2], 'base64');
      if (
        given.length !== expected.length ||
        !timingSafeEqual(given, expected)
      ) {
        throw this.refuse('content digest mismatch');
      }
      checked++;
    }
    if (checked === 0) throw this.refuse('no supported content digest');
  }

  private checkFreshness(params: Record<string, string | number>): void {
    const now = Math.floor(Date.now() / 1000);
    const created = Number(params['created']);
    if (
      !Number.isFinite(created) ||
      Math.abs(now - created) > MAX_SKEW_SECONDS
    ) {
      throw this.refuse('signature too old or from the future');
    }
    if (params['expires'] !== undefined && Number(params['expires']) < now) {
      throw this.refuse('signature expired');
    }
  }

  private async publicKey(id: string): Promise<KeyObject | null> {
    const fresh = this.keys && Date.now() - this.keys.at < KEYS_TTL_MS;
    if (!fresh) await this.loadKeys();
    let key = this.keys?.byId.get(id) ?? null;
    if (
      !key &&
      Date.now() - this.lastUnknownKeyRefresh > UNKNOWN_KEY_REFRESH_MS
    ) {
      this.lastUnknownKeyRefresh = Date.now();
      await this.loadKeys();
      key = this.keys?.byId.get(id) ?? null;
    }
    return key;
  }

  private async loadKeys(): Promise<void> {
    const base = this.configService
      .get<string>('PAWAPAY_BASE_URL', '')
      .replace(/\/+$/, '');
    try {
      const response = await fetchWithTimeout(`${base}/v2/public-key/http`, {
        headers: {
          Authorization: `Bearer ${this.configService.get<string>('PAWAPAY_API_TOKEN', '')}`,
        },
      });
      if (!response.ok) {
        this.logger.warn(`pawaPay public keys: HTTP ${response.status}`);
        return;
      }
      const list = (await response.json()) as Array<{
        id?: string;
        key?: string;
      }>;
      const byId = new Map<string, KeyObject>();
      for (const item of Array.isArray(list) ? list : []) {
        if (!item.id || !item.key) continue;
        try {
          byId.set(item.id, createPublicKey(item.key));
        } catch {
          this.logger.warn(`pawaPay public key ${item.id} is not a valid key`);
        }
      }
      this.keys = { byId, at: Date.now() };
    } catch (err) {
      this.logger.warn(
        `pawaPay public keys unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private refuse(reason: string): UnauthorizedException {
    this.logger.warn(`pawaPay callback refused: ${reason}`);
    return new UnauthorizedException('Invalid callback signature');
  }
}

type ParsedInput = {
  label: string;
  components: string[];
  params: Record<string, string | number>;
  raw: string;
};

export function parseSignatureInput(header: string): ParsedInput | null {
  const match = /^\s*([A-Za-z0-9_-]+)=(\(([^)]*)\)(.*))$/.exec(
    header.split(/,(?=\s*[A-Za-z0-9_-]+=\()/)[0],
  );
  if (!match) return null;
  const components = [...match[3].matchAll(/"([^"]+)"/g)].map((m) =>
    m[1].toLowerCase(),
  );
  const params: Record<string, string | number> = {};
  for (const m of match[4].matchAll(/;\s*([a-z0-9-]+)=("([^"]*)"|-?\d+)/gi)) {
    params[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : Number(m[2]);
  }
  return { label: match[1], components, params, raw: match[2].trim() };
}

export function parseSignature(header: string, label: string): Buffer | null {
  for (const part of header.split(',')) {
    const match = /^\s*([A-Za-z0-9_-]+)=:([^:]*):\s*$/.exec(part);
    if (match && match[1] === label) return Buffer.from(match[2], 'base64');
  }
  return null;
}

export function signatureBase(
  input: ParsedInput,
  valueOf: (component: string) => string | null,
): string | null {
  const lines: string[] = [];
  for (const component of input.components) {
    const value = valueOf(component);
    if (value === null) return null;
    lines.push(`"${component}": ${value.trim()}`);
  }
  lines.push(`"@signature-params": ${input.raw}`);
  return lines.join('\n');
}

export function verifySignature(
  alg: string,
  key: KeyObject,
  base: string,
  signature: Buffer,
): boolean {
  const data = Buffer.from(base, 'utf8');
  try {
    switch (alg) {
      case 'ecdsa-p256-sha256':
      case 'ecdsa-p384-sha384': {
        const hash = alg.endsWith('256') ? 'sha256' : 'sha384';
        return (['ieee-p1363', 'der'] as const).some((dsaEncoding) => {
          try {
            return verify(hash, data, { key, dsaEncoding }, signature);
          } catch {
            return false;
          }
        });
      }
      case 'rsa-pss-sha512':
        return verify(
          'sha512',
          data,
          { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 },
          signature,
        );
      case 'rsa-v1_5-sha256':
        return verify('sha256', data, key, signature);
      default:
        return false;
    }
  } catch {
    return false;
  }
}
