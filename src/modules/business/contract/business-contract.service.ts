import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApplicationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { ContractService } from '../../contract/contract.service';

/** Where a contract exists: the candidate was retained, then worked. */
const HIRED: ApplicationStatus[] = [
  ApplicationStatus.ACCEPTED,
  ApplicationStatus.STARTED,
  ApplicationStatus.END,
];

/**
 * The contract of a candidate the business retained, as a PDF. The contract
 * is made when the candidate is retained, but in the background: one that is
 * missing (the background step failed, or older data) is made here, so the
 * business always gets its document.
 */
@Injectable()
export class BusinessContractService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ContractService,
  ) {}

  async pdf(profileId: string, applicationId: string) {
    const application = await this.prisma.application.findFirst({
      where: { id: applicationId, job_offer: { employer_id: profileId } },
      select: { id: true, status: true },
    });
    if (!application) throw new NotFoundException('Candidature introuvable.');
    if (!HIRED.includes(application.status)) {
      throw new BadRequestException(
        'Le contrat est disponible une fois le candidat retenu.',
      );
    }
    const contract = await this.contractOf(application.id);
    return this.contracts.download(contract.id, profileId);
  }

  /** Two clicks at once can't make two contracts: the second reads the first. */
  private async contractOf(applicationId: string) {
    try {
      return await this.contracts.create(applicationId);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.contracts.findByApplication(applicationId);
        if (existing) return existing;
      }
      throw err;
    }
  }
}
