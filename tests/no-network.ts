import { vi } from "vitest";
vi.stubGlobal("fetch", () => {
  throw new Error("Network disabled in local QA");
});
