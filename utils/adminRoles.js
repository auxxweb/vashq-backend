export const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  CAR_WASH_ADMIN: 'CAR_WASH_ADMIN',
  BRANCH_ADMIN: 'BRANCH_ADMIN',
  EMPLOYEE: 'EMPLOYEE'
};

export function isBusinessOwner(role) {
  return role === ROLES.CAR_WASH_ADMIN;
}

export function isBranchAdmin(role) {
  return role === ROLES.BRANCH_ADMIN;
}

/** Full admin panel (owner or branch manager). */
export function isAdminPanelRole(role) {
  return role === ROLES.CAR_WASH_ADMIN || role === ROLES.BRANCH_ADMIN;
}

export function isEmployeeRole(role) {
  return role === ROLES.EMPLOYEE;
}
