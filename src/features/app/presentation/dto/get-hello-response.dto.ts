import { ApiProperty } from '@nestjs/swagger';

export class GetHelloResponseDto {
  @ApiProperty({
    description: 'The greeting message',
    example: 'Hello from Rabotka API!',
  })
  message: string;

  @ApiProperty({
    description: 'The language code',
    example: 'en',
  })
  language: string;

  constructor(message: string, language: string) {
    this.message = message;
    this.language = language;
  }
}
