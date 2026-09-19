'use strict';

const D = TideGrid;
const W = WaiverFlow;
const main = document.querySelector('#main');
const initialState = () => ({ step: 0, view: 'calendar', month: D.defaultDay.slice(0, 7), selectedDay: D.defaultDay, experience: '', type: '', party: '2', selectedDepartureId: null, name: '', email: '', confirmed: false, checkout: false, waiverFlow: null, prepView: 'dashboard', participantId: null, requestDrafts: {} });
let state = initialState();
let workspace = 'guest';
let bookingRevision = 0;
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const selected = () => D.departure(state.selectedDepartureId);
const trip = () => D.experience(selected()?.experienceId);
const quote = () => D.quote(selected(), state.party);
const shortDate = date => D.dateLabel(date, { weekday: 'short', month: 'short', day: 'numeric' });
const monthLabel = () => D.dateLabel(`${state.month}-01`, { month: 'long', year: 'numeric' });
const unit = item => item.type === 'private' ? 'boat' : 'guest';
const kind = item => item.type === 'private' ? 'Private charter' : 'Shared trip';
const filtered = () => D.matching(state).filter(item => !D.isPast(item.date));
const available = rows => rows.filter(item => !D.availability(item, state.party));
const zoneNote = () => state.selectedDay ? `All times ${D.zoneLabel(state.selectedDay)}` : 'All times Eastern';
const bookingKey = () => `${state.selectedDepartureId}|${state.party}|${bookingRevision}`;
const participant = () => state.waiverFlow?.participants.find(item => item.id === state.participantId);

function seaArt(theme, small = false) {
  return `<div class="sea-art ${theme} ${small ? 'small-art' : ''}" aria-hidden="true"><svg viewBox="0 0 500 230" preserveAspectRatio="xMidYMid slice"><circle class="sun" cx="380" cy="62" r="30"/><path class="far-water" d="M0 135 Q130 111 250 135 T500 132 V230 H0Z"/><path class="near-water" d="M0 173 Q120 151 255 180 T500 170 V230 H0Z"/><path class="wake" d="M55 202 Q130 185 207 199 M280 210 Q350 195 432 203"/><g class="boat"><path d="M157 138 L300 138 L279 159 L177 159Z"/><path d="M207 134 V96 H259 L276 134 M225 96 V77 M192 114 H272"/></g><path class="horizon" d="M26 130 H111 M326 130 H470"/></svg><span>${theme === 'reef' ? 'Beneath the blue' : theme === 'sunset' ? 'Chase the last light' : theme === 'private' ? 'Make the day yours' : 'Out where you belong'}</span></div>`;
}

function pricing() {
  const q = quote();
  if (!q) return '';
  return `<dl class="price-lines">
    <div class="money-row"><dt>${trip().type === 'private' ? 'Whole boat' : `${escapeHTML(state.party)} × ${D.money(trip().price)}`}</dt><dd>${D.money(q.subtotal)}</dd></div>
    <div class="money-row"><dt>Booking fee</dt><dd>${D.money(q.fee)}</dd></div>
    <div class="money-row"><dt>Sample tax (6%)</dt><dd>${D.money(q.tax)}</dd></div>
    <div class="money-row total"><dt>Sample total</dt><dd>${D.money(q.total)}</dd></div>
  </dl><p class="hint">USD · Full amount · Illustrative tax</p>`;
}

function summary(browsing = false) {
  const item = selected();
  if (!item || !quote()) return browsing ? `<div class="selection-placeholder"><span aria-hidden="true">↗</span><div><strong>Select a departure to see your total.</strong></div></div>` : '';
  return `<aside class="summary ${browsing ? 'browse-summary' : ''}" aria-label="Your trip summary">
    <div class="summary-top"><p class="eyebrow">Your trip</p><h2>${trip().name}</h2><p>${kind(trip())} · ${trip().duration} · ${trip().boat}</p><p><strong>${shortDate(item.date)} · ${D.timeLabel(item.time)} ${D.zoneLabel(item.date)}</strong><br>${escapeHTML(state.party)} guests${trip().type === 'private' ? ' · whole boat' : ''}</p></div>
    <div class="summary-body">${pricing()}${browsing ? '<button class="primary" id="continue" type="button">Continue to guest details →</button>' : ''}</div>
  </aside>`;
}

function filters() {
  return `<section class="filters" aria-label="Find a trip">
    <div><label class="field-label" for="experience">Experience</label><select id="experience"><option value="">All experiences</option>${D.experiences.map(item => `<option value="${item.id}" ${state.experience === item.id ? 'selected' : ''}>${item.name}</option>`).join('')}</select></div>
    <div><label class="field-label" for="trip-type">Trip type</label><select id="trip-type"><option value="">Shared & private</option><option value="shared" ${state.type === 'shared' ? 'selected' : ''}>Shared trips</option><option value="private" ${state.type === 'private' ? 'selected' : ''}>Private charters</option></select></div>
    <div class="party-field"><label class="field-label" for="party">Your group</label><input id="party" type="number" min="1" max="12" step="1" inputmode="numeric" value="${escapeHTML(state.party)}" aria-describedby="party-help party-error" aria-invalid="${Boolean(D.partyError(state.party))}"><span id="party-help" class="hint">1–12 guests</span></div>
  </section><p id="party-error" class="error" role="alert" ${D.partyError(state.party) ? '' : 'hidden'}>${D.partyError(state.party)}</p>`;
}

function toolbar() {
  const monthIndex = D.months.indexOf(state.month);
  return `<div class="browse-toolbar"><div class="view-switch" role="group" aria-label="Browse view">${[['calendar', '▦', 'Calendar'], ['list', '☷', 'List'], ['trips', '≈', 'Trips']].map(([id, icon, label]) => `<button type="button" data-view="${id}" aria-pressed="${state.view === id}"><span aria-hidden="true">${icon}</span> ${label}</button>`).join('')}</div>
    <div class="month-nav"><button class="icon-button" data-month="-1" aria-label="Previous month" ${monthIndex === 0 ? 'disabled' : ''}>←</button><h2 id="month-title">${monthLabel()}</h2><button class="icon-button" data-month="1" aria-label="Next month" ${monthIndex === D.months.length - 1 ? 'disabled' : ''}>→</button></div></div>
    <div class="date-scope"><span>${state.selectedDay ? `Showing ${shortDate(state.selectedDay)}` : `Any day in ${monthLabel()}`} · ${escapeHTML(state.party || '—')} guests</span>${state.selectedDay ? '<button class="text-button" id="any-day">Show any day this month</button>' : `<span class="hint">Sample dates · ${zoneNote()}</span>`}</div>`;
}

function calendar() {
  const first = new Date(`${state.month}-01T12:00:00Z`);
  const total = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const rows = D.matching(state, { ignoreDay: true });
  let cells = '<span class="calendar-blank" aria-hidden="true"></span>'.repeat(first.getUTCDay());
  for (let day = 1; day <= total; day++) {
    const date = `${state.month}-${String(day).padStart(2, '0')}`;
    const matches = rows.filter(item => item.date === date);
    // A day is past once the date has passed, or once every matching departure today has already started.
    const past = D.isPast(date) || (matches.length > 0 && matches.every(D.departed));
    const options = past ? [] : available(matches);
    const low = options.length ? Math.min(...options.map(item => D.experience(item.experienceId).price)) : null;
    const status = past ? 'Past' : options.length ? `${options.length} ${options.length === 1 ? 'trip' : 'trips'}` : matches.length ? matches.every(item => !item.remaining) ? 'Sold out' : 'No fit' : 'No trips';
    const label = `${D.dateLabel(date)}. ${status}${low ? `. Base rates from ${D.money(low)}, per guest or boat; excludes fee and tax` : ''}`;
    cells += `<button class="calendar-day ${options.length ? 'has-trips' : 'no-trips'} ${past ? 'is-past' : ''}" data-day="${date}" aria-label="${label}" aria-pressed="${state.selectedDay === date}" tabindex="-1" ${past ? 'disabled' : ''}><span class="day-number">${day}</span><span class="day-status">${status}</span>${low ? `<span class="day-price">$${low / 100}+</span>` : '<span class="day-price">—</span>'}</button>`;
  }
  return `<section class="calendar-panel" aria-labelledby="month-title"><div class="weekdays" aria-hidden="true">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => `<span>${day}</span>`).join('')}</div><div class="calendar-grid">${cells}</div><p class="calendar-key"><span class="key-dot" aria-hidden="true"></span> Available for your group <span>Base price / guest or boat · excludes fee & tax</span></p><details class="compact-details hint"><summary>Calendar key</summary><p>No trips: no matching sailings. No fit: insufficient space for your group. Past: the day, or every departure on it, has already started. Use the arrow keys, Home and End to move between days.</p></details></section>`;
}

// Roving tabindex: one day is in the Tab order; arrow keys, Home and End move focus without selecting.
function bindCalendarKeys() {
  const grid = main.querySelector('.calendar-grid');
  if (!grid) return;
  const days = [...grid.querySelectorAll('.calendar-day')];
  const focusable = item => item && !item.disabled;
  const start = days.find(item => item.dataset.day === state.selectedDay && focusable(item)) || days.find(item => item.classList.contains('has-trips')) || days.find(focusable) || days[0];
  const settle = target => days.forEach(item => { item.tabIndex = item === target ? 0 : -1; });
  settle(start);
  grid.addEventListener('keydown', event => {
    const index = days.indexOf(event.target);
    if (index < 0) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    let target;
    if (step) { let next = index + step; while (days[next] && !focusable(days[next])) next += Math.sign(step); target = days[next]; }
    else if (event.key === 'Home') target = days.find(focusable);
    else if (event.key === 'End') target = [...days].reverse().find(focusable);
    else return;
    event.preventDefault();
    if (!target || target === days[index]) return;
    settle(target);
    target.focus();
  });
}

function departureCard(item) {
  const experience = D.experience(item.experienceId);
  const error = D.availability(item, state.party);
  const isSelected = state.selectedDepartureId === item.id;
  return `<article class="departure-card ${isSelected ? 'is-selected' : ''} ${error ? 'unavailable' : ''}">
    <div class="departure-time"><strong>${D.timeLabel(item.time)}</strong><span>${experience.duration}</span></div>
    <div class="departure-info"><span class="trip-label ${experience.theme}">${kind(experience)}</span><h3>${experience.name}</h3><p>${experience.boat} · ${error || (experience.type === 'private' ? `Whole boat · up to ${experience.max}` : `${item.remaining} seats left`)}</p><button class="text-button" data-detail="${experience.id}" aria-label="Trip details for ${experience.name}">Trip details</button></div>
    <div class="departure-action"><p><strong>${D.money(experience.price)}</strong><span>/ ${unit(experience)}</span></p><button class="${isSelected ? 'selected-button' : 'secondary'}" data-select="${item.id}" ${error ? 'disabled' : ''} aria-label="${error ? error : isSelected ? 'Selected' : 'Select'} ${experience.name}, ${shortDate(item.date)}, ${D.timeLabel(item.time)}">${isSelected ? 'Selected ✓' : error === 'Past' ? 'Past' : error ? item.remaining ? 'No fit' : 'Sold out' : 'Select →'}</button></div>
  </article>`;
}

function emptyState() {
  return `<div class="empty-state"><span aria-hidden="true">≈</span><h3>No matching departures.</h3><p>Try another day or clear your filters.</p><button class="secondary" id="clear-filters">Clear filters & show any day</button></div>`;
}

function results() {
  const rows = filtered();
  const count = available(rows).length;
  const days = [...new Set(rows.map(item => item.date))];
  const unavailableMessage = rows.every(item => D.availability(item, state.party) === 'Past') ? 'These departures have already sailed.' : rows.every(item => !item.remaining) ? 'All matching departures are sold out.' : 'No departures fit your group on these dates.';
  return `<section class="departure-results" aria-label="Departure results"><div class="results-heading"><div><p class="eyebrow">${state.selectedDay ? shortDate(state.selectedDay) : monthLabel()}</p><h2>Departures</h2></div><span class="result-count" role="status">${count} available</span></div>
    ${rows.length ? `${!count ? `<div class="notice">${unavailableMessage} Try another day or adjust your filters. <button class="text-button" id="clear-filters">Clear filters & show any day</button></div>` : ''}${days.map(date => `<div class="day-group">${!state.selectedDay ? `<h3 class="date-heading">${D.dateLabel(date, { weekday: 'long', month: 'short', day: 'numeric' })}</h3>` : ''}${rows.filter(item => item.date === date).map(departureCard).join('')}</div>`).join('')}` : emptyState()}
    <p class="hint">Base rates · excludes fee & tax · ${zoneNote()}</p></section>`;
}

function experienceCards() {
  const experiences = D.experiences.filter(item => (!state.experience || state.experience === item.id) && (!state.type || state.type === item.type));
  return `<section class="experience-grid" aria-label="Explore experiences">${experiences.length ? experiences.map(item => {
    const options = available(filtered().filter(departure => departure.experienceId === item.id));
    return `<article class="experience-card">${seaArt(item.theme)}<div class="experience-body"><div class="card-meta"><span>${kind(item)} · ${item.duration}</span><span>${item.boat}</span></div><h2>${item.name}</h2><ul class="highlights">${item.highlights.map(text => `<li>${text}</li>`).join('')}</ul><div class="experience-bottom"><p><strong>${D.money(item.price)}</strong> / ${unit(item)}<small>${options.length} available ${state.selectedDay ? 'on this day' : 'this month'}</small></p><button class="secondary" data-dates="${item.id}">View dates →</button></div><button class="text-button" data-detail="${item.id}">About this trip</button></div></article>`;
  }).join('') : emptyState()}</section>`;
}

function tripScreen() {
  return `<section class="discovery-hero"><div><h1 tabindex="-1">Find your next trip.</h1><p class="intro">Fishing, reef dives, sunset cruises and private charters.</p></div>${seaArt('hero')}</section>
    ${filters()}${toolbar()}<div id="browse-content">${state.view === 'trips' ? experienceCards() : state.view === 'calendar' ? `<div class="calendar-layout">${calendar()}${results()}</div>` : results()}</div><div id="selection-summary" aria-live="polite">${summary(true)}</div>`;
}

function detailsScreen() {
  return `<h1 tabindex="-1">Guest details</h1><p class="intro">Use a fictional name and email for the booker.</p>
    <form id="details-form" novalidate autocomplete="off"><div class="field-grid"><div><label class="field-label" for="guest-name">Booker’s name</label><input id="guest-name" type="text" maxlength="100" required autocomplete="off" placeholder="Alex Example" value="${escapeHTML(state.name)}"></div><div><label class="field-label" for="guest-email">Email address</label><input id="guest-email" type="email" maxlength="254" required autocomplete="off" placeholder="alex@example.com" value="${escapeHTML(state.email)}"></div></div><div id="details-error" class="error" role="alert" hidden></div><div class="actions"><button class="text-button" data-back="0" type="button">← Back to trips</button><button class="primary" type="submit">Review sample booking →</button></div></form>`;
}

function reviewScreen() {
  return `<h1 tabindex="-1">Review your booking</h1>
    <div class="review-block"><div class="review-heading"><h2>Your trip</h2><button class="text-button" data-back="0">Edit trip</button></div><p>${trip().name} · ${trip().duration}<br>${D.dateLabel(selected().date)} · ${D.timeLabel(selected().time)} ${D.zoneLabel(selected().date)}<br>${escapeHTML(state.party)} guests · ${trip().boat}</p></div>
    <div class="review-block"><div class="review-heading"><h2>Guest details</h2><button class="text-button" data-back="1">Edit details</button></div><p>${escapeHTML(state.name)}<br>${escapeHTML(state.email)}</p></div>
    <details class="compact-details section"><summary>Sample booking policy</summary><p>Changes or cancellations up to 48 hours before departure. The operator handles weather changes. Fictional terms for this demo.</p></details>
    <form id="checkout-form"><div class="review-block" aria-label="Checkout amount"><div class="money-row checkout-total"><strong>Sample total</strong><strong>${D.money(quote().total)}</strong></div><p class="hint">USD · Fee and illustrative tax included · No later balance</p></div><label class="check-label"><input type="checkbox" id="checkout-ack" required ${state.checkout ? 'checked' : ''}><span>I understand this is a sample booking and no payment will be taken.</span></label><div class="actions"><button class="text-button" data-back="1" type="button">← Back to details</button><button class="primary" type="submit">Simulate booking →</button></div></form>`;
}

function readyScreen() {
  if (state.prepView === 'requests') return requestScreen();
  if (state.prepView === 'waiver') return waiverScreen();
  if (state.prepView === 'receipt') return receiptScreen();
  const progress = W.progress(state.waiverFlow);
  const intro = progress.complete ? 'All guest waivers signed. Check your arrival details below.' : progress.missing ? `Booking confirmed. Your waiver request was sent to ${escapeHTML(state.email)} (simulated). Add your guests so each receives theirs.` : 'Every guest has a waiver request. Open an email preview to try signing.';
  return `<p class="eyebrow">SAMPLE-001</p><h1 tabindex="-1">${progress.complete ? 'Preparation complete' : 'Booking confirmed'}</h1><p class="intro">${intro}</p>
    <div class="prep-progress" aria-label="Preparation progress"><div><span>01</span><strong>Booked</strong><small>${D.money(quote().total)} simulated</small></div><div><span>02</span><strong>Guest details</strong><small>${progress.identified} of ${progress.total} identified</small></div><div><span>03</span><strong>Sign waivers</strong><small>${progress.signed} of ${progress.total} signed</small></div></div>
    <section class="section" aria-labelledby="waiver-heading"><div class="review-heading"><h2 id="waiver-heading">Guest waivers</h2><span class="status-chip ${progress.complete ? '' : 'pending-chip'}" role="status">${progress.complete ? 'All signed (demo)' : `${progress.pending} pending`}</span></div>
      <div class="participant-list">${state.waiverFlow.participants.map(participantRow).join('')}</div>
      ${progress.missing ? '<button class="primary" id="add-guests">Add your guests →</button>' : ''}
    </section>${arrivalInfo()}<div class="actions"><button class="text-button" data-back="0" type="button">Edit sample trip</button><button class="primary" id="new-booking" type="button">Start a new demo</button></div><p class="hint">Editing the trip or guest details clears all sample requests and signatures.</p>`;
}

function arrivalInfo() {
  const resources = typeof OperatorView === 'undefined' ? [{ label: 'Florida fishing license information', url: 'https://myfwc.com/license/recreational/saltwater-fishing/' }] : OperatorView.resources();
  const notice = typeof OperatorView === 'undefined' ? '' : OperatorView.notice(selected().id);
  return `<section class="section" id="arrival"><h2>Arrival instructions</h2>${notice ? `<div class="notice guest-trip-notice"><strong>Trip notice from your operator</strong><p>${escapeHTML(notice)}</p></div>` : ''}<ol class="arrival-list"><li><strong>${D.arrivalTime(selected())} ${D.zoneLabel(selected().date)} · ${shortDate(selected().date)}</strong><br>Arrive 30 minutes before departure.</li><li><strong>Saltline Marina, Dock C · ${trip().boat}</strong><br>Fictional meeting point. Do not travel to it.</li></ol><details class="compact-details"><summary>Trip checklist</summary><p>${trip().preparation}</p></details></section>
    <section class="section" id="trip-preparation"><h2>Important links</h2><ul class="links"><li><a href="#arrival">Meeting point & arrival checklist</a></li><li><button class="text-button" data-detail="${trip().id}">${trip().id === 'reef' ? 'Dive eligibility & equipment' : 'What to expect & bring'}</button></li>${resources.map(link => `<li><a href="${escapeHTML(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(link.label)} ↗ (opens a new tab)</a></li>`).join('')}<li><span>Operator contact · unavailable in demo</span></li></ul><p class="hint">Confirm requirements with your operator.</p></section>`;
}

function roleLabel(role, name = '') { return `<div class="role-label"><span aria-hidden="true">↗</span><strong>${role}</strong>${name ? `<span>· ${escapeHTML(name)}</span>` : ''}</div>`; }
function statusLabel(status) { return { 'needs-details': 'Needs details', 'awaiting-signature': 'Awaiting signature', signed: 'Signed (demo)' }[status]; }
function participantRow(guest, index) {
  const missing = guest.status === 'needs-details';
  const name = missing ? `Guest ${index + 1}` : guest.name;
  const [key, text, prefix] = missing ? ['request', 'Add details', 'Add details for'] : guest.status === 'signed' ? ['receipt', 'View receipt', 'View receipt for'] : ['email', 'Preview email →', 'Preview email for'];
  return `<article class="participant-row"><span class="guest-number" aria-hidden="true">${index + 1}</span><div><h3>${escapeHTML(name)}</h3><p>${missing ? 'Name and email needed' : escapeHTML(guest.email)}</p><span class="waiver-status ${guest.status}">${statusLabel(guest.status)}</span></div><button class="${missing ? 'secondary' : 'text-button'}" data-${key}="${guest.id}" aria-label="${prefix} ${escapeHTML(name)}">${text}</button></article>`;
}
function requestScreen() {
  const guests = state.waiverFlow.participants.filter(item => item.status === 'needs-details');
  return `<h1 tabindex="-1">Add your guests</h1><p class="intro">Enter a fictional name and email for each guest travelling with you. Each guest you add is sent a sample waiver request right away. Adults only in this demo; no guardian signing.</p>
    <form id="request-form" novalidate autocomplete="off">${guests.map(guest => { const draft = state.requestDrafts[guest.id] || { name: '', email: '' }; return `<fieldset class="request-card"><legend>Guest ${state.waiverFlow.participants.indexOf(guest) + 1}</legend><label class="check-label"><input type="checkbox" data-recipient="${guest.id}" ${draft.checked === false ? '' : 'checked'}><span>Add this guest now</span></label><div class="field-grid"><div><label class="field-label" for="name-${guest.id}">Fictional full name</label><input id="name-${guest.id}" data-guest="${guest.id}" data-field="name" type="text" maxlength="100" placeholder="Jamie Example" value="${escapeHTML(draft.name)}" required></div><div><label class="field-label" for="email-${guest.id}">Sample email address</label><input id="email-${guest.id}" data-guest="${guest.id}" data-field="email" type="email" maxlength="254" placeholder="jamie@example.com" value="${escapeHTML(draft.email)}" required></div></div></fieldset>`; }).join('') || '<p class="hint">Every guest on this booking already has their details.</p>'}<div id="request-error" class="error" role="alert" tabindex="-1" hidden></div><div class="actions"><button class="text-button" data-prep="dashboard" type="button">← Return to booking</button>${guests.length ? '<button class="primary" type="submit">Add guests →</button>' : ''}</div></form>`;
}

function waiverScreen() {
  const guest = participant();
  return `${roleLabel('Guest preview', guest.name)}<h1 tabindex="-1">Review & sign</h1>
    <article class="sample-document" aria-label="Nonbinding sample waiver"><p class="eyebrow">Nonbinding sample waiver</p><h2>${trip().name}</h2><p>${D.dateLabel(selected().date)} · ${D.timeLabel(selected().time)} ${D.zoneLabel(selected().date)}<br>Aboard ${trip().boat} · Arrive ${D.arrivalTime(selected())} ${D.zoneLabel(selected().date)}</p><hr><p>${trip().preparation}</p><p class="hint">No release of liability or binding agreement.</p></article>
    <form id="signature-form" novalidate autocomplete="off"><label class="field-label" for="signature-name">Type your fictional full name</label><input id="signature-name" type="text" maxlength="100" required aria-describedby="signature-help" placeholder="${escapeHTML(guest.name)}"><p class="hint" id="signature-help">Enter ${escapeHTML(guest.name)}. Identity is not verified.</p><label class="check-label waiver-label"><input type="checkbox" id="waiver-read" required><span>I have read the sample trip and arrival information above.</span></label><label class="check-label waiver-label"><input type="checkbox" id="signature-demo" required><span>I understand this is a simulated signature, not a legal waiver or release of rights.</span></label><div id="signature-error" class="error" role="alert" tabindex="-1" hidden></div><div class="actions"><button class="text-button" data-prep="dashboard" type="button">← Return without signing</button><button class="primary" type="submit">Sign sample waiver →</button></div></form>`;
}

function receiptScreen() {
  const guest = participant();
  const progress = W.progress(state.waiverFlow);
  return `${roleLabel('Guest preview', guest.name)}<div class="success-mark" aria-hidden="true">✓</div><h1 tabindex="-1">Sample waiver signed</h1><div class="sample-document receipt"><span class="status-chip">Signed (demo)</span><dl><dt>Fictional signer</dt><dd class="signature-script">${escapeHTML(guest.signature.fullName)}</dd><dt>Sample recipient</dt><dd>${escapeHTML(guest.email)}</dd><dt>Trip</dt><dd>${trip().name}<br>${D.dateLabel(selected().date)} · ${D.timeLabel(selected().time)} ${D.zoneLabel(selected().date)}</dd><dt>Reference</dt><dd>SAMPLE-001 · ${guest.id}</dd></dl><p class="hint">Session-only receipt · No legal signature</p></div><p class="notice">${progress.signed} of ${progress.total} guests signed${progress.complete ? '. Preparation complete.' : ` · ${progress.pending} still pending.`}</p><div class="actions"><button class="primary" data-prep="dashboard" type="button">Return to booking →</button></div>`;
}

function invalidate() { state.confirmed = false; state.checkout = false; state.waiverFlow = null; state.prepView = 'dashboard'; state.participantId = null; state.requestDrafts = {}; }
function go(step) { if (state.confirmed) invalidate(); state.step = step; render(); }
function reset() { state = initialState(); workspace = 'guest'; if (typeof OperatorView !== 'undefined') OperatorView.reset(); render(); }
function changeSearch(patch, focusSelector) {
  Object.assign(state, patch, { selectedDepartureId: null });
  invalidate();
  render(false);
  if (focusSelector) main.querySelector(focusSelector)?.focus();
}
function render(focus = true) {
  document.querySelectorAll('[data-workspace]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.workspace === workspace)));
  if (workspace === 'operator') {
    main.innerHTML = OperatorView.render({ activeBooking: BookingDemo.snapshot() });
    OperatorView.bind(main, {
      onOpenBooking: () => { workspace = 'guest'; BookingDemo.openPreparation(); },
      onGuest: () => { workspace = 'guest'; render(); },
      onResend: id => BookingDemo.resend(id),
      refresh: () => render(false)
    });
    if (focus) { main.querySelector('h1')?.focus(); window.scrollTo({ top: 0, behavior: 'instant' }); }
    return;
  }
  const screens = [tripScreen, detailsScreen, reviewScreen, readyScreen];
  main.innerHTML = `<nav aria-label="Booking progress"><ol class="steps">${['Find a trip', 'Guest details', 'Review', 'Prepare'].map((label, i) => `<li ${i === state.step ? 'aria-current="step"' : ''}><span class="step-number">${i + 1}</span>${label}</li>`).join('')}</ol></nav>${state.step ? `<div class="layout"><div>${screens[state.step]()}</div>${summary()}</div>` : tripScreen()}`;
  bindEvents();
  if (focus) { main.querySelector('h1').focus(); window.scrollTo({ top: 0, behavior: 'instant' }); }
}

function showDetail(id, trigger) {
  const item = D.experience(id);
  const dialog = document.createElement('dialog');
  dialog.className = 'trip-dialog';
  dialog.setAttribute('aria-labelledby', 'detail-title');
  dialog.innerHTML = `<div class="dialog-top"><p class="eyebrow">${kind(item)} · ${item.duration}</p><button class="icon-button" aria-label="Close trip details">×</button></div>${seaArt(item.theme, true)}<div class="dialog-body"><h2 id="detail-title">${item.name}</h2><p>${item.description}</p><ul class="highlights">${item.highlights.map(text => `<li>${text}</li>`).join('')}</ul><p><strong>${D.money(item.price)} / ${unit(item)}</strong> · ${item.boat}<br><span class="hint">Excludes fee & tax</span></p><details class="compact-details"><summary>Before you go</summary><p>${item.preparation}</p></details>${state.step === 0 ? `<button class="primary" data-detail-dates="${item.id}">Find available dates →</button>` : ''}</div>`;
  document.body.append(dialog);
  dialog.querySelector('.icon-button').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger.isConnected) trigger.focus(); });
  dialog.querySelector('[data-detail-dates]')?.addEventListener('click', () => { dialog.close(); viewDates(id); });
  dialog.showModal();
}
function viewDates(id) {
  changeSearch({ experience: id, type: '', view: 'calendar', selectedDay: null }, '[data-view="calendar"]');
  main.querySelector('.browse-toolbar').scrollIntoView({ block: 'start' });
}

function openRequests(id = null) {
  state.waiverFlow.participants.filter(guest => guest.status === 'needs-details').forEach(guest => {
    state.requestDrafts[guest.id] = { name: '', email: '', ...state.requestDrafts[guest.id], checked: !id || id === guest.id };
  });
  state.prepView = 'requests'; render();
}
function showEmail(id, trigger) {
  const guest = state.waiverFlow.participants.find(item => item.id === id);
  if (guest?.status !== 'awaiting-signature') return;
  const dialog = document.createElement('dialog');
  dialog.className = 'trip-dialog email-dialog';
  dialog.setAttribute('aria-labelledby', 'email-title');
  dialog.innerHTML = `<div class="dialog-top"><p class="eyebrow">Guest preview · Sample email</p><button class="icon-button" aria-label="Close email preview">×</button></div><div class="dialog-body"><p class="email-recipient"><strong>To</strong> ${escapeHTML(guest.name)} &lt;${escapeHTML(guest.email)}&gt;</p><h2 id="email-title">Please sign your waiver</h2><p>${trip().name}<br>${D.dateLabel(selected().date)} · ${D.timeLabel(selected().time)} ${D.zoneLabel(selected().date)}</p><button class="primary" id="open-waiver">Open waiver →</button><p class="hint">Opens this guest’s demo preview. No email was sent.</p></div>`;
  document.body.append(dialog);
  dialog.querySelector('.icon-button').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger.isConnected) trigger.focus(); });
  dialog.querySelector('#open-waiver').addEventListener('click', () => { dialog.close(); state.participantId = id; state.prepView = 'waiver'; render(); });
  dialog.showModal();
}
function bindWaiverEvents() {
  main.querySelector('#add-guests')?.addEventListener('click', () => openRequests());
  main.querySelectorAll('[data-request]').forEach(button => button.addEventListener('click', () => openRequests(button.dataset.request)));
  main.querySelectorAll('[data-prep]').forEach(button => button.addEventListener('click', () => { state.prepView = button.dataset.prep; render(); }));
  main.querySelectorAll('[data-email]').forEach(button => button.addEventListener('click', () => showEmail(button.dataset.email, button)));
  main.querySelectorAll('[data-receipt]').forEach(button => button.addEventListener('click', () => { state.participantId = button.dataset.receipt; state.prepView = 'receipt'; render(); }));
  main.querySelectorAll('[data-guest]').forEach(input => input.addEventListener('input', () => { state.requestDrafts[input.dataset.guest][input.dataset.field] = input.value; }));
  main.querySelectorAll('[data-recipient]').forEach(input => input.addEventListener('change', () => { state.requestDrafts[input.dataset.recipient].checked = input.checked; }));
  main.querySelector('#request-form')?.addEventListener('submit', event => {
    event.preventDefault();
    try {
      const entries = [...main.querySelectorAll('[data-recipient]:checked')].map(input => ({ id: input.dataset.recipient, ...state.requestDrafts[input.dataset.recipient] }));
      state.waiverFlow = W.addDetails(state.waiverFlow, entries);
      state.prepView = 'dashboard'; render();
    } catch (error) {
      const notice = main.querySelector('#request-error'); notice.textContent = error.message; notice.hidden = false; notice.focus();
    }
  });
  main.querySelector('#signature-form')?.addEventListener('submit', event => {
    event.preventDefault();
    try {
      state.waiverFlow = W.sign(state.waiverFlow, state.participantId, { fullName: main.querySelector('#signature-name').value, read: main.querySelector('#waiver-read').checked, simulation: main.querySelector('#signature-demo').checked }, bookingKey());
      state.prepView = 'receipt'; render();
    } catch (error) {
      const notice = main.querySelector('#signature-error'); notice.textContent = error.message; notice.hidden = false; notice.focus();
    }
  });
}

function bindEvents() {
  bindWaiverEvents();
  bindCalendarKeys();
  main.querySelectorAll('[data-back]').forEach(button => button.addEventListener('click', () => go(Number(button.dataset.back))));
  main.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    state.view = button.dataset.view;
    render(false);
    main.querySelector(`[data-view="${state.view}"]`).focus();
  }));
  main.querySelectorAll('[data-month]').forEach(button => button.addEventListener('click', () => {
    const index = D.months.indexOf(state.month) + Number(button.dataset.month);
    if (D.months[index]) changeSearch({ month: D.months[index], selectedDay: null }, `[data-month="${-Number(button.dataset.month)}"]`);
  }));
  main.querySelectorAll('[data-day]').forEach(button => button.addEventListener('click', () => changeSearch({ selectedDay: button.dataset.day }, `[data-day="${button.dataset.day}"]`)));
  main.querySelector('#any-day')?.addEventListener('click', () => changeSearch({ selectedDay: null }, '[data-view="calendar"]'));
  main.querySelector('#clear-filters')?.addEventListener('click', () => changeSearch({ experience: '', type: '', selectedDay: null, party: '2' }, '#experience'));
  main.querySelector('#experience')?.addEventListener('change', event => changeSearch({ experience: event.target.value }, '#experience'));
  main.querySelector('#trip-type')?.addEventListener('change', event => changeSearch({ type: event.target.value }, '#trip-type'));
  main.querySelector('#party')?.addEventListener('input', event => changeSearch({ party: event.target.value }, '#party'));
  main.querySelectorAll('[data-detail]').forEach(button => button.addEventListener('click', () => showDetail(button.dataset.detail, button)));
  main.querySelectorAll('[data-dates]').forEach(button => button.addEventListener('click', () => viewDates(button.dataset.dates)));
  main.querySelectorAll('[data-select]').forEach(button => button.addEventListener('click', () => {
    const item = D.departure(button.dataset.select);
    if (D.availability(item, state.party) || !filtered().includes(item)) return;
    state.selectedDepartureId = item.id;
    invalidate();
    render(false);
    main.querySelector('#continue').focus({ preventScroll: true });
    main.querySelector('#selection-summary').scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }));
  main.querySelector('#continue')?.addEventListener('click', () => { if (quote()) go(1); });
  main.querySelector('#guest-name')?.addEventListener('input', event => { state.name = event.target.value; state.checkout = false; });
  main.querySelector('#guest-email')?.addEventListener('input', event => { state.email = event.target.value; state.checkout = false; });
  main.querySelector('#details-form')?.addEventListener('submit', event => {
    event.preventDefault();
    state.name = state.name.trim(); state.email = state.email.trim();
    const name = main.querySelector('#guest-name'); const email = main.querySelector('#guest-email');
    name.value = state.name; email.value = state.email;
    if (!state.name || !email.validity.valid) {
      const error = main.querySelector('#details-error');
      error.textContent = !state.name ? 'Enter a fictional booker’s name to continue.' : 'Enter a valid sample email address, such as alex@example.com.';
      error.hidden = false; (!state.name ? name : email).focus(); return;
    }
    if (quote()) go(2);
  });
  main.querySelector('#checkout-ack')?.addEventListener('change', event => { state.checkout = event.target.checked; });
  main.querySelector('#checkout-form')?.addEventListener('submit', event => {
    event.preventDefault();
    if (!state.checkout) return;
    if (!quote()) { go(0); return; }
    bookingRevision += 1;
    state.waiverFlow = W.create(bookingKey(), state.party, { name: state.name, email: state.email });
    state.confirmed = true; state.step = 3; state.prepView = 'dashboard'; render();
  });
  main.querySelector('#new-booking')?.addEventListener('click', reset);
}

const BookingDemo = {
  snapshot() {
    return state.confirmed ? { id: 'SAMPLE-001', key: bookingKey(), departureId: state.selectedDepartureId, party: Number(state.party), name: state.name, email: state.email, participants: structuredClone(state.waiverFlow.participants), total: quote().total } : null;
  },
  openPreparation() { if (state.confirmed) { state.step = 3; state.prepView = 'dashboard'; render(); } },
  // Operator-initiated resend of a sample request. Applies the waiver rules, re-renders, and returns the resend count.
  resend(id) {
    if (!state.confirmed) throw new Error('There is no session booking to resend for.');
    state.waiverFlow = W.resend(state.waiverFlow, id);
    render(false);
    return state.waiverFlow.participants.find(item => item.id === id).deliveries - 1;
  }
};

document.querySelector('#reset').addEventListener('click', reset);
document.querySelectorAll('[data-workspace]').forEach(button => button.addEventListener('click', () => {
  workspace = button.dataset.workspace;
  render();
}));
window.addEventListener('pageshow', event => { if (event.persisted) reset(); });
render(false);
