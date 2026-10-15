import {
  ForbiddenException,
  BadRequestException,
  BadGatewayException,
  ConflictException,
} from '@nestjs/common';
import { WalletController, balanceCountryChoices } from '../wallet.controller';

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
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
    );
    const result = await controller.getRevenue(makeReq() as any, {});
    expect(result).toEqual({ totalRevenue: 1000, balance: 1000 });
  });

  it('forwards the date window to the service', async () => {
    const service = makeService();
    const controller = new WalletController(
      service as any,
      makePrisma('FINANCE') as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
    );
    const dto = { created_from: '2026-09-01', created_to: '2026-09-30' };
    await controller.getRevenue(makeReq() as any, dto);
    expect(service.getSystemRevenue).toHaveBeenCalledWith(dto);
  });

  it('returns revenue for SUPER_ADMIN role', async () => {
    const controller = new WalletController(
      makeService() as any,
      makePrisma('SUPER_ADMIN') as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
    );
    const result = await controller.getRevenue(makeReq() as any, {});
    expect(result).toEqual({ totalRevenue: 1000, balance: 1000 });
  });

  it('throws ForbiddenException for non-admin role', async () => {
    const controller = new WalletController(
      makeService() as any,
      makePrisma('VIEWER') as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
    );
    await expect(controller.getRevenue(makeReq() as any, {})).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('throws ForbiddenException when user not found', async () => {
    const controller = new WalletController(
      makeService() as any,
      makePrisma(null) as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
    );
    await expect(controller.getRevenue(makeReq() as any, {})).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('getMonthlyRevenue with rollingMonths param', async () => {
    const service = {
      ...makeService(),
      getMonthlyRevenueRollingMonths: jest.fn().mockResolvedValue([]),
      getMonthlyRevenueForCalendarYear: jest.fn().mockResolvedValue([]),
    };
    const controller = new WalletController(
      service as any,
      makePrisma('ADMIN') as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
    );
    await controller.getMonthlyRevenue(makeReq() as any, undefined, '6');
    expect(service.getMonthlyRevenueRollingMonths).toHaveBeenCalledWith(6);
  });

  it('getMonthlyRevenue with year param', async () => {
    const service = {
      ...makeService(),
      getMonthlyRevenueRollingMonths: jest.fn().mockResolvedValue([]),
      getMonthlyRevenueForCalendarYear: jest.fn().mockResolvedValue([]),
    };
    const controller = new WalletController(
      service as any,
      makePrisma('ADMIN') as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
    );
    await controller.getMonthlyRevenue(makeReq() as any, '2026');
    expect(service.getMonthlyRevenueForCalendarYear).toHaveBeenCalledWith(2026);
  });

  it('getMonthlyRevenue throws BadRequestException for invalid rollingMonths', async () => {
    const service = { ...makeService() };
    const controller = new WalletController(
      service as any,
      makePrisma('ADMIN') as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
    );
    // BadRequestException is already imported
    await expect(
      controller.getMonthlyRevenue(makeReq() as any, undefined, 'invalid'),
    ).rejects.toThrow(BadRequestException);
  });

  it('getMonthlyRevenue throws BadRequestException for invalid year', async () => {
    const service = { ...makeService() };
    const controller = new WalletController(
      service as any,
      makePrisma('ADMIN') as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
    );
    // BadRequestException is already imported
    await expect(
      controller.getMonthlyRevenue(makeReq() as any, 'invalid'),
    ).rejects.toThrow(BadRequestException);
  });

  it('listTransactions returns paginated data', async () => {
    const service = {
      ...makeService(),
      listTransactionsForAdmin: jest
        .fn()
        .mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
    };
    const controller = new WalletController(
      service as any,
      makePrisma('ADMIN') as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
    );
    const result = await controller.listTransactions(makeReq() as any, {});
    expect(service.listTransactionsForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, limit: 20 }),
    );
    expect(result.total).toBe(0);
  });

  it('listPayments returns paginated data', async () => {
    const service = {
      ...makeService(),
      listPaymentsForAdmin: jest
        .fn()
        .mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
    };
    const controller = new WalletController(
      service as any,
      makePrisma('ADMIN') as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
    );
    const result = await controller.listPayments(makeReq() as any, {});
    expect(service.listPaymentsForAdmin).toHaveBeenCalled();
    expect(result.total).toBe(0);
  });

  it('listTransactions throws ForbiddenException for non-admin', async () => {
    const service = { ...makeService(), listTransactionsForAdmin: jest.fn() };
    const controller = new WalletController(
      service as any,
      makePrisma('VIEWER') as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
    );
    // ForbiddenException is already imported
    await expect(
      controller.listTransactions(makeReq() as any, {}),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('gateway balances', () => {
  const countries = [
    { code: 'CMR', name: 'Cameroun' },
    { code: 'COG', name: 'Congo' },
  ];

  function makeGateway(over: Record<string, unknown> = {}) {
    return {
      supportsBalances: jest.fn().mockReturnValue(true),
      listBalanceCountries: jest.fn().mockResolvedValue(countries),
      getBalances: jest
        .fn()
        .mockResolvedValue([
          { country: 'COG', currency: 'XAF', balance: '1500.00' },
        ]),
      ...over,
    };
  }

  const controllerWith = (gateway: unknown, role = 'FINANCE') =>
    new WalletController(
      makeService() as any,
      makePrisma(role) as any,
      {} as any,
      {} as any,
      gateway as any,
    );

  describe('balanceCountryChoices', () => {
    it('puts COG first and makes it the default', () => {
      expect(balanceCountryChoices(countries)).toEqual({
        countries: [
          { code: 'COG', name: 'Congo' },
          { code: 'CMR', name: 'Cameroun' },
        ],
        default: 'COG',
      });
    });

    it('defaults to the first country when the account has no COG', () => {
      expect(
        balanceCountryChoices([{ code: 'CMR', name: 'Cameroun' }]).default,
      ).toBe('CMR');
    });

    it('offers COG alone when the list is unknown', () => {
      expect(balanceCountryChoices([])).toEqual({
        countries: [{ code: 'COG', name: 'Congo' }],
        default: 'COG',
      });
    });
  });

  it('lists every country the account has, COG first', async () => {
    const res = await controllerWith(makeGateway()).getGatewayBalanceCountries(
      makeReq() as any,
    );
    expect(res.countries.map((c) => c.code)).toEqual(['COG', 'CMR']);
    expect(res.default).toBe('COG');
  });

  it('falls back to COG when the gateway cannot list countries', async () => {
    const gateway = makeGateway({
      listBalanceCountries: jest.fn().mockRejectedValue(new Error('down')),
    });
    const res = await controllerWith(gateway).getGatewayBalanceCountries(
      makeReq() as any,
    );
    expect(res).toEqual({
      countries: [{ code: 'COG', name: 'Congo' }],
      default: 'COG',
    });
  });

  it('reads COG by default', async () => {
    const gateway = makeGateway();
    const res = await controllerWith(gateway).getGatewayBalances(
      makeReq() as any,
    );
    expect(gateway.getBalances).toHaveBeenCalledWith('COG');
    expect(res.country).toBe('COG');
  });

  it('reads the chosen country, case-insensitively', async () => {
    const gateway = makeGateway();
    await controllerWith(gateway).getGatewayBalances(makeReq() as any, ' cmr ');
    expect(gateway.getBalances).toHaveBeenCalledWith('CMR');
  });

  it.each(['XX', 'ZMB'])(
    'refuses %s (invalid or not on the account)',
    async (country) => {
      await expect(
        controllerWith(makeGateway()).getGatewayBalances(
          makeReq() as any,
          country,
        ),
      ).rejects.toThrow(BadRequestException);
    },
  );

  it('answers 409 when the active gateway reports no balances', async () => {
    const gateway = makeGateway({
      supportsBalances: jest.fn().mockReturnValue(false),
    });
    await expect(
      controllerWith(gateway).getGatewayBalances(makeReq() as any),
    ).rejects.toThrow(ConflictException);
  });

  it('answers 502 when the gateway is unreachable', async () => {
    const gateway = makeGateway({
      getBalances: jest.fn().mockRejectedValue(new Error('down')),
    });
    await expect(
      controllerWith(gateway).getGatewayBalances(makeReq() as any),
    ).rejects.toThrow(BadGatewayException);
  });

  it('keeps balances to the wallet roles', async () => {
    await expect(
      controllerWith(makeGateway(), 'MANAGER').getGatewayBalances(
        makeReq() as any,
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
