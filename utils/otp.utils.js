import crypto from 'crypto';

export const generateOTP = () => {
  return crypto.randomInt(100000, 1000000).toString();
};

export const getOTPExpiry = (minutes = 15) => {
  const expiry = new Date();
  expiry.setMinutes(expiry.getMinutes() + minutes);
  return expiry;
};
