const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('./waiver.js');

const create = () => W.create('booking-a', 2, { name: 'Alex Example', email: 'alex@example.com' });
const consent = fullName => ({ fullName, read: true, simulation: true });

test('a booking starts with one unsigned request per participant', () => {
  const flow = create();
  assert.equal(flow.participants.length, 2);
  assert.equal(flow.participants[0].name, 'Alex Example');
  assert.equal(new Set(flow.participants.map(p => p.id)).size, 2);
  assert.ok(flow.participants.every(p => p.status === 'not-sent' && p.signature === null));
  assert.equal(W.progress(flow).complete, false);
});

test('requests must be sent before signing and require valid recipients', () => {
  const flow = create();
  const guest = flow.participants[0];
  assert.throws(() => W.sign(flow, guest.id, consent(guest.name), 'booking-a'));
  assert.throws(() => W.sendRequests(flow, [{ ...guest, email: 'invalid' }]));
  assert.throws(() => W.sendRequests(flow, [{ ...guest, name: ' ' }]));
  assert.equal(flow.participants[0].status, 'not-sent');
});

test('sending and signing are isolated to the selected participant', () => {
  const original = create();
  const sent = W.sendRequests(original, [original.participants[0]]);
  assert.equal(original.participants[0].status, 'not-sent');
  assert.equal(sent.participants[0].status, 'awaiting-signature');
  assert.equal(sent.participants[1].status, 'not-sent');
  const signed = W.sign(sent, sent.participants[0].id, consent('Alex Example'), 'booking-a');
  assert.equal(sent.participants[0].status, 'awaiting-signature');
  assert.equal(signed.participants[0].status, 'signed');
  assert.equal(signed.participants[1].status, 'not-sent');
  assert.equal(W.progress(signed).signed, 1);
  assert.equal(W.progress(signed).complete, false);
});

test('signing requires the named participant, both acknowledgments and the current booking', () => {
  const flow = create();
  const sent = W.sendRequests(flow, flow.participants);
  const guest = sent.participants[0];
  for (const input of [consent(''), consent('Someone Else'), { ...consent(guest.name), read: false }, { ...consent(guest.name), simulation: false }]) {
    assert.throws(() => W.sign(sent, guest.id, input, 'booking-a'));
  }
  assert.throws(() => W.sign(sent, guest.id, consent(guest.name), 'booking-b'));
  assert.throws(() => W.sign(sent, 'missing-person', consent(guest.name), 'booking-a'));
  assert.ok(sent.participants.every(p => p.status === 'awaiting-signature'));
});

test('completion requires every participant and preserves earlier signatures', () => {
  const original = create();
  let flow = W.sendRequests(original, [original.participants[0]]);
  flow = W.sign(flow, flow.participants[0].id, consent('  alex   example  '), 'booking-a');
  const firstSignature = flow.participants[0].signature;
  flow = W.sendRequests(flow, [flow.participants[1]]);
  assert.deepEqual(flow.participants[0].signature, firstSignature);
  assert.equal(W.progress(flow).complete, false);
  flow = W.sign(flow, flow.participants[1].id, consent(flow.participants[1].name), 'booking-a');
  assert.equal(W.progress(flow).signed, 2);
  assert.equal(W.progress(flow).complete, true);
  assert.throws(() => W.sign(flow, flow.participants[0].id, consent('Alex Example'), 'booking-a'));
});

test('starting a replacement booking carries no sent requests or signatures', () => {
  const original = create();
  const signed = W.sign(W.sendRequests(original, original.participants), original.participants[0].id, consent('Alex Example'), 'booking-a');
  const replacement = W.create('booking-b', 3, { name: 'Jamie Example', email: 'jamie@example.com' });
  assert.equal(replacement.participants.length, 3);
  assert.ok(replacement.participants.every(p => p.status === 'not-sent' && p.signature === null));
  assert.equal(W.progress(replacement).signed, 0);
  assert.equal(W.progress(signed).signed, 1);
});
