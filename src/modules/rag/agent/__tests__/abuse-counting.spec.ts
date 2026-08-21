import { MessageDirection } from '@prisma/client';
import { VovaHistoryService } from '../history.service';
import type { PrismaService } from '../../../../common/services/prisma/prisma.service';

/**
 * Le comptage des récidives, et la course qu'il a fallu fermer.
 *
 * L'écriture du message entrant est lancée EN PARALLÈLE de l'agent
 * (`conversation.service.ts`). Le compteur lisait donc un historique qui
 * contenait parfois déjà le message en cours de traitement, et `prefilter`
 * ajoutait encore 1 par-dessus : le signalement partait à la deuxième insulte
 * au lieu de la troisième, une fois sur deux. Un compteur qui décide d'ouvrir
 * une réclamation sur le compte de quelqu'un ne peut pas dépendre de qui gagne
 * une course.
 */
function makeHistory(rows: Array<{ body: string }>) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const prisma = { message: { findMany } } as unknown as PrismaService;
  return { service: new VovaHistoryService(prisma), findMany };
}

describe('priorInboundTexts', () => {
  it('exclut les messages trop récents pour être antérieurs', async () => {
    const { service, findMany } = makeHistory([]);

    await service.priorInboundTexts('p-1');

    const where = findMany.mock.calls[0][0].where as {
      direction: MessageDirection;
      created_at: { lt: Date };
    };
    expect(where.direction).toBe(MessageDirection.INBOUND);
    // Le message courant a moins d'une seconde ; la borne est dans le passé.
    expect(where.created_at.lt.getTime()).toBeLessThan(Date.now() - 5000);
  });

  it('ne lit que les messages entrants', async () => {
    // Une insulte citée par l'assistant dans sa propre réponse ne doit pas
    // compter comme une récidive de la personne.
    const { service, findMany } = makeHistory([]);
    await service.priorInboundTexts('p-1');
    expect(
      (findMany.mock.calls[0][0].where as { direction: MessageDirection })
        .direction,
    ).toBe(MessageDirection.INBOUND);
  });

  it('écarte les cartes de template et les corps vides', async () => {
    const { service } = makeHistory([
      { body: '[TPL:kycRejected]' },
      { body: '   ' },
      { body: 'bonjour' },
    ]);

    await expect(service.priorInboundTexts('p-1')).resolves.toEqual([
      'bonjour',
    ]);
  });

  it('compte zéro quand la base ne répond pas', async () => {
    // Le bon sens de l'erreur : la panne accorde un avertissement de plus, elle
    // ne déclenche pas un signalement.
    const findMany = jest.fn().mockRejectedValue(new Error('db down'));
    const prisma = { message: { findMany } } as unknown as PrismaService;

    await expect(
      new VovaHistoryService(prisma).priorInboundTexts('p-1'),
    ).resolves.toEqual([]);
  });
});
