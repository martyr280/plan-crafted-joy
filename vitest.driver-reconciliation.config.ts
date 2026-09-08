import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve:{alias:{"@":fileURLToPath(new URL("./src",import.meta.url))}},
  test:{environment:"node",include:["src/lib/driver-time/__tests__/*.test.ts"],
    setupFiles:["src/lib/driver-time/__tests__/network-block.ts"]},
});
