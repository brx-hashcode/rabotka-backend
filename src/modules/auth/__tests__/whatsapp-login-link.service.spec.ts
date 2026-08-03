import { Test, TestingModule } from '@nestjs/testing';
import { AccountStatus } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { WhatsAppLoginLinkService } from '../whatsapp-login-link.service';

describe('WhatsAppLoginLinkService', () => {
  let service: WhatsAppLoginLinkService;
  let redis: { set: jest.Mock; eval: jest.Mock };
  let prisma: { profile: { findUnique: jest.Mock } };

  beforeEach(async () => {
    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(null),
    };
    prisma = {
      profile: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: AccountStatus.ACTIVE }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppLoginLinkService,
        { provide: REDIS_CONNECTION, useValue: redis },
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(() => 'https://rabotka.work'),
          },
        },
      ],
    }).compile();

    service = module.get<WhatsAppLoginLinkService>(WhatsAppLoginLinkService);
  });

  describe('mint()', () => {
    it('stores an opaque code against the profile with a 24h TTL', async () => {
      const code = await service.mint('profile-1');

      expect(code).toEqual(expect.any(String));
      expect(code).toMatch(/^[\w-]+$/); // base64url only — safe in a URL
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining(`wa:login:${code}`),
        JSON.stringify({ p: 'profile-1', d: 'home' }),
        'EX',
        86_400,
      );
    });

    it('returns a different code every time', async () => {
      const first = await service.mint('profile-1');
      const second = await service.mint('profile-1');

      expect(first).not.toEqual(second);
    });

    it.each([AccountStatus.SUSPENDED, AccountStatus.BANNED])(
      'refuses to mint for a %s profile',
      async (status) => {
        prisma.profile.findUnique.mockResolvedValue({ status });

        expect(await service.mint('profile-1')).toBeNull();
        expect(redis.set).not.toHaveBeenCalled();
      },
    );

    it('refuses to mint for an unknown profile', async () => {
      prisma.profile.findUnique.mockResolvedValue(null);

      expect(await service.mint('ghost')).toBeNull();
    });
  });

  describe('consume()', () => {
    it('returns the profile and the destination the code was minted for', async () => {
      redis.eval.mockResolvedValue(JSON.stringify({ p: 'profile-1', d: 'applications/42' }));

      expect(await service.consume('code-1')).toEqual({
        profileId: 'profile-1',
        path: 'applications/42',
      });
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining('DEL'),
        1,
        expect.stringContaining('wa:login:code-1'),
      );
    });

    it('is single-use — the code is deleted in the same round-trip', async () => {
      redis.eval
        .mockResolvedValueOnce(JSON.stringify({ p: 'profile-1', d: 'home' }))
        .mockResolvedValueOnce(null);

      expect(await service.consume('code-1')).toMatchObject({
        profileId: 'profile-1',
      });
      expect(await service.consume('code-1')).toBeNull();
    });

    it.each(['', '   '])('rejects a blank code (%p) without hitting Redis', async (code) => {
      expect(await service.consume(code)).toBeNull();
      expect(redis.eval).not.toHaveBeenCalled();
    });
  });

  describe('appendTo()', () => {
    it('appends the code as a query parameter', async () => {
      const link = await service.appendTo('profile-1', 'application-42');

      expect(link).toMatch(/^application-42\?s=[\w-]+$/);
    });

    it('joins with the separator the caller asks for', async () => {
      // Template suffixes land inside `…/login?redirect=/home`, where a '?'
      // would make the code part of the redirect value instead of a parameter.
      const link = await service.appendTo('profile-1', 'home', '&');

      expect(link).toMatch(/^home&s=[\w-]+$/);
    });

    it('returns the plain target when the profile may not auto-login', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        status: AccountStatus.SUSPENDED,
      });

      expect(await service.appendTo('profile-1', 'application-42')).toBe(
        'application-42',
      );
    });

    it('degrades to the plain target when Redis is down', async () => {
      redis.set.mockRejectedValue(new Error('ECONNREFUSED'));

      expect(await service.appendTo('profile-1', 'application-42')).toBe(
        'application-42',
      );
    });
  });

  describe('shortLink()', () => {
    it('builds a /s/<code> link on the configured frontend', async () => {
      const link = await service.shortLink('profile-1', 'applications/42');

      expect(link).toMatch(/^https:\/\/rabotka\.work\/s\/[\w-]+$/);
    });

    it('stores the destination with the code, not in the URL', async () => {
      await service.shortLink('profile-1', '/applications/42');

      expect(redis.set).toHaveBeenCalledWith(
        expect.any(String),
        JSON.stringify({ p: 'profile-1', d: 'applications/42' }),
        'EX',
        86_400,
      );
    });

    it('returns null when the profile may not auto-login', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        status: AccountStatus.SUSPENDED,
      });

      expect(await service.shortLink('profile-1', 'home')).toBeNull();
    });

    it('returns null rather than a broken link when Redis is down', async () => {
      redis.set.mockRejectedValue(new Error('ECONNREFUSED'));

      expect(await service.shortLink('profile-1', 'home')).toBeNull();
    });
  });

  describe('consume() — legacy codes', () => {
    it('still resolves a code minted before destinations existed', async () => {
      // Those stored a bare profile id; they must not lock anyone out.
      redis.eval.mockResolvedValue('profile-legacy');

      expect(await service.consume('old-code')).toEqual({
        profileId: 'profile-legacy',
        path: 'home',
      });
    });
  });
});
