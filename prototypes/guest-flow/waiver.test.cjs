const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('./waiver.js');

const create = () => W.create('booking-a', 3, { name: 'Alex Example', email: 'alex@example.com' });
const consent = fullName => ({ fullName, read: true, simulation: true });
const details = (id, name = 'Jamie Example', email = 'jamie@example.com') => ({ id, name, email });

test('confirming a booking sends the booker’s own request and leaves other guests needing details', () => {
  const flow = create();
  assert.equal(flow.participants.length, 3);
  assert.equal(new Set(flow.participants.map(p => p.id)).size, 3);
  const [booker, ...others] = flow.participants;
  assert.equal(booker.name, 'Alex Example');
  assert.equal(booker.email, 'alex@example.com');
  assert.equal(booker.status, 'awaiting-signature');
  assert.equal(booker.deliveries, 1);
  assert.ok(others.every(p => p.status === 'needs-details' && p.name === '' && p.email === '' && p.deliveries === 0));
  assert.ok(flow.participants.every(p => p.signature === null));
  assert.deepEqual(W.progress(flow), { total: 3, identified: 1, signed: 0, pending: 3, missing: 2, complete: false });
  assert.throws(() => W.create('', 2, { name: 'A', email: 'a@example.com' }));
  assert.throws(() => W.create('booking-a', 13, { name: 'A', email: 'a@example.com' }));
});

test('adding a guest validates their details and sends that guest’s request automatically', () => {
  const original = create();
  const guest = original.participants[1];
  assert.throws(() => W.addDetails(original, []));
  assert.throws(() => W.addDetails(original, [details(guest.id, 'Jamie Example', 'invalid')]));
  assert.throws(() => W.addDetails(original, [details(guest.id, ' ')]));
  assert.throws(() => W.addDetails(original, [details(guest.id), details(guest.id)]));
  assert.throws(() => W.addDetails(original, [details('guest-1')]), /Needs details/);
  assert.throws(() => W.addDetails(original, [details('missing-person')]));
  assert.equal(original.participants[1].status, 'needs-details');
  const added = W.addDetails(original, [details(guest.id, '  jamie   example ', 'jamie@example.com')]);
  assert.equal(original.participants[1].status, 'needs-details');
  assert.equal(added.participants[1].status, 'awaiting-signature');
  assert.equal(added.participants[1].name, 'jamie example');
  assert.equal(added.participants[1].deliveries, 1);
  assert.equal(added.participants[2].status, 'needs-details');
  assert.deepEqual(W.progress(added), { total: 3, identified: 2, signed: 0, pending: 3, missing: 1, complete: false });
  assert.throws(() => W.addDetails(added, [details(guest.id)]));
});

test('signing requires an awaiting request, the named participant, both acknowledgments and the current booking', () => {
  const flow = create();
  const missing = flow.participants[1];
  assert.throws(() => W.sign(flow, missing.id, consent('Jamie Example'), 'booking-a'));
  const booker = flow.participants[0];
  for (const input of [consent(''), consent('Someone Else'), { ...consent(booker.name), read: false }, { ...consent(booker.name), simulation: false }]) {
    assert.throws(() => W.sign(flow, booker.id, input, 'booking-a'));
  }
  assert.throws(() => W.sign(flow, booker.id, consent(booker.name), 'booking-b'));
  assert.throws(() => W.sign(flow, 'missing-person', consent(booker.name), 'booking-a'));
  assert.equal(flow.participants[0].status, 'awaiting-signature');
  const signed = W.sign(flow, booker.id, consent('  alex   example  '), 'booking-a');
  assert.equal(flow.participants[0].status, 'awaiting-signature');
  assert.equal(signed.participants[0].status, 'signed');
  assert.deepEqual(signed.participants[0].signature, { fullName: 'alex example' });
  assert.equal(signed.participants[1].status, 'needs-details');
  assert.equal(W.progress(signed).signed, 1);
  assert.throws(() => W.sign(signed, booker.id, consent('Alex Example'), 'booking-a'));
});

test('resend only applies to awaiting requests, stops after three, and never touches a signature', () => {
  let flow = create();
  assert.throws(() => W.resend(flow, flow.participants[1].id));
  assert.throws(() => W.resend(flow, 'missing-person'));
  for (let count = 1; count <= W.resendLimit; count++) {
    const before = flow;
    flow = W.resend(flow, 'guest-1');
    assert.equal(before.participants[0].deliveries, count);
    assert.equal(flow.participants[0].deliveries, count + 1);
    assert.equal(flow.participants[0].status, 'awaiting-signature');
  }
  assert.equal(W.resendLimit, 3);
  assert.throws(() => W.resend(flow, 'guest-1'), /3 resends/);
  assert.equal(flow.participants[0].deliveries, 4);
  const signed = W.sign(flow, 'guest-1', consent('Alex Example'), 'booking-a');
  assert.throws(() => W.resend(signed, 'guest-1'));
  assert.deepEqual(signed.participants[0].signature, { fullName: 'Alex Example' });
  let added = W.addDetails(signed, [details('guest-2')]);
  added = W.resend(added, 'guest-2');
  assert.equal(added.participants[1].deliveries, 2);
  assert.deepEqual(added.participants[0].signature, { fullName: 'Alex Example' });
  assert.equal(added.participants[0].status, 'signed');
});

test('completion requires every participant and preserves earlier signatures', () => {
  let flow = create();
  flow = W.sign(flow, 'guest-1', consent('Alex Example'), 'booking-a');
  const firstSignature = flow.participants[0].signature;
  flow = W.addDetails(flow, [details('guest-2'), details('guest-3', 'Robin Example', 'robin@example.com')]);
  assert.deepEqual(flow.participants[0].signature, firstSignature);
  assert.deepEqual(W.progress(flow), { total: 3, identified: 3, signed: 1, pending: 2, missing: 0, complete: false });
  flow = W.sign(flow, 'guest-2', consent('Jamie Example'), 'booking-a');
  assert.equal(W.progress(flow).complete, false);
  flow = W.sign(flow, 'guest-3', consent('Robin Example'), 'booking-a');
  assert.deepEqual(W.progress(flow), { total: 3, identified: 3, signed: 3, pending: 0, missing: 0, complete: true });
  assert.deepEqual(flow.participants[0].signature, firstSignature);
});

test('a single-guest booking is complete once the booker signs', () => {
  const flow = W.create('booking-solo', 1, { name: 'Sam Example', email: 'sam@example.com' });
  assert.deepEqual(W.progress(flow), { total: 1, identified: 1, signed: 0, pending: 1, missing: 0, complete: false });
  const signed = W.sign(flow, 'guest-1', consent('Sam Example'), 'booking-solo');
  assert.equal(W.progress(signed).complete, true);
});

test('starting a replacement booking carries no added guests, resends or signatures', () => {
  const original = create();
  const signed = W.sign(W.resend(original, 'guest-1'), 'guest-1', consent('Alex Example'), 'booking-a');
  const replacement = W.create('booking-b', 3, { name: 'Jamie Example', email: 'jamie@example.com' });
  assert.equal(replacement.participants.length, 3);
  assert.equal(replacement.participants[0].deliveries, 1);
  assert.ok(replacement.participants.slice(1).every(p => p.status === 'needs-details' && p.deliveries === 0));
  assert.ok(replacement.participants.every(p => p.signature === null));
  assert.equal(W.progress(replacement).signed, 0);
  assert.equal(W.progress(signed).signed, 1);
});
