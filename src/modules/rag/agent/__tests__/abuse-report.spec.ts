import { ClaimStatus } from '@prisma/client';
import { ModuleRef } from '@nestjs/core';
import { AbuseReportService } from '../abuse-report.service';
import type { PrismaService } from '../../../../common/services/prisma/prisma.service';
import type { ClaimService } from '../../../claim/claim.service';

/**
 * Le dépôt du signalement.
 *
 * C'est la seule écriture que l'assistant provoque, sur le compte de quelqu'un,
 * et elle est visible par la personne concernée. Chacun de ces points mérite
 * son test : un doublon encombre le support, une description qui juge envenime,
 * et un échec silencieux qui remonte casserait la réponse d'un bot qui doit
 * malgré tout répondre.
 */
function makeService(overrides?: {
  findFirst?: jest.Mock;
  createForProfile?: jest.Mock;
}) {
  const findFirst = overrides?.findFirst ?? jest.fn().mockResolvedValue(null);
  const createForProfile =
    overrides?.createForProfile ?? jest.fn().mockResolvedValue({ id: 'c-1' });

  const prisma = { claim: { findFirst } } as unknown as PrismaService;
  const moduleRef = {
    get: () => ({ createForProfile }) as unknown as ClaimService,
  } as unknown as ModuleRef;

  const service = new AbuseReportService(prisma, moduleRef);
  service.onApplicationBootstrap();
  return { service, findFirst, createForProfile };
}

describe('AbuseReportService', () => {
  it('ouvre une réclamation sur le profil concerné', async () => {
    const { service, createForProfile } = makeService();

    await service.report('profil-1', 'ta gueule');

    const [profileId, dto] = createForProfile.mock.calls[0] as [
      string,
      { title: string; description: string },
    ];
    expect(profileId).toBe('profil-1');
    expect(dto.title).toContain('Signalement automatique');
    expect(dto.description).toContain('ta gueule');
  });

  it("n'envoie pas l'e-mail « votre réclamation a été créée »", async () => {
    // Le dossier est ouvert SUR la personne, pas PAR elle. L'e-mail standard la
    // féliciterait d'avoir déposé son propre signalement.
    const { service, createForProfile } = makeService();

    await service.report('profil-1', 'ta gueule');

    expect(createForProfile.mock.calls[0][2]).toEqual({ notifyProfile: false });
  });

  it('ne dépose rien si un signalement est déjà ouvert', async () => {
    // Sans ça, chaque message abusif au-delà du seuil crée un dossier de plus :
    // le support se retrouve avec quinze réclamations pour un seul échange.
    const { service, createForProfile } = makeService({
      findFirst: jest.fn().mockResolvedValue({ id: 'deja-la' }),
    });

    await service.report('profil-1', 'ta gueule');

    expect(createForProfile).not.toHaveBeenCalled();
  });

  it('ne considère ouvertes que les réclamations non traitées', async () => {
    const { service, findFirst } = makeService();

    await service.report('profil-1', 'ta gueule');

    const where = findFirst.mock.calls[0][0].where as {
      status: { in: ClaimStatus[] };
      created_at: { gte: Date };
      profile_id: string;
    };
    expect(where.status.in).toEqual([
      ClaimStatus.CREATED,
      ClaimStatus.IN_PROGRESS,
    ]);
    expect(where.profile_id).toBe('profil-1');
    // Une fenêtre : un épisode d'il y a six mois ne doit pas bloquer un
    // signalement légitime aujourd'hui.
    expect(where.created_at.gte.getTime()).toBeLessThan(Date.now());
  });

  it('reste factuel : ni jugement, ni conclusion', async () => {
    // La personne lira ce texte. Y mettre « comportement inacceptable » donne à
    // l'équipe une conclusion à la place des faits, et à la personne une raison
    // de plus d'envenimer.
    const { service, createForProfile } = makeService();

    await service.report('profil-1', 'ta gueule');

    const { description } = createForProfile.mock.calls[0][1] as {
      description: string;
    };
    for (const judgement of [
      'inacceptable',
      'agressif',
      'grossier',
      'insupportable',
      'méchant',
    ]) {
      expect(description.toLowerCase()).not.toContain(judgement);
    }
    // Mais il dit qu'un avertissement avait été donné : c'est un fait, et il
    // explique au support pourquoi le dossier existe.
    expect(description).toContain('avertissement');
  });

  it('ne casse pas la réponse quand le dépôt échoue', async () => {
    // Ce service tourne sur le chemin de réponse : la personne doit recevoir
    // son message même si la base refuse le dossier.
    const { service } = makeService({
      createForProfile: jest.fn().mockRejectedValue(new Error('db down')),
    });

    await expect(
      service.report('profil-1', 'ta gueule'),
    ).resolves.toBeUndefined();
  });

  it('ne casse pas non plus si la vérification de doublon échoue', async () => {
    const { service } = makeService({
      findFirst: jest.fn().mockRejectedValue(new Error('db down')),
    });

    await expect(
      service.report('profil-1', 'ta gueule'),
    ).resolves.toBeUndefined();
  });
});
