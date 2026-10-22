import { GuardService } from '../guard.service';

/**
 * Pentest A2-NV12 (#888): the outbound queue decodes `[CTA:]`, `[TPL:…]` and
 * `[IMG:` from any reply string, VoVa's model text included — so a planted
 * job description could steer the model into a button to an outside url, or
 * a billed template.
 */
describe('GuardService — in-band send markers', () => {
  const guard = new GuardService({ get: () => undefined } as never);

  it.each([
    [
      'a CTA',
      '[CTA:]{"body":"x","buttonText":"Go","url":"https://evil.example"}',
    ],
    ['a template', '[TPL:broadcastAnnouncement]{"message":"x"}'],
    ['media', '[IMG:https://evil.example/a.png] voici'],
  ])('strips %s from model output', (_what, reply) => {
    const { text, blocked } = guard.sanitize(reply);

    expect(text).not.toMatch(/\[(CTA|TPL|IMG):/i);
    expect(blocked).toContain('control_marker');
  });

  it('leaves ordinary brackets alone', () => {
    const { text } = guard.sanitize('Il y a [3] missions ouvertes.');
    expect(text).toContain('[3]');
  });
});
