import {
  Controller,
  Get,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../auth/decorators/public.decorator';
import { AdLinkTrackingService } from '../services/ad-link-tracking.service';

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
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      typeof forwarded === 'string'
        ? forwarded.split(',')[0]?.trim()
        : req.ip;
    const target = await this.tracking.resolveAndTrackClick(hash, {
      ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.redirect(target);
  }
}
