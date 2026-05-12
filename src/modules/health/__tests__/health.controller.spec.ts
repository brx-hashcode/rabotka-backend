import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from '../health.controller';
import { HealthCheckService } from '@nestjs/terminus';
import { MemoryHealthIndicator, DiskHealthIndicator } from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';
import { HealthService } from '../health.service';

describe('HealthController', () => {
  let controller: HealthController;
  let healthCheck: jest.Mocked<HealthCheckService>;
  let memory: jest.Mocked<MemoryHealthIndicator>;
  let disk: jest.Mocked<DiskHealthIndicator>;
  let config: jest.Mocked<ConfigService>;
  let healthService: jest.Mocked<HealthService>;

  const mockCheckResult = {
    status: 'ok',
    info: {},
    error: {},
    details: {},
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthCheckService,
          useValue: {
            check: jest.fn().mockResolvedValue(mockCheckResult),
          },
        },
        {
          provide: MemoryHealthIndicator,
          useValue: {
            checkHeap: jest
              .fn()
              .mockResolvedValue({ memory_heap: { status: 'up' } }),
            checkRSS: jest
              .fn()
              .mockResolvedValue({ memory_rss: { status: 'up' } }),
          },
        },
        {
          provide: DiskHealthIndicator,
          useValue: {
            checkStorage: jest
              .fn()
              .mockResolvedValue({ disk: { status: 'up' } }),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string, def: any) => def),
          },
        },
        {
          provide: HealthService,
          useValue: {
            formatResponse: jest.fn().mockReturnValue(mockCheckResult),
          },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
    healthCheck = module.get(HealthCheckService);
    memory = module.get(MemoryHealthIndicator);
    disk = module.get(DiskHealthIndicator);
    config = module.get(ConfigService);
    healthService = module.get(HealthService);
  });

  it('is defined', () => {
    expect(controller).toBeDefined();
  });

  it('returns health check result', async () => {
    const result = await controller.check();
    expect(result).toEqual(mockCheckResult);
    expect(healthCheck.check).toHaveBeenCalled();
    expect(healthService.formatResponse).toHaveBeenCalledWith(mockCheckResult);
  });

  it('includes memory heap check', async () => {
    await controller.check();
    const [healthFns] = (healthCheck.check as jest.Mock).mock.calls[0];
    expect(Array.isArray(healthFns)).toBe(true);
    expect(healthFns.length).toBeGreaterThanOrEqual(1);
    await healthFns[0]();
    expect(memory.checkHeap).toHaveBeenCalledWith(
      'memory_heap',
      150 * 1024 * 1024,
    );
    expect(memory.checkRSS).not.toHaveBeenCalled();
  });

  it('includes disk check when HEALTH_DISK_CHECK_ENABLED is "true"', async () => {
    (config.get as jest.Mock).mockImplementation((key: string, def: any) => {
      if (key === 'HEALTH_DISK_CHECK_ENABLED') return 'true';
      return def;
    });
    await controller.check();
    const [healthFns] = (healthCheck.check as jest.Mock).mock.calls[0];
    expect(healthFns.length).toBe(2);
    await healthFns[1]();
    expect(disk.checkStorage).toHaveBeenCalled();
  });

  it('skips disk check when HEALTH_DISK_CHECK_ENABLED is "false"', async () => {
    (config.get as jest.Mock).mockImplementation((key: string, def: any) => {
      if (key === 'HEALTH_DISK_CHECK_ENABLED') return 'false';
      return def;
    });
    await controller.check();
    const [healthFns] = (healthCheck.check as jest.Mock).mock.calls[0];
    expect(healthFns.length).toBe(1);
    expect(disk.checkStorage).not.toHaveBeenCalled();
  });
});
