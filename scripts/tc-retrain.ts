// Manual retrain runner.
import { trainAndMaybePromote } from "../src/lib/truck-capacity/train";

async function main() {
  const r = await trainAndMaybePromote();
  console.log(JSON.stringify(r, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
