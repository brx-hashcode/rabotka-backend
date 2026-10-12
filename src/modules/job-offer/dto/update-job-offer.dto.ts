import { PartialType } from '@nestjs/swagger';
import { CreateJobOfferDto } from './create-job-offer.dto';

/**
 * An employer's edit of their own ACTIVE offer. Same fields and bounds as
 * creation, all optional: an omitted field is left alone. The service checks
 * the merged result, so an edit can never produce an offer creation would
 * have refused.
 */
export class UpdateJobOfferDto extends PartialType(CreateJobOfferDto) {}
