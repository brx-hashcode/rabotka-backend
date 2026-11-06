import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateBusinessPlanDto } from '../dto/business-plan.dto';

describe('a plan’s CVs per analysis', () => {
  const errors = async (cvBatchMax: number) =>
    validate(plainToInstance(UpdateBusinessPlanDto, { cvBatchMax }));

  it('goes up to 100, set by the plan', async () => {
    expect(await errors(5)).toHaveLength(0);
    expect(await errors(100)).toHaveLength(0);
  });

  it('refuses above 100 and below 1', async () => {
    expect(await errors(101)).not.toHaveLength(0);
    expect(await errors(0)).not.toHaveLength(0);
  });
});
