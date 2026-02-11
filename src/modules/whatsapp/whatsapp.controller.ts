import {
  Controller,
  Get,
  Post,
  Res,
  HttpStatus,
  Query,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator.js';
import { WhatsAppService } from './whatsapp.service';
import { VerifyWhatsAppDto } from './dto/verify-whatsapp.dto';

const CONNECT_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect WhatsApp – Rabotka</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 360px;
      margin: 2rem auto;
      padding: 1rem;
      text-align: center;
      background: #0f0f0f;
      color: #e5e5e5;
      min-height: 100vh;
    }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p { color: #a3a3a3; font-size: 0.9rem; margin-bottom: 1.5rem; }
    #qr-wrap {
      background: #fff;
      padding: 1rem;
      border-radius: 12px;
      display: inline-block;
      margin-bottom: 1rem;
    }
    #qr-wrap img { display: block; border-radius: 4px; }
    #status { font-size: 0.85rem; margin-top: 1rem; }
    .connected { color: #22c55e; }
    .waiting { color: #eab308; }
    a { color: #3b82f6; }
  </style>
</head>
<body>
  <h1>Connect WhatsApp</h1>
  <p>Scan the QR code with WhatsApp: Linked devices → Link a device</p>
  <div id="qr-wrap" style="display: none;">
    <img id="qr-img" src="" alt="QR code" width="280" height="280" />
  </div>
  <div id="status" class="waiting">Checking connection…</div>
  <script>
    var base = '/api/v1/whatsapp/connect';
    function refresh() {
      fetch(base + '/status')
        .then(function(r) { return r.json(); })
        .then(function(d) {
          var wrap = document.getElementById('qr-wrap');
          var img = document.getElementById('qr-img');
          var status = document.getElementById('status');
          if (d.connected) {
            wrap.style.display = 'none';
            status.textContent = 'Connected. You can close this page.';
            status.className = 'connected';
            return;
          }
          if (d.hasQr) {
            img.src = base + '/qr-image?t=' + Date.now();
            wrap.style.display = 'inline-block';
            status.textContent = 'Scan the QR code with your phone. This page refreshes every 10s.';
            status.className = 'waiting';
          } else {
            wrap.style.display = 'none';
            status.textContent = 'Waiting for QR… Refresh the page in a few seconds.';
            status.className = 'waiting';
          }
        })
        .catch(function() {
          document.getElementById('status').textContent = 'Could not load status.';
        });
    }
    refresh();
    setInterval(refresh, 10000);
  </script>
</body>
</html>
`;

@ApiTags('WhatsApp')
@Controller('whatsapp')
@Public()
export class WhatsAppController {
  constructor(private readonly whatsAppService: WhatsAppService) {}

  @Get('connect/status')
  @ApiOperation({
    summary: 'WhatsApp connection status',
    description:
      'Returns whether WhatsApp is connected and if a QR code is available for pairing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Connection status',
    schema: {
      type: 'object',
      properties: {
        connected: { type: 'boolean' },
        hasQr: { type: 'boolean' },
      },
    },
  })
  getConnectStatus(): { connected: boolean; hasQr: boolean } {
    return this.whatsAppService.getConnectionStatus();
  }

  @Get('connect/qr-image')
  @ApiOperation({
    summary: 'WhatsApp QR code image',
    description: 'Returns the current pairing QR code as PNG, or 204 if none.',
  })
  @ApiResponse({ status: 200, description: 'PNG image of the QR code' })
  @ApiResponse({ status: 204, description: 'No QR code available' })
  async getQrImage(@Res() res: Response): Promise<void> {
    const buffer = await this.whatsAppService.getQrImageBuffer();
    if (buffer == null) {
      res.status(HttpStatus.NO_CONTENT).end();
      return;
    }
    res
      .setHeader('Content-Type', 'image/png')
      .setHeader('Cache-Control', 'no-store')
      .send(buffer);
  }

  @Get('connect')
  @ApiOperation({
    summary: 'WhatsApp connect page',
    description:
      'HTML page that shows the pairing QR code. Open in a browser to connect WhatsApp.',
  })
  @ApiResponse({ status: 200, description: 'HTML page' })
  connectPage(@Res() res: Response): void {
    res
      .setHeader('Content-Type', 'text/html; charset=utf-8')
      .send(CONNECT_HTML);
  }

  @Get('verify')
  @ApiOperation({
    summary: 'Verify WhatsApp token',
    description:
      'Verifies a WhatsApp verification token and links WhatsApp to the user profile. Token must be valid and not expired. Called automatically when user clicks the verification link.',
  })
  @ApiQuery({
    name: 'token',
    type: String,
    description: 'Verification token received via WhatsApp',
    example: 'abc123def456',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'WhatsApp verified successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid or expired token',
  })
  async verifyWhatsApp(
    @Query() verifyWhatsAppDto: VerifyWhatsAppDto,
  ): Promise<{ success: boolean }> {
    try {
      await this.whatsAppService.verifyWhatsAppToken(verifyWhatsAppDto.token);
      return { success: true };
    } catch (error: any) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        error.message || 'Invalid verification token',
      );
    }
  }
}
