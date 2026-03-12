import { Test, TestingModule } from '@nestjs/testing';
import { CsrfController } from '../csrf.controller';
import { CSRF_UTILITIES } from '../csrf.constants';

describe('CsrfController', () => {
  let controller: CsrfController;
  const mockGenerateCsrfToken = jest.fn().mockReturnValue('mock-csrf-token');

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CsrfController],
      providers: [
        {
          provide: CSRF_UTILITIES,
          useValue: { generateCsrfToken: mockGenerateCsrfToken },
        },
      ],
    }).compile();

    controller = module.get<CsrfController>(CsrfController);
  });

  afterEach(() => jest.clearAllMocks());

  it('is defined', () => {
    expect(controller).toBeDefined();
  });

  it('returns csrfToken from csrfUtilities.generateCsrfToken', () => {
    const req = {} as any;
    const res = {} as any;
    const result = controller.getCsrfToken(req, res);
    expect(result).toEqual({ csrfToken: 'mock-csrf-token' });
    expect(mockGenerateCsrfToken).toHaveBeenCalledWith(req, res);
  });
});
