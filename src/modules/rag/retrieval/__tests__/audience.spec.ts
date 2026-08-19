import { audienceValues } from '../help-docs.store';

/**
 * Who gets to see which passages.
 *
 * The distinction that matters is `anonymous` versus *no argument at all*:
 * omitting the audience means no filter and therefore every passage, which is
 * the opposite of what a caller with no account should see. Getting these two
 * confused would quietly hand a stranger worker-only instructions.
 */
describe('audienceValues', () => {
  it('gives a worker the shared passages and their own', () => {
    expect(audienceValues('worker')).toEqual(['all', 'worker']);
  });

  it('gives an employer the shared passages and their own', () => {
    expect(audienceValues('employer')).toEqual(['all', 'employer']);
  });

  it('gives an anonymous caller the shared passages only', () => {
    // Someone with no account cannot open *Mes réalisations* or *Candidatures
    // reçues*; a passage about a screen they cannot reach reads as an
    // instruction they are failing to follow.
    expect(audienceValues('anonymous')).toEqual(['all']);
  });

  it('never leaks one role’s passages to the other', () => {
    expect(audienceValues('worker')).not.toContain('employer');
    expect(audienceValues('employer')).not.toContain('worker');
    expect(audienceValues('anonymous')).not.toContain('worker');
    expect(audienceValues('anonymous')).not.toContain('employer');
  });
});
