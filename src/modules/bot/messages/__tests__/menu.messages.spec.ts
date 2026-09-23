import {
  openAppBotMessage,
  supportCardBotMessage,
  whatsappSupportLink,
} from '../menu.messages';
import { OPEN_APP_CTA_PATH } from '../../../../common/constants/whatsapp-templates';

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

describe('the app card', () => {
  const card = (reply: string) =>
    JSON.parse(reply.slice('[CTA:]'.length)) as Record<string, unknown>;

  it('is built by the bot, with a button', () => {
    // It used to be sent as its approved template, on the belief that only a
    // template's button opens WhatsApp's in-app browser. A free-form cta_url
    // carries the same button and, inside the 24h window, costs nothing.
    const payload = card(openAppBotMessage('Fariol'));
    expect(payload.buttonText).toBe('Voir mon compte');
    expect(payload.path).toBe(OPEN_APP_CTA_PATH);
  });

  it('reads as a card, not as a pasted letter', () => {
    // A template arrives cold and has to reintroduce itself and sign off. This
    // is the last line of a conversation already in progress, where a greeting
    // and a signature read like a letter somebody pasted in.
    const body = String(card(openAppBotMessage('Fariol')).body);

    expect(body).not.toContain('Bonjour');
    expect(body).not.toContain('L’équipe Rabotka');
    expect(body).not.toContain('Suite à votre message');
    expect(body.split('\n').length).toBeLessThanOrEqual(2);
  });

  it('keeps the template only for a window that shut in between', () => {
    const payload = card(openAppBotMessage('Fariol'));
    expect(payload.fallbackTemplate).toBe('openApp');
    // The template is the one that has to name the person.
    expect(payload.fallbackVariables).toMatchObject({ '1': 'Fariol' });
  });
});
