import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../auth/decorators/public.decorator';
import { AdLinkTrackingService } from '../services/ad-link-tracking.service';
import { clientIp } from '../../../common/utils/request-meta.util';

@Public()
@Controller('r')
export class AdTrackingController {
  constructor(private readonly tracking: AdLinkTrackingService) {}

  @Get(':hash')
  async redirect(
    @Param('hash') hash: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // The shared rule, not the client-written X-Forwarded-For (#879).
    const target = await this.tracking.resolveAndTrackClick(hash, {
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.redirect(target);
  }
}
