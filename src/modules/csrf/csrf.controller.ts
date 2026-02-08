import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CSRF_UTILITIES } from './csrf.constants';
import type { DoubleCsrfUtilities } from 'csrf-csrf';

@ApiTags('CSRF')
@Controller('csrf')
export class CsrfController {
  constructor(
    @Inject(CSRF_UTILITIES) private readonly csrfUtilities: DoubleCsrfUtilities,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Generate a CSRF token',
    description:
      'Generates a CSRF token for the client to use in the x-csrf-token header',
  })
  @ApiOkResponse({
    description:
      'Returns a CSRF token for the client to use in the x-csrf-token header',
    schema: { type: 'object', properties: { csrfToken: { type: 'string' } } },
  })
  getCsrfToken(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const csrfToken = this.csrfUtilities.generateCsrfToken(req, res);
    return { csrfToken };
  }
}
