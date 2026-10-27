/** A CV of a screening was decided: the business's open pages refresh the list. */
export const CV_SCREENING_PROGRESS = 'cv-screening.progress';

export type CvScreeningProgress = {
  profileId: string;
  screeningId: string;
  done: number;
  total: number;
};
