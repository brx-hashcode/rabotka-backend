export interface IUseCase<Input, Output> {
  execute(input: Input): Promise<Output>;
}

export abstract class BaseUseCase<Input, Output> implements IUseCase<
  Input,
  Output
> {
  abstract execute(input: Input): Promise<Output>;

  protected validate(input: Input): void {}
}
