import {
  CHART_TOOL,
  chartTools,
  criteriaChart,
  criteriaLine,
  experienceChart,
  scoresChart,
  shortNames,
  type ChartResume,
} from '../cv-chart';

const cv = (
  name: string,
  score: number,
  criteria: Record<string, number | null>,
  months?: { total: number; relevant: number },
): ChartResume => ({
  score,
  criteria,
  candidate: {
    name,
    experienceMonths: months?.total ?? null,
    relevantMonths: months?.relevant ?? null,
  },
});

const glody = cv(
  'Glody Mbutwile',
  91,
  { skills: 92, experience: 88, training: null },
  { total: 101, relevant: 97 },
);
const fariol = cv(
  'Fariol Blondeau N.',
  85,
  { skills: 85, experience: 78, training: null },
  { total: 37, relevant: 36 },
);
const fariol2 = cv('Fariol Blondeau NZIODZIAMI', 85, {
  skills: 88,
  experience: 80,
  training: null,
});

describe('shortNames', () => {
  it('says more of a name only where two would read the same', () => {
    expect(
      shortNames([
        'Glody Mbutwile',
        'Fariol Blondeau N.',
        'Fariol Blondeau NZIODZIAMI',
      ]),
    ).toEqual(['Glody M.', 'Fariol Blondeau N.', 'Fariol Blondeau NZIODZIAMI']);
  });
});

describe('charts', () => {
  it('scores: one bar per candidate, out of 100', () => {
    expect(scoresChart([glody, fariol], 'fr')).toEqual({
      v: 1,
      kind: 'bar',
      layout: 'horizontal',
      title: 'Score global',
      unit: '/100',
      categories: ['Glody M.', 'Fariol N.'],
      series: [{ name: 'Score', values: [91, 85] }],
    });
  });

  it('criteria: grouped by criterion, one the job asks of nobody left out', () => {
    const spec = criteriaChart([glody, fariol, fariol2], 'en');
    expect(spec?.categories).toEqual(['Skills', 'Experience']);
    expect(spec?.series.map((s) => s.name)).toEqual([
      'Glody M.',
      'Fariol Blondeau N.',
      'Fariol Blondeau NZIODZIAMI',
    ]);
    expect(spec?.series[0].values).toEqual([92, 88]);
  });

  it('experience: years in total and related, null where the CV was read before', () => {
    const spec = experienceChart([glody, fariol2], 'fr');
    expect(spec?.unit).toBe(' ans');
    expect(spec?.series).toEqual([
      { name: 'Expérience totale', values: [8.4, null] },
      { name: 'En lien avec le poste', values: [8.1, null] },
    ]);
    expect(experienceChart([fariol2], 'fr')).toBeNull();
  });

  it('criteria for the chats’ context', () => {
    expect(criteriaLine(glody)).toBe(
      'Scores par critère : Compétences 92, Expérience 88',
    );
    expect(criteriaLine({ criteria: null })).toBeNull();
  });
});

describe('chartTools', () => {
  it('draws the chart asked for, from these CVs only', () => {
    const tools = chartTools([glody, fariol, fariol2], 'fr', [
      'scores',
      'criteres',
    ]);
    expect(tools.definitions[0].name).toBe(CHART_TOOL);

    const all = tools.call(CHART_TOOL, { type: 'scores' });
    expect(all.fence).toMatch(/^\n\n```rabotka-chart\n\{.*\}\n```\n\n$/);
    expect(all.note).toContain('Score global');

    const two = tools.call(CHART_TOOL, {
      type: 'scores',
      candidats: ['Glody', 'NZIODZIAMI'],
    });
    const spec = JSON.parse(two.fence!.split('\n')[3]);
    expect(spec.categories).toEqual(['Glody M.', 'Fariol N.']);
  });

  it('refuses a chart this chat does not offer, or a tool it does not have', () => {
    const tools = chartTools([glody], 'fr', ['criteres']);
    expect(tools.call(CHART_TOOL, { type: 'scores' }).fence).toBeNull();
    expect(tools.call('autre', {}).fence).toBeNull();
  });
});
