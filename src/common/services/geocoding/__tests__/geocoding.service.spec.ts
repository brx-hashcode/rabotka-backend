import { GeocodingService } from '../geocoding.service';

function makeRedis() {
  return {
    get: jest.fn(),
    setex: jest.fn().mockResolvedValue('OK'),
  };
}

function makeResponse(opts: {
  ok?: boolean;
  status?: number;
  body?: unknown;
}): any {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: () => Promise.resolve(opts.body ?? []),
  };
}

describe('GeocodingService.geocode', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    jest.clearAllMocks();
    global.fetch = originalFetch;
  });

  it('returns cached coords when Redis already has them', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(JSON.stringify({ lat: 4.1, lng: 9.2 }));
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    const service = new GeocodingService(redis as any);
    const result = await service.geocode('Brazzaville');

    expect(result).toEqual({ lat: 4.1, lng: 9.2 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it('normalises the cache key (lower-case + trim)', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(JSON.stringify({ lat: 1, lng: 2 }));
    global.fetch = jest.fn() as any;

    const service = new GeocodingService(redis as any);
    await service.geocode('  Brazzaville  ');

    expect(redis.get).toHaveBeenCalledWith(
      expect.stringContaining('geocode:brazzaville'),
    );
  });

  it('falls through to Nominatim when the cache hit is corrupt JSON', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue('{not json');
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        makeResponse({ body: [{ lat: '5.5', lon: '6.6' }] }),
      ) as any;

    const service = new GeocodingService(redis as any);
    const result = await service.geocode('Pointe-Noire');

    expect(result).toEqual({ lat: 5.5, lng: 6.6 });
    expect(global.fetch).toHaveBeenCalled();
    expect(redis.setex).toHaveBeenCalled();
  });

  it('hits Nominatim on cache miss and writes the result back', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(null);
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        makeResponse({ body: [{ lat: '4.05', lon: '9.7' }] }),
      ) as any;

    const service = new GeocodingService(redis as any);
    const result = await service.geocode('Brazzaville, Congo');

    expect(result).toEqual({ lat: 4.05, lng: 9.7 });
    // Verify the URL includes the address and Nominatim params
    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toContain('nominatim.openstreetmap.org/search');
    expect(calledUrl).toContain('q=Brazzaville');
    expect(calledUrl).toContain('format=json');
    expect(calledUrl).toContain('limit=1');
    // Verify the User-Agent is set
    const init = (global.fetch as jest.Mock).mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    expect(init.headers['User-Agent']).toContain('Rabotka');
    // Cache write
    expect(redis.setex).toHaveBeenCalledWith(
      expect.stringContaining('geocode:brazzaville, congo'),
      expect.any(Number),
      JSON.stringify({ lat: 4.05, lng: 9.7 }),
    );
  });

  it('returns null and does not cache when Nominatim returns non-OK', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(null);
    global.fetch = jest
      .fn()
      .mockResolvedValue(makeResponse({ ok: false, status: 503 })) as any;

    const service = new GeocodingService(redis as any);
    const result = await service.geocode('Anywhere');

    expect(result).toBeNull();
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it('returns null when Nominatim returns an empty result array', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(null);
    global.fetch = jest
      .fn()
      .mockResolvedValue(makeResponse({ body: [] })) as any;

    const service = new GeocodingService(redis as any);
    const result = await service.geocode('Atlantis');

    expect(result).toBeNull();
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it('swallows network errors and returns null', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(null);
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down')) as any;

    const service = new GeocodingService(redis as any);
    const result = await service.geocode('Brazzaville');

    expect(result).toBeNull();
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it('propagates a Redis read error (current contract)', async () => {
    // Documents existing behaviour: the cache read is *not* wrapped in
    // try/catch, so a Redis outage surfaces as a thrown error. If we ever
    // want to harden this, replace `.rejects` with `.resolves` to null.
    const redis = makeRedis();
    redis.get.mockRejectedValueOnce(new Error('redis down'));
    global.fetch = jest.fn() as any;

    const service = new GeocodingService(redis as any);
    await expect(service.geocode('Anywhere')).rejects.toThrow('redis down');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
