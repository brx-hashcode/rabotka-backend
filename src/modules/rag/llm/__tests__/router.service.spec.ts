import { LlmRouterService } from '../router.service';
import { foldText } from '../../shared/text';

describe('LlmRouterService', () => {
  const router = new LlmRouterService();
  const base = { hasTools: false, historyLength: 0 };

  it('sends a short greeting to the cheap tier', () => {
    for (const text of ['Bonjour', 'salut ', 'Mbote', 'ok', 'Merci !', 'hey']) {
      expect(router.route({ ...base, text })).toBe('cheap');
    }
  });

  it('ignores accents and punctuation, as a phone keyboard does', () => {
    expect(router.route({ ...base, text: 'Bonsoîr...' })).toBe('cheap');
    expect(foldText('Bonsoîr...')).toBe('bonsoir');
  });

  // A turn that can reach a fee, a balance or a corpus chunk is never cheap.
  it('sends anything with tools to the standard tier', () => {
    expect(router.route({ ...base, text: 'bonjour', hasTools: true })).toBe(
      'standard',
    );
  });

  it('sends anything with history to the standard tier', () => {
    expect(router.route({ ...base, text: 'bonjour', historyLength: 1 })).toBe(
      'standard',
    );
  });

  it('sends real questions to the standard tier', () => {
    for (const text of [
      'comment payer mes penalites ?',
      "j'ai un probleme avec ma candidature",
      'combien coute le deblocage',
    ]) {
      expect(router.route({ ...base, text })).toBe('standard');
    }
  });

  it('does not treat a long message as a greeting just because it opens with one', () => {
    expect(
      router.route({
        ...base,
        text: 'bonjour je voudrais savoir comment publier une mission svp',
      }),
    ).toBe('standard');
  });

  it('sends empty input to the standard tier rather than guessing', () => {
    expect(router.route({ ...base, text: '   ' })).toBe('standard');
  });
});
