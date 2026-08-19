import { Logger } from '@nestjs/common';
import { ProfileType, VerificationStatus } from '@prisma/client';
import { VovaService } from '../vova.service';
import { bucketOf } from '../../recommendation-engine/engine-rollout.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

const PROFILE = {
  id: 'p-1',
  first_name: 'Awa',
  profile_type: ProfileType.WORKER,
  verification_status: VerificationStatus.VERIFIED,
};

function makeAgent(text = 'réponse de Vova') {
  return {
    handle: jest.fn().mockResolvedValue({
      text,
      origin: 'agent',
      escalated: false,
      destination: 'jobs',
      sanitizerBlocked: [],
    }),
  };
}

function makeConfig(values: Record<string, string> = {}) {
  return {
    get: jest.fn((key: string, fallback: string) =>
      Promise.resolve(values[key] ?? fallback),
    ),
  };
}

function makeOffers(pending: string | null = null) {
  return {
    remember: jest.fn(() => Promise.resolve()),
    take: jest.fn(() => Promise.resolve(pending)),
  };
}

const build = (
  agent: ReturnType<typeof makeAgent>,
  values?: Record<string, string>,
  offers = makeOffers(),
) =>
  new VovaService(agent as never, makeConfig(values) as never, offers as never);

/** A profile id whose stable bucket is below `percent`. */
function idInBucket(percent: number): string {
  for (let i = 0; i < 500; i++) {
    if (bucketOf(`p-${i}`) < percent) return `p-${i}`;
  }
  throw new Error('no id found');
}

describe('VovaService', () => {
  // The default state of the world: the bot behaves exactly as it did before
  // this module existed.
  it('does nothing when disabled', async () => {
    const agent = makeAgent();
    expect(await build(agent).handle(PROFILE, 'bonjour')).toBeNull();
    expect(agent.handle).not.toHaveBeenCalled();
  });

  it('computes a reply but sends nothing in shadow mode', async () => {
    const agent = makeAgent();
    const service = build(agent, {
      'vova.enabled': 'true',
      'vova.shadow_mode': 'true',
    });

    expect(await service.handle(PROFILE, 'bonjour')).toBeNull();
    // The point of shadow mode: real traffic, real replies, judged on the log.
    expect(agent.handle).toHaveBeenCalledTimes(1);
  });

  it('answers when live and the profile is in the bucket', async () => {
    const agent = makeAgent('Votre solde est de 100 FCFA.');
    const service = build(agent, {
      'vova.enabled': 'true',
      'vova.shadow_mode': 'false',
      'vova.rollout_percent': '100',
    });

    // The answer stands on its own; the card is not forced on the user.
    expect(await service.handle(PROFILE, 'mon solde ?')).toEqual([
      'Votre solde est de 100 FCFA.',
    ]);
  });

  it('stays silent for a profile outside the bucket', async () => {
    const agent = makeAgent();
    const service = build(agent, {
      'vova.enabled': 'true',
      'vova.shadow_mode': 'false',
      'vova.rollout_percent': '0',
    });

    expect(await service.handle(PROFILE, 'bonjour')).toBeNull();
    expect(agent.handle).not.toHaveBeenCalled();
  });

  // A user who gets the assistant must keep getting it — alternating between an
  // agent and a menu across messages is worse than either alone.
  it('buckets stably, so the same profile gets the same treatment', async () => {
    const values = {
      'vova.enabled': 'true',
      'vova.shadow_mode': 'false',
      'vova.rollout_percent': '50',
    };
    const inBucket = { ...PROFILE, id: idInBucket(50) };

    for (let i = 0; i < 5; i++) {
      const result = await build(makeAgent(), values).handle(inBucket, 'salut');
      expect(result).toEqual(['réponse de Vova']);
    }
  });

  it('falls back silently when the agent throws', async () => {
    const agent = { handle: jest.fn().mockRejectedValue(new Error('boom')) };
    const service = build(agent as never, {
      'vova.enabled': 'true',
      'vova.shadow_mode': 'false',
      'vova.rollout_percent': '100',
    });

    expect(await service.handle(PROFILE, 'bonjour')).toBeNull();
  });

  it('falls back when the agent exceeds its budget', async () => {
    const agent = { handle: jest.fn(() => new Promise(() => {})) };
    const service = build(agent as never, {
      'vova.enabled': 'true',
      'vova.shadow_mode': 'false',
      'vova.rollout_percent': '100',
      'vova.timeout_ms': '30',
    });

    expect(await service.handle(PROFILE, 'bonjour')).toBeNull();
  });

  it('falls back when the config lookup itself fails', async () => {
    const config = {
      get: jest.fn().mockRejectedValue(new Error('redis down')),
    };
    const service = new VovaService(
      makeAgent() as never,
      config as never,
      makeOffers() as never,
    );
    expect(await service.handle(PROFILE, 'bonjour')).toBeNull();
  });

  it('treats a nonsense rollout percentage as zero rather than everyone', async () => {
    const agent = makeAgent();
    const service = build(agent, {
      'vova.enabled': 'true',
      'vova.shadow_mode': 'false',
      'vova.rollout_percent': 'beaucoup',
    });

    expect(await service.handle(PROFILE, 'bonjour')).toBeNull();
    expect(agent.handle).not.toHaveBeenCalled();
  });
});

describe('the app card', () => {
  const live = {
    'vova.enabled': 'true',
    'vova.shadow_mode': 'false',
    'vova.rollout_percent': '100',
  };

  // A card on every reply reads as a menu, not a conversation.
  it('is not sent with an ordinary answer', async () => {
    const offers = makeOffers();
    const agent = makeAgent('Rabotka met en relation… Je vous ouvre l’écran ?');
    const replies = await build(agent, live, offers).handle(
      PROFILE,
      "c'est quoi Rabotka ?",
    );

    expect(replies).toHaveLength(1);
    expect(replies?.[0]).not.toContain('[TPL:');
    // …but the destination is remembered, so « oui » can open it.
    expect(offers.remember).toHaveBeenCalledWith('p-1', 'jobs');
  });

  // « Souhaitez-vous savoir à quoi sert ce crédit ? » is a question about
  // content. A yes to it deserves the content, not a link.
  it('remembers nothing when the reply offered no screen', async () => {
    const offers = makeOffers();
    const agent = makeAgent(
      'Vous avez *1 978 FCFA*. Souhaitez-vous savoir à quoi ce crédit peut servir ?',
    );

    await build(agent, live, offers).handle(
      PROFILE,
      'je peux avoir du crédit ?',
    );

    expect(offers.remember).not.toHaveBeenCalled();
  });

  it.each([
    "ouvre l'application",
    "Ouvre moi l'application",
    'montre moi les missions',
    'open the app',
  ])('is sent when the user asks to go there: "%s"', async (text) => {
    const replies = await build(makeAgent(), live).handle(PROFILE, text);

    expect(replies).toHaveLength(2);
    expect(replies?.[1]).toContain('[TPL:welcomePlatform]');
  });

  it('is sent on a bare « oui » after an offer, with no model call', async () => {
    const agent = makeAgent();
    const offers = makeOffers('portefeuille');
    const replies = await build(agent, live, offers).handle(PROFILE, 'oui');

    expect(replies?.[1]).toContain('"1":"portefeuille"');
    expect(agent.handle).not.toHaveBeenCalled();
  });

  it('treats « oui, mais comment ça marche ? » as a question, not an acceptance', async () => {
    const agent = makeAgent();
    const offers = makeOffers('portefeuille');
    await build(agent, live, offers).handle(
      PROFILE,
      'oui mais comment ça marche ?',
    );

    expect(agent.handle).toHaveBeenCalled();
    expect(offers.take).not.toHaveBeenCalled();
  });

  it('ignores a « oui » with nothing pending', async () => {
    const agent = makeAgent();
    const replies = await build(agent, live, makeOffers(null)).handle(
      PROFILE,
      'oui',
    );

    expect(agent.handle).toHaveBeenCalled();
    expect(replies).toHaveLength(1);
  });
});
