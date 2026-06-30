import jwt from 'jsonwebtoken';
import User from '../models/User.model.js';
import Business from '../models/Business.model.js';
import { cacheGetOrSet } from '../utils/cache.js';

const AUTH_CACHE_TTL = 10_000;

export const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.token;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await cacheGetOrSet(`auth:user:${decoded.id}`, AUTH_CACHE_TTL, () =>
      User.findById(decoded.id).select('-password').lean()
    );

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.status !== 'ACTIVE') {
      return res.status(403).json({
        success: false,
        message: 'Account is suspended'
      });
    }

    // Check business status for car wash admins, branch admins, and employees
    if ((user.role === 'CAR_WASH_ADMIN' || user.role === 'BRANCH_ADMIN' || user.role === 'EMPLOYEE') && user.businessId) {
      const business = await cacheGetOrSet(`auth:business:${user.businessId}`, AUTH_CACHE_TTL, () =>
        Business.findById(user.businessId).select('status').lean()
      );
      if (!business || business.status !== 'ACTIVE') {
        return res.status(403).json({
          success: false,
          message: 'Business account is suspended'
        });
      }
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token'
    });
  }
};

export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.'
      });
    }
    next();
  };
};
