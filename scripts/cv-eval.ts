/**
 * Measures how CVs are scored, on invented CVs (`cv-eval-cases.ts`).
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/cv-eval.ts sheet
 *       writes the CVs to read and the ratings to fill, when not there yet
 *   node_modules/.bin/tsx scripts/cv-eval.ts run [--formula=grid] [--runs=3] [--no-swap]
 *       scores every CV `runs` times, then each swapped name; real, billed calls.
 *       `previous` (the default) is the formula before the grids; `grid` also
 *       gives the geometric mean, the must-haves found and the quotes kept.
 *       `--model=openai:gpt-6-luna` asks that one only: no other takes over.
 *       `--grids=<a saved result>` uses its criteria instead of proposing some.
 *
 * Both work in ../../docs/rabotka-backend/cv-eval. Reported: the spread of a
 * score over the runs, what another name changes, and, once the ratings are
 * filled, how many pairs of candidates are ordered as a person ordered them.
 * Hand-wired like `vova-eval.ts`: Nest DI resolves nothing under tsx.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { LlmBreakerService } from '../src/modules/rag/llm/breaker.service';
import { LlmModelFactory } from '../src/modules/rag/llm/model-factory.service';
import { LlmService } from '../src/modules/rag/llm/llm.service';
import type { LlmProviderSpec } from '../src/modules/rag/llm/llm.types';
import {
  assessmentMessages,
  JSON_REMINDER,
  overallScore,
  parseAssessment,
  type CvAssessment,
} from '../src/modules/business/cv-screening/cv-assessment';
import {
  defaultGrid,
  isFit,
  isMust,
  parseProposal,
  proposalMessages,
  type GridItem,
  type MustFamily,
} from '../src/modules/business/cv-screening/cv-grid';
import {
  evaluate,
  markingMessages,
  parseMarking,
} from '../src/modules/business/cv-screening/cv-marking';
import {
  geometricScore,
  type MustStatus,
} from '../src/modules/business/cv-screening/scoring';
import { CVS, JOBS, NAME_SWAPS, type EvalCv } from './cv-eval-cases';

config({ path: '.env.local' });
config({ path: '.env' });

const DIR = resolve(__dirname, '../../../docs/rabotka-backend/cv-eval');
const RATINGS = join(DIR, 'ratings.csv');
/** CVs read at once, as the queue does. */
const CONCURRENCY = 3;
/** The day the careers are counted to, so a run next month compares with this one. */
const NOW = new Date('2026-11-25T00:00:00Z');

const jobOf = (cv: EvalCv) => JOBS.find((j) => j.id === cv.job)!;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs: number[]) =>
  Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const round1 = (n: number) => Math.round(n * 10) / 10;

function makeLlm(): LlmService {
  const cfg = new ConfigService();
  const breaker: Pick<
    LlmBreakerService,
    'isOpen' | 'health' | 'recordSuccess' | 'recordFailure'
  > = {
    isOpen: () => Promise.resolve(false),
    health: () => Promise.resolve(new Map()),
    recordSuccess: () => Promise.resolve(),
    recordFailure: () => Promise.resolve(false),
  };
  return new LlmService(new LlmModelFactory(cfg), breaker as never, cfg);
}

function plain(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p: { text?: unknown }) => (typeof p?.text === 'string' ? p.text : ''))
    .join('');
}

const used = new Map<string, number>();

/** `--model=provider:name`: the only one asked. */
const PINNED = ((arg) => {
  if (!arg) return null;
  const [provider, ...name] = arg.slice('--model='.length).split(':');
  return { provider, model: name.join(':') } as LlmProviderSpec;
})(process.argv.find((a) => a.startsWith('--model=')));

/** One marked CV, whichever formula marked it. */
type Scored = {
  score: number;
  /** Who answered: two models do not mark alike. */
  model: string;
  criteria: Record<string, number | null | undefined>;
  geometric?: number;
  musts?: Partial<Record<MustFamily, MustStatus>>;
  /** Of the marks above 0, how many came with words found in the CV. */
  proofs?: { marked: number; quoted: number };
};

type Messages = BaseMessage[];

async function ask(
  llm: LlmService,
  input: Messages,
  id: string,
  temperature?: number,
): Promise<{ text: string; model: string }> {
  const options = {
    tier: 'document' as const,
    timeoutMs: 45_000,
    correlationId: `cv-eval:${id}`,
    ...(temperature === undefined ? {} : { temperature }),
  };
  const { output, telemetry } = PINNED
    ? await llm.invokeWith(PINNED, input, options)
    : await llm.invoke(input, options);
  const model = `${telemetry.provider}/${telemetry.model}`;
  used.set(model, (used.get(model) ?? 0) + 1);
  return { text: plain(output.content), model };
}

/** Asked, and asked once more when the answer cannot be read. */
async function read<T>(
  llm: LlmService,
  messages: Messages,
  id: string,
  parse: (raw: string) => T | null,
  temperature?: number,
): Promise<{ value: T; model: string } | null> {
  const first = await ask(llm, messages, id, temperature);
  const value = parse(first.text);
  if (value) return { value, model: first.model };
  const second = await ask(
    llm,
    [...messages, new AIMessage(first.text), new HumanMessage(JSON_REMINDER)],
    id,
    temperature,
  );
  const again = parse(second.text);
  return again ? { value: again, model: second.model } : null;
}

async function previous(
  llm: LlmService,
  cv: EvalCv,
  text: string,
): Promise<Scored | null> {
  const got = await read<CvAssessment>(
    llm,
    assessmentMessages(jobOf(cv), { kind: 'text', text }),
    cv.id,
    (raw) => parseAssessment(raw, NOW),
  );
  if (!got?.value.isCv) return null;
  return {
    score: overallScore(got.value.criteria),
    criteria: got.value.criteria,
    model: got.model,
  };
}

async function withGrid(
  llm: LlmService,
  grids: Map<string, GridItem[]>,
  cv: EvalCv,
  text: string,
): Promise<Scored | null> {
  const grid = grids.get(cv.job)!;
  const got = await read(
    llm,
    markingMessages(jobOf(cv), grid, { kind: 'text', text }),
    cv.id,
    (raw) => parseMarking(raw, grid, text, [], NOW),
    0,
  );
  if (!got?.value.isCv) return null;
  const { reading } = got.value;
  const e = evaluate(grid, reading);
  const musts: Partial<Record<MustFamily, MustStatus>> = {};
  for (const m of grid.filter(isMust)) musts[m.family] = e.musts[m.key];
  let marked = 0;
  let quoted = 0;
  for (const r of Object.values(reading.items)) {
    for (const f of r.found ?? []) {
      marked++;
      if (f.quote) quoted++;
    }
    if (r.mark) {
      marked++;
      if (r.quote) quoted++;
    }
  }
  return {
    score: e.score,
    criteria: e.marks,
    model: got.model,
    geometric: geometricScore(grid.filter(isFit), e.marks),
    musts,
    proofs: { marked, quoted },
  };
}

/** One grid per job for the whole run, as an offer has one. */
async function propose(llm: LlmService): Promise<Map<string, GridItem[]>> {
  // Two models are compared on the same criteria, or it is the criteria that differ.
  const from = process.argv.find((a) => a.startsWith('--grids='));
  if (from) {
    const saved = JSON.parse(readFileSync(from.slice(8), 'utf8')) as {
      grids: [string, GridItem[]][];
    };
    return new Map(saved.grids);
  }
  const grids = new Map<string, GridItem[]>();
  for (const job of JOBS) {
    const got = await read(
      llm,
      proposalMessages(job),
      `grid-${job.id}`,
      (raw) => parseProposal(raw, { remote: job.id === 'dev' }),
      0,
    ).catch(() => null);
    grids.set(job.id, got?.value ?? defaultGrid('fr'));
    if (!got) console.error(`${job.id}: no proposal, default grid`);
  }
  return grids;
}

/** What each fact of the cases is called in a grid. */
const FACT_FAMILY: Record<string, MustFamily> = {
  diploma: 'DIPLOMA',
  years: 'EXPERIENCE',
  licence: 'LICENCE',
  english: 'LANGUAGE',
  clearance: 'CERTIFICATION',
};

async function pool<T, R>(items: T[], run: (item: T) => Promise<R>) {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await run(items[i]);
      }
    }),
  );
  return out;
}

/** `fit` per CV: 2 fits well, 1 partly, 0 no; absent while not filled. */
function readRatings(): Map<string, number> {
  const out = new Map<string, number>();
  if (!existsSync(RATINGS)) return out;
  for (const line of readFileSync(RATINGS, 'utf8').split(/\r?\n/).slice(1)) {
    const [id, , fit] = line.split(/[;,]/).map((c) => c.trim());
    if (id && /^[012]$/.test(fit ?? '')) out.set(id, Number(fit));
  }
  return out;
}

/** Pairs of one job rated differently: how many the score orders the same way (a tie is half). */
function agreement(scores: Map<string, number>, ratings: Map<string, number>) {
  let pairs = 0;
  let right = 0;
  for (const job of JOBS) {
    const ids = CVS.filter((c) => c.job === job.id).map((c) => c.id);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [ra, rb] = [ratings.get(ids[i]), ratings.get(ids[j])];
        const [sa, sb] = [scores.get(ids[i]), scores.get(ids[j])];
        if (ra === undefined || rb === undefined || ra === rb) continue;
        if (sa === undefined || sb === undefined) continue;
        pairs++;
        if (sa === sb) right += 0.5;
        else if (sa > sb === ra > rb) right++;
      }
    }
  }
  return { pairs, right };
}

function sheet() {
  mkdirSync(DIR, { recursive: true });
  const md = [
    '# CVs to rate',
    '',
    'Every person here is invented. For each CV, write in `ratings.csv` how well it fits the job: **2** fits well, **1** partly, **0** no. Judge the CV only, not the score.',
    ...JOBS.flatMap((job) => [
      '',
      `## ${job.title} (\`${job.id}\`)`,
      '',
      job.text,
      ...CVS.filter((c) => c.job === job.id).flatMap((c) => [
        '',
        `### ${c.id}`,
        '',
        '```text',
        c.text,
        '```',
      ]),
    ]),
    '',
  ].join('\n');
  writeFileSync(join(DIR, 'cvs.md'), md);
  // Never over ratings someone has started to fill.
  if (!existsSync(RATINGS)) {
    writeFileSync(
      RATINGS,
      ['cv;job;fit;comment', ...CVS.map((c) => `${c.id};${c.job};;`), ''].join(
        '\n',
      ),
    );
  }
  console.log(`Written in ${DIR}`);
}

async function run(formula: 'previous' | 'grid', runs: number, swap: boolean) {
  const llm = makeLlm();
  const grids =
    formula === 'grid' ? await propose(llm) : new Map<string, GridItem[]>();
  let failed = 0;
  const score = async (cv: EvalCv, text: string): Promise<Scored | null> => {
    try {
      const got =
        formula === 'grid'
          ? await withGrid(llm, grids, cv, text)
          : await previous(llm, cv, text);
      if (!got) failed++;
      return got;
    } catch (err) {
      failed++;
      console.error(cv.id, err instanceof Error ? err.message : err);
      return null;
    }
  };

  const jobs = CVS.flatMap((cv) => Array.from({ length: runs }, () => cv));
  const results = await pool(jobs, async (cv) => ({
    id: cv.id,
    got: await score(cv, cv.text),
  }));
  const rows = CVS.map((cv) => {
    const got = results.flatMap((r) =>
      r.id === cv.id && r.got ? [r.got] : [],
    );
    const scores = got.map((g) => g.score);
    return {
      id: cv.id,
      scores,
      mean: scores.length ? round1(mean(scores)) : null,
      sd: scores.length ? round1(sd(scores)) : null,
      geometric: got.length
        ? round1(mean(got.map((g) => g.geometric ?? g.score)))
        : null,
      criteria: got.map((g) => g.criteria),
      models: got.map((g) => g.model),
      musts: got.map((g) => g.musts ?? {}),
      proofs: got.map((g) => g.proofs ?? { marked: 0, quoted: 0 }),
    };
  });

  const swaps = swap
    ? await pool(
        Object.entries(NAME_SWAPS).flatMap(([id, names]) =>
          names.map((name) => ({ id, name })),
        ),
        async ({ id, name }) => {
          const cv = CVS.find((c) => c.id === id)!;
          const text = [name, ...cv.text.split('\n').slice(1)].join('\n');
          const got = await score(cv, text);
          return {
            id,
            name,
            score: got?.score ?? null,
            model: got?.model ?? null,
          };
        },
      )
    : [];

  const means = new Map(
    rows.flatMap((r) => (r.mean === null ? [] : [[r.id, r.mean] as const])),
  );
  const spreads = rows.flatMap((r) => (r.sd === null ? [] : [r.sd]));
  const ratings = readRatings();
  const { pairs, right } = agreement(means, ratings);
  const shifts = swaps.flatMap((s) => {
    const base = means.get(s.id);
    return s.score === null || base === undefined
      ? []
      : [Math.abs(s.score - base)];
  });
  // Criteria one job's CVs are not all marked on: they are divided differently.
  const uneven = JOBS.map((job) => {
    const sets = new Set(
      rows
        .filter((r) => CVS.find((c) => c.id === r.id)?.job === job.id)
        .flatMap((r) => r.criteria.map((c) => Object.keys(c).sort().join('+'))),
    );
    return { job: job.id, sets: [...sets] };
  });

  for (const job of JOBS) {
    console.log(`\n${job.title}`);
    for (const r of rows
      .filter((x) => CVS.find((c) => c.id === x.id)?.job === job.id)
      .sort((a, b) => (b.mean ?? -1) - (a.mean ?? -1))) {
      console.log(
        `  ${r.id.padEnd(10)} ${String(r.mean).padStart(5)}  (${r.scores.join(', ')})  rated ${ratings.get(r.id) ?? '-'}`,
      );
    }
  }
  console.log(
    `\nSpread over ${runs} runs: mean sd ${round1(mean(spreads))}, worst ${Math.max(...spreads)}`,
  );
  console.log('Criteria marked, per job:');
  for (const u of uneven) console.log(`  ${u.job}: ${u.sets.join(' | ')}`);
  if (shifts.length) {
    console.log(
      `Another name moves the score by ${round1(mean(shifts))} on average, ${round1(Math.max(...shifts))} at most`,
    );
    for (const s of swaps)
      console.log(
        `  ${s.id} ${s.name}: ${s.score} (own name ${means.get(s.id)})`,
      );
  }
  console.log(
    pairs
      ? `Pairs ordered as rated: ${right}/${pairs} (${Math.round((right / pairs) * 100)}%)`
      : 'No ratings yet: accuracy not measured (fill ratings.csv).',
  );
  if (formula === 'grid') {
    const geometric = new Map(
      rows.flatMap((r) =>
        r.geometric === null ? [] : [[r.id, r.geometric] as const],
      ),
    );
    const g = agreement(geometric, ratings);
    if (g.pairs) {
      console.log(
        `Geometric mean, pairs ordered as rated: ${g.right}/${g.pairs} (${Math.round((g.right / g.pairs) * 100)}%)`,
      );
    }
    // Against the facts written with the CVs; a fact the grid did not ask is apart.
    const seen = { right: 0, wrong: [] as string[], notAsked: 0 };
    for (const row of rows) {
      const facts = CVS.find((c) => c.id === row.id)!.musts;
      for (const got of row.musts) {
        for (const [key, fact] of Object.entries(facts)) {
          const found = got[FACT_FAMILY[key]];
          if (found === undefined) seen.notAsked++;
          else if (found === fact) seen.right++;
          else seen.wrong.push(`${row.id} ${key}: ${found}, is ${fact}`);
        }
      }
    }
    const all = seen.right + seen.wrong.length;
    console.log(
      `Must-haves read right: ${seen.right}/${all}; not in the grid: ${seen.notAsked}`,
    );
    const tally = new Map<string, number>();
    for (const w of seen.wrong) tally.set(w, (tally.get(w) ?? 0) + 1);
    for (const [w, n] of tally) console.log(`  ${w} (×${n})`);
    const proofs = rows.flatMap((r) => r.proofs);
    const marked = proofs.reduce((n, x) => n + x.marked, 0);
    const quoted = proofs.reduce((n, x) => n + x.quoted, 0);
    console.log(`Marks with words found in the CV: ${quoted}/${marked}`);
  }
  // The same CV by the same model: what is left once the fallback is set aside.
  const same = rows.flatMap((r) => {
    const first = r.models[0];
    const scores = r.scores.filter((_, i) => r.models[i] === first);
    return scores.length > 1 ? [Math.max(...scores) - Math.min(...scores)] : [];
  });
  if (same.length) {
    console.log(
      `Same CV, same model: range ${round1(mean(same))} on average, ${Math.max(...same)} at most (${same.length} CVs)`,
    );
  }
  console.log(`Failed: ${failed}. Models: ${JSON.stringify([...used])}`);

  mkdirSync(join(DIR, 'results'), { recursive: true });
  const file = join(
    DIR,
    'results',
    `${formula}-formula${PINNED ? `-${PINNED.model}` : ''}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(
    file,
    JSON.stringify(
      {
        formula,
        runs,
        grids: [...grids],
        rows,
        swaps,
        uneven,
        failed,
        models: [...used],
      },
      null,
      2,
    ),
  );
  console.log(`Saved ${file}`);
}

const [command, ...flags] = process.argv.slice(2);
const runs = Number(flags.find((f) => f.startsWith('--runs='))?.slice(7) ?? 3);
if (command === 'sheet') sheet();
else if (command === 'run') {
  run(
    flags.includes('--formula=grid') ? 'grid' : 'previous',
    runs,
    !flags.includes('--no-swap'),
  )
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else {
  console.error('Usage: cv-eval.ts sheet | run [--runs=3] [--no-swap]');
  process.exit(1);
}
