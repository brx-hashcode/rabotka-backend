/** A CV of a screening was decided: the business's open pages refresh the list. */
export const CV_SCREENING_PROGRESS = 'cv-screening.progress';

export type CvScreeningProgress = {
  profileId: string;
  screeningId: string;
  done: number;
  total: number;
};

/** « Ré-analyser »: applicants scored on their profile, to score again. */
export const CV_GRID_RESCORE = 'cv-grid.rescore';

export type CvGridRescore = { applicationIds: string[] };
