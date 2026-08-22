import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { ProfileType, VerificationStatus } from '@prisma/client';
import { buildAnonymousSystemPrompt, buildSystemPrompt } from '../prompts';
import { REPLY_MAX_CHARS, capLength } from '../guard.service';

/**
 * La profondeur des réponses, et la boucle d'interrogatoire.
 *
 * Deux transcripts réels ont motivé ce fichier. Dans l'un, VoVa pose quatre
 * fois la même question sans rien ouvrir. Dans l'autre, un assistant tiers
 * décrit Rabotka mieux que VoVa — parce que le plafond de 600 caractères
 * empêchait littéralement de livrer le « pourquoi » que le corpus contient.
 */

const registered = buildSystemPrompt({
  firstName: 'Marie',
  profileType: ProfileType.WORKER,
  verificationStatus: VerificationStatus.VERIFIED,
  categorySlugs: [],
  knownCategorySlugs: [],
  grounding: [],
  requiredTools: [],
  language: 'fr',
});

const anonymous = buildAnonymousSystemPrompt({ grounding: [], language: 'fr' });

describe('plafond de réponse', () => {
  it('laisse passer une réponse complète sur « c’est quoi Rabotka »', () => {
    // Mesuré sur corpus/c-est-quoi-rabotka.md :
    //   En bref + Pourquoi            664  <- dépassait déjà l'ancien plafond
    //     + Les deux côtés            927  <- doit tenir
    const complete = 'x'.repeat(927);
    expect(capLength(complete)).toHaveLength(927);
  });

  it('coupe encore ce qui part vraiment en digression', () => {
    // Le parcours en six étapes (1477) appartient à « comment ça marche ? »,
    // une AUTRE question. Le plafond force cette distinction plutôt que de
    // laisser tout arriver d'un bloc.
    expect(capLength('x'.repeat(1477)).length).toBeLessThanOrEqual(
      REPLY_MAX_CHARS,
    );
  });

  it('vaut 1200 — la valeur mesurée, pas un arrondi', () => {
    expect(REPLY_MAX_CHARS).toBe(1200);
  });
});

describe('longueur conditionnée au type de question', () => {
  it.each([
    ['inscrit', registered],
    ['anonyme', anonymous],
  ])('%s : bref pour un chiffre, développé pour une explication', (_l, p) => {
    expect(p).toContain('DEUX PHRASES');
    expect(p).toContain('VRAIE réponse');
  });

  it.each([
    ['inscrit', registered],
    ['anonyme', anonymous],
  ])('%s : interdit les tableaux, que WhatsApp n’affiche pas', (_l, p) => {
    expect(p).toContain('Jamais de tableau');
  });
});

describe('la boucle d’interrogatoire anonyme', () => {
  it('a une règle d’arrêt qui nomme /compte', () => {
    // Son absence est la cause : le prompt disait de demander ce que la
    // personne cherche, et rien ne disait quoi faire de la réponse.
    expect(anonymous).toContain('TERMINÉ de poser des questions');
    expect(anonymous).toContain('*/compte*');
  });

  it.each(['son métier', 'sa ville', 'ses disponibilités', 'son budget'])(
    'interdit nommément de demander %s',
    (quoi) => {
      // Une interdiction générale n'avait pas tenu : le modèle jugeait ses
      // propres questions utiles.
      expect(anonymous).toContain(quoi);
    },
  );

  it('interdit de creuser un métier donné spontanément', () => {
    expect(anonymous).toContain('ne rebondis pas dessus pour creuser');
  });

  it('propose deux options numérotées plutôt qu’une question ouverte', () => {
    // « 1 » ou « 2 » ferme le choix par construction ; « dans quel domaine ? »
    // a bouclé quatre fois.
    expect(anonymous).toContain('DEUX options numérotées');
    expect(anonymous).toContain("plutôt qu'une question ouverte");
  });
});

describe('salutation et présentation', () => {
  it.each([
    ['inscrit', registered],
    ['anonyme', anonymous],
  ])('%s : ne donne pas « Bonsoir » comme exemple unique', (_l, p) => {
    // L'exemple contredisait la règle : « avec le même mot » suivi du seul
    // « Bonsoir ! », et le modèle a répondu Bonsoir à un Bonjour de 14h35.
    const bonjour = (p.match(/Bonjour/g) ?? []).length;
    const bonsoir = (p.match(/Bonsoir/g) ?? []).length;
    expect(bonjour).toBeGreaterThan(0);
    expect(bonsoir).toBeGreaterThan(0);
  });

  it('anonyme : ne se présente qu’au tout premier message', () => {
    // Le prompt inscrit avait ce garde-fou, l'anonyme non — d'où une
    // re-présentation en plein milieu de conversation.
    expect(anonymous).toContain('TOUT PREMIER message');
  });

  it('anonyme : dit de ne pas deviner l’heure', () => {
    expect(anonymous).toContain("Tu n'as pas l'heure");
  });
});

describe('corpus contre schéma', () => {
  const corpus = (name: string) =>
    readFileSync(
      path.join(__dirname, '..', '..', 'retrieval', 'corpus', name),
      'utf8',
    );

  /**
   * La régression qui compte.
   *
   * VoVa a listé « carte d'étudiant » et « acte de naissance » comme pièces
   * acceptées. Ce n'était pas une hallucination : le corpus l'écrivait. Aucune
   * des deux n'existe dans `DocumentType`, et quelqu'un qui téléverse un acte
   * de naissance sur cette parole se fait refuser.
   *
   * Ce test attrape la prochaine dérive sans relecture humaine.
   */
  it.each(["carte d'étudiant", 'acte de naissance'])(
    'verification-kyc.md ne mentionne plus %s',
    (fantome) => {
      expect(corpus('verification-kyc.md')).not.toContain(fantome);
    },
  );

  it('verification-kyc.md nomme les quatre pièces réelles', () => {
    // DocumentType : IDENTITY_CARD, PASSPORT, DRIVER_LICENSE, NIU_CARD.
    const text = corpus('verification-kyc.md');
    for (const vraie of [
      'carte nationale',
      'passeport',
      'permis de conduire',
      'NIU',
    ]) {
      expect(text).toContain(vraie);
    }
  });

  it('aucun document du corpus ne parle du « site »', () => {
    // Le prompt interdit « site » et « navigateur » : pour la personne, tout
    // se passe dans l'application, qui s'ouvre dans WhatsApp.
    const dir = path.join(__dirname, '..', '..', 'retrieval', 'corpus');
    const files = readdirSync(dir);
    for (const file of files.filter((f) => f.endsWith('.md'))) {
      expect(corpus(file)).not.toMatch(/\b(le site|du site|navigateur)\b/);
    }
  });
});

/**
 * Le message du 22/08 à 13h14, capturé en production :
 *
 *   Utilisateur : « Bonjour, je cherche du travail »
 *   VoVa        : « Bonsoir ! 👋 … Vous cherchez une mission dans quel domaine ? »
 *
 * Quatre défauts dans une seule réponse : « Bonsoir » à 13h14, une question
 * alors que la personne avait déjà dit ce qu'elle voulait, aucune mention de
 * l'absence de compte, et une description qui décrit le même côté deux fois.
 */
describe('« Bonjour, je cherche du travail »', () => {
  it('impose de dire que le numéro n’a pas de compte', () => {
    expect(anonymous).toContain("n'a pas encore de compte Rabotka");
  });

  it('rend la sortie vers /compte systématique, pas optionnelle', () => {
    expect(anonymous).toContain('TOUTE réponse à quelqu');
    expect(anonymous).toContain('pas une conclusion polie');
  });

  it('interdit de redemander ce que la personne vient de dire', () => {
    expect(anonymous).toContain("EN MÊME TEMPS qu'elle te salue");
    expect(anonymous).toContain('ne propose pas les options');
  });

  it('ne propose les options QUE si l’intention est inconnue', () => {
    expect(anonymous).toContain("SEULEMENT si elle ne l'a pas déjà dit");
  });

  it('interdit d’inverser travailleur et recruteur', () => {
    // « met en relation des personnes cherchant une mission avec des
    // travailleurs disponibles » : les deux moitiés décrivent le travailleur.
    expect(anonymous).toContain('CHERCHE une mission est le travailleur');
    expect(anonymous).toContain('PROPOSE une mission est le recruteur');
  });
});
