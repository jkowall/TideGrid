const test = require('node:test');
const assert = require('node:assert/strict');
const TideGrid = require('./domain.js');

// Tests inject "today" so the relative inventory stays deterministic: 2026-09-19 is a Saturday.
const TODAY = '2026-09-19';
const inventory = TideGrid.build(TODAY);
const DAY = 86400000;
const addDays = (date, count) => new Date(new Date(`${date}T12:00:00Z`).getTime() + count * DAY).toISOString().slice(0, 10);
const on = (date, experience, time) => inventory.departures.find(item =>
  item.date === date && item.experienceId === experience && item.time === time);
const day = inventory.defaultDay; // 2026-09-23 for this today
const soldOutDay = '2026-09-20';
const noSailingDay = '2026-09-21';

test('the window covers the current and next month, and the default export builds from today', () => {
  assert.equal(inventory.today, TODAY);
  assert.deepEqual(inventory.months, ['2026-09', '2026-10']);
  assert.deepEqual(inventory.bounds, { start: '2026-09-01', end: '2026-10-31' });
  assert.ok(inventory.departures.every(item => item.date >= inventory.bounds.start && item.date <= inventory.bounds.end));
  assert.match(TideGrid.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(TideGrid.months[0], TideGrid.today.slice(0, 7));
  assert.equal(typeof TideGrid.build, 'function');
  assert.throws(() => TideGrid.build('2026-13-40'));
  const december = TideGrid.build('2026-12-15');
  assert.deepEqual(december.months, ['2026-12', '2027-01']);
  assert.equal(december.bounds.end, '2027-01-31');
});

test('the deterministic pattern produces the expected dates for this today', () => {
  assert.equal(day, '2026-09-23');
  const september = [...new Set(inventory.departures.filter(item => item.date.startsWith('2026-09')).map(item => item.date))];
  assert.deepEqual(september, ['2026-09-02', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-09', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-16', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-23', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-30']);
  const experiences = new Set(inventory.departures.filter(item => !inventory.isPast(item.date)).map(item => item.experienceId));
  assert.deepEqual([...experiences].sort(), ['fishing', 'private', 'reef', 'sunset']);
  assert.ok(on('2026-09-25', 'private', '13:00') && !on('2026-09-25', 'reef', '09:30'));
  assert.ok(on('2026-09-26', 'reef', '09:30') && !on('2026-09-26', 'private', '13:00'));
});

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

test('the default day is at least three days ahead and has an available departure', () => {
  assert.ok(day >= addDays(TODAY, 3));
  assert.ok(inventory.departures.some(item => item.date === day && inventory.availability(item, 1) === ''));
  for (const today of ['2026-09-01', '2026-09-30', '2026-10-31', '2026-11-01', '2026-02-27', '2027-12-31']) {
    const built = TideGrid.build(today);
    assert.ok(built.defaultDay >= addDays(today, 3), today);
    assert.ok(built.defaultDay <= addDays(today, 6), today);
    assert.ok(built.departures.some(item => item.date === built.defaultDay && built.availability(item, 1) === ''), today);
  }
});

test('exactly one sold-out sailing day and a no-sailing weekday fall within the next 14 days', () => {
  // The month-end todays open the calendar on the next month; the sold-out day must sit in that month so Session A task 2 can find it.
  for (const today of [TODAY, '2026-09-01', '2026-09-27', '2026-10-29', '2026-10-30', '2026-10-31', '2026-12-27', '2026-12-28', '2027-01-29', '2027-01-30']) {
    const built = TideGrid.build(today);
    const window = [];
    for (let offset = 1; offset <= 14; offset++) window.push(addDays(today, offset));
    const sailing = window.filter(date => built.departures.some(item => item.date === date));
    const soldOut = sailing.filter(date => built.departures.filter(item => item.date === date).every(item => item.remaining === 0));
    assert.equal(soldOut.length, 1, today);
    assert.notEqual(soldOut[0], built.defaultDay, today);
    assert.equal(soldOut[0].slice(0, 7), built.defaultDay.slice(0, 7), today);
    const everySoldOut = [...new Set(built.departures.map(item => item.date))].filter(date => built.departures.filter(item => item.date === date).every(item => item.remaining === 0));
    assert.deepEqual(everySoldOut, soldOut, today);
    const quiet = window.filter(date => !built.departures.some(item => item.date === date));
    assert.ok(quiet.length >= 1, today);
  }
  assert.ok(inventory.departures.some(item => item.date === soldOutDay));
  assert.ok(inventory.departures.filter(item => item.date === soldOutDay).every(item => inventory.availability(item, 1) === 'Sold out'));
  assert.equal(inventory.matching({ month: '2026-09', selectedDay: noSailingDay }).length, 0);
});

test('past departures stay in matching for the calendar but are unavailable', () => {
  assert.equal(inventory.isPast(addDays(TODAY, -1)), true);
  assert.equal(inventory.isPast(TODAY), false);
  assert.equal(inventory.isPast(addDays(TODAY, 1)), false);
  const past = inventory.matching({ month: '2026-09' }).filter(item => inventory.isPast(item.date));
  assert.ok(past.length > 0);
  assert.ok(past.every(item => inventory.availability(item, 1) === 'Past'));
  assert.ok(past.every(item => inventory.quote(item, 1) === null));
  const todayRows = inventory.departures.filter(item => item.date === TODAY);
  assert.ok(todayRows.length > 0);
  // Without an injected "now", every departure on today's date is still ahead.
  assert.equal(inventory.now, inventory.instant(TODAY, '00:00'));
  assert.ok(todayRows.every(item => !inventory.departed(item)));
  assert.ok(todayRows.some(item => inventory.availability(item, 1) === ''));
});

test('with an injected now, departures earlier today are past while later ones stay bookable', () => {
  const morning = on(TODAY, 'fishing', '08:00');
  const later = inventory.departures.find(item => item.date === TODAY && item.time > '10:00' && item.remaining > 0);
  assert.ok(morning && later);
  const tenAM = TideGrid.build(TODAY, inventory.instant(TODAY, '10:00'));
  assert.equal(tenAM.now, inventory.instant(TODAY, '10:00'));
  assert.equal(tenAM.availability(tenAM.departure(morning.id), 1), 'Past');
  assert.equal(tenAM.quote(tenAM.departure(morning.id), 1), null);
  assert.equal(tenAM.availability(tenAM.departure(later.id), 1), '');
  assert.equal(tenAM.isPast(TODAY), false);
  assert.equal(tenAM.defaultDay, inventory.defaultDay);
  const night = TideGrid.build(TODAY, inventory.instant(TODAY, '23:59'));
  assert.ok(night.departures.filter(item => item.date === TODAY).every(item => night.availability(item, 1) === 'Past'));
  assert.ok(night.departures.filter(item => item.date === addDays(TODAY, 1)).every(item => !night.departed(item)));
  assert.equal(TideGrid.build(TODAY, inventory.instant(TODAY, '07:59')).availability(morning, 1), '');
  assert.equal(TideGrid.build(TODAY, inventory.instant(TODAY, '08:00')).availability(morning, 1), '');
  assert.equal(TideGrid.build(TODAY, inventory.instant(TODAY, '08:01')).availability(morning, 1), 'Past');
  assert.throws(() => TideGrid.build(TODAY, 'tonight'));
  assert.throws(() => TideGrid.build(TODAY, NaN));
});

test('zone labels and instants follow America/New_York daylight time', () => {
  assert.equal(inventory.zoneLabel('2026-07-04'), 'EDT');
  assert.equal(inventory.zoneLabel('2026-01-15'), 'EST');
  assert.equal(inventory.zoneLabel(day), 'EDT');
  assert.equal(inventory.zoneLabel(Date.UTC(2026, 0, 15, 12)), 'EST');
  assert.equal(inventory.instant('2026-07-04', '12:00'), Date.UTC(2026, 6, 4, 16));
  assert.equal(inventory.instant('2026-01-15', '12:00'), Date.UTC(2026, 0, 15, 17));
  // Daylight time ends on 2026-11-01, so the same wall time one day apart is 25 hours apart.
  assert.equal(inventory.instant('2026-11-01', '12:00') - inventory.instant('2026-10-31', '12:00'), 25 * 60 * 60 * 1000);
  assert.equal(inventory.instant('2026-03-08', '12:00') - inventory.instant('2026-03-07', '12:00'), 23 * 60 * 60 * 1000);
  assert.equal(inventory.departures.find(item => item.date === '2026-09-30' && item.experienceId === 'sunset').time, '17:30');
  assert.equal(TideGrid.build('2026-11-15').departures.find(item => item.experienceId === 'sunset' && item.date === '2026-11-18').time, '17:00');
  // The transition days themselves: daylight time ends 2026-11-01 (Sunday) and begins 2026-03-08 (Sunday); both are sailing days.
  assert.equal(inventory.zoneLabel('2026-10-31'), 'EDT');
  assert.equal(inventory.zoneLabel('2026-11-01'), 'EST');
  assert.equal(inventory.zoneLabel('2026-03-07'), 'EST');
  assert.equal(inventory.zoneLabel('2026-03-08'), 'EDT');
  // The ambiguous 01:30 on 2026-11-01 resolves to its first occurrence (still daylight time); 03:00 on 2026-03-08 is the first hour after the gap.
  assert.equal(inventory.instant('2026-11-01', '01:30'), Date.UTC(2026, 10, 1, 5, 30));
  assert.equal(inventory.instant('2026-03-08', '01:59'), Date.UTC(2026, 2, 8, 6, 59));
  assert.equal(inventory.instant('2026-03-08', '03:00'), Date.UTC(2026, 2, 8, 7));
  const sunsetOn = (today, date) => TideGrid.build(today).departures.find(item => item.experienceId === 'sunset' && item.date === date).time;
  assert.equal(sunsetOn('2026-10-15', '2026-10-31'), '17:30');
  assert.equal(sunsetOn('2026-10-15', '2026-11-01'), '17:00');
  assert.equal(sunsetOn('2026-02-15', '2026-03-07'), '17:00');
  assert.equal(sunsetOn('2026-02-15', '2026-03-08'), '17:30');
});

test('month, day, experience and charter filters compose without leaking other dates', () => {
  const filters = { month: '2026-09', selectedDay: day, experience: 'fishing', type: 'shared' };
  assert.deepEqual(inventory.matching(filters).map(item => item.time), ['08:00', '13:00']);
  assert.ok(inventory.matching(filters, { ignoreDay: true }).length > 2);
  assert.equal(inventory.matching({ ...filters, type: 'private' }).length, 0);
  const october = inventory.matching({ month: '2026-10' });
  assert.ok(october.length > 0);
  assert.ok(october.every(item => item.date.startsWith('2026-10')));
});

test('no sailings, sold out and too few seats remain distinguishable', () => {
  assert.equal(inventory.matching({ month: '2026-09', selectedDay: noSailingDay }).length, 0);
  const soldOut = inventory.matching({ month: '2026-09', selectedDay: soldOutDay });
  assert.ok(soldOut.length > 0);
  assert.ok(soldOut.every(item => inventory.availability(item, 1) === 'Sold out'));
  const afternoon = on(day, 'fishing', '13:00');
  assert.equal(inventory.availability(afternoon, 2), '');
  assert.equal(inventory.availability(afternoon, 3), 'Only 2 seats left');
  assert.equal(inventory.quote(afternoon, 3), null);
  assert.equal(inventory.availability(on(day, 'reef', '09:30'), 1), 'Sold out');
});

test('quote requires an explicit departure and a valid whole party', () => {
  assert.equal(inventory.quote(undefined, 2), null);
  for (const party of ['', '0', '-1', '1.5', '13', 'abc', 'Infinity']) {
    assert.ok(inventory.partyError(party));
    assert.equal(inventory.quote(on(day, 'fishing', '08:00'), party), null);
  }
  assert.equal(inventory.quote(on(day, 'sunset', '17:30'), 1), null);
});

test('shared price scales by guests while private price stays flat within boat capacity', () => {
  const shared = on(day, 'fishing', '08:00');
  const charter = on(day, 'private', '13:00');
  assert.deepEqual(inventory.quote(shared, 2), { subtotal: 19000, fee: 1000, tax: 1200, total: 21200 });
  assert.equal(inventory.quote(shared, 3).subtotal, 28500);
  assert.equal(inventory.quote(charter, 1).total, 69960);
  assert.deepEqual(inventory.quote(charter, 1), inventory.quote(charter, 6));
  assert.equal(inventory.quote(charter, 7), null);
});

test('arrival and date labels preserve the selected local sailing date', () => {
  assert.equal(inventory.arrivalTime(on(day, 'fishing', '08:00')), '7:30 AM');
  assert.equal(inventory.arrivalTime(on(day, 'reef', '09:30')), '9:00 AM');
  assert.equal(inventory.dateLabel('2026-10-31'), 'Saturday, October 31, 2026');
  assert.equal(inventory.timeLabel('13:00'), '1:00 PM');
});
