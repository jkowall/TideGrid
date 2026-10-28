// Guest self-service (lane 1, G2.11c): cancellation, management, and email.
export {
  type CancelBookingResult,
  type CancellationRecord,
  type CancellationTerms,
  type CancelRefusal,
  cancelBooking,
  previewCancellation,
  refundFor,
} from "./cancel.ts";
export {
  type BookerDetails,
  type CancelCheckoutResult,
  CHECKOUT_TTL_SECONDS,
  type CreateCheckoutInput,
  type CreateCheckoutResult,
  cancelCheckoutSession,
  createCheckoutSession,
  type EnsurePaymentResult,
  ensureProviderPayment,
  getCheckoutSession,
  MAX_OPEN_CHECKOUTS_PER_CLIENT,
  ownerRefFor,
  type StaffCheckoutDetails,
} from "./checkout.ts";
// Console reads (G2.12b).
export {
  type BookingDetailView,
  type ConsoleExceptionView,
  DAY_TRIPS_LIMIT,
  type DayBookingsResult,
  type DayBookingView,
  type DayTripView,
  type ExceptionsPageResult,
  type ExtraView,
  extrasOf,
  findBookingByReference,
  getBookingDetail,
  getTripRoster,
  listDayBookings,
  listExceptionsPage,
  maskProviderReference,
  offsetDateTime,
  type PartyView,
  partyOf,
  type RosterView,
  sumByCode,
} from "./console.ts";
// Console completion (G2.12c): search, a day's report and CSV, and notes.
export {
  csvField,
  csvInstant,
  csvMoney,
  csvText,
  dayExportFileName,
  renderCsv,
  renderDayExport,
} from "./csv.ts";
export {
  buildDayReport,
  DAY_REPORT_LIMIT,
  type DayReport,
  type DayReportOutcome,
  type DayReportRow,
  type DayReportTotals,
  totalsOf,
} from "./day-report.ts";
export {
  CANCELED_TEMPLATE,
  CONFIRMATION_TEMPLATE,
  enqueueCancellationEmail,
  enqueueConfirmationEmail,
  enqueueManageLinkEmail,
  MANAGE_LINK_TEMPLATE,
  MANAGE_LINK_TTL_SECONDS,
  MANAGE_PATH,
} from "./emails.ts";
export {
  type HandledEvent,
  handleVerifiedEvent,
  type ProcessOutcome,
  type ProcessResult,
  processProviderEvent,
  type SettleRefundResult,
  settleRefund,
} from "./finalize.ts";
export { clean, money, partyText, receiptRows, tripWhen } from "./format.ts";
// Booking lifecycle hooks and participants (lane 1, G2.11c).
export {
  type BookingCanceledEvent,
  type BookingConfirmedEvent,
  BookingHookRefusal,
  type BookingHooks,
  noBookingHooks,
  type ParticipantEvent,
  type ParticipantField,
  type ParticipantUpdatedEvent,
} from "./hooks.ts";
export {
  getManagedBooking,
  MANAGE_SESSION_TTL_SECONDS,
  MAX_LINK_EMAILS_PER_HOUR,
  type ManagedBookingView,
  manageSession,
  type OpenCheckoutSessionResult,
  type OpenManageSessionResult,
  openManageSession,
  openManageSessionFromCheckout,
  type RequestLinkResult,
  renewManageLink,
  requestManageLink,
} from "./manage.ts";
export {
  type AddBookingNoteResult,
  addBookingNote,
  type BookingNoteView,
  listBookingNotes,
  NOTES_LIMIT,
} from "./notes.ts";
export {
  listParticipants,
  MAX_PARTY_SIZE,
  normalizeParticipant,
  type ParticipantDetails,
  type ParticipantListView,
  type ParticipantView,
  type PutParticipantResult,
  putParticipant,
} from "./participants.ts";
export {
  type FinalizationExceptionView,
  listFinalizationExceptions,
  listTripBookings,
  type StaffBooking,
} from "./reads.ts";
export {
  type BookingSearchField,
  type BookingSearchOutcome,
  type BookingSearchQuery,
  type BookingSearchView,
  emailFragment,
  escapeLike,
  nameWords,
  referencePrefix,
  searchBookings,
  searchFields,
} from "./search.ts";
export {
  bookingReferencePattern,
  checkoutSecretPattern,
  clientKeyFor,
  hashCheckoutSecret,
  newBookingReference,
} from "./secrets.ts";
// Staff-assisted booking (G2.12d).
export {
  cancelStaffCheckout,
  getStaffCheckout,
  type OpenStaffCheckoutInput,
  openStaffCheckout,
  recordStaffTestPaymentSuperseded,
  requestStaffTestPayment,
  type StaffCheckoutView,
  type StaffTestPaymentOutcome,
  type StaffTestPaymentRequestResult,
  staffCheckoutPaymentRef,
  staffClientAddress,
  staffViewOf,
} from "./staff-checkout.ts";
export {
  type CheckoutSweepItem,
  type CheckoutSweepOptions,
  type CheckoutSweepReport,
  DEFAULT_CHECKOUT_SWEEP_BATCH,
  DEFAULT_CHECKOUT_SWEEP_GRACE_SECONDS,
  type ExpireCheckoutsResult,
  expireCheckoutSessions,
  type InconsistentCheckout,
  InconsistentCheckoutError,
  sweepCheckouts,
} from "./sweep.ts";
export { type CheckoutSessionView, loadSessionView } from "./views.ts";
