// Guest self-service (lane 1, G2.11c): cancellation, management, and email.

// Private-charter deposits and balances (W3-G2.8).
export {
  BALANCE_PAYMENT_REUSE_HOURS,
  BALANCE_REMINDER_MIN_NOTICE_HOURS,
  type BalancePaymentEventOutcome,
  type ChangeDueDateResult,
  cancelQueuedBalanceEmails,
  changeBalanceDueDate,
  type EnsureBalancePaymentResult,
  enqueueBalanceReminders,
  ensureBalanceProviderPayment,
  MAX_BALANCE_LINKS_PER_HOUR,
  type OpenBalancePaymentResult,
  onBalancePaymentEvent,
  openBalancePayment,
  type SendBalanceLinkResult,
  sendBalanceLink,
} from "./balance.ts";
export {
  BALANCE_DUE_WINDOW_DAYS,
  type BalanceDueChangeView,
  type BalancePaymentView,
  type BalanceState,
  type BalanceView,
  getBookingBalance,
} from "./balance-read.ts";
// Correcting the booker's own name and email (W3-G2.11-rest, 0037).
export {
  type BookerContactChangeRecord,
  type ChangeBookerContactInput,
  type ChangeBookerContactResult,
  changeBookerContact,
  listBookerContactChanges,
  MAX_CONTACT_CHANGES_PER_DAY,
} from "./booker-contact.ts";
export {
  type CancelBookingResult,
  type CancellationRecord,
  type CancellationTerms,
  type CancelRefusal,
  cancelBooking,
  previewCancellation,
  previewStaffCancellation,
  refundFor,
  type StaffCancellationPreview,
  type StaffCancelResult,
  type StaffRemedyChoice,
  staffCancelBooking,
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
  type ExceptionResolutionView,
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
// Refunds, booking credit, fee reversal, and payment cancellation (W3-G2.9).
export {
  adjustCredit,
  appendCreditEntry,
  type CreditAccountView,
  type CreditCommandResult,
  type CreditEntryView,
  CreditKeyReusedError,
  creditAccountForBooking,
  creditBalanceForBooking,
  ensureCreditAccount,
  getCreditAccount,
  redeemCredit,
  reinstateCredit,
} from "./credits.ts";
// Console completion (G2.12c): search, a day's report and CSV, and notes.
export {
  csvField,
  csvInstant,
  csvMoney,
  csvReference,
  csvSignedMoney,
  csvText,
  dayExportFileName,
  moneyExportFileName,
  renderCsv,
  renderDayExport,
  renderMoneyExport,
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
// Staff resend of a booking's email (G2.16b).
export {
  MAX_OPERATOR_RESENDS_PER_HOUR,
  MAX_STAFF_RESENDS,
  RESEND_REASONS,
  RESEND_REFUSAL_ORDER,
  type ResendAvailability,
  type ResendFacts,
  type ResendKind,
  type ResendReason,
  type ResendRefusal,
  type ResendRefusalCode,
  type ResendResult,
  refusalsOf,
  resendAvailability,
  resendBookingEmail,
  resendRefusal,
  STAFF_RESEND_INTERVAL_MINUTES,
} from "./email-resend.ts";
export {
  CANCELED_TEMPLATE,
  CONFIRMATION_TEMPLATE,
  enqueueCancellationEmail,
  enqueueConfirmationEmail,
  enqueueManageLinkEmail,
  enqueueReminderEmail,
  MANAGE_LINK_TEMPLATE,
  MANAGE_LINK_TTL_SECONDS,
  MANAGE_PATH,
  REMINDER_TEMPLATE,
  RESCHEDULED_TEMPLATE,
} from "./emails.ts";
// Finalization exception resolution (W1-FIN-EXC).
export {
  type ResolvedExceptionView,
  type ResolveExceptionResult,
  resolveFinalizationException,
} from "./exception-resolution.ts";
export {
  CORE_FEE_BP,
  type FeeReversal,
  feeReversalFor,
  reverseFeeForRefund,
} from "./fee-ledger.ts";
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
  type ParticipantRemovedEvent,
  type ParticipantUpdatedEvent,
} from "./hooks.ts";
// Participant invitations and the participant's own details (W3-G2.11-rest, 0036).
export {
  getParticipantProfile,
  INVITATION_LINK_TTL_SECONDS,
  INVITATION_TEMPLATE,
  type InviteParticipantResult,
  inviteParticipant,
  MAX_INVITATIONS_PER_BOOKING,
  MAX_INVITATIONS_PER_INVITEE,
  type OpenParticipantSessionResult,
  type OwnDetails,
  openParticipantSession,
  PARTICIPANT_PATH,
  PARTICIPANT_SESSION_TTL_SECONDS,
  type ParticipantProfileView,
  type ParticipantSession,
  participantSession,
  type UpdateOwnDetailsResult,
  updateOwnDetails,
} from "./invitations.ts";
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
// Money movements for a date range (W3-G2.12-rest).
export {
  buildMoneyReport,
  controlsAgree,
  MONEY_ENTRY_KINDS,
  MONEY_REPORT_LIMIT,
  MONEY_REPORT_MAX_DAYS,
  type MoneyEntry,
  type MoneyEntryKind,
  type MoneyKindTotals,
  type MoneyReport,
  type MoneyReportOutcome,
  type MoneyTotals,
  moneyTotalsOf,
  totalsByKind,
} from "./money-report.ts";
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
  withdrawProfileAccess,
} from "./participants.ts";
// Giving up a place in a shared-seat party (W3-G2.11-rest).
export {
  listPartyChanges,
  type PartyChangeIssue,
  type PartyChangeRecord,
  type RemoveParticipantInput,
  type RemoveParticipantResult,
  removeParticipant,
} from "./party-changes.ts";
export {
  requestPaymentCancellation,
  type SettleCancellationResult,
  settlePaymentCancellation,
} from "./payment-cancel.ts";
export {
  type FinalizationExceptionView,
  listFinalizationExceptions,
  listTripBookings,
  listTripBookingsPage,
  MAX_TRIP_BOOKINGS_PAGE,
  type StaffBooking,
  type TripBookingsPage,
} from "./reads.ts";
export {
  ASSESSMENT_WINDOW_DAYS,
  assessClosedBookings,
  checkPendingPayment,
  type DisputeEventOutcome,
  type DisputeView,
  type ExternalSettlementInput,
  type ExternalSettlementResult,
  type ExternalSettlementView,
  type FeeInvoiceView,
  issueNextInvoice,
  listDisputes,
  listExternalSettlements,
  listFeeInvoices,
  listPaymentReconciliationExceptions,
  onDisputeEvent,
  PAYMENT_CHECK_DAYS,
  type PaymentCheckResult,
  type PaymentExceptionView,
  RECEIVED_SHARE_TARGET_BP,
  type ReconciliationReport,
  type ReconciliationRow,
  type ReconciliationSweepOptions,
  type ReconciliationSweepReport,
  type ReconciliationTotals,
  reconciliationReport,
  recordExternalSettlement,
  sweepReconciliation,
} from "./reconciliation.ts";
export {
  listRefundExceptions,
  onRefundEvent,
  REFUND_EXCEPTION_AFTER_HOURS,
  type RefundEventOutcome,
  type RefundExceptionView,
  raiseRefundException,
} from "./refunds.ts";
// Moving a whole booking to another trip (W3-G2.11-rest).
export {
  MAX_RESCHEDULE_OPTIONS,
  previewReschedule,
  RESCHEDULE_HORIZON_DAYS,
  type RescheduleInput,
  type RescheduleOption,
  type ReschedulePreview,
  type RescheduleRecord,
  type RescheduleRefusal,
  type RescheduleResult,
  rescheduleBooking,
  type TripOptionIssue,
} from "./reschedule.ts";
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
