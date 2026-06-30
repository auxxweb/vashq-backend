/** Detect race / capacity errors when two users book the same slot or bay. */
export function isBookingSlotConflict(error) {
  if (!error) return false;
  if (error.code === 11000) return true;
  const msg = String(error.message || '').toLowerCase();
  return (
    msg.includes('just booked') ||
    msg.includes('fully booked') ||
    msg.includes('not available') ||
    msg.includes('invalid bay')
  );
}

export function sendBookingErrorResponse(error, res, fallbackMessage = 'Could not create booking') {
  if (isBookingSlotConflict(error)) {
    return res.status(409).json({
      success: false,
      code: 'SLOT_CONFLICT',
      message: error.message || 'This slot was just booked. Please choose another.'
    });
  }
  return res.status(400).json({
    success: false,
    message: error.message || fallbackMessage
  });
}
