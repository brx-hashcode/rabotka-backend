import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AdInboxGateway } from '../ad-inbox.gateway';

const makeClient = (
  handshake: Partial<{
    auth: Record<string, unknown>;
    headers: Record<string, string>;
  }> = {},
) =>
  ({
    id: 'socket-1',
    handshake: { auth: {}, headers: {}, ...handshake },
    join: jest.fn(),
    disconnect: jest.fn(),
  }) as any;

describe('AdInboxGateway', () => {
  let gateway: AdInboxGateway;
  let jwtService: { verify: jest.Mock };
  const emit = jest.fn();

  beforeEach(async () => {
    jwtService = {
      verify: jest.fn().mockReturnValue({ sub: 'profile-1', type: 'profile' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdInboxGateway,
        { provide: JwtService, useValue: jwtService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'AUTH_COOKIE_NAME' ? 'rabotka_token' : 'secret',
            ),
          },
        },
      ],
    }).compile();

    gateway = module.get<AdInboxGateway>(AdInboxGateway);
    gateway.server = { to: jest.fn().mockReturnValue({ emit }) } as any;
  });

  describe('handleConnection()', () => {
    it('joins the room derived from the handshake token, not from client input', () => {
      const client = makeClient({ auth: { token: 'jwt-token' } });

      gateway.handleConnection(client);

      expect(client.join).toHaveBeenCalledWith('profile:profile-1');
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it('reads the token from the auth cookie when no auth payload is given', () => {
      const client = makeClient({
        headers: { cookie: 'other=1; rabotka_token=jwt-from-cookie' },
      });

      gateway.handleConnection(client);

      expect(jwtService.verify).toHaveBeenCalledWith(
        'jwt-from-cookie',
        expect.anything(),
      );
      expect(client.join).toHaveBeenCalledWith('profile:profile-1');
    });

    it('disconnects a client with no token', () => {
      const client = makeClient();

      gateway.handleConnection(client);

      expect(client.join).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('disconnects a client whose token fails verification', () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('invalid signature');
      });
      const client = makeClient({ auth: { token: 'forged' } });

      gateway.handleConnection(client);

      expect(client.join).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('disconnects admin tokens — they have no ad inbox', () => {
      jwtService.verify.mockReturnValue({ sub: 'user-1', type: 'admin' });
      const client = makeClient({ auth: { token: 'admin-token' } });

      gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe('emitNewAd()', () => {
    it('emits to the profile room', () => {
      const payload = {
        deliveryId: 'dl-1',
        advertisementId: 'ad-1',
        title: 'Promo',
        description: 'Desc',
        imageUrl: null,
        callToAction: null,
        ctaUrl: null,
        tags: ['promo'],
      };

      gateway.emitNewAd('profile-9', payload);

      expect(gateway.server.to).toHaveBeenCalledWith('profile:profile-9');
      expect(emit).toHaveBeenCalledWith('ad:new', payload);
    });
  });
});
