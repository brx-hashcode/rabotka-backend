export const REDIS_CONNECTION = 'REDIS_CONNECTION';

const env = process.env.IS_PROD === 'true' ? 'prod' : 'dev';
export const REDIS_KEY_PREFIX = `rabotka:${env}:`;
