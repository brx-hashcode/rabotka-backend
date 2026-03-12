import { PrismaService } from '../prisma.service';
import { ConfigService } from '@nestjs/config';

jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(function (this: any) {
    this.$connect = jest.fn().mockResolvedValue(undefined);
    this.$disconnect = jest.fn().mockResolvedValue(undefined);
  }),
}));

describe('PrismaService', () => {
  let connectMock: jest.Mock;
  let disconnectMock: jest.Mock;

  function createService(databaseUrl?: string): PrismaService {
    const configService = databaseUrl
      ? ({
          get: (key: string) =>
            key === 'DATABASE_URL' ? databaseUrl : undefined,
        } as any)
      : null;
    const service = new PrismaService(configService);
    connectMock = service.$connect as jest.Mock;
    disconnectMock = service.$disconnect as jest.Mock;
    return service;
  }

  it('creates without configService', () => {
    expect(() => createService()).not.toThrow();
  });

  it('creates with configService providing DATABASE_URL', () => {
    expect(() =>
      createService('postgresql://user:pass@localhost:5432/testdb'),
    ).not.toThrow();
  });

  it('calls $connect on onModuleInit', async () => {
    const service = createService();
    await service.onModuleInit();
    expect(connectMock).toHaveBeenCalled();
  });

  it('calls $disconnect on onModuleDestroy', async () => {
    const service = createService();
    await service.onModuleDestroy();
    expect(disconnectMock).toHaveBeenCalled();
  });

  it('uses process.env.DATABASE_URL when configService returns undefined', () => {
    process.env.DATABASE_URL = 'postgresql://env:env@localhost:5432/envdb';
    const configService = { get: () => undefined } as any as ConfigService;
    expect(() => new PrismaService(configService)).not.toThrow();
    delete process.env.DATABASE_URL;
  });
});
