import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { countSignupUpload } from '../signup-token';

/** Header carrying the token from POST /auth/signup/verify-otp. */
export const SIGNUP_TOKEN_HEADER = 'x-signup-token';

/**
 * Lets a KYC upload through only for a signup whose phone number was just
 * verified, and only up to SIGNUP_MAX_UPLOADS files per signup.
 *
 * A guard rather than a check in the handler: guards run BEFORE the file
 * interceptor, so a request without a valid token is refused before its body
 * — up to 10 MB — is read into memory.
 */
@Injectable()
export class SignupUploadGuard implements CanActivate {
  constructor(@Inject(REDIS_CONNECTION) private readonly redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = request.headers[SIGNUP_TOKEN_HEADER];
    const allowed = await countSignupUpload(
      this.redis,
      typeof token === 'string' ? token : null,
    );
    if (!allowed) {
      throw new ForbiddenException(
        'Vérifiez votre numéro avant d’envoyer vos documents, ou recommencez la vérification.',
      );
    }
    return true;
  }
}
