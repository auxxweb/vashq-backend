import { isAdminPanelRole } from '../utils/adminRoles.js';
import { isSalesEmployee } from '../utils/employeeType.js';

/** Restrict route to business owner or branch manager (not floor employees). */
export function adminPanelOnly(req, res, next) {
  if (!isAdminPanelRole(req.user?.role)) {
    return res.status(403).json({ success: false, message: 'Access denied. Admin only.' });
  }
  next();
}

/** Admin panel roles, or sales employees (CRM / bookings workflows). */
export function adminPanelOrSalesEmployee(req, res, next) {
  if (isAdminPanelRole(req.user?.role) || isSalesEmployee(req.user)) {
    return next();
  }
  return res.status(403).json({
    success: false,
    message: 'Access denied. Admin or sales employee only.'
  });
}
