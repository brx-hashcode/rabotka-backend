import type { TemplateKey, TemplateParams } from '../messages.types';
import { WHATSAPP_TEMPLATES } from '../../../../common/constants/whatsapp-templates';

/**
 * These assertions are mostly for the COMPILER — the brief requires template
 * params to be typed per template rather than `Record<string, string>`, and the
 * only way that regresses is silently, by `TemplateParams` widening to `any`.
 * A runtime-only test would never notice.
 */
describe('TemplateParams', () => {
  it('resolves a scalar-param template to that scalar', () => {
    const name: TemplateParams<'kyc'> = 'Fariol';
    // '2' is the CTA destination behind "Accéder à Rabotka", swapped for a
    // login code on the way out — not a body parameter.
    expect(WHATSAPP_TEMPLATES.kyc.variables(name)).toEqual({
      '1': 'Fariol',
      '2': 'home',
    });
  });

  it('resolves an object-param template to its exact shape', () => {
    const params: TemplateParams<'jobRecommendation'> = {
      firstName: 'Fariol',
      title: 'Plombier',
      amount: '25000',
      address: 'Brazzaville',
      date: '12/08',
      jobOfferId: 'offer-1',
    };
    expect(
      WHATSAPP_TEMPLATES.jobRecommendation.variables(params),
    ).toMatchObject({ '1': 'Fariol', '6': 'offer-1' });
  });

  it('resolves a no-param template to undefined', () => {
    const none: TemplateParams<'applicationRejected'> = undefined;
    expect(none).toBeUndefined();
    expect(WHATSAPP_TEMPLATES.applicationRejected.variables()).toEqual({
      '1': 'recherche-offres',
    });
  });

  it('rejects params belonging to a different template', () => {
    // @ts-expect-error jobRecommendation does not take { jobTitle }
    const wrong: TemplateParams<'jobRecommendation'> = { jobTitle: 'Plombier' };
    expect(wrong).toBeDefined();
  });

  it('rejects a scalar where an object is required', () => {
    // @ts-expect-error reminder24h takes an object, not a string
    const wrong: TemplateParams<'reminder24h'> = 'nope';
    expect(wrong).toBeDefined();
  });

  it('covers every registry entry', () => {
    const keys = Object.keys(WHATSAPP_TEMPLATES) as TemplateKey[];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(typeof WHATSAPP_TEMPLATES[key].variables).toBe('function');
    }
  });
});
