import { getBusinessModules, isModuleEnabled } from '../services/businessModulesService.js';

export function moduleDisabledResponse(res, moduleKey) {
  return res.status(403).json({
    success: false,
    code: 'MODULE_DISABLED',
    module: moduleKey,
    message: 'This feature is not enabled for your business. Contact your platform administrator.'
  });
}

/** Require a single module after req.businessId is set. */
export function requireBusinessModule(moduleKey) {
  return async (req, res, next) => {
    try {
      if (!req.businessId) {
        return res.status(403).json({ success: false, message: 'Business not assigned' });
      }
      const modules = await getBusinessModules(req.businessId);
      req.businessModules = modules;
      if (!isModuleEnabled(modules, moduleKey)) {
        return moduleDisabledResponse(res, moduleKey);
      }
      next();
    } catch (err) {
      console.error('Module gate error:', err);
      res.status(err.status || 500).json({ success: false, message: err.message || 'Server error' });
    }
  };
}

/** Attach modules without blocking (for my-subscription). */
export async function attachBusinessModules(req, res, next) {
  try {
    if (req.businessId) {
      req.businessModules = await getBusinessModules(req.businessId);
    }
    next();
  } catch (err) {
    next(err);
  }
}
