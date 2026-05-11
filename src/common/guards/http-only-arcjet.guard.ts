import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ArcjetGuard } from '@arcjet/nest';

@Injectable()
export class HttpOnlyArcjetGuard implements CanActivate {
  constructor(private readonly arcjetGuard: InstanceType<typeof ArcjetGuard>) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    return this.arcjetGuard.canActivate(context) as Promise<boolean>;
  }
}
