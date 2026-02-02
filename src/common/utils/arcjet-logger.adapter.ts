import { Logger } from '@nestjs/common';
import { format as utilFormat } from 'node:util';

type LogMethod = (
  msgOrObj: string | Record<string, unknown>,
  msg?: string,
  ...args: unknown[]
) => void;

function formatArcjetMessage(
  msgOrObj: string | Record<string, unknown>,
  msg?: string,
  ...args: unknown[]
): string {
  const template = typeof msgOrObj === 'string' ? msgOrObj : (msg ?? '');
  const formatArgs = typeof msgOrObj === 'string' ? [msg, ...args] : args;
  const validArgs = formatArgs.filter((a) => a !== undefined);
  if (validArgs.length === 0) return template;
  try {
    return utilFormat(template, ...validArgs);
  } catch {
    return `${template} ${validArgs.map(String).join(' ')}`;
  }
}

export function createArcjetLoggerAdapter(context = 'Arcjet'): {
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
} {
  const logger = new Logger(context);
  return {
    debug(msgOrObj, msg?, ...args) {
      logger.debug(formatArcjetMessage(msgOrObj, msg, ...args));
    },
    info(msgOrObj, msg?, ...args) {
      logger.log(formatArcjetMessage(msgOrObj, msg, ...args));
    },
    warn(msgOrObj, msg?, ...args) {
      logger.warn(formatArcjetMessage(msgOrObj, msg, ...args));
    },
    error(msgOrObj, msg?, ...args) {
      logger.error(formatArcjetMessage(msgOrObj, msg, ...args));
    },
  };
}
