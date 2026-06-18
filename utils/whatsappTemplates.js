export const DEFAULT_WHATSAPP_TEMPLATES = {
  received: 'Hello {{name}}, your vehicle {{vehicleNumber}} has been received. Token: {{token}}',
  workStarted: 'Your car {{vehicleNumber}} – work is in progress.',
  completed: '✅ Your vehicle {{vehicleNumber}} is ready for delivery. Token: {{token}}',
  delivered:
    '🚗 Thank you! Your vehicle {{vehicleNumber}} has been delivered. Job completed.\n\nBefore photos: {{beforeImagesLink}}\nAfter photos: {{afterImagesLink}}'
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
