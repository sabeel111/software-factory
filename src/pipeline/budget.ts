// Cost accounting across stages, attempts and concurrent runs (R4.4, R5.3).

export class BudgetExceeded extends Error {
  override name = "BudgetExceeded";
}

export class Budget {
  private spentUsd = 0;

  constructor(
    readonly limitUsd: number,
    private readonly parent?: Budget,
  ) {}

  get spent(): number {
    return this.spentUsd;
  }

  /** Headroom left here and in every ancestor. */
  get remaining(): number {
    const own = this.limitUsd - this.spentUsd;
    return Math.max(0, this.parent ? Math.min(own, this.parent.remaining) : own);
  }

  get exhausted(): boolean {
    return this.remaining <= 0;
  }

  charge(usd: number): void {
    this.spentUsd += usd;
    this.parent?.charge(usd);
  }

  /** Throw before starting work that the budget can no longer pay for. */
  ensure(what: string): void {
    if (this.exhausted) throw new BudgetExceeded(`Budget exhausted before ${what}`);
  }

  child(limitUsd: number): Budget {
    return new Budget(limitUsd, this);
  }
}
