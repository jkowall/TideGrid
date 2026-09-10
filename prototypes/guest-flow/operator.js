'use strict';

// An in-memory operator workspace. Every booking, payment and check-in is a sample.
const OperatorView = (() => {
  const D = TideGrid;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const defaultLinks = () => [{ id: 'license', label: 'Florida saltwater fishing licenses', url: 'https://myfwc.com/license/recreational/saltwater-fishing/' }];
  let day = '2026-09-26';
  let selectedId = '';
  let links = defaultLinks();
  let notices = {};
  let drafts = {};
  let checked = new Set();
  let editingLink = null;
  let expanded = new Set();
  let message = '';
  let sequence = 0;
  let active = null;
  const shortDate = date => D.dateLabel(date, { weekday: 'short', month: 'short', day: 'numeric' });
  const statusLabel = status => status === 'signed' ? 'Signed · demo' : status === 'awaiting-signature' ? 'Awaiting signature' : 'Not sent';
  function sampleBookings(item) {
    const trip = D.experience(item.experienceId);
    const count = trip.max - item.remaining;
    const names = ['Avery Sample', 'Morgan Sample', 'Jordan Sample', 'Riley Sample', 'Casey Sample', 'Quinn Sample', 'Taylor Sample', 'Drew Sample', 'Alex Sample', 'Jamie Sample', 'Robin Sample', 'Sam Sample'];
    const rows = [];
    const groupSize = trip.type === 'private' ? trip.max : 2;
    for (let index = 0; index < count; index += groupSize) {
      const participants = names.slice(index, Math.min(index + groupSize, count)).map((name, offset) => ({ id: `p-${index + offset}`, name, status: index + offset < Math.ceil(count * .65) ? 'signed' : index + offset === count - 1 ? 'not-sent' : 'awaiting-signature' }));
      const subtotal = trip.price * (trip.type === 'private' ? 1 : participants.length);
      rows.push({ id: `DEMO-${String(index / 2 + 1).padStart(3, '0')}`, key: `${item.id}-${index}`, name: names[index], email: `sample${index + 1}@example.com`, participants, party: participants.length, total: subtotal + 1000 + Math.round((subtotal + 1000) * .06), seeded: true });
    }
    return rows;
  }
  function bookings(item) {
    const rows = sampleBookings(item);
    if (active?.departureId === item.id) rows.unshift({ ...active, key: `active-${active.key || active.departureId}`, seeded: false });
    return rows;
  }
  const people = item => bookings(item).flatMap(booking => booking.participants.map(person => ({ ...person, checkKey: `${booking.key}:${person.id}` })));
  const isChecked = person => person.status === 'signed' && checked.has(person.checkKey);
  function stats(items) {
    const participants = items.flatMap(people);
    return { guests: participants.length, pending: participants.filter(person => person.status !== 'signed').length, checked: participants.filter(isChecked).length, total: items.flatMap(bookings).reduce((sum, booking) => sum + Number(booking.total || 0), 0) };
  }
  function departureCard(item) {
    const trip = D.experience(item.experienceId);
    const counts = stats([item]);
    const remaining = Math.max(0, trip.max - counts.guests);
    const weather = typeof WeatherOps === 'undefined' ? {} : WeatherOps.status(item.id);
    return `<button type="button" class="op-departure ${selectedId === item.id ? 'is-selected' : ''}" data-op-departure="${esc(item.id)}" aria-pressed="${selectedId === item.id}">
      <span class="op-trip-time">${D.timeLabel(item.time)}<small>EDT · ${trip.duration}</small></span>
      <span class="op-trip-name"><strong>${esc(trip.name)}</strong><small>${esc(trip.boat)} · ${trip.type === 'private' ? 'Private charter' : 'Shared trip'}</small></span>
      <span class="op-trip-capacity"><strong>${counts.guests} / ${trip.max} guests</strong><span class="op-capacity-track" aria-hidden="true"><span style="width:${Math.min(100, counts.guests / trip.max * 100)}%"></span></span><small>${trip.type === 'private' ? counts.guests ? 'Boat assigned · sample' : 'Whole boat available' : remaining ? `${remaining} seats available` : 'Full departure'}</small></span>
      <span class="op-trip-status"><span class="op-pill ${counts.pending ? 'op-pill-amber' : ''}">${counts.pending ? `${counts.pending} ${counts.pending === 1 ? 'waiver' : 'waivers'} pending` : counts.guests ? 'Waivers complete' : 'No bookings'}</span>${weather.watch ? '<span class="op-pill op-pill-amber">Marine watch</span>' : ''}${weather.proposal ? `<small>${weather.proposal === 'delay' ? 'Delay' : 'Cancellation'} proposal · pending</small>` : ''}<small>${counts.checked} demo checked in</small></span>
      <span class="op-row-arrow" aria-hidden="true">↗</span>
    </button>`;
  }
  function bookingCard(booking) {
    const signed = booking.participants.filter(person => person.status === 'signed').length;
    const isExpanded = expanded.has(booking.key);
    return `<article class="op-booking ${booking.seeded ? '' : 'op-booking-active'}"><div class="op-booking-top"><div><p class="op-kicker">${booking.seeded ? 'Fictional seeded booking' : 'Your prototype booking'} · ${esc(booking.id)}</p><h3>${esc(booking.name)}</h3><p>${booking.participants.length} guests · ${signed}/${booking.participants.length} waivers signed</p></div><div class="op-booking-money"><strong>${D.money(Number(booking.total || 0))}</strong><span>Payment simulated</span></div></div>
      <ul class="op-participants">${booking.participants.map(person => {
        const checkKey = `${booking.key}:${person.id}`;
        const enabled = person.status === 'signed';
        const isIn = enabled && checked.has(checkKey);
        return `<li><div><strong>${esc(person.name || 'Unnamed participant')}</strong><span class="op-person-status ${enabled ? 'op-person-signed' : ''}">${statusLabel(person.status)}</span></div><label class="op-check"><input type="checkbox" data-op-check="${esc(checkKey)}" ${isIn ? 'checked' : ''} ${enabled ? '' : 'disabled'}><span>${isIn ? 'Checked in · demo' : enabled ? 'Demo check-in' : 'Signature required'}</span></label></li>`;
      }).join('')}</ul>
      <div class="op-booking-actions">${!booking.seeded ? `<button type="button" class="text-button" data-op-open-booking>${signed < booking.participants.length ? 'Open waiver dashboard' : 'View guest booking'} →</button>` : `<button type="button" class="text-button" data-op-preview="${esc(booking.key)}" aria-expanded="${isExpanded}">${isExpanded ? 'Hide' : 'Preview'} sample booking details</button>`}</div>
      ${isExpanded && booking.seeded ? `<div class="op-sample-detail"><strong>Booking preview</strong><p>Booker: ${esc(booking.name)} · ${esc(booking.email)}</p><p>Full payment is simulated. Pending waivers show where an operator would follow up; this sample does not contact anyone.</p></div>` : ''}</article>`;
  }
  function manifest(item) {
    if (!item) return '<section class="op-panel"><h2>No departures scheduled</h2><p class="op-muted">Pick a sailing day to explore the sample manifest.</p></section>';
    const trip = D.experience(item.experienceId);
    const rows = bookings(item);
    const counts = stats([item]);
    return `<section class="op-panel op-manifest" aria-labelledby="op-manifest-title"><div class="op-section-heading"><div><p class="op-kicker">Departure manifest</p><h2 id="op-manifest-title">${esc(trip.name)}</h2><p>${shortDate(item.date)} · ${D.timeLabel(item.time)} EDT · ${esc(trip.boat)}</p></div><span class="op-pill">${counts.guests} guests</span></div>
      <div class="op-manifest-summary"><span><strong>${counts.guests - counts.pending}/${counts.guests}</strong> waivers signed</span><span><strong>${counts.checked}/${counts.guests}</strong> demo checked in</span><span><strong>${D.arrivalTime(item)}</strong> sample arrival</span></div>
      ${rows.length ? rows.map(bookingCard).join('') : '<div class="op-empty"><span aria-hidden="true">≈</span><h3>A little room for possibility.</h3><p>No sample bookings on this departure. Make a guest booking to see it appear here.</p><button type="button" class="secondary" data-op-guest>Explore guest booking →</button></div>'}
      <p class="op-footnote">Check-in controls unlock after that participant’s sample waiver is signed. These are local demo marks, not boarding clearance or a real check-in.</p>
    </section>`;
  }
  function noticeEditor(item) {
    if (!item) return '';
    const value = drafts[item.id] ?? notices[item.id] ?? '';
    return `<section class="op-panel"><p class="op-kicker">Before they arrive</p><h2>Trip notice</h2><p class="op-muted">A short operator note for ${esc(D.experience(item.experienceId).name)}, ${D.timeLabel(item.time)} on ${shortDate(item.date)}. Saved notes appear on this departure’s guest arrival screen.</p><form id="op-notice-form"><label class="field-label" for="op-notice">Arrival note</label><textarea id="op-notice" maxlength="600" rows="4" placeholder="Example: Meet beside the blue sign at the sample marina.">${esc(value)}</textarea><p class="op-footnote">Operator-entered text only. Nothing is sent. This is not a weather forecast or a safety assessment.</p><div class="op-form-actions"><button class="primary" type="submit">Save local notice</button>${notices[item.id] ? '<button class="text-button" type="button" data-op-clear-notice>Remove saved notice</button>' : ''}</div></form>${notices[item.id] ? `<div class="op-saved-note"><strong>Saved sample notice</strong><p>${esc(notices[item.id])}</p></div>` : ''}</section>`;
  }
  function linksEditor() {
    const editing = links.find(link => link.id === editingLink);
    return `<section class="op-panel"><p class="op-kicker">A useful little detail</p><h2>Guest essentials</h2><p class="op-muted">Manage the important links shown on every guest’s ready screen. Changes live only in this open prototype.</p><ul class="op-resource-list">${links.map(link => `<li><div><a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.label)} ↗</a><span>${esc(new URL(link.url).hostname)}</span></div><div class="op-link-actions"><button class="text-button" type="button" data-op-edit-link="${esc(link.id)}" aria-label="Edit ${esc(link.label)}">Edit</button><button class="text-button" type="button" data-op-remove-link="${esc(link.id)}" aria-label="Remove ${esc(link.label)}">Remove</button></div></li>`).join('') || '<li class="op-muted">No links yet. Add an operator resource below.</li>'}</ul><form id="op-link-form"><h3>${editing ? 'Edit link' : 'Add an important link'}</h3><label class="field-label" for="op-link-label">Link label</label><input id="op-link-label" name="label" type="text" required maxlength="80" value="${esc(editing?.label || '')}" placeholder="What guests should know"><label class="field-label" for="op-link-url">Website URL</label><input id="op-link-url" name="url" type="url" required maxlength="1000" value="${esc(editing?.url || '')}" placeholder="https://example.com/guest-info" aria-describedby="op-link-hint"><p id="op-link-hint" class="op-footnote">Use a full https:// address. Add your actual operator contact link here when available.</p><div class="op-form-actions"><button class="secondary" type="submit">${editing ? 'Save link' : 'Add link'}</button>${editing ? '<button class="text-button" type="button" data-op-cancel-link>Cancel edit</button>' : ''}</div></form></section>`;
  }
  function render({ activeBooking = null } = {}) {
    active = activeBooking;
    const items = D.departures.filter(item => item.date === day);
    if (!items.some(item => item.id === selectedId)) selectedId = items.find(item => item.id === active?.departureId)?.id || items.find(item => sampleBookings(item).length)?.id || items[0]?.id || '';
    const item = D.departure(selectedId);
    const totals = stats(items);
    const activeDay = D.departure(active?.departureId)?.date;
    return `<div class="operator-workspace"><header class="op-heading"><div><p class="op-kicker">Saltline · Operator workspace</p><h1 tabindex="-1">A good day starts<br>with <em>everyone ready.</em></h1><p class="op-muted">Your sailings, your guests, and the details that keep the day moving.</p></div><div class="op-day-control"><label class="field-label" for="op-date">Operations date</label><input id="op-date" type="date" min="2026-09-01" max="2026-10-31" value="${day}"><span>Sample dates · Eastern Time (EDT)</span></div></header>
      <div class="op-demo-note"><span class="op-demo-dot" aria-hidden="true"></span><span>Interactive operator demo. All bookings and totals are fictional; edits clear on page refresh.</span></div>
      <nav class="op-shortcuts" aria-label="Operator sections"><a href="#op-sailings-title">Departures</a><a href="#operator-weather">Marine conditions</a><a href="#op-manifest-title">Manifest</a><a href="#operator-guest-tools">Guest tools</a></nav>
      <div class="op-feedback" role="status" ${message ? '' : 'hidden'}>${esc(message)}</div>
      ${active && activeDay ? `<div class="op-active-note"><span><strong>Your prototype booking</strong><br>${esc(D.experience(D.departure(active.departureId).experienceId).name)} · ${shortDate(activeDay)}</span><div class="op-link-actions"><button type="button" class="text-button" data-op-active-day>View its manifest →</button><button type="button" class="text-button" data-op-open-booking>Guest preparation →</button></div></div>` : ''}
      <section class="op-metrics" aria-label="Daily sample totals"><div><span>Departures</span><strong>${items.length}</strong><small>${shortDate(day)}</small></div><div><span>Guests expected</span><strong>${totals.guests}</strong><small>${totals.checked} demo checked in</small></div><div class="${totals.pending ? 'op-metric-attention' : ''}"><span>Waivers to complete</span><strong>${totals.pending}</strong><small>${totals.pending ? 'Signatures still needed' : 'No outstanding signatures'}</small></div><div><span>Simulated booking totals</span><strong>${D.money(totals.total)}</strong><small>USD · no money collected</small></div></section>
      <section class="op-sailings" aria-labelledby="op-sailings-title"><div class="op-section-heading"><div><p class="op-kicker">On the water</p><h2 id="op-sailings-title">${shortDate(day)} departures</h2></div><span class="op-muted">Select a trip to open its manifest</span></div><div class="op-departures">${items.map(departureCard).join('') || '<div class="op-empty"><h3>A quiet day on the dock.</h3><p>No sample departures on this date. Try September 26 or another sailing day.</p><button class="secondary" type="button" data-op-default-day>Show September 26</button></div>'}</div><p class="op-footnote">Capacity uses the guest calendar’s sample inventory${active ? ', plus your prototype booking' : ''}. No seats are actually reserved.</p></section>
      <div id="operator-weather">${typeof WeatherOps === 'undefined' ? '' : WeatherOps.render({ departure: item, bookings: item ? bookings(item) : [], savedNotice: item ? notices[item.id] || '' : '' })}</div>
      <div class="op-work-grid">${manifest(item)}<aside class="op-tools" id="operator-guest-tools" aria-label="Guest communications tools">${noticeEditor(item)}${linksEditor()}</aside></div></div>`;
  }
  function bind(root, { onOpenBooking, onGuest, refresh }) {
    const rerender = (feedback = '', focusSelector = '') => {
      message = feedback;
      refresh();
      if (focusSelector) root.querySelector(focusSelector)?.focus();
    };
    const weatherDeparture = D.departure(selectedId);
    if (typeof WeatherOps !== 'undefined') WeatherOps.bind(root, {
      departure: weatherDeparture,
      bookings: weatherDeparture ? bookings(weatherDeparture) : [],
      refresh: () => rerender(),
      onNotice: text => {
        if (!weatherDeparture) return;
        notices[weatherDeparture.id] = text;
        drafts[weatherDeparture.id] = text;
      }
    });
    root.querySelector('#op-date')?.addEventListener('change', event => {
      const value = event.target.value;
      if (!/^2026-(09|10)-\d{2}$/.test(value) || !event.target.checkValidity()) return;
      day = value;
      rerender('', '#op-date');
    });
    const openManifest = () => {
      rerender();
      const heading = root.querySelector('#op-manifest-title');
      heading?.setAttribute('tabindex', '-1');
      heading?.focus({ preventScroll: true });
      root.querySelector('.op-manifest')?.scrollIntoView({ block: 'start', behavior: 'instant' });
    };
    root.querySelectorAll('[data-op-departure]').forEach(button => button.addEventListener('click', () => { selectedId = button.dataset.opDeparture; openManifest(); }));
    root.querySelector('[data-op-default-day]')?.addEventListener('click', () => { day = '2026-09-26'; rerender('', '#op-date'); });
    root.querySelector('[data-op-active-day]')?.addEventListener('click', () => { day = D.departure(active.departureId).date; selectedId = active.departureId; openManifest(); });
    root.querySelectorAll('[data-op-open-booking]').forEach(button => button.addEventListener('click', () => onOpenBooking?.()));
    root.querySelectorAll('[data-op-guest]').forEach(button => button.addEventListener('click', () => onGuest?.()));
    root.querySelectorAll('[data-op-preview]').forEach(button => button.addEventListener('click', () => { const key = button.dataset.opPreview; expanded.has(key) ? expanded.delete(key) : expanded.add(key); rerender('', `[data-op-preview="${key}"]`); }));
    root.querySelectorAll('[data-op-check]').forEach(input => input.addEventListener('change', () => {
      const key = input.dataset.opCheck;
      const person = people(D.departure(selectedId)).find(person => person.checkKey === key);
      if (person?.status !== 'signed') return;
      input.checked ? checked.add(key) : checked.delete(key);
      rerender(`${person.name || 'Participant'} ${input.checked ? 'marked checked in' : 'check-in cleared'} in this demo only.`);
      [...root.querySelectorAll('[data-op-check]')].find(item => item.dataset.opCheck === key)?.focus();
    }));
    root.querySelector('#op-notice')?.addEventListener('input', event => { drafts[selectedId] = event.target.value; });
    root.querySelector('#op-notice-form')?.addEventListener('submit', event => {
      event.preventDefault();
      notices[selectedId] = root.querySelector('#op-notice').value.trim().slice(0, 600);
      drafts[selectedId] = notices[selectedId];
      rerender(notices[selectedId] ? 'Local notice saved. It now appears on this departure’s guest arrival screen. Nothing was sent.' : 'The saved notice is now empty.', '#op-notice');
    });
    root.querySelector('[data-op-clear-notice]')?.addEventListener('click', () => { delete notices[selectedId]; delete drafts[selectedId]; rerender('Saved notice removed from the sample guest arrival screen.', '#op-notice'); });
    root.querySelectorAll('[data-op-edit-link]').forEach(button => button.addEventListener('click', () => { editingLink = button.dataset.opEditLink; rerender('', '#op-link-label'); }));
    root.querySelector('[data-op-cancel-link]')?.addEventListener('click', () => { editingLink = null; rerender('', '#op-link-label'); });
    root.querySelectorAll('[data-op-remove-link]').forEach(button => button.addEventListener('click', () => {
      links = links.filter(link => link.id !== button.dataset.opRemoveLink);
      if (editingLink === button.dataset.opRemoveLink) editingLink = null;
      rerender('Link removed from the guest ready screen.', '#op-link-label');
    }));
    root.querySelector('#op-link-url')?.addEventListener('input', event => event.target.setCustomValidity(''));
    root.querySelector('#op-link-label')?.addEventListener('input', event => event.target.setCustomValidity(''));
    root.querySelector('#op-link-form')?.addEventListener('submit', event => {
      event.preventDefault();
      const labelInput = root.querySelector('#op-link-label');
      const urlInput = root.querySelector('#op-link-url');
      const label = labelInput.value.trim().slice(0, 80);
      let url;
      try { url = new URL(urlInput.value.trim()); } catch { /* Show native field feedback below. */ }
      if (!label) { labelInput.setCustomValidity('Enter a label for guests.'); labelInput.reportValidity(); return; }
      if (!url || url.protocol !== 'https:' || url.username || url.password) { urlInput.setCustomValidity('Enter a full https:// website address without a username or password.'); urlInput.reportValidity(); return; }
      const updated = { id: editingLink || `link-${++sequence}`, label, url: url.href };
      links = editingLink ? links.map(link => link.id === editingLink ? updated : link) : [...links, updated];
      editingLink = null;
      rerender('Important links updated on the guest ready screen.', '#op-link-label');
    });
  }
  function reset() {
    if (typeof WeatherOps !== 'undefined') WeatherOps.reset();
    day = '2026-09-26'; selectedId = ''; links = defaultLinks(); notices = {}; drafts = {}; checked = new Set(); editingLink = null; expanded = new Set(); message = ''; sequence = 0; active = null;
  }
  return { render, bind, resources: () => links.map(link => ({ ...link })), notice: departureId => notices[departureId] || '', reset };
})();
