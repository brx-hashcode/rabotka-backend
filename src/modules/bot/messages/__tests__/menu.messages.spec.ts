import { supportCardBotMessage, whatsappSupportLink } from '../menu.messages';

const contact = {
  email: 'contact@rabotka.work',
  phone: '+242 06 112 9696',
  address: '',
};

const decode = (reply: string) => {
  expect(reply.startsWith('[CTA:]')).toBe(true);
  return JSON.parse(reply.slice('[CTA:]'.length)) as Record<string, string>;
};

describe('supportCardBotMessage', () => {
  it('is a card whose button opens the support chat', () => {
    const cta = decode(supportCardBotMessage(contact));

    expect(cta.buttonText).toBe('Écrire au support');
    expect(cta.url).toBe(
      `https://wa.me/242061129696?text=${encodeURIComponent('Bonjour, j’ai besoin d’aide sur Rabotka.')}`,
    );
    expect(cta.body).toContain('*Support Rabotka*');
    expect(cta.body).toContain('contact@rabotka.work');
    expect(cta.body).toContain('+242 06 112 9696');
    expect(cta.fallbackText).toBe(cta.body);
    expect(cta.path).toBeUndefined();
  });

  it('says why when the account is suspended', () => {
    const cta = decode(
      supportCardBotMessage(contact, {
        suspended: true,
        reason: 'Comportement signalé',
      }),
    );

    expect(cta.body).toContain('Votre compte est suspendu.');
    expect(cta.body).toContain('Motif : Comportement signalé');
    expect(decodeURIComponent(cta.url)).toContain(
      'mon compte Rabotka est suspendu',
    );
  });

  // Nowhere to point the button: the plain card is still worth sending.
  it('stays plain text without a phone number', () => {
    const reply = supportCardBotMessage({ ...contact, phone: '' });

    expect(reply).not.toContain('[CTA:]');
    expect(reply).toContain('contact@rabotka.work');
  });
});

describe('whatsappSupportLink', () => {
  it('keeps only the digits of the number', () => {
    expect(whatsappSupportLink('+242 06-112 9696')).toMatch(
      /^https:\/\/wa\.me\/242061129696\?text=/,
    );
  });

  it('is null without digits', () => {
    expect(whatsappSupportLink(' - ')).toBeNull();
  });
});
