import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';

export interface JwtPayload {
  sub: string;
  type?: 'profile' | 'admin';
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
  ) {}

  canActivate(context: ExecutionContext): boolean {
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
      throw new UnauthorizedException('auth.errors.no_token');
    }

    try {
      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      const tokenType = payload.type || 'profile';

      (request as AuthenticatedRequest).user = {
        ...(tokenType === 'profile'
          ? { profileId: payload.sub }
          : { userId: payload.sub }),
        type: tokenType,
      };

      return true;
    } catch {
      throw new UnauthorizedException('auth.errors.invalid_token');
    }
  }

  private extractToken(request: Request): string | undefined {
    const cookieName = this.configService.get<string>('AUTH_COOKIE_NAME');

    if (!cookieName) {
      throw new Error('AUTH_COOKIE_NAME is not set');
    }

    const cookieToken = request.cookies?.[cookieName];
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
