import { BadRequestException } from '@nestjs/common';
import { RecurrenceFrequency } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { CreateEventDto } from '../dto/create-event.dto';
import { EventSeriesService } from '../services/event-series.service';
import { RecurrenceExpanderService } from '../services/recurrence-expander.service';

/**
 * The rule that stops a repeating event from stacking on every day.
 *
 * Kept separate from the writing paths on purpose: the guard has to reject
 * before anything reaches the database, so these tests hand it a Prisma double
 * that fails loudly if it is ever touched.
 */
describe('EventSeriesService — occurrence/interval guard', () => {
  const untouchedPrisma = new Proxy(
    {},
    {
      get() {
        throw new Error('the guard must reject before writing anything');
      },
    },
  ) as PrismaService;

  const service = new EventSeriesService(
    untouchedPrisma,
    new RecurrenceExpanderService(),
  );

  const dto = (startDate: string, endDate?: string) =>
    ({
      title: 'Lunch',
      description: 'Lunch',
      color: 'blue',
      startDate,
      endDate,
    }) as CreateEventDto;

  const create = (
    frequency: RecurrenceFrequency,
    startDate: string,
    endDate?: string,
  ) => service.createSeries(dto(startDate, endDate), { frequency }, 'user-1');

  it('rejects a weekly event that outlasts the week it repeats over', async () => {
    // The shape behind "my event is duplicated on every day": each occurrence is
    // still running when the next forty start, so day 280 carries forty bars.
    await expect(
      create(
        RecurrenceFrequency.WEEKLY,
        '2026-08-17T09:00:00.000Z',
        '2030-08-17T09:00:00.000Z',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an occurrence exactly as long as its interval', async () => {
    // Touching ends still put two occurrences on the same day, every day.
    await expect(
      create(
        RecurrenceFrequency.DAILY,
        '2026-08-17T09:00:00.000Z',
        '2026-08-18T09:00:00.000Z',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('names the frequency and its ceiling, so the message says what to change', async () => {
    await expect(
      create(
        RecurrenceFrequency.MONTHLY,
        '2026-08-17T09:00:00.000Z',
        '2027-08-17T09:00:00.000Z',
      ),
    ).rejects.toThrow(/repeats monthly.*at most a month/s);
  });

  it('lets a multi-day event through when it still fits the interval', async () => {
    // Tue→Fri, repeating weekly: long, but finished before the next one starts.
    // Reaching Prisma at all is the pass condition — the double throws on use.
    await expect(
      create(
        RecurrenceFrequency.WEEKLY,
        '2026-08-18T09:00:00.000Z',
        '2026-08-21T17:00:00.000Z',
      ),
    ).rejects.toThrow('the guard must reject before writing anything');
  });

  it('lets an event with no end date through, at its default duration', async () => {
    await expect(
      create(RecurrenceFrequency.DAILY, '2026-08-17T09:00:00.000Z'),
    ).rejects.toThrow('the guard must reject before writing anything');
  });
});
