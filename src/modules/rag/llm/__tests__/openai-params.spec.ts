import { openAiParams } from '../model-factory.service';

describe('openAiParams', () => {
  it.each(['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5.4-mini', 'gpt-5-mini'])(
    'leaves %s as it was',
    (model) => {
      expect(openAiParams(model, 0.2)).toEqual({ temperature: 0.2 });
    },
  );

  it.each(['gpt-6-luna', 'gpt-6.1-terra', 'gpt-5.6-luna', 'gpt-5.6-terra'])(
    'turns reasoning off on %s, or it refuses a temperature',
    (model) => {
      expect(openAiParams(model, 0)).toEqual({
        temperature: 0,
        modelKwargs: { reasoning_effort: 'none' },
      });
    },
  );

  it.each(['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6-astra'])(
    'sends %s no temperature: it takes none',
    (model) => {
      expect(openAiParams(model, 0.2).temperature).toBeUndefined();
      expect(openAiParams(model, 0.2)).not.toHaveProperty('modelKwargs');
    },
  );
});
