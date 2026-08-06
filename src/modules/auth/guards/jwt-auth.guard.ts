import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import Redis from 'ioredis';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { clearAuthCookie, readAuthCookie } from '../auth-cookie.util';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../../common/services/redis/redis.constants';

export interface JwtPayload {
  sub: string;
  type?: 'profile' | 'admin';
  jti?: string;
  iat?: number;
  exp?: number;
}

export interface AuthenticatedRequest extends Request {
  user: {
    profileId?: string;
    userId?: string;
    type: 'profile' | 'admin';
  };
}

export interface ProfileAuthenticatedRequest extends Request {
  user: {
    profileId: string;
    type: 'profile';
  };
}

export interface AdminAuthenticatedRequest extends Request {
  user: {
    userId: string;
    type: 'admin';
  };
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Authentification requise');
    }

    try {
      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      if (payload.jti) {
        const blocked = await this.redis.get(
          `${REDIS_KEY_PREFIX}jwtblocklist:${payload.jti}`,
        );
        if (blocked)
          throw new UnauthorizedException('Session invalide ou expirée');
      }

      const tokenType = payload.type || 'profile';

      (request as AuthenticatedRequest).user = {
        ...(tokenType === 'profile'
          ? { profileId: payload.sub }
          : { userId: payload.sub }),
        type: tokenType,
      };

      return true;
    } catch (err) {
      // The cookie holds a token this server will never accept again (expired,
      // revoked, or signed by a retired secret). Leaving it in place means the
      // browser resends it on every request forever, and nothing on the client
      // can delete it — it is httpOnly. Mobile sends a bearer token and has no
      // cookie to clear, so only touch the response when one was actually sent.
      if (readAuthCookie(request, this.configService)) {
        clearAuthCookie(
          context.switchToHttp().getResponse<Response>(),
          this.configService,
        );
      }

      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Session invalide ou expirée');
    }
  }

  private extractToken(request: Request): string | undefined {
    const cookieToken = readAuthCookie(request, this.configService);
    if (cookieToken) {
      return cookieToken;
    }

    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    return undefined;
  }
}
