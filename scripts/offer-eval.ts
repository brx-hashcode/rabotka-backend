/**
 * Measures « Rédiger avec l'IA » on requests whose facts are known.
 *
 *   node_modules/.bin/tsx scripts/offer-eval.ts --model=openai:gpt-4o-mini [--show]
 *   node_modules/.bin/tsx scripts/offer-eval.ts --model=… --writer=<another offer-writer.ts>
 *
 * Real, billed calls: one per request. Checked: the place and the facts of the
 * request are in the offer, another place is not, no figure nobody gave.
 */
import { resolve } from 'node:path';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { config } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import type { LlmBreakerService } from '../src/modules/rag/llm/breaker.service';
import { LlmModelFactory } from '../src/modules/rag/llm/model-factory.service';
import { LlmService } from '../src/modules/rag/llm/llm.service';
import type { LlmProviderSpec } from '../src/modules/rag/llm/llm.types';
import type { OfferBrief } from '../src/modules/business/offer-writer/offer-writer';

config({ path: '.env.local' });

type Case = {
  id: string;
  brief: string;
  form?: Partial<OfferBrief>;
  /** In the conditions, each as one of these. */
  has: RegExp[];
  /** Nowhere but in « Qui sommes-nous ». */
  not: RegExp[];
};

const TRADES = [
  'Cuisine & Restauration',
  'Nettoyage',
  'Transport & Livraison',
  'Informatique',
  'Comptabilité',
  'Autre',
];
const FORM: OfferBrief = {
  brief: '',
  title: null,
  employmentType: null,
  city: 'Kinshasa',
  isRemote: false,
  quantity: 1,
  businessName: 'ZuaFood',
  countryName: 'République Démocratique du Congo',
  businessCategory: 'Association',
};

const CASES: Case[] = [
  {
    id: 'place',
    brief:
      "Nous sommes à la recherche d'un assistant directeur avec 2 ans d'expérience au moins vivant a Brazzaville au Congo",
    form: { employmentType: 'CDI' },
    has: [/Brazzaville/, /(2|deux) ans/i],
    not: [/Kinshasa/, /strat[ée]gie/i],
  },
  {
    id: 'devops',
    brief:
      "Ingénieur DevOps confirmé, maîtrise d'AWS et Azure obligatoire, vivant à Brazzaville",
    form: { employmentType: 'CDI' },
    has: [/Brazzaville/, /AWS/, /Azure/, /obligatoire/],
    not: [/Kinshasa/, /secteur technologique/i],
  },
  {
    id: 'pay',
    brief:
      '2 serveurs pour un mariage samedi soir à Pointe-Noire, 15 000 FCFA chacun',
    has: [/Pointe-Noire/, /15 ?000/, /samedi/i, /: 2|2 (personnes|serveurs)/],
    not: [/Kinshasa/],
  },
  {
    id: 'default',
    brief: "Un agent d'entretien pour nos bureaux, 3 matinées par semaine",
    has: [/Kinshasa/, /3 matin[ée]es/],
    not: [],
  },
  {
    id: 'type',
    brief:
      'Stagiaire en comptabilité pour 6 mois à Douala, indemnité 50 000 FCFA par mois',
    form: { employmentType: 'CDI' },
    has: [/Douala/, /6 mois/, /50 ?000/, /Stage/],
    not: [/Kinshasa/, /CDI/],
  },
  {
    id: 'remote',
    brief:
      'Développeur React en télétravail, 3 ans minimum, anglais professionnel exigé',
    has: [/distance/, /(3|trois) ans/i, /anglais/i],
    not: [/Lieu : Kinshasa/],
  },
  {
    id: 'unfair',
    brief:
      'Jeune femme de moins de 30 ans pour accueillir les clients à Abidjan, permis B exigé',
    has: [/Abidjan/, /permis B/i],
    not: [/Kinshasa/, /30 ans/, /jeune/i, /femme/i],
  },
  {
    id: 'short',
    brief: 'chauffeur',
    has: [/Kinshasa/],
    not: [/\d+ ans/, /permis [BC]\b.*(exig|obligatoire)/i],
  },
  {
    id: 'english',
    brief:
      'We need a data analyst based in Accra for a 12-month fixed term contract, Excel and SQL required',
    has: [/Accra/, /12.month/i, /SQL/],
    not: [/Kinshasa/, /Qui sommes/],
  },
  {
    id: 'contact',
    brief:
      'Cuisinière à Libreville, envoyer CV au 06 600 00 00 ou a@zuafood.com, début le 5 janvier',
    has: [/Libreville/, /5 janvier/],
    not: [/600 00/, /@/, /Kinshasa/],
  },
  {
    id: 'hours',
    brief:
      'Caissier à Yaoundé du lundi au samedi de 8h à 17h, CDD 3 mois renouvelable, 2 ans en supermarché',
    has: [/Yaound[ée]/, /8 ?h/, /17 ?h/, /3 mois/, /CDD/, /(2|deux) ans/i],
    not: [/Kinshasa/],
  },
];

async function main() {
  const arg = (name: string) =>
    process.argv
      .find((a) => a.startsWith(`--${name}=`))
      ?.slice(name.length + 3);
  const [provider, ...name] = (arg('model') ?? 'openai:gpt-4o-mini').split(':');
  const spec = { provider, model: name.join(':') } as LlmProviderSpec;
  const path = arg('writer');
  const writer = (await import(
    path ? resolve(path) : '../src/modules/business/offer-writer/offer-writer'
  )) as typeof import('../src/modules/business/offer-writer/offer-writer');
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
  const llm = new LlmService(new LlmModelFactory(cfg), breaker as never, cfg);
  let checks = 0;
  let right = 0;
  let invented = 0;
  let vague = 0;
  let again = 0;
  let thinOnes = 0;
  let tokens = 0;
  for (const c of CASES) {
    const input: OfferBrief = { ...FORM, ...c.form, brief: c.brief };
    const { output, telemetry } = await llm.invokeWith(
      spec,
      writer.draftMessages(input, TRADES),
      {
        tier: 'writing',
        timeoutMs: 60_000,
      },
    );
    tokens += (telemetry.inputTokens ?? 0) + (telemetry.outputTokens ?? 0);
    let draft = writer.parseDraft(output.content as string, TRADES, input);
    // As the service does: once more for what it forgot.
    const gaps =
      draft && writer.problems ? writer.problems(draft, c.brief) : [];
    if (draft && gaps.length > 0) {
      again++;
      const { output: second } = await llm.invokeWith(
        spec,
        [
          ...writer.draftMessages(input, TRADES),
          new AIMessage(output.content),
          new HumanMessage(writer.problemsReminder(gaps)),
        ],
        { tier: 'writing', timeoutMs: 60_000 },
      );
      const better = writer.parseDraft(second.content as string, TRADES, input);
      if (better && writer.problems(better, c.brief).length < gaps.length) {
        draft = better;
      }
    }
    if (!draft) {
      console.log(`${c.id}: unreadable`);
      checks += c.has.length + c.not.length;
      continue;
    }
    const body = draft.description.split(/\n\n/).slice(1).join('\n\n');
    const missing = c.has.filter((r) => !r.test(draft.description));
    const wrong = c.not.filter((r) => r.test(body));
    const figures = (draft.description.match(/\d+/g) ?? []).filter(
      (n) => !`${c.brief} ${input.businessName}`.includes(n),
    );
    const empty = (
      body.match(
        /essentiel pour|bon fonctionnement|efficacité opérationnelle|dynamique et motiv|soutenir notre équipe/gi,
      ) ?? []
    ).length;
    // Missions and skills: an offer may be right and say nothing.
    const opens =
      /(Le poste\nNous (recherchons|recrutons|cherchons)|The role\nWe)/.test(
        draft.description,
      );
    if (!opens) console.log(`${c.id}: does not open with who is looked for`);
    const thin = (draft.description.match(/^- /gm) ?? []).length < 8;
    if (thin) thinOnes++;
    checks += c.has.length + c.not.length;
    right += c.has.length + c.not.length - missing.length - wrong.length;
    invented += figures.length;
    vague += empty;
    console.log(
      `${c.id}: ${missing.length + wrong.length ? 'WRONG' : 'ok'}${missing.length ? ` missing ${missing.join(' ')}` : ''}${wrong.length ? ` has ${wrong.join(' ')}` : ''}${figures.length ? ` invented ${figures.join(',')}` : ''} | removed ${JSON.stringify(draft.removed)} | place ${JSON.stringify(draft.place ?? null)} changes ${JSON.stringify(draft.changes ?? [])} toConfirm ${JSON.stringify(draft.toConfirm)}`,
    );
    if (process.argv.includes(`--show=${c.id}`))
      console.log(`\n${draft.title}\n${draft.description}\n`);
  }
  console.log(
    `TOTAL ${right}/${checks} facts right, ${invented} invented figures, ${vague} empty phrases, ${again} asked again, ${thinOnes} thin, ${Math.round(tokens / CASES.length)} tokens an offer`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
