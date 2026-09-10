const test = require('node:test');
const assert = require('node:assert/strict');
const inventory = require('./domain.js');

const on = (date, experience, time) => inventory.departures.find(item =>
  item.date === date && item.experienceId === experience && item.time === time);

test('all discovery views share chronological inventory with unique departures', () => {
  const ids = inventory.departures.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  const dates = inventory.departures.map(item => `${item.date}${item.time}`);
  assert.deepEqual(dates, [...dates].sort());
  for (const item of inventory.departures) {
    assert.ok(inventory.experience(item.experienceId));
    assert.ok(item.remaining >= 0);
  }
});

test('month, day, experience and charter filters compose without leaking other dates', () => {
  const filters = { month: '2026-09', selectedDay: '2026-09-26', experience: 'fishing', type: 'shared' };
  assert.deepEqual(inventory.matching(filters).map(item => item.time), ['08:00', '13:00']);
  assert.ok(inventory.matching(filters, { ignoreDay: true }).length > 2);
  assert.equal(inventory.matching({ ...filters, type: 'private' }).length, 0);
  const october = inventory.matching({ month: '2026-10' });
  assert.ok(october.length > 0);
  assert.ok(october.every(item => item.date.startsWith('2026-10')));
});

test('no sailings, sold out and too few seats remain distinguishable', () => {
  assert.equal(inventory.matching({ month: '2026-09', selectedDay: '2026-09-22' }).length, 0);
  const soldOut = inventory.matching({ month: '2026-09', selectedDay: '2026-09-21' });
  assert.ok(soldOut.length > 0);
  assert.ok(soldOut.every(item => inventory.availability(item, 1) === 'Sold out'));
  const afternoon = on('2026-09-26', 'fishing', '13:00');
  assert.equal(inventory.availability(afternoon, 2), '');
  assert.equal(inventory.availability(afternoon, 3), 'Only 2 seats left');
  assert.equal(inventory.quote(afternoon, 3), null);
});

test('quote requires an explicit departure and a valid whole party', () => {
  assert.equal(inventory.quote(undefined, 2), null);
  for (const party of ['', '0', '-1', '1.5', '13', 'abc', 'Infinity']) {
    assert.ok(inventory.partyError(party));
    assert.equal(inventory.quote(on('2026-09-26', 'fishing', '08:00'), party), null);
  }
  assert.equal(inventory.quote(on('2026-09-26', 'sunset', '17:30'), 1), null);
});

test('shared price scales by guests while private price stays flat within boat capacity', () => {
  const shared = on('2026-09-26', 'fishing', '08:00');
  const charter = on('2026-09-26', 'private', '13:00');
  assert.deepEqual(inventory.quote(shared, 2), { subtotal: 19000, fee: 1000, tax: 1200, total: 21200 });
  assert.equal(inventory.quote(shared, 3).subtotal, 28500);
  assert.equal(inventory.quote(charter, 1).total, 69960);
  assert.deepEqual(inventory.quote(charter, 1), inventory.quote(charter, 6));
  assert.equal(inventory.quote(charter, 7), null);
});

test('arrival and date labels preserve the selected local sailing date', () => {
  assert.equal(inventory.arrivalTime(on('2026-09-26', 'fishing', '08:00')), '7:30 AM');
  assert.equal(inventory.arrivalTime(on('2026-09-26', 'reef', '09:30')), '9:00 AM');
  assert.equal(inventory.dateLabel('2026-10-31'), 'Saturday, October 31, 2026');
  assert.equal(inventory.timeLabel('13:00'), '1:00 PM');
});
