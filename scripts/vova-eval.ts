/**
 * VoVa evals — retrieval and whole answers, scored, optionally recorded in
 * Langfuse as dataset runs so changes can be compared over time.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/vova-eval.ts retrieval
 *   node_modules/.bin/tsx scripts/vova-eval.ts answers [--only=fee-worker,kyc-why] [--verbose]
 *
 * Run it before changing a prompt, the corpus, the embedder or a model, and
 * again after. With LANGFUSE_* keys set, each run is stored under the dataset
 * (`vova-retrieval` / `vova-answers`) with its scores and full traces; without
 * them it prints the same results locally and uploads nothing.
 *
 * What it needs: the local Qdrant with the corpus ingested (`vova-ingest.ts`),
 * and for `answers` at least one LLM provider key — those calls are real and
 * billed (≈ 30 turns).
 *
 * Hand-wired like `vova-context.ts`, not booted through Nest: under `tsx` Nest
 * DI resolves nothing (no `design:paramtypes`), and the agent's real
 * dependencies are few enough to write out. Tool data comes from FIXTURES
 * below, so answers do not depend on whatever is in the local database.
 */
import { config } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { AccountStatus, ProfileType, VerificationStatus } from '@prisma/client';
import { createVovaContext } from './vova-context';
import { SUITE } from './vova-suite';
import { ANSWER_CASES, type AnswerCase } from './vova-eval-cases';
import { VovaAgentService } from '../src/modules/rag/agent/agent.service';
import { GuardService } from '../src/modules/rag/agent/guard.service';
import { LlmService } from '../src/modules/rag/llm/llm.service';
import { LlmRouterService } from '../src/modules/rag/llm/router.service';
import { LlmBreakerService } from '../src/modules/rag/llm/breaker.service';
import { LlmModelFactory } from '../src/modules/rag/llm/model-factory.service';
import { Deadline } from '../src/modules/rag/llm/deadline';
import { detectLanguageOrNull } from '../src/modules/rag/agent/language';
import {
  initVovaTracing,
  shutdownVovaTracing,
  vovaLangfuseClient,
} from '../src/modules/rag/observability/tracing';

config({ path: '.env.local' });
config({ path: '.env' });

interface Evaluation {
  name: string;
  value: number;
  comment?: string;
}

interface EvalItem<I, E> {
  id: string;
  input: I;
  expectedOutput: E;
}

type Task<I, O> = (input: I) => Promise<O>;
type Evaluator<I, O, E> = (args: {
  input: I;
  output: O;
  expectedOutput: E;
}) => Evaluation[];

/* ───────────────────────── retrieval ───────────────────────── */

interface RetrievalOut {
  sources: string[];
  topScore: number;
}

function retrievalEvaluator({
  output,
  expectedOutput,
}: {
  output: RetrievalOut;
  expectedOutput: { source: string };
}): Evaluation[] {
  const rank = output.sources.indexOf(expectedOutput.source);
  return [
    { name: 'hit@1', value: rank === 0 ? 1 : 0 },
    { name: 'hit@5', value: rank >= 0 && rank < 5 ? 1 : 0 },
    {
      name: 'reciprocal_rank',
      value: rank >= 0 ? 1 / (rank + 1) : 0,
      comment: `top=${output.sources[0] ?? '—'} score=${output.topScore.toFixed(3)}`,
    },
  ];
}

/* ───────────────────────── answers ───────────────────────── */

/** Fixture data the tools read. Anything not here throws, and the tool answers « indisponible ». */
const FIXTURES = {
  fees: { employerFeeFcfa: 750, workerFeeFcfa: 500, expiryHours: 48 },
  walletBalance: 750,
  profile: {
    verification_status: 'REJECTED',
    kyc_rejection_reason: 'Photo de la pièce floue',
    reliability_score: 62,
    average_rating: 4.1,
    city: 'Brazzaville',
  },
  penalties: [] as unknown[],
  applications: { data: [] as unknown[], total: 0 },
  contact: { email: 'contact@rabotka.co', phone: '', address: 'Brazzaville' },
};

/** Any method → rejects. Tools catch it and reply « indisponible ». */
function unavailable(name: string): unknown {
  return new Proxy(
    {},
    {
      get: (_t, prop) => () =>
        Promise.reject(
          new Error(`${name}.${String(prop)} not in eval fixtures`),
        ),
    },
  );
}

function buildAgent(retrieve: unknown): {
  agent: VovaAgentService;
  close: () => void;
} {
  const cfg = new ConfigService();
  // Never open: the real breaker keeps its state in Redis, so one provider
  // hiccup early in a run would turn every later case into « no usable
  // provider » — scoring the breaker, not VoVa. Each case gets a real attempt.
  const breaker: Pick<
    LlmBreakerService,
    'isOpen' | 'health' | 'recordSuccess' | 'recordFailure'
  > = {
    isOpen: () => Promise.resolve(false),
    health: () => Promise.resolve(new Map()),
    recordSuccess: () => Promise.resolve(),
    recordFailure: () => Promise.resolve(false),
  };
  const llm = new LlmService(new LlmModelFactory(cfg), breaker as never, cfg);

  const deps = {
    help: retrieve,
    systemConfig: {
      getContactUnlockFees: () => Promise.resolve(FIXTURES.fees),
      getContactInfo: () => Promise.resolve(FIXTURES.contact),
    },
    wallet: {
      getProfileWalletBalance: () => Promise.resolve(FIXTURES.walletBalance),
    },
    profiles: {
      findById: () => Promise.resolve(FIXTURES.profile),
      getPenaltiesByProfileId: () => Promise.resolve(FIXTURES.penalties),
      getApplicationsByProfileId: () => Promise.resolve(FIXTURES.applications),
    },
    applications: {
      findByEmployer: () => Promise.resolve({ data: [], total: 0 }),
    },
    jobOffers: {
      findByEmployerId: () => Promise.resolve([]),
      countOpenOffers: () => Promise.resolve(12),
      findActive: () => Promise.resolve({ data: [], total: 0 }),
      findByReference: () => Promise.resolve(null),
    },
    unlock: unavailable('unlock'),
    categories: {
      resolve: () => Promise.resolve(null),
      suggest: () => Promise.resolve([]),
    },
  };

  const agent = new VovaAgentService(
    llm,
    new LlmRouterService(),
    new GuardService(),
    { slugs: () => Promise.resolve([]) } as never,
    {
      recent: () => Promise.resolve([]),
      priorInboundTexts: () => Promise.resolve([]),
    } as never,
    { read: () => Promise.resolve([]) } as never,
    // Both doors: `getForTurn` is the per-turn memo in front of `get`.
    { get: () => deps, getForTurn: () => deps } as never,
    { report: () => Promise.resolve() } as never,
    cfg,
  );
  return { agent, close: () => undefined };
}

interface AnswerOut {
  text: string;
  refusalId: string | null;
  toolsCalled: string[];
  origin: string;
}

/** A decline in the model's own words, FR or EN. */
const DECLINE =
  /\b(je ne (peux|suis) pas|je n['’]ai pas acc[eè]s|ne peux pas vous aider|i can['’]?not|i can['’]t|i['’]m not able)\b/i;

/** Compare facts loosely: case, accents and spaces inside numbers do not matter. */
function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/(\d)[\s .](?=\d)/g, '$1');
}

function answerEvaluator({
  output,
  expectedOutput: c,
}: {
  output: AnswerOut;
  expectedOutput: AnswerCase;
}): Evaluation[] {
  const scores: Evaluation[] = [];

  if (c.tools?.length) {
    const missing = c.tools.filter((t) => !output.toolsCalled.includes(t));
    scores.push({
      name: 'required_tools_called',
      value: missing.length === 0 ? 1 : 0,
      comment: missing.length
        ? `missing ${missing.join(', ')}; called [${output.toolsCalled.join(', ')}]`
        : undefined,
    });
  }

  if (c.refusal !== undefined) {
    // The guard tags its refusals with an id; the model declining in its own
    // words carries none. Both are a refusal — how WELL it declined is for the
    // LLM judge in Langfuse, not for a regex.
    const declined = output.refusalId === null && DECLINE.test(output.text);
    const ok =
      c.refusal === null
        ? output.refusalId === null && !declined
        : output.refusalId === c.refusal || declined;
    scores.push({
      name: 'refusal_correct',
      value: ok ? 1 : 0,
      comment: ok
        ? undefined
        : `expected ${c.refusal ?? 'an answer'}, got ${output.refusalId ?? 'an answer'}`,
    });
  }

  if (c.mustMention?.length) {
    const text = norm(output.text);
    const missing = c.mustMention.filter((f) => !text.includes(norm(f)));
    scores.push({
      name: 'facts_present',
      value: missing.length === 0 ? 1 : 0,
      comment: missing.length ? `missing ${missing.join(', ')}` : undefined,
    });
  }

  if (c.language) {
    const got = detectLanguageOrNull(output.text);
    scores.push({
      name: 'language_match',
      value: got === null || got === c.language ? 1 : 0,
      comment: got && got !== c.language ? `replied in ${got}` : undefined,
    });
  }

  scores.push({
    name: 'no_error',
    value: output.origin === 'error' ? 0 : 1,
  });
  return scores;
}

/* ───────────────────────── runner ───────────────────────── */

async function run<I, O, E>(
  dataset: string,
  description: string,
  items: EvalItem<I, E>[],
  task: Task<I, O>,
  evaluate: Evaluator<I, O, E>,
  /**
   * Items in flight at once. The runner defaults to 50, which sends every
   * turn simultaneously: the local embedder blocks on its native call, every
   * retrieval misses its 4 s slice, and providers rate-limit — measuring the
   * pile-up instead of VoVa.
   */
  maxConcurrency: number,
): Promise<void> {
  const lf = vovaLangfuseClient();
  const runName = `${dataset} ${new Date().toISOString().slice(0, 16)}`;
  const totals = new Map<string, { sum: number; n: number }>();
  const add = (evals: Evaluation[]) => {
    for (const e of evals) {
      const t = totals.get(e.name) ?? { sum: 0, n: 0 };
      t.sum += e.value;
      t.n += 1;
      totals.set(e.name, t);
    }
  };
  const print = (id: string, evals: Evaluation[]) => {
    const failed = evals.filter((e) => e.value < 1);
    const mark = failed.length ? 'FAIL' : 'ok  ';
    console.log(
      `${mark} ${id.padEnd(48)} ${failed.map((e) => `${e.name}${e.comment ? ` (${e.comment})` : ''}`).join(' · ')}`,
    );
  };

  if (lf) {
    // Upsert the dataset and its items: stable ids, so re-running updates the
    // same items instead of piling up duplicates.
    await lf.api.datasets
      .create({ name: dataset, description })
      .catch(() => undefined);
    for (const item of items) {
      await lf.dataset.createItem({
        datasetName: dataset,
        id: `${dataset}:${item.id}`,
        input: item.input,
        expectedOutput: item.expectedOutput,
      });
    }
    const ds = await lf.dataset.get(dataset);
    const byId = new Map(items.map((i) => [`${dataset}:${i.id}`, i]));
    // Only the selected items (`--only`): the dataset holds every case, and
    // `ds.runExperiment` would run all of them. Passing dataset items as
    // `data` keeps the run linked to the dataset.
    await lf.experiment.run({
      data: ds.items.filter((it) => byId.has(it.id)),
      name: dataset,
      runName,
      maxConcurrency,
      task: async ({ input }) => task(input as I),
      evaluators: [
        async ({ input, output, expectedOutput }) => {
          const evals = evaluate({
            input: input as I,
            output: output as O,
            expectedOutput: expectedOutput as E,
          });
          add(evals);
          const item = [...byId.values()].find(
            (i) => JSON.stringify(i.input) === JSON.stringify(input),
          );
          print(item?.id ?? '?', evals);
          return evals;
        },
      ],
    });
  } else {
    console.log('(no LANGFUSE_* keys: running locally, nothing uploaded)\n');
    for (const item of items) {
      try {
        const output = await task(item.input);
        const evals = evaluate({
          input: item.input,
          output,
          expectedOutput: item.expectedOutput,
        });
        add(evals);
        print(item.id, evals);
      } catch (err) {
        console.log(`ERR  ${item.id.padEnd(48)} ${String(err)}`);
      }
    }
  }

  console.log(`\n${runName}`);
  for (const [name, t] of totals) {
    console.log(
      `  ${name.padEnd(24)} ${(t.sum / t.n).toFixed(3)}  (${t.n} items)`,
    );
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode !== 'retrieval' && mode !== 'answers') {
    console.error('Usage: vova-eval.ts retrieval | answers [--only=id1,id2]');
    process.exit(1);
  }
  const only = process.argv
    .find((a) => a.startsWith('--only='))
    ?.slice('--only='.length)
    .split(',');

  await initVovaTracing();
  const ctx = createVovaContext();
  const closers: Array<() => void> = [];

  try {
    if (mode === 'retrieval') {
      await run<{ question: string }, RetrievalOut, { source: string }>(
        'vova-retrieval',
        'Help-corpus recall: does a real question retrieve the right article? Shared with vova-query.ts --suite.',
        SUITE.map(([question, source]) => ({
          id: question.replace(/\W+/g, '-').slice(0, 60),
          input: { question },
          expectedOutput: { source },
        })),
        async ({ question }) => {
          const r = await ctx.retrieve.search(question, 5);
          return {
            sources: r.hits.map((h) => h.source),
            topScore: r.hits[0]?.score ?? 0,
          };
        },
        retrievalEvaluator,
        4,
      );
      return;
    }

    const { agent, close } = buildAgent(ctx.retrieve);
    closers.push(close);
    const cases = ANSWER_CASES.filter((c) => !only || only.includes(c.id));
    await run<{ as: string; text: string }, AnswerOut, AnswerCase>(
      'vova-answers',
      'Whole VoVa turns on fixture data: required tools, refusals, facts, language.',
      cases.map((c) => ({
        id: c.id,
        input: { as: c.as, text: c.text },
        expectedOutput: c,
      })),
      async ({ as, text }) => {
        const deadline = Deadline.start(45_000, 'vova-eval');
        try {
          const reply = await agent.handle({
            profileId: '00000000-0000-4000-8000-00000000e7a1',
            profileType:
              as === 'employer' ? ProfileType.EMPLOYER : ProfileType.WORKER,
            firstName: 'Awa',
            verificationStatus: VerificationStatus.VERIFIED,
            accountStatus: AccountStatus.ACTIVE,
            categorySlugs: [],
            text,
            correlationId: 'vova-eval',
            deadline,
          });
          if (process.argv.includes('--verbose')) {
            console.log(
              `\n» ${text}\n« ${reply.text}\n  tools=[${(reply.toolsCalled ?? []).join(', ')}] refusal=${reply.refusalId ?? '—'}`,
            );
          }
          return {
            text: reply.text,
            refusalId: reply.refusalId ?? null,
            toolsCalled: reply.toolsCalled ?? [],
            origin: reply.origin,
          };
        } finally {
          deadline.dispose();
        }
      },
      answerEvaluator,
      1,
    );
  } finally {
    for (const close of closers) close();
    await ctx.close();
    await shutdownVovaTracing();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
