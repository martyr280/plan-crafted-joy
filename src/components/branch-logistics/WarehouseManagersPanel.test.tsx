import { describe, expect, it } from "vitest";
import { branchInvitesQueryKey } from "@/lib/branch-invite-keys";

describe("branch invites cache key", () => {
  it("is scoped by authenticated user id", () => {
    expect(branchInvitesQueryKey("a")).toEqual(["branch-invites", "a"]);
    expect(branchInvitesQueryKey("a")).not.toEqual(branchInvitesQueryKey("b"));
    expect(branchInvitesQueryKey(undefined)).toEqual(["branch-invites", "anonymous"]);
  });
});
