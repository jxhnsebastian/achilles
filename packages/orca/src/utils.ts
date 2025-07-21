export function convertToUiAmount(amount: bigint, decimals: number): number {
  const divisor = BigInt(10) ** BigInt(decimals);
  const beforeDecimal = amount / divisor;
  const afterDecimal = amount % divisor;

  return Number(beforeDecimal) + Number(afterDecimal) / Number(divisor);
}

export function serializeWeb3Object(tx: any): string {
  return JSON.stringify(
    tx,
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}
