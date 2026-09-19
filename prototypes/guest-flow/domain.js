'use strict';

// Fictional inventory generated relative to today in the operator zone. No live availability.
const TideGrid = (() => {
  const zone = 'America/New_York';
  const experiences = [
    { id: 'fishing', name: 'Coastal fishing', type: 'shared', duration: '4 hours', price: 9500, max: 6, boat: 'Saltline One', theme: 'fishing', tagline: 'A good morning. A better fish story.', description: 'Head along the coast with a small group and a local-style guide. Settle into the rhythm of the water, with tackle and bait included in this example.', highlights: ['Tackle & bait included', 'Small group, up to 6', 'Morning or afternoon'], preparation: 'Bring sun protection, water, and nonslip shoes. Ask your operator which fishing-license requirements apply.' },
    { id: 'reef', name: 'Reef discovery dive', type: 'shared', duration: '3 hours', price: 14500, max: 8, boat: 'Blue Current', theme: 'reef', tagline: 'A different world, just below the surface.', description: 'A two-site reef outing for certified divers. Explore a fictional coastal reef with a small group; actual sites and conditions would be confirmed by your operator.', highlights: ['Certified divers only', 'Two reef sites', 'Tanks & weights included'], preparation: 'Certified divers only in this example. Bring certification details and your dive equipment; the real operator would confirm eligibility, equipment, and conditions. This demo verifies none of these.' },
    { id: 'sunset', name: 'Sunset on the water', type: 'shared', duration: '2 hours', price: 6900, max: 12, boat: 'Evening Tide', theme: 'sunset', tagline: 'The coast looks better in golden light.', description: 'Slow down for a relaxed cruise along the shoreline. Find your favorite spot on deck and watch the day turn to evening.', highlights: ['Relaxed coastal cruise', 'Up to 12 guests', 'Water & soft drinks included'], preparation: 'Bring a light layer, sun protection, and nonslip shoes. Your actual operator would confirm the route and onboard refreshments.' },
    { id: 'private', name: 'Your own stretch of ocean', type: 'private', duration: '4 hours', price: 65000, max: 6, boat: 'Saltline Reserve', theme: 'private', tagline: 'Your people. Your boat. Your afternoon.', description: 'Have the boat to yourselves for a coastal escape. This sample charter includes a captain and a flexible route to discuss with the operator.', highlights: ['Whole boat for up to 6', 'Captain included', 'Plan your route together'], preparation: 'Bring sun protection, water, and nonslip shoes. Discuss your preferred activities and any special requirements with the actual operator before traveling.' }
  ];
  const day = 86400000;
  const pad = value => String(value).padStart(2, '0');
  const iso = (year, month, date) => `${year}-${pad(month)}-${pad(date)}`;
  const parse = date => { const [year, month, date_] = String(date).split('-').map(Number); return { year, month, date: date_ }; };
  const utcNoon = date => { const parts = parse(date); return Date.UTC(parts.year, parts.month - 1, parts.date, 12); };
  const fromUTC = ms => { const at = new Date(ms); return iso(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate()); };
  const addDays = (date, count) => fromUTC(utcNoon(date) + count * day);
  const weekday = date => new Date(utcNoon(date)).getUTCDay();
  const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
  const validDate = date => /^\d{4}-\d{2}-\d{2}$/.test(String(date)) && fromUTC(utcNoon(date)) === date;
  const zoneParts = at => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).formatToParts(at).map(part => [part.type, part.value]));
  const zoneDate = at => { const parts = zoneParts(at); return `${parts.year}-${parts.month}-${parts.day}`; };
  // Accepts a YYYY-MM-DD date (evaluated at local noon) or an instant, and returns the zone's short name for that moment (daylight or standard).
  const zoneLabel = date => zoneParts(typeof date === 'string' ? new Date(utcNoon(date)) : new Date(date)).timeZoneName;
  // Epoch milliseconds for a wall-clock time in the operator zone; the offset comes from Intl, not a constant.
  function instant(date, time) {
    const parts = parse(date);
    const [hour, minute] = String(time).split(':').map(Number);
    const wall = Date.UTC(parts.year, parts.month - 1, parts.date, hour, minute);
    const offsetAt = ms => { const p = zoneParts(new Date(ms)); return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second)) - ms; };
    const first = wall - offsetAt(wall);
    const resolved = wall - offsetAt(first);
    // A wall time inside the spring-forward gap does not exist; move it forward (02:30 becomes 03:30) rather than back.
    const p = zoneParts(new Date(resolved));
    return Number(p.hour) % 24 === hour && Number(p.minute) === minute ? resolved : first;
  }
  // True while the zone observes daylight saving: the UTC offset at local noon is smaller than the mid-January (standard time) offset.
  const daylightSaving = date => instant(date, '12:00') - utcNoon(date) < instant(`${parse(date).year}-01-15`, '12:00') - Date.UTC(parse(date).year, 0, 15, 12);
  const experience = id => experiences.find(item => item.id === id);
  const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
  const dateLabel = (date, options = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) => new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
  const timeLabel = time => { const [hour, minute] = time.split(':').map(Number); return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`; };
  const arrivalTime = item => { const [hour, minute] = item.time.split(':').map(Number); const total = hour * 60 + minute - 30; return timeLabel(`${Math.floor(total / 60)}:${total % 60}`); };
  const partyError = party => Number.isInteger(Number(party)) && Number(party) >= 1 && Number(party) <= 12 ? '' : 'Choose a whole number of guests from 1 to 12.';

  // Builds the inventory for a given "today" (YYYY-MM-DD in the operator zone) and an optional "now" instant (epoch ms).
  // Tests inject the date to stay deterministic; without "now", every departure on today's date is still ahead.
  function build(todayISO, nowMs) {
    if (!validDate(todayISO)) throw new Error('build() requires a YYYY-MM-DD date.');
    if (nowMs !== undefined && !Number.isFinite(nowMs)) throw new Error('build() takes "now" as epoch milliseconds.');
    const today = todayISO;
    const now = nowMs === undefined ? instant(today, '00:00') : nowMs;
    const { year, month } = parse(today);
    const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
    const months = [`${year}-${pad(month)}`, `${next.year}-${pad(next.month)}`];
    const bounds = { start: iso(year, month, 1), end: iso(next.year, next.month, daysInMonth(next.year, next.month)) };
    const pattern = [0, 3, 5, 6]; // Sun, Wed, Fri, Sat
    const sailingDays = [];
    for (let date = bounds.start; date <= bounds.end; date = addDays(date, 1)) if (pattern.includes(weekday(date))) sailingDays.push(date);
    // Inside today+1 through today+14: one featured day (the default selection, with the low-seat and sold-out rows the tests use),
    // exactly one fully sold-out sailing day, and at least one weekday without sailings (the pattern skips Mon, Tue and Thu).
    // The calendar opens on the featured day's month, so the sold-out day must share that month or Session A task 2 cannot find
    // it. Near a month end the first sailing three days out can be the month's only upcoming sailing; the featured day then moves
    // to the next sailing (at most three days later), which is in the next month with sailings around it. The sold-out day is the
    // first other upcoming sailing in the featured month, so both stay well inside the 14-day window.
    const upcoming = date => date >= addDays(today, 1);
    const partner = candidate => sailingDays.find(date => upcoming(date) && date !== candidate && date.slice(0, 7) === candidate.slice(0, 7));
    const featureDay = sailingDays.find(date => date >= addDays(today, 3) && partner(date));
    const soldOutDay = partner(featureDay);
    const departures = sailingDays.flatMap((date, index) => {
      const sunsetTime = daylightSaving(date) ? '17:30' : '17:00';
      const rows = date === featureDay
        ? [['fishing', '08:00', 6], ['sunset', sunsetTime, 0], ['private', '13:00', 6], ['fishing', '13:00', 2], ['reef', '09:30', 0]]
        : [
          ['fishing', '08:00', index % 4 === 0 ? 2 : 6],
          ['sunset', sunsetTime, index % 3 === 0 ? 0 : 10],
          [index % 2 === 0 ? 'reef' : 'private', index % 2 === 0 ? '09:30' : '13:00', index % 2 === 0 ? 8 : 6]
        ];
      return rows.map(([experienceId, time, remaining]) => ({ id: `${date}-${experienceId}-${time.replace(':', '')}`, experienceId, date, time, remaining: date === soldOutDay ? 0 : remaining }));
    }).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
    const isPast = date => String(date) < today;
    // A departure is past once its wall-clock start in the operator zone is behind "now"; this covers today's earlier sailings.
    const departed = item => isPast(item.date) || instant(item.date, item.time) < now;
    const departure = id => departures.find(item => item.id === id);
    // The featured day is the default selection: it is never the sold-out day and always carries available rows.
    const defaultDay = featureDay;
    function availability(item, party) {
      if (partyError(party)) return partyError(party);
      if (!item) return 'Choose a departure to continue.';
      if (departed(item)) return 'Past';
      if (!item.remaining) return 'Sold out';
      const trip = experience(item.experienceId);
      if (Number(party) > trip.max) return `Maximum ${trip.max} guests`;
      if (Number(party) > item.remaining) return `Only ${item.remaining} seats left`;
      return '';
    }
    // Past departures are still returned so the calendar can render those days as disabled.
    function matching(filters, { ignoreDay = false } = {}) {
      return departures.filter(item => {
        const trip = experience(item.experienceId);
        return item.date.startsWith(filters.month) && (!filters.experience || trip.id === filters.experience) && (!filters.type || trip.type === filters.type) && (ignoreDay || !filters.selectedDay || item.date === filters.selectedDay);
      });
    }
    function quote(item, party) {
      if (availability(item, party)) return null;
      const trip = experience(item.experienceId);
      const subtotal = trip.price * (trip.type === 'private' ? 1 : Number(party));
      const fee = 1000;
      const tax = Math.round((subtotal + fee) * 0.06);
      return { subtotal, fee, tax, total: subtotal + fee + tax };
    }
    return { zone, experiences, departures, months, bounds, today, now, defaultDay, experience, departure, money, dateLabel, timeLabel, arrivalTime, partyError, availability, matching, quote, isPast, departed, zoneLabel, instant, build };
  }
  return build(zoneDate(new Date()), Date.now());
})();
if (typeof module !== 'undefined') module.exports = TideGrid;
