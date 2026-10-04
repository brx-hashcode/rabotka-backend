import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AgentStatus,
  DocumentType,
  KycDocumentCategory,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { kycBucket } from '../../common/services/storage/kyc-bucket';
import { kycContentKind } from '../../common/services/storage/kyc-key';
import { StorageService } from '../../common/services/storage/storage.service';
import type { DownloadResult } from '../../common/services/storage/types/storage.types';
import { FileService } from '../file/file.service';
import { GeoService } from '../geo/geo.service';
import { LayoutService } from '../mail/layout.service';
import { MailService } from '../mail/mail.service';
import { agentCreatedEmail } from '../mail/templates';
import { SystemConfigService } from '../system-config/system-config.service';
import { toE164 } from '../whatsapp/contracts/address';
import {
  AGENT_AVATAR_FOLDER,
  AGENT_KYC_FOLDER,
  isAgentAvatarKey,
  isAgentKycKey,
  normalizeAgentEmail,
  normalizeIdDocumentNumber,
  requiredKycCategories,
} from './agent-identity';
import type {
  AdminListAgentsDto,
  AgentKycDocumentRefDto,
  AgentZoneDto,
  CreateAgentDto,
  UpdateAgentDto,
} from './dto/admin-agent.dto';

/** How long one logged identity-document view covers further views. */
const KYC_VIEW_LOG_WINDOW_MS = 60 * 60 * 1000;

/** What a canonical E.164 number looks like once `toE164` has run. */
const E164_PATTERN = /^\+\d{8,15}$/;

export type AgentStatusAction = 'suspend' | 'reactivate' | 'revoke';

/**
 * The legal moves, and which ones need a reason. REVOKED is terminal: an agent
 * whose relationship with Rabotka ended is not brought back by a click — a new
 * agent is created instead.
 */
const STATUS_TRANSITIONS: Record<
  AgentStatusAction,
  { from: AgentStatus[]; to: AgentStatus; needsReason: boolean }
> = {
  suspend: {
    from: [AgentStatus.ACTIVE],
    to: AgentStatus.SUSPENDED,
    needsReason: true,
  },
  reactivate: {
    from: [AgentStatus.SUSPENDED],
    to: AgentStatus.ACTIVE,
    needsReason: false,
  },
  revoke: {
    from: [AgentStatus.ACTIVE, AgentStatus.SUSPENDED],
    to: AgentStatus.REVOKED,
    needsReason: true,
  },
};

const ADMIN_AGENT_LIST_SELECT = {
  id: true,
  created_at: true,
  first_name: true,
  last_name: true,
  email: true,
  phone: true,
  avatar_url: true,
  status: true,
  last_login_at: true,
  zones: {
    select: { country_code: true, city: true },
    orderBy: [{ country_code: 'asc' }, { city: 'asc' }],
  },
} as const satisfies Prisma.AgentSelect;

const ADMIN_AGENT_DETAIL_SELECT = {
  ...ADMIN_AGENT_LIST_SELECT,
  updated_at: true,
  id_document_type: true,
  id_document_number: true,
  status_reason: true,
  created_by_user_id: true,
  // Metadata only. The bytes are read through the authenticated stream route;
  // the storage key is read here only to tell an image from a PDF, and never
  // leaves the server.
  kyc_documents: {
    select: {
      id: true,
      document_category: true,
      storage_key: true,
      created_at: true,
      updated_at: true,
    },
    orderBy: { document_category: 'asc' },
  },
} as const satisfies Prisma.AgentSelect;

type AdminAgentListRow = Prisma.AgentGetPayload<{
  select: typeof ADMIN_AGENT_LIST_SELECT;
}>;
type AdminAgentDetailRow = Prisma.AgentGetPayload<{
  select: typeof ADMIN_AGENT_DETAIL_SELECT;
}>;

function toAdminAgentListItem(a: AdminAgentListRow) {
  return {
    id: a.id,
    createdAt: a.created_at,
    firstName: a.first_name,
    lastName: a.last_name,
    email: a.email,
    phone: a.phone,
    avatarUrl: a.avatar_url,
    status: a.status,
    lastLoginAt: a.last_login_at,
    zones: a.zones.map((z) => ({ countryCode: z.country_code, city: z.city })),
  };
}

function toAdminAgentDetail(a: AdminAgentDetailRow) {
  return {
    ...toAdminAgentListItem(a),
    updatedAt: a.updated_at,
    idDocumentType: a.id_document_type,
    idDocumentNumber: a.id_document_number,
    statusReason: a.status_reason,
    createdByUserId: a.created_by_user_id,
    kycDocuments: a.kyc_documents.map((d) => ({
      id: d.id,
      category: d.document_category,
      // The stream route's path carries no extension, so the admin cannot
      // tell an image from a PDF on its own — same reason as for profiles.
      contentKind: kycContentKind(d.storage_key, null),
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    })),
  };
}

/**
 * Everything the back office does to an agent.
 *
 * Files follow the profile onboarding pattern: each is uploaded on its own
 * first (`uploadKycFile` / `uploadAvatar`), and the create or replace call
 * carries only the storage keys it got back. The difference is that the key is
 * all the client ever receives — no signed url for a KYC file is issued, in
 * line with the admin stream route that replaced signed urls for profiles. The
 * admin already holds the file they just picked, so the preview is local.
 */
@Injectable()
export class AdminAgentService {
  private readonly logger = new Logger(AdminAgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileService: FileService,
    private readonly storage: StorageService,
    private readonly systemConfig: SystemConfigService,
    private readonly config: ConfigService,
    private readonly geo: GeoService,
    private readonly mail: MailService,
    private readonly layout: LayoutService,
  ) {}

  // ── Uploads ───────────────────────────────────────────────────────────────

  /**
   * One identity document, into the PRIVATE bucket. Not watermarked, like the
   * profile verification images: it is only ever read by a reviewer through
   * the stream route, and the mark would re-encode the detail they need.
   */
  async uploadKycFile(file: Express.Multer.File): Promise<{ key: string }> {
    if (!file) throw new BadRequestException('Le fichier est requis');
    const result = await this.fileService.uploadToStorage(file, {
      folder: AGENT_KYC_FOLDER,
      access: 'private',
      bucket: await this.kycBucket(),
      watermark: false,
    });
    return { key: result.key };
  }

  async uploadAvatar(
    file: Express.Multer.File,
  ): Promise<{ key: string; url: string }> {
    if (!file) throw new BadRequestException('La photo est requise');
    const result = await this.fileService.uploadToStorage(file, {
      folder: AGENT_AVATAR_FOLDER,
      access: 'public',
    });
    return { key: result.key, url: result.url };
  }

  // ── Create / read / update ────────────────────────────────────────────────

  async create(dto: CreateAgentDto, adminUserId: string) {
    const email = normalizeAgentEmail(dto.email);
    const phone = this.normalizePhone(dto.phone);
    const idDocumentNumber = this.normalizeIdNumber(dto.idDocumentNumber);
    const zones = this.resolveZones(dto.zones);
    const documents = await this.resolveKycDocuments(
      dto.idDocumentType,
      dto.kycDocuments,
    );
    const avatar = dto.avatarKey
      ? await this.resolveAvatar(dto.avatarKey)
      : null;

    let agent: AdminAgentDetailRow;
    try {
      agent = await this.prisma.agent.create({
        data: {
          first_name: dto.firstName,
          last_name: dto.lastName,
          email,
          phone,
          id_document_type: dto.idDocumentType,
          id_document_number: idDocumentNumber,
          avatar_url: avatar?.url ?? null,
          avatar_storage_key: avatar?.key ?? null,
          created_by_user_id: adminUserId,
          zones: { create: zones },
          kyc_documents: {
            create: documents.map((d) => ({
              document_category: d.category,
              storage_key: d.key,
              uploaded_by_user_id: adminUserId,
            })),
          },
        },
        select: ADMIN_AGENT_DETAIL_SELECT,
      });
    } catch (err) {
      throw this.conflictFor(err);
    }

    // Fire-and-forget: the agent exists either way, and a mail outage must not
    // make the admin think the creation failed and create them twice.
    void this.sendWelcome(agent.email, agent.first_name);

    return this.withCreator(agent);
  }

  async list(dto: AdminListAgentsDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const where: Prisma.AgentWhereInput = {
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.q
        ? {
            OR: [
              { first_name: { contains: dto.q, mode: 'insensitive' } },
              { last_name: { contains: dto.q, mode: 'insensitive' } },
              { email: { contains: dto.q, mode: 'insensitive' } },
              { phone: { contains: dto.q.replace(/\s/g, '') } },
            ],
          }
        : {}),
      ...(dto.city
        ? {
            zones: {
              some: { city: { equals: dto.city, mode: 'insensitive' } },
            },
          }
        : {}),
      // Several zones mean "covers any of them". Matched exactly: the options
      // come from `listZones`, i.e. from the stored spellings themselves.
      // Country and city are separate conditions, both required: "in Congo" and
      // "in Brazzaville or Pointe-Noire". Kept in AND so they never overwrite each
      // other or the search OR above.
      AND: [
        ...(dto.country?.length
          ? [{ zones: { some: { country_code: { in: dto.country } } } }]
          : []),
        ...(dto.zone?.length
          ? [
              {
                zones: {
                  some: {
                    OR: dto.zone.map((z) => {
                      const [country_code, ...rest] = z.split(':');
                      return { country_code, city: rest.join(':') };
                    }),
                  },
                },
              },
            ]
          : []),
      ],
    };

    const [total, rows] = await Promise.all([
      this.prisma.agent.count({ where }),
      this.prisma.agent.findMany({
        where,
        select: ADMIN_AGENT_LIST_SELECT,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return { data: rows.map(toAdminAgentListItem), total, page, limit };
  }

  /**
   * Every city at least one agent covers, with how many agents cover it —
   * the options of the list's Zone filter. Revoked agents are left out:
   * filtering on a city nobody can work any more answers nothing.
   */
  async listZones() {
    const rows = await this.prisma.agentZone.findMany({
      where: { agent: { status: { not: AgentStatus.REVOKED } } },
      select: { country_code: true, city: true, agent_id: true },
      orderBy: [{ country_code: 'asc' }, { city: 'asc' }],
    });
    // `agentIds` lets the coverage map count an agent once per department
    // even when they cover several of its cities.
    const byZone = new Map<
      string,
      { countryCode: string; city: string; agentIds: string[] }
    >();
    for (const r of rows) {
      const key = `${r.country_code}:${r.city}`;
      const zone = byZone.get(key) ?? {
        countryCode: r.country_code,
        city: r.city,
        agentIds: [],
      };
      zone.agentIds.push(r.agent_id);
      byZone.set(key, zone);
    }
    return [...byZone.values()].map((z) => ({
      ...z,
      agents: z.agentIds.length,
    }));
  }

  async getDetail(id: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      select: ADMIN_AGENT_DETAIL_SELECT,
    });
    if (!agent) throw new NotFoundException('Agent introuvable');
    return this.withCreator(agent);
  }

  /**
   * The detail, plus who created the agent — by name, which is what an admin
   * reads. A bare id, like `Profile.verified_by`, so it is looked up here; an
   * archived admin still resolves, a purged one shows as unknown.
   */
  private async withCreator(agent: AdminAgentDetailRow) {
    const creator = await this.prisma.user.findUnique({
      where: { id: agent.created_by_user_id },
      select: { first_name: true, last_name: true },
    });
    return {
      ...toAdminAgentDetail(agent),
      createdByName: creator
        ? `${creator.first_name} ${creator.last_name}`.trim()
        : null,
    };
  }

  async update(id: string, dto: UpdateAgentDto) {
    await this.assertExists(id);

    const data: Prisma.AgentUpdateInput = {
      ...(dto.firstName !== undefined ? { first_name: dto.firstName } : {}),
      ...(dto.lastName !== undefined ? { last_name: dto.lastName } : {}),
      ...(dto.email !== undefined
        ? { email: normalizeAgentEmail(dto.email) }
        : {}),
      ...(dto.phone !== undefined
        ? { phone: this.normalizePhone(dto.phone) }
        : {}),
    };
    const zones = dto.zones ? this.resolveZones(dto.zones) : null;

    try {
      const agent = await this.prisma.$transaction(async (tx) => {
        if (zones) {
          await tx.agentZone.deleteMany({ where: { agent_id: id } });
          await tx.agentZone.createMany({
            data: zones.map((z) => ({ ...z, agent_id: id })),
          });
        }
        return tx.agent.update({
          where: { id },
          data,
          select: ADMIN_AGENT_DETAIL_SELECT,
        });
      });
      return this.withCreator(agent);
    } catch (err) {
      throw this.conflictFor(err);
    }
  }

  /**
   * A conditional update, so two admins clicking at once cannot both act on
   * the same starting status — the second finds nothing to move.
   */
  async setStatus(id: string, action: AgentStatusAction, reason?: string) {
    const rule = STATUS_TRANSITIONS[action];
    const trimmed = reason?.trim() || null;
    if (rule.needsReason && !trimmed) {
      throw new BadRequestException('Un motif est requis');
    }

    const { count } = await this.prisma.agent.updateMany({
      where: { id, status: { in: rule.from } },
      data: {
        status: rule.to,
        status_reason: rule.to === AgentStatus.ACTIVE ? null : trimmed,
      },
    });

    if (count === 0) {
      const current = await this.prisma.agent.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!current) throw new NotFoundException('Agent introuvable');
      throw new ConflictException(
        `Action impossible : l'agent est déjà ${current.status}`,
      );
    }

    return this.getDetail(id);
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  async replaceAvatar(id: string, avatarKey: string) {
    const previous = await this.prisma.agent.findUnique({
      where: { id },
      select: { avatar_storage_key: true },
    });
    if (!previous) throw new NotFoundException('Agent introuvable');

    const avatar = await this.resolveAvatar(avatarKey);
    await this.prisma.agent.update({
      where: { id },
      data: { avatar_url: avatar.url, avatar_storage_key: avatar.key },
    });

    // After the row points at the new file, never before: a failed update
    // must not leave the agent with no picture at all.
    const oldKey = previous.avatar_storage_key;
    if (oldKey && oldKey !== avatar.key) {
      await this.storage
        .delete(oldKey)
        .catch((err: unknown) =>
          this.logger.warn(`Old agent avatar ${oldKey} not deleted`, err),
        );
    }

    return this.getDetail(id);
  }

  /**
   * Replaces one identity document.
   *
   * The superseded object is NOT deleted: StorageService.delete addresses the
   * default (public) bucket only, and this one lives in the private bucket. It
   * stays private and unreferenced until storage grows a bucket-aware delete.
   */
  async replaceKycDocument(
    id: string,
    category: KycDocumentCategory,
    key: string,
    adminUserId: string,
  ) {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      select: { id_document_type: true },
    });
    if (!agent) throw new NotFoundException('Agent introuvable');

    if (!requiredKycCategories(agent.id_document_type).includes(category)) {
      throw new BadRequestException(
        `Le document ${category} ne s'applique pas à une pièce de type ${agent.id_document_type}`,
      );
    }
    await this.assertKycObject(key);

    await this.prisma.agentKycDocument.upsert({
      where: {
        idx_agent_kyc_document_category: {
          agent_id: id,
          document_category: category,
        },
      },
      create: {
        agent_id: id,
        document_category: category,
        storage_key: key,
        uploaded_by_user_id: adminUserId,
      },
      update: { storage_key: key, uploaded_by_user_id: adminUserId },
    });

    return this.getDetail(id);
  }

  /**
   * Whether this admin has no AGENT_KYC_VIEWED entry for this agent in the
   * last hour — the window the controller dedupes document-view logs on.
   */
  async isNewKycViewWindow(agentId: string, userId: string): Promise<boolean> {
    const recent = await this.prisma.log.findFirst({
      where: {
        action: 'AGENT_KYC_VIEWED',
        entity_type: 'Agent',
        entity_id: agentId,
        user_id: userId,
        created_at: { gte: new Date(Date.now() - KYC_VIEW_LOG_WINDOW_MS) },
      },
      select: { id: true },
    });
    return !recent;
  }

  async streamKycDocument(
    agentId: string,
    documentId: string,
  ): Promise<DownloadResult & { filename: string }> {
    const doc = await this.prisma.agentKycDocument.findFirst({
      where: { id: documentId, agent_id: agentId },
      select: { storage_key: true, document_category: true },
    });
    if (!doc) throw new NotFoundException('Document introuvable.');

    const downloaded = await this.fileService.download(
      doc.storage_key,
      await this.kycBucket(),
    );
    const ext = doc.storage_key.split('.').pop();
    return {
      ...downloaded,
      filename: `agent-${doc.document_category.toLowerCase()}.${ext}`,
    };
  }

  // ── Validation helpers ────────────────────────────────────────────────────

  private normalizePhone(raw: string): string {
    const phone = toE164(raw);
    if (!E164_PATTERN.test(phone)) {
      throw new BadRequestException(
        "Numéro de téléphone invalide : indiquez l'indicatif pays (ex. +242…)",
      );
    }
    return phone;
  }

  private normalizeIdNumber(raw: string): string {
    const value = normalizeIdDocumentNumber(raw);
    if (!value) {
      throw new BadRequestException('Numéro de pièce invalide');
    }
    return value;
  }

  /**
   * Canonical city spelling (GeoService), so a zone compares equal to the
   * `JobOffer.city` written through the same service. Duplicates collapse.
   */
  private resolveZones(
    zones: AgentZoneDto[],
  ): { country_code: string; city: string }[] {
    const out = new Map<string, { country_code: string; city: string }>();
    for (const z of zones) {
      const resolved = this.geo.resolveLocation({
        countryCode: z.countryCode,
        city: z.city,
      });
      const zone = {
        country_code: resolved.country_code!,
        city: resolved.city!,
      };
      out.set(`${zone.country_code}:${zone.city.toLowerCase()}`, zone);
    }
    return [...out.values()];
  }

  /**
   * The full set for this document type — no more, no less, one per category —
   * each a key this module issued, and each actually present in the private
   * bucket. A key the client invented, or one naming another folder, never
   * reaches a row.
   */
  private async resolveKycDocuments(
    documentType: DocumentType,
    refs: AgentKycDocumentRefDto[],
  ): Promise<AgentKycDocumentRefDto[]> {
    const required = requiredKycCategories(documentType);
    const seen = new Set<KycDocumentCategory>();

    for (const ref of refs) {
      if (seen.has(ref.category)) {
        throw new BadRequestException(`Document ${ref.category} en double`);
      }
      if (!required.includes(ref.category)) {
        throw new BadRequestException(
          `Le document ${ref.category} ne s'applique pas à une pièce de type ${documentType}`,
        );
      }
      seen.add(ref.category);
    }

    const missing = required.filter((c) => !seen.has(c));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Pièces d'identité manquantes : ${missing.join(', ')}`,
      );
    }

    for (const ref of refs) await this.assertKycObject(ref.key);
    return refs;
  }

  private async assertKycObject(key: string): Promise<void> {
    if (!isAgentKycKey(key)) {
      throw new BadRequestException('Référence de fichier invalide');
    }
    const exists = await this.fileService.exists(key, await this.kycBucket());
    if (!exists) {
      throw new BadRequestException(
        'Fichier introuvable : téléversez-le à nouveau',
      );
    }
  }

  private async resolveAvatar(
    key: string,
  ): Promise<{ key: string; url: string }> {
    if (!isAgentAvatarKey(key)) {
      throw new BadRequestException('Référence de photo invalide');
    }
    if (!(await this.fileService.exists(key))) {
      throw new BadRequestException(
        'Photo introuvable : téléversez-la à nouveau',
      );
    }
    // Derived from the key, never taken from the client: a url field would let
    // a request point an agent's avatar anywhere on the internet.
    const url = await this.storage.getUrl(key, { access: 'public' });
    return { key, url };
  }

  private kycBucket(): Promise<string> {
    return kycBucket(this.systemConfig, this.config);
  }

  private async assertExists(id: string): Promise<void> {
    const found = await this.prisma.agent.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Agent introuvable');
  }

  /** P2002 → a 409 that says which field collided; anything else rethrown. */
  private conflictFor(err: unknown): unknown {
    if (
      !(err instanceof Prisma.PrismaClientKnownRequestError) ||
      err.code !== 'P2002'
    ) {
      return err;
    }
    // The whole meta, not just `target`: with the pg driver adapter the
    // constraint's fields can arrive nested under `driverAdapterError` rather
    // than as `target`, and this has to name the field either way.
    const target = JSON.stringify(err.meta ?? {});
    if (target.includes('email')) {
      return new ConflictException('Un agent utilise déjà cet email');
    }
    if (target.includes('phone')) {
      return new ConflictException('Un agent utilise déjà ce numéro');
    }
    if (target.includes('id_document')) {
      return new ConflictException(
        'Un agent est déjà enregistré avec cette pièce d’identité',
      );
    }
    return new ConflictException('Cet agent existe déjà');
  }

  private async sendWelcome(email: string, firstName: string): Promise<void> {
    try {
      await this.mail.sendMail({
        to: email,
        subject: 'Votre compte agent Rabotka',
        html: await this.layout.wrap(agentCreatedEmail(firstName), {
          previewText: 'Votre compte agent Rabotka a été créé',
        }),
      });
    } catch (err) {
      this.logger.warn(`Agent welcome email to ${email} failed`, err);
    }
  }
}
