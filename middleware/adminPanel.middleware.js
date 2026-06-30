import { isAdminPanelRole } from '../utils/adminRoles.js';

/** Restrict route to business owner or branch manager (not floor employees). */
export function adminPanelOnly(req, res, next) {
  if (!isAdminPanelRole(req.user?.role)) {
    return res.status(403).json({ success: false, message: 'Access denied. Admin only.' });
  }
  next();
}
