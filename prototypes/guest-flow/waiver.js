'use strict';

// Session-only interaction model. These records are not legal signature evidence.
// Confirming a booking sends the booker's own request automatically. Other guests start as
// "needs-details"; the booker adds each guest's details and that guest's request is sent on add.
const WaiverFlow = (() => {
  const resendLimit = 3;
  const normalize = value => String(value ?? '').trim().replace(/\s+/g, ' ');
  const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
  function create(bookingKey, party, booker) {
    if (!bookingKey || !Number.isInteger(Number(party)) || Number(party) < 1 || Number(party) > 12) throw new Error('A valid sample booking is required.');
    return { bookingKey, participants: Array.from({ length: Number(party) }, (_, index) => index
      ? { id: `guest-${index + 1}`, name: '', email: '', status: 'needs-details', deliveries: 0, signature: null }
      : { id: 'guest-1', name: normalize(booker.name), email: normalize(booker.email), status: 'awaiting-signature', deliveries: 1, signature: null }) };
  }
  function addDetails(flow, entries) {
    if (!flow || !entries?.length) throw new Error('Add at least one guest to continue.');
    if (new Set(entries.map(item => item.id)).size !== entries.length) throw new Error('Add each guest only once.');
    const updates = new Map(entries.map(item => {
      const participant = flow.participants.find(guest => guest.id === item.id);
      if (!participant || participant.status !== 'needs-details') throw new Error('Details can only be added for a guest marked Needs details.');
      const name = normalize(item.name); const email = normalize(item.email);
      if (name.length < 2 || name.length > 100) throw new Error('Enter a fictional guest name between 2 and 100 characters.');
      if (!validEmail(email)) throw new Error('Enter a valid sample email address, such as guest2@example.com.');
      return [item.id, { ...participant, name, email, status: 'awaiting-signature', deliveries: 1 }];
    }));
    return { ...flow, participants: flow.participants.map(item => updates.get(item.id) || item) };
  }
  function resend(flow, id) {
    const participant = flow?.participants.find(item => item.id === id);
    if (!participant || participant.status !== 'awaiting-signature') throw new Error('Only a request that is awaiting a signature can be re-sent.');
    if (participant.deliveries - 1 >= resendLimit) throw new Error(`The demo allows ${resendLimit} resends per guest.`);
    return { ...flow, participants: flow.participants.map(item => item.id === id ? { ...item, deliveries: item.deliveries + 1 } : item) };
  }
  function sign(flow, id, input, bookingKey) {
    const participant = flow?.participants.find(item => item.id === id);
    if (!flow || flow.bookingKey !== bookingKey || !participant || participant.status !== 'awaiting-signature') throw new Error('Open an awaiting sample request for this booking before signing.');
    const fullName = normalize(input.fullName);
    if (fullName.toLowerCase() !== participant.name.toLowerCase()) throw new Error(`Type the fictional name shown on this request: ${participant.name}.`);
    if (input.read !== true || input.simulation !== true) throw new Error('Check both acknowledgments to sign this sample.');
    return { ...flow, participants: flow.participants.map(item => item.id === id ? { ...item, status: 'signed', signature: { fullName } } : item) };
  }
  function progress(flow) {
    const participants = flow?.participants || [];
    const total = participants.length;
    const missing = participants.filter(item => item.status === 'needs-details').length;
    const signed = participants.filter(item => item.status === 'signed').length;
    return { total, identified: total - missing, signed, pending: total - signed, missing, complete: total > 0 && signed === total };
  }
  return { create, addDetails, resend, sign, progress, resendLimit };
})();
if (typeof module !== 'undefined') module.exports = WaiverFlow;
