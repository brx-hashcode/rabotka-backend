import { anthropicParams } from '../model-factory.service';

describe('anthropicParams', () => {
  it('leaves claude-haiku-4-5 as it was', () => {
    expect(anthropicParams('claude-haiku-4-5', 0.2)).toEqual({
      temperature: 0.2,
    });
  });

  it('sends claude-haiku-5-5 no temperature, and no thinking', () => {
    expect(anthropicParams('claude-haiku-5-5', 0.2)).toEqual({
      temperature: undefined,
      thinking: { type: 'disabled' },
      maxTokens: 16_384,
    });
  });

  it.each(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-4-8'])(
    'sends %s no temperature, and leaves its thinking alone',
    (model) => {
      const params = anthropicParams(model, 0.2);
      expect(params.temperature).toBeUndefined();
      expect(params).not.toHaveProperty('thinking');
    },
  );
});
