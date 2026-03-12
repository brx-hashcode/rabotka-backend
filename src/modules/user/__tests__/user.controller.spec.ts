import { UserController } from '../user.controller';

function makeService() {
  return {
    getList: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    createAdmin: jest.fn().mockResolvedValue({
      id: '1', first_name: 'John', last_name: 'Doe', email: 'j@d.com',
      role: 'ADMIN', is_active: true, created_at: new Date(), updated_at: new Date(),
    }),
    updateAdmin: jest.fn().mockResolvedValue({
      id: '1', first_name: 'John', last_name: 'Doe', email: 'j@d.com',
      role: 'ADMIN', is_active: true, last_login_at: null, created_at: new Date(), updated_at: new Date(),
    }),
    activate: jest.fn().mockResolvedValue({
      id: '1', first_name: 'John', last_name: 'Doe', email: 'j@d.com',
      role: 'ADMIN', is_active: true, last_login_at: null, created_at: new Date(), updated_at: new Date(),
    }),
    deactivate: jest.fn().mockResolvedValue({
      id: '1', first_name: 'John', last_name: 'Doe', email: 'j@d.com',
      role: 'ADMIN', is_active: false, last_login_at: null, created_at: new Date(), updated_at: new Date(),
    }),
    deleteAdmin: jest.fn().mockResolvedValue(undefined),
  };
}

describe('UserController', () => {
  let controller: UserController;
  let service: ReturnType<typeof makeService>;

  beforeEach(() => {
    service = makeService();
    controller = new UserController(service as any);
  });

  it('list() delegates to service.getList', async () => {
    const result = await controller.list({ page: 1, limit: 10 } as any);
    expect(service.getList).toHaveBeenCalledWith({ page: 1, limit: 10 });
    expect(result).toEqual({ data: [], total: 0 });
  });

  it('createAdmin() returns formatted user', async () => {
    const result = await controller.createAdmin({ email: 'j@d.com', password: 'pw', role: 'ADMIN' } as any);
    expect(result).toMatchObject({ id: '1', firstName: 'John', lastName: 'Doe', email: 'j@d.com' });
  });

  it('updateAdmin() returns formatted user', async () => {
    const result = await controller.updateAdmin('1', { email: 'j@d.com' } as any);
    expect(result).toMatchObject({ id: '1', firstName: 'John' });
    expect(service.updateAdmin).toHaveBeenCalledWith('1', { email: 'j@d.com' });
  });

  it('activate() calls service.activate and returns user', async () => {
    const result = await controller.activate('1');
    expect(service.activate).toHaveBeenCalledWith('1');
    expect(result).toMatchObject({ id: '1', isActive: true });
  });

  it('deactivate() calls service.deactivate and returns user', async () => {
    const result = await controller.deactivate('1');
    expect(service.deactivate).toHaveBeenCalledWith('1');
    expect(result).toMatchObject({ id: '1', isActive: false });
  });

  it('deleteAdmin() returns success', async () => {
    const result = await controller.deleteAdmin('1');
    expect(service.deleteAdmin).toHaveBeenCalledWith('1');
    expect(result).toEqual({ success: true });
  });
});
