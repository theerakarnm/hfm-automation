export interface CompareInput {
  fromLabel: string;
  fromDate: string;
  fromCount: number;
  toLabel: string;
  toDate: string;
  toCount: number;
  fromIds: Set<number>;
  toIds: Set<number>;
}

export interface CompareResult {
  fromLabel: string;
  fromDate: string;
  fromCount: number;
  toLabel: string;
  toDate: string;
  toCount: number;
  delta: number;
  pct: number | null;
  missingIds: number[];
  newIds: number[];
}

export function compareWalletSets(input: CompareInput): CompareResult {
  const missingIds: number[] = [];
  for (const id of input.fromIds) if (!input.toIds.has(id)) missingIds.push(id);
  missingIds.sort((a, b) => a - b);

  const newIds: number[] = [];
  for (const id of input.toIds) if (!input.fromIds.has(id)) newIds.push(id);
  newIds.sort((a, b) => a - b);

  const delta = input.toCount - input.fromCount;
  const pct = input.fromCount > 0 ? (delta / input.fromCount) * 100 : null;

  return {
    fromLabel: input.fromLabel,
    fromDate: input.fromDate,
    fromCount: input.fromCount,
    toLabel: input.toLabel,
    toDate: input.toDate,
    toCount: input.toCount,
    delta,
    pct,
    missingIds,
    newIds,
  };
}
