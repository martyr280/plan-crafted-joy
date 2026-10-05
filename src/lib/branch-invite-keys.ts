// Cache is scoped to the signed-in user so a later session never sees another admin's list.
export const branchInvitesQueryKey = (userId: string | undefined) =>
  ["branch-invites", userId ?? "anonymous"] as const;
