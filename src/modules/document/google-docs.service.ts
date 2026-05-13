import { Injectable, BadRequestException } from '@nestjs/common';

@Injectable()
export class GoogleDocsService {
  async exportGoogleDocAsDocx(googleDocsId: string): Promise<Buffer> {
    const exportUrl = `https://docs.google.com/feeds/download/documents/export/Export?id=${googleDocsId}&exportFormat=docx`;
    const res = await fetch(exportUrl, { redirect: 'follow' });
    if (!res.ok) {
      throw new BadRequestException(
        `Could not export Google Doc (HTTP ${res.status}). Make sure the document is set to "Anyone with the link can view".`,
      );
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
      throw new BadRequestException(
        'Google Doc is private or not accessible. Set sharing to "Anyone with the link can view" and try again.',
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
