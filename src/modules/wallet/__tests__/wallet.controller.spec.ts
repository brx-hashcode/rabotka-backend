import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { WalletController } from '../wallet.controller';

function makeService() {
  return {
    getSystemRevenue: jest
      .fn()
      .mockResolvedValue({ totalRevenue: 1000, balance: 1000 }),
  };
}

function makePrisma(role: string | null) {
  return {
    user: {
      findUnique: jest.fn().mockResolvedValue(role ? { role } : null),
    },
  };
}

function makeReq(userId = 'user-1') {
  return { user: { userId } };
}

describe('WalletController', () => {
  it('returns revenue for ADMIN role', async () => {
    const controller = new WalletController(
      makeService() as any,
      makePrisma('ADMIN') as any,
    );
    const result = await controller.getRevenue(makeReq() as any);
    expect(result).toEqual({ totalRevenue: 1000, balance: 1000 });
  });

  it('returns revenue for SUPER_ADMIN role', async () => {
    const controller = new WalletController(
      makeService() as any,
      makePrisma('SUPER_ADMIN') as any,
    );
    const result = await controller.getRevenue(makeReq() as any);
    expect(result).toEqual({ totalRevenue: 1000, balance: 1000 });
  });

  it('throws ForbiddenException for non-admin role', async () => {
    const controller = new WalletController(
      makeService() as any,
      makePrisma('VIEWER') as any,
    );
    await expect(controller.getRevenue(makeReq() as any)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('throws ForbiddenException when user not found', async () => {
    const controller = new WalletController(
      makeService() as any,
      makePrisma(null) as any,
    );
    await expect(controller.getRevenue(makeReq() as any)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('getMonthlyRevenue with rollingMonths param', async () => {
    const service = {
      ...makeService(),
      getMonthlyRevenueRollingMonths: jest.fn().mockResolvedValue([]),
      getMonthlyRevenueForCalendarYear: jest.fn().mockResolvedValue([]),
    };
    const controller = new WalletController(service as any, makePrisma('ADMIN') as any);
    await controller.getMonthlyRevenue(makeReq() as any, undefined, '6');
    expect(service.getMonthlyRevenueRollingMonths).toHaveBeenCalledWith(6);
  });

  it('getMonthlyRevenue with year param', async () => {
    const service = {
      ...makeService(),
      getMonthlyRevenueRollingMonths: jest.fn().mockResolvedValue([]),
      getMonthlyRevenueForCalendarYear: jest.fn().mockResolvedValue([]),
    };
    const controller = new WalletController(service as any, makePrisma('ADMIN') as any);
    await controller.getMonthlyRevenue(makeReq() as any, '2026');
    expect(service.getMonthlyRevenueForCalendarYear).toHaveBeenCalledWith(2026);
  });

  it('getMonthlyRevenue throws BadRequestException for invalid rollingMonths', async () => {
    const service = { ...makeService() };
    const controller = new WalletController(service as any, makePrisma('ADMIN') as any);
    // BadRequestException is already imported
    await expect(controller.getMonthlyRevenue(makeReq() as any, undefined, 'invalid')).rejects.toThrow(BadRequestException);
  });

  it('getMonthlyRevenue throws BadRequestException for invalid year', async () => {
    const service = { ...makeService() };
    const controller = new WalletController(service as any, makePrisma('ADMIN') as any);
    // BadRequestException is already imported
    await expect(controller.getMonthlyRevenue(makeReq() as any, 'invalid')).rejects.toThrow(BadRequestException);
  });

  it('listTransactions returns paginated data', async () => {
    const service = {
      ...makeService(),
      listTransactionsForAdmin: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
    };
    const controller = new WalletController(service as any, makePrisma('ADMIN') as any);
    const result = await controller.listTransactions(makeReq() as any, {});
    expect(service.listTransactionsForAdmin).toHaveBeenCalledWith(expect.objectContaining({ page: 1, limit: 20 }));
    expect(result.total).toBe(0);
  });

  it('listPayments returns paginated data', async () => {
    const service = {
      ...makeService(),
      listPaymentsForAdmin: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
    };
    const controller = new WalletController(service as any, makePrisma('ADMIN') as any);
    const result = await controller.listPayments(makeReq() as any, {});
    expect(service.listPaymentsForAdmin).toHaveBeenCalled();
    expect(result.total).toBe(0);
  });

  it('listTransactions throws ForbiddenException for non-admin', async () => {
    const service = { ...makeService(), listTransactionsForAdmin: jest.fn() };
    const controller = new WalletController(service as any, makePrisma('VIEWER') as any);
    // ForbiddenException is already imported
    await expect(controller.listTransactions(makeReq() as any, {})).rejects.toThrow(ForbiddenException);
  });
});
