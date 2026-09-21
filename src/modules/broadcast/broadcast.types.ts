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
};
