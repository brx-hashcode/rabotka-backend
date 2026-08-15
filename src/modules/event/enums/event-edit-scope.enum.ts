/**
 * Which occurrences an edit or a delete reaches.
 *
 * The three choices Google Calendar offers, because a repeating event has no
 * single right answer: cancelling one week's standup, moving every standup from
 * now on, and renaming the whole series are all ordinary things to want.
 *
 * THIS is the default everywhere, so a caller that says nothing — including
 * every request made before this existed — touches exactly one row.
 */
export enum EventEditScope {
  THIS = 'THIS',
  THIS_AND_FOLLOWING = 'THIS_AND_FOLLOWING',
  ALL = 'ALL',
}
