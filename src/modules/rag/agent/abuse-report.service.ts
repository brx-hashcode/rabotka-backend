import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ClaimStatus } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { ClaimService } from '../../claim/claim.service';

/**
 * Le signalement déposé quand quelqu'un persiste à insulter l'assistant.
 *
 * POURQUOI CE FICHIER EXISTE PLUTÔT QU'UN OUTIL DU MODÈLE.
 *
 * `read-only.ts` interdit à l'agent de créer une réclamation, et la raison y est
 * écrite : « une mutation déclenchée par une phrase est une mutation déclenchée
 * par quiconque peut écrire cette phrase ». Donner un outil `creer_reclamation`
 * au modèle aurait rendu ce dépôt atteignable par n'importe quel message bien
 * tourné — y compris pour ouvrir une réclamation au nom de quelqu'un d'autre.
 *
 * Ce service n'est donc PAS branché sur `tool-deps.provider.ts`. Il est appelé
 * par le pipeline, après un compteur, sur un critère fixe. Le modèle n'a
 * toujours aucun moyen d'écrire quoi que ce soit, et l'invariant tient.
 *
 * La réclamation est VISIBLE par la personne concernée : elle la retrouvera dans
 * *Réclamations*. C'est un choix, pas un effet de bord — elle a été avertie deux
 * fois avant, et découvrir un dossier qu'on ne peut pas lire serait pire.
 *
 * `ClaimService` est résolu par `ModuleRef` et non importé, pour la raison que
 * `tool-deps.provider.ts` explique en détail : `ClaimModule` importe
 * `AuthModule`, qui referme le nœud de cycles documenté dans `worker.module.ts`,
 * et l'application refuse alors de démarrer. Contrairement aux services des
 * outils, celui-ci n'est PAS enveloppé dans `readOnly()` — il écrit, c'est tout
 * son objet, et c'est le pipeline qui en décide.
 */
@Injectable()
export class AbuseReportService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AbuseReportService.name);
  private claims!: ClaimService;

  /** Préfixe stable : c'est lui qui rend le dépôt idempotent. */
  private static readonly TITLE = 'Signalement automatique — langage abusif';

  /** Au-delà, la personne est repartie sur un nouvel épisode. */
  private static readonly WINDOW_DAYS = 30;

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Résolu au démarrage, pas au premier signalement.
   *
   * `strict: false` lit dans tout le conteneur, au prix d'une erreur d'exécution
   * là où le compilateur ne voit rien. La résoudre ici la transforme en échec de
   * boot bruyant plutôt qu'en surprise le jour où quelqu'un insulte le bot.
   */
  onApplicationBootstrap(): void {
    this.claims = this.moduleRef.get(ClaimService, { strict: false });
  }

  async report(profileId: string, message: string): Promise<void> {
    try {
      if (await this.alreadyOpen(profileId)) {
        this.logger.debug(
          `Abuse report already open for ${profileId} — not filing another`,
        );
        return;
      }

      await this.claims.createForProfile(
        profileId,
        {
          title: AbuseReportService.TITLE,
          description: this.describe(message),
        },
        // Pas d'e-mail « Votre réclamation a été créée » : ce dossier est ouvert
        // SUR la personne, pas PAR elle. Elle est déjà prévenue dans la
        // conversation, dans des termes exacts — un e-mail qui la félicite
        // d'avoir déposé son propre signalement dirait le contraire.
        { notifyProfile: false },
      );

      this.logger.warn(`Abuse report filed for profile ${profileId}`);
    } catch (err) {
      // Un signalement qui échoue ne doit pas empêcher la réponse de partir :
      // la personne reçoit son avertissement, l'équipe verra le log.
      this.logger.error(
        `Could not file the abuse report for ${profileId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Sans ça, chaque message abusif au-delà du seuil crée une réclamation de
   * plus — le support se retrouverait avec quinze dossiers pour un échange.
   */
  private async alreadyOpen(profileId: string): Promise<boolean> {
    const since = new Date(
      Date.now() - AbuseReportService.WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    const existing = await this.prisma.claim.findFirst({
      where: {
        profile_id: profileId,
        title: AbuseReportService.TITLE,
        created_at: { gte: since },
        // Encore ouverte : ni traitée, ni rejetée par le support.
        status: { in: [ClaimStatus.CREATED, ClaimStatus.IN_PROGRESS] },
      },
      select: { id: true },
    });

    return existing !== null;
  }

  /**
   * Factuel, daté, sans commentaire.
   *
   * La personne lira ce texte. Y mettre un jugement — « comportement
   * inacceptable », « agressivité caractérisée » — donnerait à l'équipe une
   * conclusion à la place des faits, et à la personne une raison de plus
   * d'envenimer. On cite, on date, on s'arrête.
   */
  private describe(message: string): string {
    return [
      'Réclamation ouverte automatiquement par VoVa AI.',
      '',
      `Le ${new Date().toLocaleDateString('fr-FR')}, cette conversation a contenu ` +
        "plusieurs messages insultants ou menaçants envers l'assistant, malgré un " +
        'avertissement rappelant que le compte pouvait être suspendu.',
      '',
      'Dernier message concerné :',
      `« ${message.trim()} »`,
      '',
      "L'échange complet est consultable dans l'historique WhatsApp du profil.",
    ].join('\n');
  }
}
