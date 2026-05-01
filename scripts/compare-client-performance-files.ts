const PREV_FILE =
  process.env.PREV_FILE ??
  "output/client-performance_2026-02-01_2026-02-28.json";
const CURR_FILE =
  process.env.CURR_FILE ??
  "output/client-performance_2026-03-01_2026-03-31.json";
const TARGET_WALLET = Number(
  process.env.TARGET_WALLET ?? process.env.TARGET_WALLET ?? 30506525,
);

function eq(a: number, b: number): string {
  return a === b ? "EQUAL" : "DIFF";
}

function sorted<T>(set: Set<T>): T[] {
  return [...set].sort((a, b) => Number(a) - Number(b));
}

function diff<T>(a: Set<T>, b: Set<T>): T[] {
  return sorted(a).filter((id) => !b.has(id));
}

function step(title: string, obj: Record<string, unknown>): void {
  console.log(`\n${title}`);
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  const prev = await Bun.file(PREV_FILE).json();
  const curr = await Bun.file(CURR_FILE).json();

  step("STEP 0: Input", {
    targetWallet: TARGET_WALLET,
    previousFile: PREV_FILE,
    currentFile: CURR_FILE,
  });

  step("STEP 1: API totals", {
    prevTotalsClients: prev.totals.clients,
    currTotalsClients: curr.totals.clients,
    comparison: eq(prev.totals.clients, curr.totals.clients),
    note: "totals.clients from API response",
  });

  step("STEP 2: Raw clients[] length", {
    prevRows: prev.clients.length,
    currRows: curr.clients.length,
    comparison: eq(prev.clients.length, curr.clients.length),
  });

  const prevWalletRows = prev.clients.filter(
    (c: { subaffiliate: number }) => c.subaffiliate === TARGET_WALLET,
  );
  const currWalletRows = curr.clients.filter(
    (c: { subaffiliate: number }) => c.subaffiliate === TARGET_WALLET,
  );

  step("STEP 3: Filter by subaffiliate === TARGET_WALLET", {
    prevRowsUnderWallet: prevWalletRows.length,
    currRowsUnderWallet: currWalletRows.length,
    comparison: eq(prevWalletRows.length, currWalletRows.length),
    removedFromPrev: prev.clients.length - prevWalletRows.length,
    removedFromCurr: curr.clients.length - currWalletRows.length,
  });

  const prevClientIdList = prevWalletRows.map(
    (c: { client_id: number }) => c.client_id,
  );
  const currClientIdList = currWalletRows.map(
    (c: { client_id: number }) => c.client_id,
  );

  step("STEP 4: Map filtered rows to client_id list", {
    prevClientIdListLength: prevClientIdList.length,
    currClientIdListLength: currClientIdList.length,
    comparison: eq(prevClientIdList.length, currClientIdList.length),
    prevFirst10ClientIds: prevClientIdList.slice(0, 10),
    currFirst10ClientIds: currClientIdList.slice(0, 10),
    note: "Duplicates still exist here",
  });

  const prevClientIdSet = new Set(prevClientIdList);
  const currClientIdSet = new Set(currClientIdList);
  const prevOnlyClientIds = diff(prevClientIdSet, currClientIdSet);
  const currOnlyClientIds = diff(currClientIdSet, prevClientIdSet);

  step("STEP 5: Distinct client_id set (what countDistinctClients uses)", {
    prevDistinctClientIds: prevClientIdSet.size,
    currDistinctClientIds: currClientIdSet.size,
    countComparison: eq(prevClientIdSet.size, currClientIdSet.size),
    prevOnlyCount: prevOnlyClientIds.length,
    currOnlyCount: currOnlyClientIds.length,
    setComparison:
      prevOnlyClientIds.length === 0 && currOnlyClientIds.length === 0
        ? "EQUAL"
        : "DIFF",
    prevOnlyFirst20: prevOnlyClientIds.slice(0, 20),
    currOnlyFirst20: currOnlyClientIds.slice(0, 20),
    note: "This is what findMissing/findNew compare",
  });

  const prevAccountSet = new Set(
    prevWalletRows.map((c: { account_id: number }) => c.account_id),
  );
  const currAccountSet = new Set(
    currWalletRows.map((c: { account_id: number }) => c.account_id),
  );
  const prevOnlyAccounts = diff(prevAccountSet, currAccountSet);
  const currOnlyAccounts = diff(currAccountSet, prevAccountSet);

  step("STEP 6: Cross-check distinct account_id set", {
    prevDistinctAccountIds: prevAccountSet.size,
    currDistinctAccountIds: currAccountSet.size,
    countComparison: eq(prevAccountSet.size, currAccountSet.size),
    prevOnlyCount: prevOnlyAccounts.length,
    currOnlyCount: currOnlyAccounts.length,
    setComparison:
      prevOnlyAccounts.length === 0 && currOnlyAccounts.length === 0
        ? "EQUAL"
        : "DIFF",
  });

  const prevCompositeSet = new Set(
    prevWalletRows.map(
      (c: { account_id: number; client_id: number }) =>
        `${c.account_id}_${c.client_id}`,
    ),
  );
  const currCompositeSet = new Set(
    currWalletRows.map(
      (c: { account_id: number; client_id: number }) =>
        `${c.account_id}_${c.client_id}`,
    ),
  );
  const prevOnlyComposite = diff(prevCompositeSet, currCompositeSet);
  const currOnlyComposite = diff(currCompositeSet, prevCompositeSet);

  step("STEP 7: Cross-check account_id + client_id composite set", {
    prevCompositeCount: prevCompositeSet.size,
    currCompositeCount: currCompositeSet.size,
    countComparison: eq(prevCompositeSet.size, currCompositeSet.size),
    prevOnlyCount: prevOnlyComposite.length,
    currOnlyCount: currOnlyComposite.length,
    setComparison:
      prevOnlyComposite.length === 0 && currOnlyComposite.length === 0
        ? "EQUAL"
        : "DIFF",
  });

  const delta = currClientIdSet.size - prevClientIdSet.size;
  const sign = delta > 0 ? "+" : "";
  const pctStr =
    prevClientIdSet.size > 0
      ? ` (${sign}${((delta / prevClientIdSet.size) * 100).toFixed(2)}%)`
      : "";

  step("STEP 8: Current report result", {
    previousCount: prevClientIdSet.size,
    currentCount: currClientIdSet.size,
    change: `${sign}${delta} Wallets${pctStr}`,
    missingWalletsSincePrev: prevOnlyClientIds.length,
    newWalletsInCurr: currOnlyClientIds.length,
  });

  console.log("\n--- Simulated report message ---");
  console.log(
    `Month-over-month Wallet Report\nWallet under ${TARGET_WALLET}\nLast month: ${prevClientIdSet.size} Wallets\nThis month: ${currClientIdSet.size} Wallets\nChange: ${sign}${delta} Wallets${pctStr}\n${prevOnlyClientIds.length} Missing Wallets since Last month\n${currOnlyClientIds.length} New Wallets in This month`,
  );
}

main();
