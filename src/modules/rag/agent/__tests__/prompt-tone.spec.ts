import { ProfileType, VerificationStatus } from '@prisma/client';
import { buildSystemPrompt } from '../prompts';

const base = {
  firstName: 'Marie',
  profileType: ProfileType.WORKER,
  categorySlugs: [],
  knownCategorySlugs: [],
  grounding: [],
  requiredTools: [],
  language: 'fr' as const,
};

const promptFor = (verificationStatus: VerificationStatus) =>
  buildSystemPrompt({ ...base, verificationStatus });

const verified = promptFor(VerificationStatus.VERIFIED);

describe('la salutation', () => {
  /**
   * Vient d'un échange réel : « Bonsoir Rabotka 😊, merci » a reçu « Dites-moi,
   * que puis-je faire pour vous ce soir ? ». Le message contenait « merci »,
   * donc la règle du remerciement s'appliquait, et celle de la salutation ne
   * couvrait que les « bonjour » tout seuls.
   */
  it('impose de rendre la salutation avant de répondre', () => {
    expect(verified).toContain('Rends la salutation EN PREMIER');
  });

  it('couvre le bonsoir accompagné, pas seulement le bonjour seul', () => {
    expect(verified).toContain("même au milieu d'une autre phrase");
  });

  it('met le prénom en gras dans la salutation', () => {
    expect(verified).toContain('Bonsoir *Marie* !');
  });

  it('interdit de commencer par une question à qui vient de saluer', () => {
    expect(verified).toContain(
      'Ne commence jamais une réponse par une question',
    );
  });

  it('bannit aussi « que puis-je faire pour vous »', () => {
    // La règle nommait « comment puis-je vous aider ? » ; la variante employée
    // sur ce vrai message passait à travers.
    expect(verified).toContain('que puis-je faire pour vous');
  });

  it("survit à l'absence de prénom", () => {
    const anon = buildSystemPrompt({
      ...base,
      firstName: null,
      verificationStatus: VerificationStatus.VERIFIED,
    });
    // Pas d'astérisques orphelins ni de « Bonsoir  ! » bancal à construire.
    expect(anon).not.toContain('**');
  });
});

describe('le prénom en gras', () => {
  it('est listé parmi les éléments à mettre en gras', () => {
    expect(verified).toContain('Le prénom de la personne se met en gras');
  });

  it('est limité à une occurrence par réponse', () => {
    expect(verified).toContain('Une seule fois dans la réponse');
  });
});

describe('les branches de vérification', () => {
  it('affirme « déjà vérifiée » uniquement quand c’est vrai', () => {
    expect(verified).toContain('déjà vérifiée');
    expect(promptFor(VerificationStatus.PENDING)).not.toContain(
      'déjà vérifiée',
    );
    expect(promptFor(VerificationStatus.REJECTED)).not.toContain(
      'déjà vérifiée',
    );
  });

  it('dit à un dossier REFUSÉ de passer par la réclamation', () => {
    const rejected = promptFor(VerificationStatus.REJECTED);
    expect(rejected).toContain('REFUSÉE');
    expect(rejected).toContain('réclamation');
    expect(rejected).toContain('ne peut pas renvoyer ses documents');
  });

  it('interdit de conseiller de recommencer la photo', () => {
    // Le produit n'a aucun écran pour ça : les pièces ne sont acceptées qu'à la
    // création du compte.
    expect(promptFor(VerificationStatus.REJECTED)).toContain(
      'jamais de recommencer sa photo',
    );
  });

  it('distingue PENDING de REJECTED', () => {
    const pending = promptFor(VerificationStatus.PENDING);
    expect(pending).toContain("en cours d'examen");
    expect(pending).not.toContain('REFUSÉE');
  });

  it('ne dit rien du tout quand le dossier est validé', () => {
    expect(verified).not.toContain("en cours d'examen");
    expect(verified).not.toContain('REFUSÉE');
  });
});

describe('le ton humain', () => {
  it('autorise les emojis, avec un plafond explicite', () => {
    expect(verified).toContain('UN par message');
    expect(verified).toContain('👋');
  });

  it('interdit la décoration', () => {
    expect(verified).toContain('Jamais un emoji par phrase');
  });

  /**
   * La partie qui compte.
   *
   * « Chaleureux et drôle » s'obtient facilement, et s'obtient facilement AU
   * MAUVAIS MOMENT. Un smiley sur un refus de vérification ou une vanne à
   * quelqu'un qui vient de se faire arnaquer donne l'impression qu'on n'a pas
   * compris ce qui lui arrive.
   */
  it.each([
    'vérification refusée',
    'pénalité',
    'suspension',
    'litige',
    'arnaque',
    'sécurité',
    'garde d’enfants',
  ])('coupe emojis et plaisanteries : %s', (topic) => {
    const block = verified.slice(verified.indexOf('AUCUN emoji'));
    expect(block.slice(0, 600)).toContain(topic.replace('’', "'"));
  });

  it('dit où passe la chaleur quand les emojis sont coupés', () => {
    expect(verified).toContain('La chaleur passe par ce que tu fais');
  });

  it('donne un exemple de ce qu’il ne faut PAS faire sur un refus', () => {
    // Sans contre-exemple, la consigne « sois chaleureux » l'emporte sur la
    // consigne « sauf ici », parce qu'elle est la seule illustrée.
    expect(verified).toContain('Oups, votre vérification a été refusée');
  });

  it('demande de reconnaître la situation sans réciter', () => {
    expect(verified).toContain('pas « je comprends votre frustration » récité');
  });
});
