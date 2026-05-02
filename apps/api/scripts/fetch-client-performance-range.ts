import { fetchClientsByRange } from "../src/services/hfm.service";
import { getIctDateString } from "../src/utils/date";

const FROM_DATE = process.env.FROM_DATE ?? "2026-01-01";
const TO_DATE = process.env.TO_DATE ?? "2026-01-31";
const OUTPUT = process.env.OUTPUT ?? `./output/client-performance_${FROM_DATE}_${TO_DATE}.json`;

async function main() {
  console.log(`[fetch] client performance from ${FROM_DATE} to ${TO_DATE}`);

  const result = await fetchClientsByRange(FROM_DATE, TO_DATE);

  if (!result.ok) {
    console.error(`[fetch] failed: ${result.reason}`);
    process.exit(1);
  }

  const { clients, totals } = result.data;
  console.log(`[fetch] got ${clients.length} client(s)`);

  const output = {
    fetched_at: getIctDateString(new Date()),
    from_date: FROM_DATE,
    to_date: TO_DATE,
    totals,
    clients,
  };

  const file = Bun.file(OUTPUT);
  await Bun.write(OUTPUT, JSON.stringify(output, null, 2));
  console.log(`[fetch] saved to ${OUTPUT} (${(await file.size / 1024).toFixed(1)} KB)`);
}

main();
