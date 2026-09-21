/**
 * One unit of broadcast work.
 *
 * `dispatch` walks the frozen recipient rows from `cursor` and re-queues itself
 * for the next page, rather than fanning out thousands of jobs up front: the
 * queue stays small, cancellation is checked between pages, and a crash resumes
 * from the last committed cursor instead of replaying the whole send.
 */
export type BroadcastJobData = {
  type: 'dispatch';
  broadcastId: string;
  /** How many recipient rows have already been handled. */
  cursor: number;
  /**
   * Which RUN this page belongs to — a fresh value for every send and every
   * retry.
   *
   * The continuation job's id is built from it. Without it the id was
   * `broadcast-<id>-<cursor>`, which repeats the moment a retry walks the same
   * cursors again: BullMQ keeps a completed job for an hour, so the second
   * run's continuation was silently dropped as a duplicate, `finish()` never
   * ran, and the broadcast sat in SENDING for ever.
   */
  runId: string;
};
