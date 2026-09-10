'use strict';

// Fixed, fictional September–October 2026 inventory. No live availability.
const TideGrid = (() => {
  const experiences = [
    { id: 'fishing', name: 'Coastal fishing', type: 'shared', duration: '4 hours', price: 9500, max: 6, boat: 'Saltline One', theme: 'fishing', tagline: 'A good morning. A better fish story.', description: 'Head along the coast with a small group and a local-style guide. Settle into the rhythm of the water, with tackle and bait included in this example.', highlights: ['Tackle & bait included', 'Small group, up to 6', 'Morning or afternoon'], preparation: 'Bring sun protection, water, and nonslip shoes. Ask your operator which fishing-license requirements apply.' },
    { id: 'reef', name: 'Reef discovery dive', type: 'shared', duration: '3 hours', price: 14500, max: 8, boat: 'Blue Current', theme: 'reef', tagline: 'A different world, just below the surface.', description: 'A two-site reef outing for certified divers. Explore a fictional coastal reef with a small group; actual sites and conditions would be confirmed by your operator.', highlights: ['Certified divers only', 'Two reef sites', 'Tanks & weights included'], preparation: 'Certified divers only in this example. Bring certification details and your dive equipment; the real operator would confirm eligibility, equipment, and conditions. This demo verifies none of these.' },
    { id: 'sunset', name: 'Sunset on the water', type: 'shared', duration: '2 hours', price: 6900, max: 12, boat: 'Evening Tide', theme: 'sunset', tagline: 'The coast looks better in golden light.', description: 'Slow down for a relaxed cruise along the shoreline. Find your favorite spot on deck and watch the day turn to evening.', highlights: ['Relaxed coastal cruise', 'Up to 12 guests', 'Water & soft drinks included'], preparation: 'Bring a light layer, sun protection, and nonslip shoes. Your actual operator would confirm the route and onboard refreshments.' },
    { id: 'private', name: 'Your own stretch of ocean', type: 'private', duration: '4 hours', price: 65000, max: 6, boat: 'Saltline Reserve', theme: 'private', tagline: 'Your people. Your boat. Your afternoon.', description: 'Have the boat to yourselves for a coastal escape. This sample charter includes a captain and a flexible route to discuss with the operator.', highlights: ['Whole boat for up to 6', 'Captain included', 'Plan your route together'], preparation: 'Bring sun protection, water, and nonslip shoes. Discuss your preferred activities and any special requirements with the actual operator before traveling.' }
  ];
  const sailingDays = ['09-12', '09-13', '09-16', '09-18', '09-19', '09-20', '09-21', '09-23', '09-25', '09-26', '09-27', '09-30', '10-02', '10-03', '10-04', '10-07', '10-09', '10-10', '10-11', '10-14', '10-16', '10-17', '10-18', '10-21', '10-23', '10-24', '10-25', '10-28', '10-30', '10-31'];
  const departures = sailingDays.flatMap((day, index) => {
    const date = `2026-${day}`;
    const soldOut = day === '09-21';
    const rows = [
      ['fishing', '08:00', index % 4 === 0 ? 2 : 6],
      ['sunset', day.startsWith('09') ? '17:30' : '17:00', index % 3 === 0 ? 0 : 10],
      [index % 2 === 0 ? 'reef' : 'private', index % 2 === 0 ? '09:30' : '13:00', index % 2 === 0 ? 8 : 6]
    ];
    if (day === '09-26') rows.push(['fishing', '13:00', 2], ['reef', '09:30', 0]);
    return rows.map(([experienceId, time, remaining]) => ({ id: `${date}-${experienceId}-${time.replace(':', '')}`, experienceId, date, time, remaining: soldOut ? 0 : remaining }));
  }).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  const months = ['2026-09', '2026-10'];
  const experience = id => experiences.find(item => item.id === id);
  const departure = id => departures.find(item => item.id === id);
  const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
  const dateLabel = (date, options = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) => new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
  const timeLabel = time => { const [hour, minute] = time.split(':').map(Number); return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`; };
  const arrivalTime = item => { const [hour, minute] = item.time.split(':').map(Number); const total = hour * 60 + minute - 30; return timeLabel(`${Math.floor(total / 60)}:${total % 60}`); };
  const partyError = party => Number.isInteger(Number(party)) && Number(party) >= 1 && Number(party) <= 12 ? '' : 'Choose a whole number of guests from 1 to 12.';
  function availability(item, party) {
    if (partyError(party)) return partyError(party);
    if (!item) return 'Choose a departure to continue.';
    if (!item.remaining) return 'Sold out';
    const trip = experience(item.experienceId);
    if (Number(party) > trip.max) return `Maximum ${trip.max} guests`;
    if (Number(party) > item.remaining) return `Only ${item.remaining} seats left`;
    return '';
  }
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
  return { experiences, departures, months, experience, departure, money, dateLabel, timeLabel, arrivalTime, partyError, availability, matching, quote };
})();
if (typeof module !== 'undefined') module.exports = TideGrid;
