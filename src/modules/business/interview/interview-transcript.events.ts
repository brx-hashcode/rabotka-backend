/**
 * Sentences were added to an interview's transcription: the business's open
 * « Compte rendu » shows them at once, as the conversation goes.
 */
export const INTERVIEW_TRANSCRIPT_LINES = 'interview.transcript-lines';

export type InterviewTranscriptLines = {
  /** The business's profile: its socket room. */
  profileId: string;
  interviewId: string;
};
