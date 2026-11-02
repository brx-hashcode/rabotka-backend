import { Prisma } from '@prisma/client';
import { BusinessContractService } from '../business-contract.service';

function make(application: unknown) {
  const prisma: any = {
    application: { findFirst: jest.fn().mockResolvedValue(application) },
  };
  const contracts: any = {
    create: jest.fn().mockResolvedValue({ id: 'c1' }),
    findByApplication: jest.fn().mockResolvedValue({ id: 'c1' }),
    download: jest.fn().mockResolvedValue({
      buffer: Buffer.from('%PDF'),
      filename: 'contrat.pdf',
    }),
  };
  return {
    service: new BusinessContractService(prisma, contracts),
    prisma,
    contracts,
  };
}

describe('BusinessContractService', () => {
  it('makes the contract if missing and gives its PDF, for the business’s own retained candidate', async () => {
    const { service, prisma, contracts } = make({ id: 'a1', status: 'END' });
    await expect(service.pdf('biz', 'a1')).resolves.toMatchObject({
      filename: 'contrat.pdf',
    });
    expect(prisma.application.findFirst.mock.calls[0][0].where).toEqual({
      id: 'a1',
      job_offer: { employer_id: 'biz' },
    });
    expect(contracts.create).toHaveBeenCalledWith('a1');
    expect(contracts.download).toHaveBeenCalledWith('c1', 'biz');
  });

  it('is not found for another business’s application', async () => {
    const { service, contracts } = make(null);
    await expect(service.pdf('biz', 'a1')).rejects.toThrow(
      'Candidature introuvable.',
    );
    expect(contracts.create).not.toHaveBeenCalled();
  });

  it('waits until the candidate is retained', async () => {
    const { service, contracts } = make({ id: 'a1', status: 'PENDING' });
    await expect(service.pdf('biz', 'a1')).rejects.toThrow(
      /une fois le candidat retenu/,
    );
    expect(contracts.create).not.toHaveBeenCalled();
  });

  it('reads the contract a concurrent click just made', async () => {
    const { service, contracts } = make({ id: 'a1', status: 'ACCEPTED' });
    contracts.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    await service.pdf('biz', 'a1');
    expect(contracts.findByApplication).toHaveBeenCalledWith('a1');
    expect(contracts.download).toHaveBeenCalledWith('c1', 'biz');
  });
});
