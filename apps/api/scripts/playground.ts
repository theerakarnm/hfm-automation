const TARGET_FILE =
  process.env.PREV_FILE ??
  "output/client_2026-04-30-2.json";

async function main() {
  const target = await Bun.file(TARGET_FILE).json();

  console.log(target.data.length);
}

main();
