import { AdminExternalApplicationsController } from '../admin-external-applications.controller';

jest.mock('../../../profile/send-private-file', () => ({
  sendPrivateFile: jest.fn(),
}));

describe('AdminExternalApplicationsController', () => {
  const careers = {
    listForAdmin: jest
      .fn()
      .mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
    cvFileForAdmin: jest.fn().mockResolvedValue({
      body: 'x',
      contentType: 'application/pdf',
      filename: 'cv.pdf',
    }),
  };
  const logs = { create: jest.fn().mockResolvedValue(undefined) };
  const controller = new AdminExternalApplicationsController(
    careers as any,
    logs as any,
  );

  beforeEach(() => jest.clearAllMocks());

  it('lists with defaults and passes the filters on', async () => {
    await controller.list({
      q: 'Awa',
      status: ['PENDING'],
      employerId: 'p-1',
    } as any);
    expect(careers.listForAdmin).toHaveBeenCalledWith({
      page: 1,
      limit: 20,
      q: 'Awa',
      status: ['PENDING'],
      jobOfferId: undefined,
      employerId: 'p-1',
    });
  });

  it('logs every CV an admin opens', async () => {
    await controller.cv(
      'e-1',
      { user: { userId: 'admin-1' } } as any,
      {} as any,
    );
    expect(careers.cvFileForAdmin).toHaveBeenCalledWith('e-1');
    expect(logs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'EXTERNAL_APPLICATION_CV_VIEWED',
        entityId: 'e-1',
        userId: 'admin-1',
      }),
    );
  });
});
