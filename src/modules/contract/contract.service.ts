import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { DocumentService } from '../document/document.service';
import { DocumentCategory, PaymentFlow } from '@prisma/client';
import {
  computeContractPublicReference,
  resolveMissionPeriodForContractPdf,
  paymentFlowPayModeFr,
  paymentFlowFrequencyFr,
} from './contract-template.helpers';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../common/services/redis/redis.constants';

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
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
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

  async download(
    contractId: string,
    requestingProfileId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const contract = await this.loadContractForPdf(contractId);

    const { application } = contract;
    const isWorker = application.worker_id === requestingProfileId;
    const isEmployer =
      application.job_offer.employer_id === requestingProfileId;
    if (!isWorker && !isEmployer) {
      throw new ForbiddenException('Not authorized to access this contract');
    }

    const template = await this.prisma.document.findFirst({
      where: { category: DocumentCategory.CONTRACT },
      orderBy: { created_at: 'desc' },
    });
    if (!template) throw new NotFoundException('No CONTRACT template found');

    const job = application.job_offer;
    const worker = application.worker;
    const filename = `contrat_${worker.last_name}_${job.title.replaceAll(/[^a-zA-Z0-9]/g, '_')}.pdf`;

    const cacheKey = `${REDIS_KEY_PREFIX}pdf:contract:${contractId}:${template.id}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return { buffer: Buffer.from(cached, 'base64'), filename };

    const data = this.buildContractTemplateData(contract);
    const buffer = await this.documentService.fillDocumentTemplateAsPdf(
      template.id,
      data,
    );

    await Promise.all([
      this.redis.set(cacheKey, buffer.toString('base64')),
      this.prisma.contract.update({
        where: { id: contractId },
        data: { status: 'DOWNLOADED' },
      }),
    ]);

    return { buffer, filename };
  }

  async downloadAsAdmin(
    contractId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const contract = await this.loadContractForPdf(contractId);

    const template = await this.prisma.document.findFirst({
      where: { category: DocumentCategory.CONTRACT },
      orderBy: { created_at: 'desc' },
    });
    if (!template) throw new NotFoundException('No CONTRACT template found');

    const job = contract.application.job_offer;
    const worker = contract.application.worker;
    const filename = `contrat_${worker.last_name}_${job.title.replaceAll(/[^a-zA-Z0-9]/g, '_')}.pdf`;

    const cacheKey = `${REDIS_KEY_PREFIX}pdf:contract:${contractId}:${template.id}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return { buffer: Buffer.from(cached, 'base64'), filename };

    const data = this.buildContractTemplateData(contract);
    const buffer = await this.documentService.fillDocumentTemplateAsPdf(
      template.id,
      data,
    );

    await this.redis.set(cacheKey, buffer.toString('base64'));
    return { buffer, filename };
  }

  async findByApplication(applicationId: string): Promise<ContractItem | null> {
    const contract = await this.prisma.contract.findUnique({
      where: { application_id: applicationId },
    });
    return contract ? this.mapContract(contract) : null;
  }

  private async loadContractForPdf(contractId: string) {
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
    return contract;
  }

  /**
   * MONTHLY: END_DATE = contract.created_at (acceptance proxy) + 30 UTC calendar days.
   * Other payment flows: END from scheduled_at + note-based duration (or 1 day).
   */
  private buildContractTemplateData(contract: {
    id: string;
    created_at: Date;
    application: {
      job_offer: {
        title: string;
        description: string;
        address: string;
        amount: { toString(): string } | null;
        payment_flow: PaymentFlow | null;
        scheduled_at: Date;
        note: string | null;
        employer: {
          first_name: string;
          last_name: string;
          email: string;
          phone: string;
        };
      };
      worker: {
        first_name: string;
        last_name: string;
        email: string;
        phone: string;
      };
    };
  }): Record<string, string> {
    const s = (v: string | null | undefined) => v ?? '-';
    const job = contract.application.job_offer;
    const worker = contract.application.worker;
    const employer = job.employer;

    const publicId = computeContractPublicReference({
      contractId: contract.id,
      createdAt: contract.created_at,
    });
    const period = resolveMissionPeriodForContractPdf({
      scheduledAt: job.scheduled_at ? new Date(job.scheduled_at) : null,
      contractCreatedAt: contract.created_at,
      paymentFlow: job.payment_flow,
      jobNote: job.note,
    });
    const startStr = period.startDate
      ? period.startDate.toLocaleDateString('fr-FR')
      : '-';
    const endStr = period.endDate
      ? period.endDate.toLocaleDateString('fr-FR')
      : '-';

    const amountFormatted =
      job.amount == null ? '-' : Number(job.amount).toLocaleString('fr-FR');

    const employerName =
      `${employer.first_name} ${employer.last_name}`.trim() || '-';
    const workerFullname =
      `${worker.first_name} ${worker.last_name}`.trim() || '-';

    return {
      CONTRACT_ID: publicId,
      CONTRACT_UUID: contract.id,
      START_DATE: startStr,
      END_DATE: endStr,
      DURATION: period.durationLabel,
      EMPLOYER_NAME: employerName,
      EMPLOYER_PHONE: s(employer.phone),
      EMPLOYER_EMAIL: s(employer.email),
      WORKER_FULLNAME: workerFullname,
      WORKER_PHONE: s(worker.phone),
      WORKER_EMAIL: s(worker.email),
      JOB_TITLE: s(job.title),
      JOB_DESCRIPTION: s(job.description),
      JOB_LOCATION: s(job.address),
      PAY_MODE: paymentFlowPayModeFr(job.payment_flow),
      PAY_FREQUENCY: paymentFlowFrequencyFr(job.payment_flow),
      AMOUNT: amountFormatted,
      WORKER_FIRST_NAME: s(worker.first_name),
      WORKER_LAST_NAME: s(worker.last_name),
      EMPLOYER_FIRST_NAME: s(employer.first_name),
      EMPLOYER_LAST_NAME: s(employer.last_name),
      JOB_ADDRESS: s(job.address),
      JOB_AMOUNT: job.amount == null ? '-' : job.amount.toString(),
      JOB_PAYMENT_FLOW: s(job.payment_flow),
      JOB_DATE: startStr,
      GENERATED_DATE: contract.created_at.toLocaleDateString('fr-FR'),
    };
  }

  private mapContract(c: {
    id: string;
    application_id: string;
    template_version: number;
    status: string;
    created_at: Date;
  }): ContractItem {
    return {
      id: c.id,
      applicationId: c.application_id,
      templateVersion: c.template_version,
      status: c.status,
      createdAt: c.created_at.toISOString(),
    };
  }
}
