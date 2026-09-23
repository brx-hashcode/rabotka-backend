import { Logger } from '@nestjs/common';
import { AccountStatus, ProfileType, VerificationStatus } from '@prisma/client';
import { VovaService } from '../vova.service';
import { bucketOf } from '../../recommendation-engine/engine-rollout.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

const PROFILE = {
  id: 'p-1',
  first_name: 'Awa',
  profile_type: ProfileType.WORKER,
  verification_status: VerificationStatus.VERIFIED,
  status: AccountStatus.ACTIVE,
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
    handleAnonymous: jest.fn().mockResolvedValue({
      text,
      origin: 'agent',
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

function makeAnonymous(
  over: Partial<{
    history: jest.Mock;
    remember: jest.Mock;
    consume: jest.Mock;
    consumeWalled: jest.Mock;
  }> = {},
) {
  return {
    history: jest.fn(() => Promise.resolve([])),
    remember: jest.fn(() => Promise.resolve()),
    consume: jest.fn(() => Promise.resolve(true)),
    consumeWalled: jest.fn(() => Promise.resolve(true)),
    ...over,
  };
}

/** Memory refresh is fire-and-forget after the reply — it must never be awaited
 *  by the turn, so the default stub simply resolves. */
function makeMemory(over: Record<string, unknown> = {}) {
  return { refresh: jest.fn(() => Promise.resolve()), ...over };
}

const build = (
  agent: ReturnType<typeof makeAgent>,
  values?: Record<string, string>,
  offers = makeOffers(),
  anonymous = makeAnonymous(),
  memory = makeMemory(),
) =>
  new VovaService(
    agent as never,
    makeConfig(values) as never,
    offers as never,
    anonymous as never,
    memory as never,
  );

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
    expect(await build(agent).handle(PROFILE, 'comment ca marche')).toBeNull();
    expect(agent.handle).not.toHaveBeenCalled();
  });

  it('computes a reply but sends nothing in shadow mode', async () => {
    const agent = makeAgent();
    const service = build(agent, {
      'vova.enabled': 'true',
      'vova.shadow_mode': 'true',
    });

    expect(await service.handle(PROFILE, 'comment ca marche')).toBeNull();
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

    expect(await service.handle(PROFILE, 'comment ca marche')).toBeNull();
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
      const result = await build(makeAgent(), values).handle(
        inBucket,
        'comment ca marche',
      );
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

    expect(await service.handle(PROFILE, 'comment ca marche')).toBeNull();
  });

  it('falls back when the agent exceeds its budget', async () => {
    const agent = { handle: jest.fn(() => new Promise(() => {})) };
    const service = build(agent as never, {
      'vova.enabled': 'true',
      'vova.shadow_mode': 'false',
      'vova.rollout_percent': '100',
      'vova.timeout_ms': '30',
    });

    expect(await service.handle(PROFILE, 'comment ca marche')).toBeNull();
  });

  it('falls back when the config lookup itself fails', async () => {
    const config = {
      get: jest.fn().mockRejectedValue(new Error('redis down')),
    };
    const service = new VovaService(
      makeAgent() as never,
      config as never,
      makeOffers() as never,
      makeAnonymous() as never,
      makeMemory() as never,
    );
    expect(await service.handle(PROFILE, 'comment ca marche')).toBeNull();
  });

  it('treats a nonsense rollout percentage as zero rather than everyone', async () => {
    const agent = makeAgent();
    const service = build(agent, {
      'vova.enabled': 'true',
      'vova.shadow_mode': 'false',
      'vova.rollout_percent': 'beaucoup',
    });

    expect(await service.handle(PROFILE, 'comment ca marche')).toBeNull();
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
    // Free-form, NOT the approved template. Meta bills MARKETING wherever it
    // lands, and this card is always a reply — so inside the 24h window, where
    // a free-form message costs nothing. The template stays as the fallback
    // for a job that drains after the window has shut.
    expect(replies?.[1]).toContain('[CTA:]');
    expect(replies?.[1]).not.toContain('[TPL:');
    expect(replies?.[1]).toContain('"fallbackText"');
  });

  it('is sent on a bare « oui » after an offer, with no model call', async () => {
    const agent = makeAgent();
    const offers = makeOffers('portefeuille');
    const replies = await build(agent, live, offers).handle(PROFILE, 'oui');

    // The destination now rides on the card's own `path` rather than on a
    // fallback template's variables — which is the more direct assertion.
    expect(replies?.[1]).toContain('"path":"portefeuille"');
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

/**
 * The unregistered path.
 *
 * Every "no" here must produce `null`, because `null` is what makes the caller
 * send the signup card — the behaviour a stranger got before any of this
 * existed. A bug that returned a string instead would put a generated reply in
 * front of someone the assistant was switched off for.
 */
describe('VovaService.handleAnonymous', () => {
  const ON = { 'vova.enabled': 'true', 'vova.anonymous_enabled': 'true' };

  it('answers a stranger when both switches are on', async () => {
    const agent = makeAgent('Rabotka met en relation…');
    const service = build(agent, ON);

    expect(
      await service.handleAnonymous('+242060000001', 'c’est quoi Rabotka ?'),
      // `offerAccount` is true on every real answer now: a stranger's only next
      // step is creating an account, and the bot staples the card that does it.
      // The prompt used to end each reply with « Tapez */compte* » — same
      // frequency, one tap instead of a typed command.
    ).toEqual({ text: 'Rabotka met en relation…', offerAccount: true });
  });

  it('stays silent when only the master switch is on', async () => {
    // The assistant answering registered users must not imply it answers
    // strangers: that is a separate decision with a separate risk.
    const agent = makeAgent();
    const service = build(agent, { 'vova.enabled': 'true' });

    expect(
      await service.handleAnonymous('+242060000001', 'comment ca marche ?'),
    ).toBeNull();
    expect(agent.handleAnonymous).not.toHaveBeenCalled();
  });

  it('stays silent when the master switch is off, even if anonymous is on', async () => {
    const agent = makeAgent();
    const service = build(agent, { 'vova.anonymous_enabled': 'true' });

    expect(
      await service.handleAnonymous('+242060000001', 'comment ca marche ?'),
    ).toBeNull();
    expect(agent.handleAnonymous).not.toHaveBeenCalled();
  });

  it('says so when the daily allowance is spent, instead of going quiet', async () => {
    // Silently falling back to the card was indistinguishable from the
    // assistant being switched off: the conversation simply stopped answering,
    // which reads as a fault rather than a limit. A limit you are told about is
    // a reason to open an account.
    const agent = makeAgent();
    const anonymous = makeAnonymous({
      consume: jest.fn(() => Promise.resolve(false)),
    });
    const service = build(agent, ON, makeOffers(), anonymous);

    const reply = await service.handleAnonymous('+242060000001', 'et donc ?');

    expect(reply?.offerAccount).toBe(true);
    expect(reply?.text).toMatch(/compte/i);
    expect(agent.handleAnonymous).not.toHaveBeenCalled();
  });

  it('passes the stored turns to the agent and records the exchange', async () => {
    const past = [{ role: 'user' as const, text: 'c’est quoi Rabotka ?' }];
    const anonymous = makeAnonymous({
      history: jest.fn(() => Promise.resolve(past)),
    });
    const agent = makeAgent('Oui, exactement.');
    const service = build(agent, ON, makeOffers(), anonymous);

    await service.handleAnonymous('+242060000001', 'oui');

    expect(agent.handleAnonymous).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'oui', history: past }),
    );
    expect(anonymous.remember).toHaveBeenCalledWith(
      '+242060000001',
      'oui',
      'Oui, exactement.',
    );
  });

  it('falls back to the card when the agent throws', async () => {
    const agent = makeAgent();
    agent.handleAnonymous.mockRejectedValue(new Error('providers down'));
    const service = build(agent, ON);

    expect(
      await service.handleAnonymous('+242060000001', 'comment ca marche ?'),
    ).toBeNull();
  });

  // THE guard against noise. Every real answer now carries the signup card, so
  // the one reply that must NOT is the one that hands the turn back: a greeting
  // ends with « vous cherchez une mission, ou quelqu'un ? », and stapling a card
  // to it answers a question the person has not been asked yet.
  //
  // This is the assertion that will rot silently if the card ever becomes
  // unconditional — nothing else in the suite would fail.
  it('does not offer the card on a bare greeting', async () => {
    const agent = makeAgent();
    const service = build(agent, ON);

    const reply = await service.handleAnonymous('+242060000001', 'bonjour');

    expect(reply?.offerAccount).toBe(false);
    // And it never reached the model: the greeting is answered from a constant.
    expect(agent.handleAnonymous).not.toHaveBeenCalled();
  });

  it('never returns an app card — a stranger has nothing to open', async () => {
    const service = build(makeAgent('Voici comment ça marche.'), ON);
    const reply = await service.handleAnonymous(
      '+242060000001',
      'comment ça marche ?',
    );

    // The card, when one is warranted, is the caller's to append — this
    // service only says whether it is. That first assertion is the invariant
    // the test is named for and still holds; the flag now says YES, because a
    // stranger's only next step is creating an account and the card carries
    // the button that does it. The prompt no longer asks them to type a word.
    expect(reply?.text).not.toContain('[TPL:');
    expect(reply?.offerAccount).toBe(true);
  });
});

/**
 * Le budget des comptes derrière un mur.
 *
 * Tant que le bot leur répondait par une carte figée, ces profils ne coûtaient
 * rien. Les ouvrir à l'assistant est juste — c'est la seule population qui a
 * une question brûlante et aucun menu pour y répondre — mais c'est aussi celle
 * qui a le plus de raisons de la reposer vingt fois, qui ne rapporte rien tant
 * qu'elle est bloquée, et qui, dans le cas d'une suspension, peut l'être
 * justement pour abus.
 */
describe('la limite des comptes bloqués', () => {
  const LIVE = {
    'vova.enabled': 'true',
    'vova.shadow_mode': 'false',
    'vova.rollout_percent': '100',
  };

  const walled = [
    ['suspendu', { status: AccountStatus.SUSPENDED }],
    ['KYC en cours', { verification_status: VerificationStatus.PENDING }],
    ['KYC refusé', { verification_status: VerificationStatus.REJECTED }],
  ] as const;

  it.each(walled)('décompte un profil %s', async (_label, over) => {
    const anonymous = makeAnonymous();
    const service = build(makeAgent(), LIVE, makeOffers(), anonymous);

    await service.handle({ ...PROFILE, ...over }, 'pourquoi ?');

    expect(anonymous.consumeWalled).toHaveBeenCalledWith('p-1', 10);
  });

  it('ne décompte pas un profil actif et vérifié', async () => {
    const anonymous = makeAnonymous();
    const service = build(makeAgent(), LIVE, makeOffers(), anonymous);

    await service.handle(PROFILE, 'une question');

    expect(anonymous.consumeWalled).not.toHaveBeenCalled();
  });

  // Au-delà du budget : null, donc le bot retombe sur sa propre carte. La porte
  // s'ouvre toujours, il n'y a simplement plus d'assistant aujourd'hui.
  it('rend null une fois le budget épuisé, sans appeler le modèle', async () => {
    const agent = makeAgent();
    const anonymous = makeAnonymous({
      consumeWalled: jest.fn(() => Promise.resolve(false)),
    });
    const service = build(agent, LIVE, makeOffers(), anonymous);

    const reply = await service.handle(
      { ...PROFILE, status: AccountStatus.SUSPENDED },
      'pourquoi ?',
    );

    expect(reply).toBeNull();
    expect(agent.handle).not.toHaveBeenCalled();
  });

  // Le mode observation calcule la réponse puis la jette : les tokens sont
  // dépensés pareil. Un budget qui ignore ce mode rate l'endroit le moins cher
  // où trop dépenser.
  it('décompte aussi en mode observation', async () => {
    const anonymous = makeAnonymous();
    const service = build(
      makeAgent(),
      { ...LIVE, 'vova.shadow_mode': 'true' },
      makeOffers(),
      anonymous,
    );

    await service.handle(
      { ...PROFILE, status: AccountStatus.SUSPENDED },
      'pourquoi ?',
    );

    expect(anonymous.consumeWalled).toHaveBeenCalled();
  });

  // Le raccourci « oui » ne passe pas par le modèle, donc il ne coûte rien et
  // ne doit rien consommer.
  it('ne décompte pas le raccourci d’acceptation', async () => {
    const anonymous = makeAnonymous();
    const service = build(makeAgent(), LIVE, makeOffers('/home'), anonymous);

    await service.handle(
      { ...PROFILE, status: AccountStatus.SUSPENDED },
      'oui',
    );

    expect(anonymous.consumeWalled).not.toHaveBeenCalled();
  });

  it('respecte la limite configurée', async () => {
    const anonymous = makeAnonymous();
    const service = build(
      makeAgent(),
      { ...LIVE, 'vova.walled_daily_limit': '3' },
      makeOffers(),
      anonymous,
    );

    await service.handle(
      { ...PROFILE, status: AccountStatus.SUSPENDED },
      'pourquoi ?',
    );

    expect(anonymous.consumeWalled).toHaveBeenCalledWith('p-1', 3);
  });
});

/**
 * A bare hello, answered with a fixed string and no model call.
 *
 * The single largest cost reduction available on this path: the agent always
 * binds tools, so `router.route` returns `standard` for everything and even
 * « bonjour » paid a 4508-token prompt through a 12-tool graph.
 */
describe('VovaService greeting fast path', () => {
  const LIVE = { 'vova.enabled': 'true', 'vova.shadow_mode': 'false' };

  it('answers a registered user without calling the agent', async () => {
    const agent = makeAgent();
    const reply = await build(agent, {
      ...LIVE,
      'vova.rollout_percent': '100',
    }).handle(PROFILE, 'bonjour');

    expect(agent.handle).not.toHaveBeenCalled();
    expect(reply).toHaveLength(1);
    expect(reply?.[0]).toContain('VoVa');
  });

  it.each(['Bonjour', 'BONJOUR', 'bonjour !', 'salut', 'Coucou', 'hello'])(
    'treats %p as a greeting whatever the casing or punctuation',
    async (text) => {
      const agent = makeAgent();
      await build(agent, {
        ...LIVE,
        'vova.rollout_percent': '100',
      }).handle(PROFILE, text);

      expect(agent.handle).not.toHaveBeenCalled();
    },
  );

  it('does NOT short-circuit a question that merely opens with a hello', async () => {
    // The trap this guards: « bonjour, combien coûte un déblocage ? » is a
    // question, and answering it with a fixed greeting drops it on the floor.
    const agent = makeAgent();
    await build(agent, {
      ...LIVE,
      'vova.rollout_percent': '100',
    }).handle(PROFILE, 'bonjour, combien coute un deblocage ?');

    expect(agent.handle).toHaveBeenCalled();
  });

  it('stays silent in shadow mode, like every other reply', async () => {
    const agent = makeAgent();
    const reply = await build(agent, {
      'vova.enabled': 'true',
      'vova.shadow_mode': 'true',
      'vova.rollout_percent': '100',
    }).handle(PROFILE, 'bonjour');

    expect(reply).toBeNull();
  });

  it('answers a stranger without spending one of their daily questions', async () => {
    // Deliberate: burning an allowance on the one message that costs nothing
    // to answer would be the worst possible trade.
    const anonymous = makeAnonymous();
    const agent = makeAgent();
    const service = build(
      agent,
      { 'vova.enabled': 'true', 'vova.anonymous_enabled': 'true' },
      makeOffers(),
      anonymous,
    );

    const reply = await service.handleAnonymous('+242060000001', 'bonjour');

    expect(agent.handleAnonymous).not.toHaveBeenCalled();
    expect(anonymous.consume).not.toHaveBeenCalled();
    expect(reply?.text).toContain('VoVa');
    expect(reply?.offerAccount).toBe(false);
  });

  it('still respects the master switch', async () => {
    const reply = await build(makeAgent(), {
      'vova.enabled': 'false',
    }).handle(PROFILE, 'bonjour');

    expect(reply).toBeNull();
  });
});
