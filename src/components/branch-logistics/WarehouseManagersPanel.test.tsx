import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/branch-invite.functions", () => ({
  cancelBranchInvite: vi.fn(),
  confirmBranchInvite: vi.fn(),
  listBranchInvites: vi.fn(),
  saveBranchInviteDraft: vi.fn(),
  finishBranchInviteActivation: vi.fn(),
}));

import { branchInvitesQueryKey } from "./WarehouseManagersPanel";

describe("branch invites cache key", () => {
  it("is scoped by authenticated user id", () => {
    expect(branchInvitesQueryKey("a")).toEqual(["branch-invites", "a"]);
    expect(branchInvitesQueryKey("a")).not.toEqual(branchInvitesQueryKey("b"));
    expect(branchInvitesQueryKey(undefined)).toEqual(["branch-invites", "anonymous"]);
  });
});
