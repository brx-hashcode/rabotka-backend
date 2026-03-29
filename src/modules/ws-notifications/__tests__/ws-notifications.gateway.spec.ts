import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WsNotificationsGateway } from '../ws-notifications.gateway';

function makeClient(overrides: {
  cookie?: string;
  authorization?: string;
  auth?: Record<string, string>;
} = {}) {
  return {
    id: 'socket-1',
    handshake: {
      headers: {
        cookie: overrides.cookie,
        authorization: overrides.authorization,
      },
      auth: overrides.auth ?? {},
    },
    join: jest.fn(),
    disconnect: jest.fn(),
  } as any;
}

describe('WsNotificationsGateway', () => {
  let gateway: WsNotificationsGateway;
  let jwtService: jest.Mocked<JwtService>;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(() => {
    jwtService = {
      verify: jest.fn(),
    } as unknown as jest.Mocked<JwtService>;

    configService = {
      get: jest.fn().mockImplementation((key: string, fallback?: unknown) => {
        const map: Record<string, unknown> = {
          AUTH_COOKIE_NAME: 'auth-token',
          JWT_SECRET: 'test-secret',
        };
        return map[key] ?? fallback;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    const redis = {} as any;
    gateway = new WsNotificationsGateway(configService, jwtService, redis);
  });

  describe('handleConnection', () => {
    it('accepts admin with valid cookie token and joins admins room', () => {
      jwtService.verify.mockReturnValue({ sub: 'admin-1', type: 'admin' } as any);
      const client = makeClient({ cookie: 'auth-token=valid-jwt; other=val' });

      gateway.handleConnection(client);

      expect(jwtService.verify).toHaveBeenCalledWith('valid-jwt', { secret: 'test-secret' });
      expect(client.join).toHaveBeenCalledWith('admins');
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it('accepts admin with Bearer authorization header', () => {
      jwtService.verify.mockReturnValue({ sub: 'admin-2', type: 'admin' } as any);
      const client = makeClient({ authorization: 'Bearer my-token' });

      gateway.handleConnection(client);

      expect(jwtService.verify).toHaveBeenCalledWith('my-token', { secret: 'test-secret' });
      expect(client.join).toHaveBeenCalledWith('admins');
    });

    it('accepts admin with handshake auth token', () => {
      jwtService.verify.mockReturnValue({ sub: 'admin-3', type: 'admin' } as any);
      const client = makeClient({ auth: { token: 'raw-token' } });

      gateway.handleConnection(client);

      expect(jwtService.verify).toHaveBeenCalledWith('raw-token', { secret: 'test-secret' });
      expect(client.join).toHaveBeenCalledWith('admins');
    });

    it('disconnects client with no token', () => {
      const client = makeClient();

      gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.join).not.toHaveBeenCalled();
    });

    it('disconnects non-admin user', () => {
      jwtService.verify.mockReturnValue({ sub: 'profile-1', type: 'profile' } as any);
      const client = makeClient({ cookie: 'auth-token=profile-jwt' });

      gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.join).not.toHaveBeenCalled();
    });

    it('disconnects client with invalid token', () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('invalid');
      });
      const client = makeClient({ cookie: 'auth-token=bad-jwt' });

      gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('handles cookie with = in value', () => {
      jwtService.verify.mockReturnValue({ sub: 'admin-4', type: 'admin' } as any);
      const client = makeClient({ cookie: 'auth-token=abc=def=ghi' });

      gateway.handleConnection(client);

      expect(jwtService.verify).toHaveBeenCalledWith('abc=def=ghi', { secret: 'test-secret' });
      expect(client.join).toHaveBeenCalledWith('admins');
    });
  });

  describe('handleDisconnect', () => {
    it('does not throw', () => {
      const client = makeClient();
      expect(() => gateway.handleDisconnect(client)).not.toThrow();
    });
  });
});
