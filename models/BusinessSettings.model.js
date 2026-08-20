import mongoose from 'mongoose';

const businessSettingsSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    unique: true
  },
  language: {
    type: String,
    default: 'en'
  },
  timezone: {
    type: String,
    default: 'UTC'
  },
  currency: {
    type: String,
    default: 'USD'
  },
  dateFormat: {
    type: String,
    default: 'YYYY-MM-DD'
  },
  numberFormat: {
    type: String,
    default: 'en-US'
  },
  theme: {
    type: String,
    enum: ['light', 'dark'],
    default: 'light'
  },
  workingHours: {
    start: { type: String, default: '09:00' },
    end: { type: String, default: '18:00' }
  },
  /** Shop-wide working days & hours (0=Sun … 6=Sat). Used for bookings and operations. */
  weeklyOperatingSchedule: [{
    day: { type: Number, min: 0, max: 6, required: true },
    isOpen: { type: Boolean, default: true },
    start: { type: String, default: '09:00' },
    end: { type: String, default: '18:00' }
  }],
  capacity: {
    type: Number,
    default: 5,
    min: 1
  },
  autoSendWhatsApp: {
    type: Boolean,
    default: true
  },
  notificationPreferences: {
    jobCreated: { type: Boolean, default: true },
    jobCompleted: { type: Boolean, default: true },
    jobDelivered: { type: Boolean, default: true },
    planExpiry: { type: Boolean, default: true }
  },
  shopWhatsappNumber: { type: String, trim: true },
  googleReviewLink: { type: String, trim: true },
  whatsappTemplates: {
    received: { type: String, trim: true },
    workStarted: { type: String, trim: true },
    inProgress: { type: String, trim: true },
    washing: { type: String, trim: true },
    drying: { type: String, trim: true },
    completed: { type: String, trim: true },
    delivered: { type: String, trim: true },
    invoiceShare: { type: String, trim: true },
    invoicePackage: { type: String, trim: true },
    googleReview: { type: String, trim: true },
    bookingConfirmed: { type: String, trim: true },
    bookingCancelled: { type: String, trim: true },
    bookingRejected: { type: String, trim: true }
  },
  // Payment (Online) - for invoice & WhatsApp share
  upiId: { type: String, trim: true },
  qrCodeImage: { type: String, trim: true },
  paymentMobileNumber: { type: String, trim: true },
  // GST (optional) - shown on invoice when set
  gstNumber: { type: String, trim: true },
  taxPercentage: { type: Number, min: 0, max: 100 },
  /** Minimum before/after photos required on a job (unless "without images"). */
  jobImagesMin: { type: Number, min: 0, max: 20, default: 2 },
  /** Maximum before/after photos allowed on a job. */
  jobImagesMax: { type: Number, min: 1, max: 20, default: 4 },
  /** When true, checkout can choose Card under Online (and Split online portion). */
  cardPaymentEnabled: { type: Boolean, default: false },
  /**
   * When true, Mark Completed requires quality checklist for services that have one defined.
   * Off by default — existing job completion flow unchanged.
   */
  qualityCheckEnabled: { type: Boolean, default: false },
  /**
   * When true, owner can manage service categories and assign them on Services / Variable / Products.
   * Off by default — existing catalog UX unchanged.
   */
  serviceCategoriesEnabled: { type: Boolean, default: false },
  /**
   * When true (and service categories are on), each category can have subcategories.
   * Services can be tagged with a subcategory; booking/job UIs filter category → subcategory → services.
   */
  serviceSubcategoriesEnabled: { type: Boolean, default: false },
  /**
   * When true, Create Job allows mixing wash services, variable visits, and products in one cart.
   * Off by default — classic Job / Variable Service tabs remain.
   */
  mixedCartEnabled: { type: Boolean, default: false },
  /**
   * When true, invoice checkout can enter discount as a fixed amount (₹) or percent (%).
   * Off by default — percent-only discount remains (existing invoices unchanged).
   */
  invoiceDiscountAmountEnabled: { type: Boolean, default: false },
  /**
   * When true, marking a job COMPLETED creates a draft invoice that can be viewed,
   * shared, and printed with payment pending. Mark Delivered / close-job flow unchanged.
   * Off by default — invoices still create only after Mark Delivered.
   */
  invoiceOnCompletedEnabled: { type: Boolean, default: false },
  /**
   * When true, CRM / Leads menu and APIs are available for this business.
   * Off by default — existing workflows unchanged.
   */
  crmEnabled: { type: Boolean, default: false },
  /**
   * When true, Create Job “New vehicle” can use AI camera scan to fill plate/brand/model/color.
   * Off by default — existing manual car entry is unchanged.
   */
  vehicleScannerEnabled: { type: Boolean, default: false },
  /**
   * When true, Attendance (punch in/out, breaks, calendar, correction requests) is available.
   * Off by default — existing workflows unchanged.
   */
  attendanceEnabled: { type: Boolean, default: false },
  /**
   * When true, Other Revenue (additional inflows outside jobs/products/variable sales) is available.
   * Off by default — Settings → enable + manage revenue types.
   */
  otherRevenueEnabled: { type: Boolean, default: false },
  /**
   * When true (and attendanceEnabled), punch in/out require the employee to be inside
   * the configured geo perimeter around attendanceLatitude/Longitude.
   */
  attendanceGeoFenceEnabled: { type: Boolean, default: false },
  /** Shop / office center for attendance geofence (WGS84). */
  attendanceLatitude: { type: Number, default: null },
  attendanceLongitude: { type: Number, default: null },
  /** Allowed radius in meters (e.g. 50 or 1000). */
  attendancePerimeterMeters: { type: Number, default: null, min: 0 },
  /**
   * When true, customer phone fields show a country-code selector (international numbers).
   * Off by default — classic local mobile input remains (server defaults missing codes to +91).
   */
  internationalPhoneEnabled: { type: Boolean, default: false },
  /**
   * When true, Create Job / job edit can assign multiple employees to one job.
   * All assignees see it under My Jobs and can edit / complete checkout.
   * Off by default — single-employee assign remains the default UX.
   */
  multiEmployeeAssignEnabled: { type: Boolean, default: false },
  /**
   * When true, Create Job can assign one or more job-level employees to each selected service
   * (subset of the job's assignees) so work can be attributed per service.
   * Off by default.
   */
  perServiceEmployeeAssignEnabled: { type: Boolean, default: false },
  /**
   * When true, new job tokens use sequential custom format (prefix/date/counter).
   * Off by default — keeps system YYYYMMDD-RANDOM tokens.
   */
  customJobTokenEnabled: { type: Boolean, default: false },
  jobTokenSettings: {
    prefix: { type: String, default: '', trim: true, maxlength: 10 },
    datePart: { type: String, enum: ['NONE', 'DDMM', 'YYYYMMDD'], default: 'NONE' },
    sequenceScope: { type: String, enum: ['DAILY', 'MONTHLY', 'GLOBAL'], default: 'DAILY' },
    padLength: { type: Number, default: 3, min: 1, max: 6 },
    separator: { type: String, default: '-', maxlength: 2 }
  },
  /**
   * When true, new invoice numbers use sequential custom format.
   * Off by default — keeps system random INV-… numbers.
   */
  customInvoiceNumberEnabled: { type: Boolean, default: false },
  invoiceNumberSettings: {
    prefix: { type: String, default: 'INV', trim: true, maxlength: 10 },
    datePart: { type: String, enum: ['NONE', 'DDMM', 'YYYYMMDD'], default: 'NONE' },
    sequenceScope: { type: String, enum: ['DAILY', 'MONTHLY', 'GLOBAL'], default: 'GLOBAL' },
    padLength: { type: Number, default: 4, min: 1, max: 8 },
    separator: { type: String, default: '-', maxlength: 2 }
  },
  // Loyalty program (optional)
  loyaltyPointValueInr: { type: Number, min: 0, default: 0 }, // 1 point = ₹X
  loyaltyMaxRedeemPointsPerJob: { type: Number, min: 0, default: 0 }, // 0 = no redeem allowed
  // Online booking
  onlineBookingEnabled: { type: Boolean, default: true },
  /** Days of week 0=Sun … 6=Sat; empty/null = all days (legacy — prefer bookingWeeklySchedule) */
  bookingAllowedDays: [{ type: Number, min: 0, max: 6 }],
  /** Per-day open hours and closure; 0=Sun … 6=Sat */
  bookingWeeklySchedule: [{
    day: { type: Number, min: 0, max: 6, required: true },
    isOpen: { type: Boolean, default: true },
    start: { type: String, default: '09:00' },
    end: { type: String, default: '18:00' }
  }],
  bookingAdvanceDays: { type: Number, min: 1, max: 365, default: 30 },
  /**
   * Dynamic public booking contact form (step “You”).
   * Defaults applied in bookingContactForm utils when empty.
   */
  bookingContactFormFields: [{
    id: { type: String, trim: true },
    key: { type: String, trim: true, required: true },
    label: { type: String, trim: true, required: true },
    type: {
      type: String,
      enum: ['text', 'tel', 'email', 'textarea', 'number', 'date', 'time', 'datetime', 'select', 'chips'],
      default: 'text'
    },
    required: { type: Boolean, default: false },
    placeholder: { type: String, trim: true, default: '' },
    options: [{ type: String, trim: true }],
    optionLabels: { type: mongoose.Schema.Types.Mixed },
    locked: { type: Boolean, default: false },
    section: {
      type: String,
      enum: ['contact', 'vehicle', 'visit', 'other'],
      default: 'other'
    },
    showWhen: {
      key: { type: String, trim: true },
      equals: { type: String, trim: true }
    }
  }]
}, {
  timestamps: true
});

export default mongoose.model('BusinessSettings', businessSettingsSchema);
