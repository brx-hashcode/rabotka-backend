import { Global, Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';

/**
 * Global for the same reason RedisModule is: the claim is asked for at the
 * webhook boundary, in the queue worker and in the send path, and threading an
 * import through each of those modules buys nothing. It holds no state of its
 * own — REDIS_CONNECTION is where the state lives.
 */
@Global()
@Module({
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
