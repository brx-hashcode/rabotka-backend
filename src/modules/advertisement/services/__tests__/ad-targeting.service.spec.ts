import { Test, TestingModule } from '@nestjs/testing';
import { AdTargetingService } from '../ad-targeting.service';
import { PrismaService } from '../../../../common/services/prisma/prisma.service';

const mockProfiles = [
  {
    id: 'p-1',
    first_name: 'Alice',
    last_name: 'Smith',
    email: 'alice@test.com',
    phone: '+242001',
    whatsapp_connected: true,
  },
];

const mockPrisma = {
  $queryRaw: jest.fn(),
};

describe('AdTargetingService', () => {
  let service: AdTargetingService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdTargetingService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<AdTargetingService>(AdTargetingService);
  });

  const makeAd = (audience: string) => ({
    id: 'ad-1',
    bundle: { max_reach: 100, target_audience: audience },
  });

  it('resolves WORKER audience', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([]) // no excluded
      .mockResolvedValueOnce(mockProfiles);
    const result = await service.resolveRecipients(makeAd('WORKER'));
    expect(result).toEqual(mockProfiles);
  });

  it('resolves EMPLOYER audience', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(mockProfiles);
    const result = await service.resolveRecipients(makeAd('EMPLOYER'));
    expect(result).toEqual(mockProfiles);
  });

  it('resolves ALL audience', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(mockProfiles);
    const result = await service.resolveRecipients(makeAd('ALL'));
    expect(result).toEqual(mockProfiles);
  });

  it('excludes already sent profiles', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ profile_id: 'p-already' }]) // excluded
      .mockResolvedValueOnce(mockProfiles);
    const result = await service.resolveRecipients(makeAd('WORKER'));
    expect(result).toEqual(mockProfiles);
  });
});
