export const DEFAULT_WHATSAPP_TEMPLATES = {
  received: 'Hello {{name}}, your vehicle {{vehicleNumber}} has been received. Token: {{token}}',
  workStarted: 'Your car {{vehicleNumber}} – work is in progress.',
  completed: '✅ Your vehicle {{vehicleNumber}} is ready for delivery. Token: {{token}}',
  delivered:
    '🚗 Thank you! Your vehicle {{vehicleNumber}} has been delivered. Job completed.\n\nBefore photos: {{beforeImagesLink}}\nAfter photos: {{afterImagesLink}}',
  invoiceShare:
    'Hello {{name}}, your vehicle service is completed. Total: {{total}} {{currency}}. View & download invoice (PDF): {{invoiceLink}} Thank you!',
  invoicePackage:
    'Hello {{name}}, your package purchase is ready. Total: {{total}} {{currency}}. Package: {{packageName}}. View & download invoice (PDF): {{invoiceLink}} Thank you!',
  googleReview: 'Thank you for choosing us 🙏\nPlease leave us a Google review: {{reviewLink}}',
  bookingConfirmed:
    'Hello {{name}},\n\nYour appointment at {{businessName}} is confirmed.\n\nDate: {{bookingDate}}\nTime: {{slotTime}}\nVehicle: {{vehicleNumber}}{{pickupNote}}\n\nThank you for choosing us!',
  bookingCancelled:
    'Hello {{name}},\n\nYour booking at {{businessName}} for {{vehicleNumber}} on {{bookingDate}} ({{slotTime}}) has been cancelled.\n\nContact us if you would like to reschedule.',
  bookingRejected:
    'Hello {{name}},\n\nWe regret that we cannot accept your booking for {{vehicleNumber}} on {{bookingDate}} ({{slotTime}}).\n\nPlease choose another slot or contact us.'
}

/** Merge stored templates with defaults; map legacy inProgress → workStarted. */
export function normalizeWhatsappTemplates(stored) {
  const raw = stored && typeof stored === 'object' ? stored : {}
  const merged = { ...DEFAULT_WHATSAPP_TEMPLATES, ...raw }
  if (!String(merged.workStarted || '').trim() && String(merged.inProgress || '').trim()) {
    merged.workStarted = merged.inProgress
  }
  return merged
}
