import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The reminder spec builds the processor by hand, so it passes whatever the
 * worker really gives it. That is how every in-app notice of this processor
 * was lost in production with the suite green.
 */
describe('the worker builds ReminderProcessor', () => {
  const source = readFileSync(
    join(__dirname, '../../../../worker.module.ts'),
    'utf8',
  );
  const construction = source.slice(
    source.indexOf('return new ReminderProcessor('),
    source.indexOf('return new ReminderProcessor(') + 400,
  );

  it('with the route to the bell and the mail', () => {
    expect(construction).toContain('workerInAppEvents(inApp)');
    expect(construction).toContain('mail,');
    expect(construction).toContain('layout,');
  });
});
