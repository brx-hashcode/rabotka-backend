import { ConfigService } from '@nestjs/config';
import { HelpEmbeddingsService } from '../embeddings.service';

/**
 * The sequence-length setting, and the guard that keeps it honest.
 *
 * Nothing here loads the model — it is ~1GB and several seconds, which has no
 * place in a unit suite. What IS worth pinning is the arithmetic around it,
 * because the failure it guards against is silent: a text over the limit still
 * returns a 1024-dimension vector, just computed from clipped input. There is
 * no error, and the only symptom is recall quietly getting worse.
 */
const stubQdrant = {} as never;

/** A service whose model is already "loaded", so no embedder is ever built. */
function serviceWith(env: Record<string, string>) {
  const config = new ConfigService();
  jest
    .spyOn(config, 'get')
    .mockImplementation((key: string) => env[key] as never);

  const service = new HelpEmbeddingsService(config, stubQdrant);
  const embedder = {
    queryEmbed: jest.fn().mockResolvedValue([0.1, 0.2]),
    passageEmbed: jest.fn(),
  };
  (service as unknown as { embedder: unknown }).embedder = embedder;
  return { service, embedder };
}

describe('HelpEmbeddingsService — sequence length', () => {
  it('defaults to 256, not the library default of 512', () => {
    // 512 is fastembed's default and costs ~1.6s per query because it pads to
    // the limit rather than to the text. 256 is ~775ms for the identical
    // vector, and still leaves ~4x headroom over the longest expanded query.
    const { service } = serviceWith({});
    expect(
      (service as unknown as { maxLength(): number }).maxLength(),
    ).toBe(256);
  });

  it('is overridable, so ingestion can ask for the full length', () => {
    // scripts/vova-ingest.ts sets 512 for itself: corpus chunks are 350 words
    // and would be truncated at the serving value.
    const { service } = serviceWith({ VOVA_EMBED_MAX_LENGTH: '512' });
    expect(
      (service as unknown as { maxLength(): number }).maxLength(),
    ).toBe(512);
  });

  it('reads the override as a number, not a string', () => {
    // ConfigService.get<number>() does NOT return a number without a casting
    // schema — this module keeps `readNumber` for exactly that reason, and a
    // string here would be handed straight to fastembed.
    const { service } = serviceWith({ VOVA_EMBED_MAX_LENGTH: '128' });
    const value = (service as unknown as { maxLength(): number }).maxLength();
    expect(typeof value).toBe('number');
    expect(value).toBe(128);
  });
});

describe('HelpEmbeddingsService — truncation guard', () => {
  it('warns before a query is long enough to be clipped', async () => {
    const { service } = serviceWith({ VOVA_EMBED_MAX_LENGTH: '256' });
    const warn = jest
      .spyOn(
        (service as unknown as { logger: { warn: (m: string) => void } })
          .logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    await service.embedQuery('x'.repeat(700));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('TRUNCATED');
    expect(warn.mock.calls[0][0]).toContain('VOVA_EMBED_MAX_LENGTH=256');
  });

  it('stays quiet for a realistic expanded query', async () => {
    // The longest expansion measured on real WhatsApp phrasings was ~190
    // characters. A guard that cried wolf on those would be turned off.
    const { service } = serviceWith({ VOVA_EMBED_MAX_LENGTH: '256' });
    const warn = jest
      .spyOn(
        (service as unknown as { logger: { warn: (m: string) => void } })
          .logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    await service.embedQuery('x'.repeat(190));

    expect(warn).not.toHaveBeenCalled();
  });

  it('checks every passage in a batch, not just the first', async () => {
    const { service, embedder } = serviceWith({
      VOVA_EMBED_MAX_LENGTH: '256',
    });
    embedder.passageEmbed.mockReturnValue(
      (async function* () {
        yield [[0.1], [0.2]];
      })(),
    );
    const warn = jest
      .spyOn(
        (service as unknown as { logger: { warn: (m: string) => void } })
          .logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    await service.embedPassages(['short', 'y'.repeat(900)]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('passage');
  });

  it('scales the budget with the configured length', async () => {
    // 700 chars is over the budget at 256 and comfortably under it at 512 —
    // the guard has to move with the setting rather than hold a fixed number.
    const { service } = serviceWith({ VOVA_EMBED_MAX_LENGTH: '512' });
    const warn = jest
      .spyOn(
        (service as unknown as { logger: { warn: (m: string) => void } })
          .logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    await service.embedQuery('x'.repeat(700));

    expect(warn).not.toHaveBeenCalled();
  });
});
