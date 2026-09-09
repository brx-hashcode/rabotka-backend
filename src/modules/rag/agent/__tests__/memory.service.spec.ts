import { Logger } from '@nestjs/common';
import { VovaMemoryService, type MemoryFact } from '../memory.service';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

const PROFILE = 'p-1';
const DAY = 86_400_000;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY).toISOString();
}

function makeDeps(over: Record<string, unknown> = {}) {
  const prisma = {
    vovaProfileMemory: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
  const history = { recent: jest.fn().mockResolvedValue([]) };
  const llm = {
    invoke: jest.fn().mockResolvedValue({ output: { content: '' } }),
  };
  // `set` returns 'OK' when the NX claim is won, null when another turn holds
  // it — which is exactly how the rebuild decides whether it is its job.
  const redis = { set: jest.fn().mockResolvedValue('OK') };
  return { prisma, history, llm, redis, ...over };
}

function build(deps: ReturnType<typeof makeDeps>) {
  return new VovaMemoryService(
    deps.prisma as never,
    deps.history as never,
    deps.llm as never,
    deps.redis as never,
  );
}

const TURNS = [
  { role: 'user' as const, text: 'je cherche du ménage' },
  { role: 'assistant' as const, text: 'très bien' },
];

/** The exchange that just happened, handed to `refresh` rather than read back. */
const CURRENT = { user: 'je suis libre le week-end', assistant: 'noté' };

describe('VovaMemoryService.read()', () => {
  it('returns the stored facts', async () => {
    const deps = makeDeps();
    deps.prisma.vovaProfileMemory.findUnique.mockResolvedValue({
      facts: [{ text: 'Fait le ménage', at: daysAgo(1) }],
    });
    expect(await build(deps).read(PROFILE)).toEqual([
      { text: 'Fait le ménage', at: expect.any(String) },
    ]);
  });

  it('returns nothing rather than throwing when the database is down', async () => {
    // No memory is worse than no reply: the turn must still be answerable.
    const deps = makeDeps();
    deps.prisma.vovaProfileMemory.findUnique.mockRejectedValue(
      new Error('db down'),
    );
    expect(await build(deps).read(PROFILE)).toEqual([]);
  });

  it('drops facts older than the staleness floor', async () => {
    // A fact that has quietly stopped being true is worse than no fact: it gets
    // asserted to someone who knows better.
    const deps = makeDeps();
    deps.prisma.vovaProfileMemory.findUnique.mockResolvedValue({
      facts: [
        { text: 'Cherchait du ménage', at: daysAgo(200) },
        { text: 'Habite Poto-Poto', at: daysAgo(5) },
      ],
    });
    const facts = await build(deps).read(PROFILE);
    expect(facts.map((f) => f.text)).toEqual(['Habite Poto-Poto']);
  });

  it('keeps a fact whose date cannot be parsed', async () => {
    // Losing a true fact to a formatting slip is the worse of the two errors.
    const deps = makeDeps();
    deps.prisma.vovaProfileMemory.findUnique.mockResolvedValue({
      facts: [{ text: 'Habite Poto-Poto', at: 'not-a-date' }],
    });
    expect(await build(deps).read(PROFILE)).toHaveLength(1);
  });

  it('caps a row written by an older build, so it cannot bloat a prompt', async () => {
    const deps = makeDeps();
    deps.prisma.vovaProfileMemory.findUnique.mockResolvedValue({
      facts: Array.from({ length: 30 }, (_, i) => ({
        text: `fait ${i}`,
        at: daysAgo(1),
      })),
    });
    expect(await build(deps).read(PROFILE)).toHaveLength(8);
  });

  it('survives a row that is not an array', async () => {
    const deps = makeDeps();
    deps.prisma.vovaProfileMemory.findUnique.mockResolvedValue({
      facts: { nope: true },
    });
    expect(await build(deps).read(PROFILE)).toEqual([]);
  });
});

describe('VovaMemoryService.refresh()', () => {
  it('rebuilds and stores the facts', async () => {
    const deps = makeDeps();
    deps.history.recent.mockResolvedValue(TURNS);
    deps.llm.invoke.mockResolvedValue({
      output: { content: '- Fait le ménage\n- Habite Poto-Poto' },
    });

    await build(deps).refresh(PROFILE, CURRENT);

    expect(deps.llm.invoke).toHaveBeenCalledWith(
      expect.anything(),
      // The cheap tier: this is summarising chat into short sentences, off the
      // reply path, where a slower better answer buys nothing.
      expect.objectContaining({ tier: 'cheap' }),
    );
    const written = deps.prisma.vovaProfileMemory.upsert.mock.calls[0][0] as {
      update: { facts: MemoryFact[] };
    };
    expect(written.update.facts.map((f) => f.text)).toEqual([
      'Fait le ménage',
      'Habite Poto-Poto',
    ]);
  });

  it('does nothing when another turn already holds the rebuild claim', async () => {
    // Otherwise a long exchange pays for a rebuild on every message.
    const deps = makeDeps();
    deps.redis.set.mockResolvedValue(null);

    await build(deps).refresh(PROFILE, CURRENT);

    expect(deps.llm.invoke).not.toHaveBeenCalled();
    expect(deps.prisma.vovaProfileMemory.upsert).not.toHaveBeenCalled();
  });

  /** The transcript the model was shown, as one string. */
  function promptOf(deps: ReturnType<typeof makeDeps>): string {
    const [messages] = deps.llm.invoke.mock.calls[0] as [
      { content: unknown }[],
    ];
    return messages.map((m) => String(m.content)).join('\n');
  }

  it('reads the current exchange even when nothing is in the database yet', async () => {
    // The inbound row is written in parallel with the bot and the outbound one
    // only on send, so a first conversation has neither in Postgres when this
    // runs. Read from history alone, the very turn that triggered the rebuild
    // would be the one turn it never saw.
    const deps = makeDeps();
    deps.history.recent.mockResolvedValue([]);
    deps.llm.invoke.mockResolvedValue({
      output: { content: '- Libre le week-end' },
    });

    await build(deps).refresh(PROFILE, CURRENT);

    expect(promptOf(deps)).toContain('je suis libre le week-end');
    expect(deps.prisma.vovaProfileMemory.upsert).toHaveBeenCalled();
  });

  it('does not show the message twice when the race wrote it first', async () => {
    // The same race cuts both ways. Doubled, the model reads a plain statement
    // as insistence — and the result would depend on which write won.
    const deps = makeDeps();
    deps.history.recent.mockResolvedValue([
      ...TURNS,
      { role: 'user' as const, text: CURRENT.user },
    ]);
    deps.llm.invoke.mockResolvedValue({
      output: { content: '- Libre le week-end' },
    });

    await build(deps).refresh(PROFILE, CURRENT);

    const occurrences = promptOf(deps).split(CURRENT.user).length - 1;
    expect(occurrences).toBe(1);
  });

  it('keeps both when the person genuinely repeated themselves', async () => {
    // Only the tail is de-duplicated: saying the same thing twice, a turn
    // apart, is a real thing people do and it means something.
    const deps = makeDeps();
    deps.history.recent.mockResolvedValue([
      { role: 'user' as const, text: CURRENT.user },
      { role: 'assistant' as const, text: 'noté' },
    ]);
    deps.llm.invoke.mockResolvedValue({
      output: { content: '- Libre le week-end' },
    });

    await build(deps).refresh(PROFILE, CURRENT);

    const occurrences = promptOf(deps).split(CURRENT.user).length - 1;
    expect(occurrences).toBe(2);
  });

  it('keeps what is already known when the model returns nothing', async () => {
    // An empty answer is legitimate — a conversation can carry nothing worth
    // keeping — but it must not wipe the existing list.
    const deps = makeDeps();
    deps.history.recent.mockResolvedValue(TURNS);
    deps.prisma.vovaProfileMemory.findUnique.mockResolvedValue({
      facts: [{ text: 'Habite Poto-Poto', at: daysAgo(1) }],
    });
    deps.llm.invoke.mockResolvedValue({ output: { content: '   \n  ' } });

    await build(deps).refresh(PROFILE, CURRENT);

    expect(deps.prisma.vovaProfileMemory.upsert).not.toHaveBeenCalled();
  });

  it('swallows a model failure', async () => {
    // A memory one turn out of date is a memory nobody notices.
    const deps = makeDeps();
    deps.history.recent.mockResolvedValue(TURNS);
    deps.llm.invoke.mockRejectedValue(new Error('provider down'));

    await expect(
      build(deps).refresh(PROFILE, CURRENT),
    ).resolves.toBeUndefined();
    expect(deps.prisma.vovaProfileMemory.upsert).not.toHaveBeenCalled();
  });

  it('trims what the model returns to the cap', async () => {
    const deps = makeDeps();
    deps.history.recent.mockResolvedValue(TURNS);
    deps.llm.invoke.mockResolvedValue({
      output: {
        content: Array.from({ length: 20 }, (_, i) => `- fait ${i}`).join('\n'),
      },
    });

    await build(deps).refresh(PROFILE, CURRENT);

    const written = deps.prisma.vovaProfileMemory.upsert.mock.calls[0][0] as {
      update: { facts: MemoryFact[] };
    };
    expect(written.update.facts).toHaveLength(8);
  });
});

describe('VovaMemoryService.render()', () => {
  it('renders nothing when there is nothing remembered', () => {
    // The ordinary case — a first conversation — must produce the same prompt
    // as before memory existed, not a degraded one.
    expect(VovaMemoryService.render([])).toEqual([]);
  });

  it('lists the facts and tells the model not to recite them', () => {
    const lines = VovaMemoryService.render([
      { text: 'Habite Poto-Poto', at: daysAgo(1) },
    ]);
    expect(lines).toContain('- Habite Poto-Poto');
    expect(lines.join('\n')).toContain('Ne récite pas');
  });
});
