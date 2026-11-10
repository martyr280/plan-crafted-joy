// Who may see and edit driver hourly rates.
//
// Global admin or ops_logistics_admin. A branch_manager role wins: combined
// branch-manager + admin (or logistics admin) is denied here, matching
// public.has_role(), which returns false for every non-branch role when
// private.is_branch_manager is true. Invite-only branch bindings are enforced
// again by that SQL function and by the restrictive branch_manager_deny policy.
// This does not widen diagnostics, warehouse-remark editing, or other admin gates.

const PAY_ROLES = ["admin", "ops_logistics_admin"] as const;

export function canManageDriverPay(roles: readonly string[] | null | undefined): boolean {
  const list = roles ?? [];
  if (list.includes("branch_manager")) return false;
  return list.some((r) => (PAY_ROLES as readonly string[]).includes(r));
}

/** Client gates for Driver Time. isAdmin and diagnostics stay global-admin only. */
export function driverTimeGates(roles: readonly string[] | null | undefined) {
  const list = roles ?? [];
  const isAdmin = list.includes("admin");
  return {
    canViewModule: list.some(
      (r) => r === "admin" || r === "ops_logistics" || r === "ops_logistics_admin",
    ),
    isAdmin,
    canManageDriverPay: canManageDriverPay(list),
    canOpenDiagnostics: isAdmin,
  };
}
