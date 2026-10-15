import { Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  PawapaySignatureVerifier,
  SignedCallback,
  parseSignatureInput,
} from '../pawapay-signature';
import { fetchWithTimeout } from '../../../../utils/fetch-with-timeout.util';

jest.mock('../../../../utils/fetch-with-timeout.util', () => ({
  fetchWithTimeout: jest.fn(),
}));
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

const fetchMock = fetchWithTimeout as jest.Mock;

const config = {
  get: jest.fn(
    (key: string, fallback?: string) =>
      ({
        PAWAPAY_BASE_URL: 'https://api.sandbox.pawapay.io',
        PAWAPAY_API_TOKEN: 'tok',
      })[key] ?? fallback,
  ),
};

// pawaPay's key pair, as far as these tests are concerned.
const { publicKey, privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const KEY_ID = 'HTTP_EC_P256_KEY:1';

const keysReply = (keys: Array<{ id: string; key: string }>) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(keys),
});

/**
 * A callback signed the way pawaPay signs them: the digest of the body, then
 * an RFC 9421 signature over method, authority, path and three headers.
 */
function signedCallback(
  body: unknown,
  opts: {
    created?: number;
    keyid?: string;
    tamper?: (c: SignedCallback) => void;
  } = {},
): SignedCallback {
  const raw = Buffer.from(JSON.stringify(body));
  const digest = `sha-512=:${createHash('sha512').update(raw).digest('base64')}:`;
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const signatureDate = new Date(created * 1000).toISOString();
  const params = `("@method" "@authority" "@path" "signature-date" "content-digest" "content-type");alg="ecdsa-p256-sha256";keyid="${opts.keyid ?? KEY_ID}";created=${created};expires=${created + 60}`;
  const base = [
    '"@method": POST',
    '"@authority": api.rabotka.test',
    '"@path": /api/v1/webhooks/payment/pawapay',
    `"signature-date": ${signatureDate}`,
    `"content-digest": ${digest}`,
    '"content-type": application/json',
    `"@signature-params": ${params}`,
  ].join('\n');
  const signature = sign('sha256', Buffer.from(base), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');

  const callback: SignedCallback = {
    method: 'POST',
    authority: 'api.rabotka.test',
    path: '/api/v1/webhooks/payment/pawapay',
    rawBody: raw,
    headers: {
      'content-type': 'application/json',
      'content-digest': digest,
      'signature-date': signatureDate,
      'signature-input': `sig-pp=${params}`,
      signature: `sig-pp=:${signature}:`,
    },
  };
  opts.tamper?.(callback);
  return callback;
}

describe('PawapaySignatureVerifier', () => {
  let verifier: PawapaySignatureVerifier;
  const body = { depositId: 'dep-1', status: 'COMPLETED', amount: '1500.00' };

  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock.mockResolvedValue(keysReply([{ id: KEY_ID, key: PUBLIC_PEM }]));
    verifier = new PawapaySignatureVerifier(config as never);
  });

  it('accepts a callback pawaPay signed', async () => {
    await expect(
      verifier.verify(signedCallback(body)),
    ).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.sandbox.pawapay.io/v2/public-key/http',
    );
  });

  it('fetches the keys once and reuses them', async () => {
    await verifier.verify(signedCallback(body));
    await verifier.verify(signedCallback(body));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  const refused = async (callback: SignedCallback) =>
    expect(verifier.verify(callback)).rejects.toThrow(UnauthorizedException);

  it('refuses a body changed after signing', async () => {
    await refused(
      signedCallback(body, {
        tamper: (c) => {
          c.rawBody = Buffer.from(JSON.stringify({ ...body, amount: '1.00' }));
        },
      }),
    );
  });

  it('refuses a body whose digest was recomputed to match', async () => {
    // The digest header is signed: fixing it up breaks the signature instead.
    await refused(
      signedCallback(body, {
        tamper: (c) => {
          const forged = Buffer.from(
            JSON.stringify({ ...body, amount: '1.00' }),
          );
          c.rawBody = forged;
          c.headers['content-digest'] =
            `sha-512=:${createHash('sha512').update(forged).digest('base64')}:`;
        },
      }),
    );
  });

  it('refuses a callback sent to another path', async () => {
    await refused(
      signedCallback(body, {
        tamper: (c) => {
          c.path = '/api/v1/webhooks/payment/pawapay/payouts';
        },
      }),
    );
  });

  it('refuses an old signature (replay)', async () => {
    await refused(
      signedCallback(body, { created: Math.floor(Date.now() / 1000) - 3600 }),
    );
  });

  it.each(['signature', 'signature-input', 'content-digest', 'signature-date'])(
    'refuses a callback without %s',
    async (header) => {
      await refused(
        signedCallback(body, {
          tamper: (c) => {
            delete c.headers[header];
          },
        }),
      );
    },
  );

  it('refuses when the raw body is unavailable', async () => {
    await refused(
      signedCallback(body, {
        tamper: (c) => {
          c.rawBody = undefined;
        },
      }),
    );
  });

  it('refuses a signature made with another key', async () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    fetchMock.mockResolvedValue(
      keysReply([
        {
          id: KEY_ID,
          key: other.publicKey
            .export({ type: 'spki', format: 'pem' })
            .toString(),
        },
      ]),
    );
    await refused(signedCallback(body));
  });

  it('refetches once for an unknown key id (rotation), then refuses it', async () => {
    await refused(signedCallback(body, { keyid: 'HTTP_EC_P256_KEY:2' }));
    // First load, then one refresh for the unknown id.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Made-up key ids must not make us call pawaPay every time.
    await refused(signedCallback(body, { keyid: 'HTTP_EC_P256_KEY:3' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('accepts a rotated key once pawaPay publishes it', async () => {
    fetchMock
      .mockResolvedValueOnce(keysReply([{ id: 'OLD', key: PUBLIC_PEM }]))
      .mockResolvedValueOnce(keysReply([{ id: KEY_ID, key: PUBLIC_PEM }]));
    await expect(
      verifier.verify(signedCallback(body)),
    ).resolves.toBeUndefined();
  });

  it('refuses everything while the keys cannot be fetched', async () => {
    fetchMock.mockRejectedValue(new Error('pawaPay down'));
    await refused(signedCallback(body));
  });
});

describe('parseSignatureInput', () => {
  it('reads the label, components and parameters', () => {
    const parsed = parseSignatureInput(
      'sig-pp=("@method" "@path" "content-digest");alg="ecdsa-p256-sha256";keyid="K:1";created=100;expires=160',
    );
    expect(parsed).toEqual({
      label: 'sig-pp',
      components: ['@method', '@path', 'content-digest'],
      params: {
        alg: 'ecdsa-p256-sha256',
        keyid: 'K:1',
        created: 100,
        expires: 160,
      },
      raw: '("@method" "@path" "content-digest");alg="ecdsa-p256-sha256";keyid="K:1";created=100;expires=160',
    });
  });

  it('returns null for something that is not a signature input', () => {
    expect(parseSignatureInput('nonsense')).toBeNull();
  });
});
