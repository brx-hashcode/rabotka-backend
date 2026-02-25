import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ImageWatermarkService } from './image-watermark.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [ImageWatermarkService],
  exports: [ImageWatermarkService],
})
export class ImageWatermarkModule {}
