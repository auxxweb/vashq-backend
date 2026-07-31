import { writeAuditLog, clientMetaFromRequest } from '../utils/auditLog.js';

/**
 * Logs a sensitive action after the response finishes (includes statusCode).
 * Must run after authenticate so req.user is available when applicable.
 *
 * @param {string} action
 * @param {object} [options]
 * @param {'CRITICAL'|'HIGH'|'MEDIUM'} [options.severity]
 * @param {string} [options.targetType]
 * @param {string|function} [options.targetId]
 * @param {string|function} [options.targetLabel]
 * @param {object|function} [options.meta]
 * @param {string|function} [options.businessId]
 */
export function auditSensitive(action, options = {}) {
  return (req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      try {
        const { ip, userAgent, deviceSummary } = clientMetaFromRequest(req);
        const resolve = (val) => (typeof val === 'function' ? val(req, res) : val);

        const targetId = resolve(options.targetId) ?? req.params?.id ?? req.params?.userId ?? null;
        const targetLabel = resolve(options.targetLabel) ?? null;
        const businessId =
          resolve(options.businessId) ??
          req.businessId ??
          req.user?.businessId?._id ??
          req.user?.businessId ??
          null;
        const metaRaw = resolve(options.meta) || {};
        const meta = { durationMs: Date.now() - started, ...metaRaw };
        // Never persist secrets
        delete meta.password;
        delete meta.newPassword;
        delete meta.adminPassword;
        delete meta.temporaryPassword;
        delete meta.confirmPassword;

        writeAuditLog({
          actorId: req.user?._id || null,
          actorEmail: req.user?.email || null,
          actorRole: req.user?.role || null,
          businessId,
          action,
          severity: options.severity || 'HIGH',
          channel: 'APP',
          method: req.method,
          path: req.originalUrl || req.path,
          targetType: options.targetType || null,
          targetId,
          targetLabel,
          success: res.statusCode < 400,
          statusCode: res.statusCode,
          ip,
          userAgent,
          deviceSummary,
          meta
        });
      } catch (err) {
        console.error('auditSensitive finish handler failed:', err?.message || err);
      }
    });
    next();
  };
}
