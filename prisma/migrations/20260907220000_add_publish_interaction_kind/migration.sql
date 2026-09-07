-- AlterEnum
-- Publishing an offer is an employer's most deliberate statement of the sector
-- they hire in. It was the one such action the interaction log had no word for,
-- so an employer's category affinity could only ever come from the categories
-- they ticked once at signup.
ALTER TYPE "InteractionKind" ADD VALUE 'PUBLISH';
