import { AssignmentStatus, type PrismaClient } from '@prisma/client';
import type { AnswerFilesService } from '../../answer-files/answer-files.service';
import { answerText } from '../../job-offer/offer-questions';
import type { ApplicantFacts, OfferFacts } from './applicant-assessment';

type Db = Pick<PrismaClient, 'application' | 'assignment' | 'portfolioItem'>;

const MAX_MISSIONS = 15;
const MAX_PORTFOLIO = 8;

/**
 * What the scoring and the applicant's CV text both read: the offer, and the
 * candidate as Rabotka knows them (trades, missions, publications, answers,
 * and the text of « Mon CV » when they sent it, contacts removed). A plain
 * function: a purged CV is rebuilt from it too, in the CV analysis module.
 */
export async function applicantFacts(
  prisma: Db,
  answerFiles: Pick<AnswerFilesService, 'notes'> | undefined,
  applicationId: string,
) {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: {
      job_offer: { include: { category: { select: { name: true } } } },
      answers: {
        select: { label: true, kind: true, value: true, passed: true },
        orderBy: { created_at: 'asc' },
      },
      profile_cv: { select: { cv_text: true } },
      worker: {
        include: {
          category: { select: { name: true } },
          categories: {
            include: { category: { select: { name: true } } },
          },
        },
      },
    },
  });
  if (!app) return null;
  const [missions, portfolio] = await Promise.all([
    prisma.assignment.findMany({
      where: { worker_id: app.worker_id, status: AssignmentStatus.COMPLETED },
      orderBy: { completed_at: 'desc' },
      take: MAX_MISSIONS,
      select: {
        completed_at: true,
        job_offer: {
          select: { title: true, category: { select: { name: true } } },
        },
      },
    }),
    prisma.portfolioItem.findMany({
      where: { profile_id: app.worker_id, description: { not: null } },
      orderBy: { position: 'asc' },
      take: MAX_PORTFOLIO,
      select: { description: true },
    }),
  ]);
  const w = app.worker;
  const trades = [
    ...new Set(
      [w.category?.name, ...w.categories.map((c) => c.category.name)].filter(
        (t): t is string => !!t,
      ),
    ),
  ];
  const o = app.job_offer;
  const offer: OfferFacts = {
    title: o.title,
    description: o.description,
    trade: o.category?.name ?? null,
    city: o.city,
    country: o.country_name,
    isRemote: o.is_remote,
    note: o.note,
  };
  const applicant: ApplicantFacts = {
    trades,
    description: w.description,
    city: w.city,
    country: w.country_name ?? null,
    memberSince: w.created_at,
    reliabilityScore: w.reliability_score,
    ratingAvg: w.rating_avg,
    ratingCount: w.rating_count,
    missions: missions.map((m) => ({
      title: m.job_offer.title,
      trade: m.job_offer.category?.name ?? null,
      completedAt: m.completed_at,
    })),
    portfolio: portfolio.map((p) => (p.description ?? '').slice(0, 200)),
    // A « Fichier » answer by the text of its file.
    answers: answerFiles
      ? await answerFiles.notes(app.answers ?? [])
      : (app.answers ?? []).map((x) => ({
          question: x.label,
          answer: answerText(x),
          knockoutFailed: x.passed === false,
        })),
    cvText: app.profile_cv?.cv_text || undefined,
  };
  return { app, offer, applicant };
}
