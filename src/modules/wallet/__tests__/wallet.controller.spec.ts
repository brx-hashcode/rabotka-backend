import { ForbiddenException } from '@nestjs/common';
import { WalletController } from '../wallet.controller';

function makeService() {
  return { getSystemRevenue: jest.fn().mockResolvedValue({ totalRevenue: 1000, balance: 1000 }) };
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
    const controller = new WalletController(makeService() as any, makePrisma('ADMIN') as any);
    const result = await controller.getRevenue(makeReq() as any);
    expect(result).toEqual({ totalRevenue: 1000, balance: 1000 });
  });

  it('returns revenue for SUPER_ADMIN role', async () => {
    const controller = new WalletController(makeService() as any, makePrisma('SUPER_ADMIN') as any);
    const result = await controller.getRevenue(makeReq() as any);
    expect(result).toEqual({ totalRevenue: 1000, balance: 1000 });
  });

  it('throws ForbiddenException for non-admin role', async () => {
    const controller = new WalletController(makeService() as any, makePrisma('VIEWER') as any);
    await expect(controller.getRevenue(makeReq() as any)).rejects.toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when user not found', async () => {
    const controller = new WalletController(makeService() as any, makePrisma(null) as any);
    await expect(controller.getRevenue(makeReq() as any)).rejects.toThrow(ForbiddenException);
  });
});
