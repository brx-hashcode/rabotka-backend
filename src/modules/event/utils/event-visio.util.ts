import { newVisioRoom } from '../../../common/services/jitsi/jitsi-token';

/**
 * An event's visio room after an edit. `visio` left out keeps what there is;
 * false removes it; true keeps the room there is, or makes one. A room is
 * never replaced, so a link already sent keeps working.
 */
export function visioRoomFor(
  visio: boolean | undefined,
  current: string | null,
): string | null {
  if (visio === undefined) return current;
  if (!visio) return null;
  return current ?? newVisioRoom('RabotkaEvt');
}
