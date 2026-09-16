import { ProfileNotificationsGateway } from '../profile-notifications.gateway';

describe('ProfileNotificationsGateway', () => {
  let jwt: { verify: jest.Mock };
  let config: { get: jest.Mock };
  let gateway: ProfileNotificationsGateway;

  const socket = (over: Record<string, unknown> = {}) => ({
    id: 's-1',
    handshake: { auth: {}, headers: {} },
    join: jest.fn(),
    disconnect: jest.fn(),
    ...over,
  });

  beforeEach(() => {
    jwt = { verify: jest.fn() };
    config = {
      get: jest.fn((key: string) =>
        key === 'AUTH_COOKIE_NAME' ? 'rabotka_auth' : 'secret',
      ),
    };
    gateway = new ProfileNotificationsGateway(jwt as never, config as never);
  });

  it('rejects a connection with no token', () => {
    const client = socket();
    gateway.handleConnection(client as never);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('rejects an admin token', () => {
    jwt.verify.mockReturnValue({ sub: 'u-1', type: 'admin' });
    const client = socket({
      handshake: { auth: { token: 't' }, headers: {} },
    });
    gateway.handleConnection(client as never);
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('joins the profile room from the auth cookie', () => {
    jwt.verify.mockReturnValue({ sub: 'p-1', type: 'profile' });
    const client = socket({
      handshake: { auth: {}, headers: { cookie: 'a=b; rabotka_auth=tok' } },
    });
    gateway.handleConnection(client as never);
    expect(jwt.verify).toHaveBeenCalledWith('tok', { secret: 'secret' });
    expect(client.join).toHaveBeenCalledWith('profile:p-1');
  });

  it('emits to the recipient room, and tolerates having no server', () => {
    expect(() => gateway.emitNew('p-1', {} as never)).not.toThrow();

    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    gateway.server = { to } as never;
    gateway.emitNew('p-1', { id: 'n-1' } as never);

    expect(to).toHaveBeenCalledWith('profile:p-1');
    expect(emit).toHaveBeenCalledWith('notification:new', { id: 'n-1' });
  });
});
