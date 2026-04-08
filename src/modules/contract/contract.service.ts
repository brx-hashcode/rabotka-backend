import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { DocumentService } from '../document/document.service';
import { DocumentCategory } from '@prisma/client';

export type ContractItem = {
  id: string;
  applicationId: string;
  templateVersion: number;
  status: string;
  createdAt: string;
};

@Injectable()
export class ContractService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentService: DocumentService,
  ) {}

  async create(applicationId: string): Promise<ContractItem> {
    const existing = await this.prisma.contract.findUnique({
      where: { application_id: applicationId },
    });
    if (existing) {
      return this.mapContract(existing);
    }

    const contract = await this.prisma.contract.create({
      data: { application_id: applicationId },
    });
    return this.mapContract(contract);
  }

  async download(contractId: string, requestingProfileId: string): Promise<{ buffer: Buffer; filename: string }> {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      include: {
        application: {
          include: {
            job_offer: { include: { employer: true } },
            worker: true,
          },
        },
      },
    });

    if (!contract) throw new NotFoundException('Contract not found');

    const { application } = contract;
    const isWorker = application.worker_id === requestingProfileId;
    const isEmployer = application.job_offer.employer_id === requestingProfileId;
    if (!isWorker && !isEmployer) {
      throw new ForbiddenException('Not authorized to access this contract');
    }

    // Find the active CONTRACT template
    const template = await this.prisma.document.findFirst({
      where: { category: DocumentCategory.CONTRACT },
      orderBy: { created_at: 'desc' },
    });
    if (!template) throw new NotFoundException('No CONTRACT template found');

    const job = application.job_offer;
    const worker = application.worker;
    const employer = application.job_offer.employer;

    const data: Record<string, string> = {
      CONTRACT_ID: contract.id,
      WORKER_FIRST_NAME: worker.first_name,
      WORKER_LAST_NAME: worker.last_name,
      WORKER_EMAIL: worker.email,
      WORKER_PHONE: worker.phone,
      EMPLOYER_FIRST_NAME: employer.first_name,
      EMPLOYER_LAST_NAME: employer.last_name,
      EMPLOYER_EMAIL: employer.email,
      EMPLOYER_PHONE: employer.phone,
      JOB_TITLE: job.title,
      JOB_DESCRIPTION: job.description,
      JOB_ADDRESS: job.address,
      JOB_AMOUNT: job.amount.toString(),
      JOB_PAYMENT_FLOW: job.payment_flow,
      JOB_DATE: new Date(job.scheduled_at).toLocaleDateString('fr-FR'),
      GENERATED_DATE: new Date().toLocaleDateString('fr-FR'),
    };

    const buffer = await this.documentService.fillDocumentTemplateAsPdf(template.id, data);

    // Mark as downloaded
    await this.prisma.contract.update({
      where: { id: contractId },
      data: { status: 'DOWNLOADED' },
    });

    const filename = `contrat_${worker.last_name}_${job.title.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    return { buffer, filename };
  }

  async downloadAsAdmin(contractId: string): Promise<{ buffer: Buffer; filename: string }> {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      include: {
        application: {
          include: {
            job_offer: { include: { employer: true } },
            worker: true,
          },
        },
      },
    });

    if (!contract) throw new NotFoundException('Contract not found');

    const template = await this.prisma.document.findFirst({
      where: { category: DocumentCategory.CONTRACT },
      orderBy: { created_at: 'desc' },
    });
    if (!template) throw new NotFoundException('No CONTRACT template found');

    const { application } = contract;
    const job = application.job_offer;
    const worker = application.worker;
    const employer = application.job_offer.employer;

    const data: Record<string, string> = {
      CONTRACT_ID: contract.id,
      WORKER_FIRST_NAME: worker.first_name,
      WORKER_LAST_NAME: worker.last_name,
      WORKER_EMAIL: worker.email,
      WORKER_PHONE: worker.phone,
      EMPLOYER_FIRST_NAME: employer.first_name,
      EMPLOYER_LAST_NAME: employer.last_name,
      EMPLOYER_EMAIL: employer.email,
      EMPLOYER_PHONE: employer.phone,
      JOB_TITLE: job.title,
      JOB_DESCRIPTION: job.description,
      JOB_ADDRESS: job.address,
      JOB_AMOUNT: job.amount.toString(),
      JOB_PAYMENT_FLOW: job.payment_flow,
      JOB_DATE: new Date(job.scheduled_at).toLocaleDateString('fr-FR'),
      GENERATED_DATE: new Date().toLocaleDateString('fr-FR'),
    };

    const buffer = await this.documentService.fillDocumentTemplateAsPdf(template.id, data);
    const filename = `contrat_${worker.last_name}_${job.title.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    return { buffer, filename };
  }

  async findByApplication(applicationId: string): Promise<ContractItem | null> {
    const contract = await this.prisma.contract.findUnique({
      where: { application_id: applicationId },
    });
    return contract ? this.mapContract(contract) : null;
  }

  private mapContract(c: any): ContractItem {
    return {
      id: c.id,
      applicationId: c.application_id,
      templateVersion: c.template_version,
      status: c.status,
      createdAt: c.created_at.toISOString(),
    };
  }
}
