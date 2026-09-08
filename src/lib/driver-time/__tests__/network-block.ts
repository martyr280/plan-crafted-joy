import { vi } from "vitest";
vi.stubGlobal("fetch",vi.fn(()=>{throw new Error("Network disabled in warehouse reconciliation tests");}));
