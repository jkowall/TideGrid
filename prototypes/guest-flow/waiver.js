'use strict';

// Session-only interaction model. These records are not legal signature evidence.
const WaiverFlow = (() => {
  const normalize = value => String(value ?? '').trim().replace(/\s+/g, ' ');
  const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
  function create(bookingKey, party, booker) {
    if (!bookingKey || !Number.isInteger(Number(party)) || Number(party) < 1 || Number(party) > 12) throw new Error('A valid sample booking is required.');
    return { bookingKey, participants: Array.from({ length: Number(party) }, (_, index) => ({
      id: `guest-${index + 1}`,
      name: index ? `Guest ${index + 1} Example` : normalize(booker.name),
      email: index ? `guest${index + 1}@example.com` : normalize(booker.email),
      status: 'not-sent', signature: null
    })) };
  }
  function sendRequests(flow, recipients) {
    if (!flow || !recipients.length) throw new Error('Select at least one guest to send a sample request.');
    if (new Set(recipients.map(item => item.id)).size !== recipients.length) throw new Error('Select each guest only once.');
    const updates = new Map(recipients.map(item => {
      const participant = flow.participants.find(guest => guest.id === item.id);
      if (!participant || participant.status !== 'not-sent') throw new Error('A request can only be sent for a guest marked Not sent.');
      const name = normalize(item.name); const email = normalize(item.email);
      if (name.length < 2 || name.length > 100) throw new Error('Enter a fictional guest name between 2 and 100 characters.');
      if (!validEmail(email)) throw new Error('Enter a valid sample email address, such as guest2@example.com.');
      return [item.id, { ...participant, name, email, status: 'awaiting-signature' }];
    }));
    return { ...flow, participants: flow.participants.map(item => updates.get(item.id) || item) };
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
    const sent = participants.filter(item => item.status !== 'not-sent').length;
    const signed = participants.filter(item => item.status === 'signed').length;
    return { total, sent, signed, pending: total - signed, complete: total > 0 && signed === total };
  }
  return { create, sendRequests, sign, progress };
})();
if (typeof module !== 'undefined') module.exports = WaiverFlow;
