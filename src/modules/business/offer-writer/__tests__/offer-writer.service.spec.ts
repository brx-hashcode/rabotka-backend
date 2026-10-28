import { ForbiddenException } from '@nestjs/common';
import { OfferWriterService } from '../offer-writer.service';

const draftJson = JSON.stringify({
  title: 'Agent d’entretien',
  description: 'Missions :\n- Nettoyer les bureaux',
  categoryName: 'Nettoyage',
  employmentType: 'CDD',
  removed: [],
});

function make() {
  const prisma: any = {
    business: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ name: 'ZuaFood', category: 'RESTAURATION' }),
    },
    jobCategory: {
      findMany: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Nettoyage' }]),
    },
  };
  const llm: any = { invoke: jest.fn() };
  const subscriptions: any = {
    businessOf: jest.fn().mockResolvedValue('b1'),
    consumeOfferDraft: jest.fn().mockResolvedValue({ subscriptionId: 's1' }),
    releaseOfferDraft: jest.fn().mockResolvedValue(undefined),
    entitlements: jest.fn().mockResolvedValue({ offerDraftsRemaining: 19 }),
  };
  return {
    service: new OfferWriterService(prisma, llm, subscriptions),
    llm,
    subscriptions,
  };
}

describe('OfferWriterService', () => {
  it('writes the draft on one of the plan’s drafts, with the trade’s id', async () => {
    const { service, llm, subscriptions } = make();
    llm.invoke.mockResolvedValue({ output: { content: draftJson } });

    await expect(
      service.draft('p1', { brief: 'agent pour nos bureaux' }),
    ).resolves.toMatchObject({
      title: 'Agent d’entretien',
      categoryId: 'c1',
      employmentType: 'CDD',
      remaining: 19,
    });
    expect(subscriptions.consumeOfferDraft).toHaveBeenCalledWith('b1');
    expect(subscriptions.releaseOfferDraft).not.toHaveBeenCalled();
  });

  it('asks once more when the first answer is not the JSON', async () => {
    const { service, llm } = make();
    llm.invoke
      .mockResolvedValueOnce({ output: { content: 'Bien sûr !' } })
      .mockResolvedValueOnce({ output: { content: draftJson } });
    await expect(
      service.draft('p1', { brief: 'agent' }),
    ).resolves.toMatchObject({
      title: 'Agent d’entretien',
    });
    expect(llm.invoke).toHaveBeenCalledTimes(2);
  });

  it('gives the draft back when nothing could be written', async () => {
    const { service, llm, subscriptions } = make();
    llm.invoke.mockRejectedValue(new Error('chain exhausted'));
    await expect(service.draft('p1', { brief: 'agent' })).rejects.toThrow(
      /pas décomptée/,
    );
    expect(subscriptions.releaseOfferDraft).toHaveBeenCalledWith('s1');
  });

  it('stops at the plan before calling the model', async () => {
    const { service, llm, subscriptions } = make();
    subscriptions.consumeOfferDraft.mockRejectedValue(
      new ForbiddenException('plus de rédactions'),
    );
    await expect(service.draft('p1', { brief: 'agent' })).rejects.toThrow(
      'plus de rédactions',
    );
    expect(llm.invoke).not.toHaveBeenCalled();
  });
});
