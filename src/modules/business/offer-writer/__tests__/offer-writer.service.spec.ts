import { ForbiddenException } from '@nestjs/common';
import { GeoService } from '../../../geo/geo.service';
import { OfferWriterService } from '../offer-writer.service';

const draftJson = JSON.stringify({
  facts: { city: 'Pointe-Noire', employmentType: 'CDD' },
  title: 'Agent d’entretien',
  tasks: ['Nettoyer', 'Ranger', 'Vider les corbeilles', 'Laver les vitres'],
  skills: ['Utiliser les produits', 'Entretenir le matériel'],
  categoryName: 'Nettoyage',
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
    service: new OfferWriterService(
      prisma,
      llm,
      subscriptions,
      new GeoService(),
    ),
    llm,
    subscriptions,
  };
}

describe('OfferWriterService', () => {
  it('writes the draft on one of the plan’s drafts, with the trade’s id', async () => {
    const { service, llm, subscriptions } = make();
    llm.invoke.mockResolvedValue({ output: { content: draftJson } });

    await expect(
      service.draft('p1', {
        brief: 'agent pour nos bureaux à Pointe-Noire au Congo, CDD',
        city: 'Kinshasa',
      }),
    ).resolves.toMatchObject({
      title: 'Agent d’entretien',
      categoryId: 'c1',
      employmentType: 'CDD',
      // As the form's pickers list it.
      place: { remote: false, city: 'Pointe-Noire', countryCode: 'CG' },
      changes: [{ field: 'place', from: 'Kinshasa', to: 'Pointe-Noire' }],
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

  it('asks once more for what the offer forgot, and keeps the better one', async () => {
    const brief = 'agent à Pointe-Noire, permis B exigé';
    const full = JSON.stringify({
      ...JSON.parse(draftJson),
      skills: ['Conduire', { text: 'Permis B', required: true }],
    });
    const { service, llm } = make();
    llm.invoke
      .mockResolvedValueOnce({ output: { content: draftJson } })
      .mockResolvedValueOnce({ output: { content: full } });
    const d = await service.draft('p1', { brief });
    expect(d.description).toContain('- Permis B : obligatoire');
    expect(llm.invoke.mock.calls[1][0].at(-1).content).toContain('permis B');

    // Nothing better: the first one, and it counts as any other.
    for (const second of ['Bien sûr !', new Error('down')]) {
      const m = make();
      m.llm.invoke.mockResolvedValueOnce({ output: { content: draftJson } });
      if (second instanceof Error) m.llm.invoke.mockRejectedValueOnce(second);
      else m.llm.invoke.mockResolvedValueOnce({ output: { content: second } });
      const kept = await m.service.draft('p1', { brief });
      expect(kept.title).toBe('Agent d’entretien');
      expect(m.llm.invoke).toHaveBeenCalledTimes(2);
      expect(m.subscriptions.releaseOfferDraft).not.toHaveBeenCalled();
    }
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
