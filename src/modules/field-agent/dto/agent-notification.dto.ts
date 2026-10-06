import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, IsUrl, MaxLength, ValidateNested } from 'class-validator';

class PushSubscriptionKeysDto {
  @ApiProperty()
  @IsString()
  @MaxLength(256)
  p256dh: string;

  @ApiProperty()
  @IsString()
  @MaxLength(128)
  auth: string;
}

/** The browser's PushSubscription.toJSON(), as the agent app sends it. */
export class AgentPushSubscribeDto {
  @ApiProperty({ example: 'https://fcm.googleapis.com/fcm/send/…' })
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(1024)
  endpoint: string;

  @ApiProperty({ type: PushSubscriptionKeysDto })
  @ValidateNested()
  @Type(() => PushSubscriptionKeysDto)
  keys: PushSubscriptionKeysDto;
}

export class AgentPushUnsubscribeDto {
  @ApiProperty()
  @IsString()
  @MaxLength(1024)
  endpoint: string;
}
