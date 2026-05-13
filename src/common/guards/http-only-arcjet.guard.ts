import { Injectable, type ExecutionContext, Inject } from '@nestjs/common';
import { ArcjetGuard, ARCJET } from '@arcjet/nest';

@Injectable()
export class HttpOnlyArcjetGuard extends ArcjetGuard {
  constructor(@Inject(ARCJET) aj: unknown) {
    super(aj as ConstructorParameters<typeof ArcjetGuard>[0]);
  }

  override canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return Promise.resolve(true);
    }
    return super.canActivate(context);
  }
}
