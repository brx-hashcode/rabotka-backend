import { Test, TestingModule } from '@nestjs/testing';
import { AccountStatus } from '@prisma/client';
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
        'profile-1',
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
    it('returns the profile the code was minted for', async () => {
      redis.eval.mockResolvedValue('profile-1');

      expect(await service.consume('code-1')).toBe('profile-1');
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining('DEL'),
        1,
        expect.stringContaining('wa:login:code-1'),
      );
    });

    it('is single-use — the code is deleted in the same round-trip', async () => {
      redis.eval
        .mockResolvedValueOnce('profile-1')
        .mockResolvedValueOnce(null);

      expect(await service.consume('code-1')).toBe('profile-1');
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
});
