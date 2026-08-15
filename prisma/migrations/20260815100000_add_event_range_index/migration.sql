-- The calendar now asks for a visible window instead of downloading every row,
-- so the hot query is an interval overlap:
--
--   WHERE start_date <= :to AND end_date >= :from
--
-- A composite (start_date, end_date) index range-scans on the leading column
-- and evaluates the second from the index tuple, with no heap fetch to decide
-- the predicate. It subsumes the old single-column index, so that one goes —
-- created first, dropped second, so the table is never left without one.
CREATE INDEX "idx_event_start_end" ON "events" ("start_date", "end_date");

DROP INDEX "idx_event_start_date";
