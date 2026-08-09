/** Floor / wash staff — existing employee portal features only. */
export const EMPLOYEE_TYPE_DEFAULT = 'DEFAULT';
/** Sales staff — default features + CRM leads + bookings (when enabled). */
export const EMPLOYEE_TYPE_SALES = 'SALES';

export const EMPLOYEE_TYPES = [EMPLOYEE_TYPE_DEFAULT, EMPLOYEE_TYPE_SALES];

export function normalizeEmployeeType(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === EMPLOYEE_TYPE_SALES) return EMPLOYEE_TYPE_SALES;
  return EMPLOYEE_TYPE_DEFAULT;
}

export function isSalesEmployee(user) {
  if (!user || user.role !== 'EMPLOYEE') return false;
  return normalizeEmployeeType(user.employeeType) === EMPLOYEE_TYPE_SALES;
}

export function isDefaultEmployee(user) {
  if (!user || user.role !== 'EMPLOYEE') return false;
  return !isSalesEmployee(user);
}
