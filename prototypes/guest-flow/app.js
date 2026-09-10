'use strict';

// All inventory and amounts are fixtures. No storage, requests, or payment SDKs.
const trips = {
  shared: { name: 'Coastal fishing', kind: 'Shared trip', duration: '4 hours', price: 9500, max: 6, description: 'A morning on the water, with room for a few new friends.', times: [{ time: '8:00 AM', seats: 6 }, { time: '1:00 PM', seats: 2 }, { time: '4:30 PM', seats: 0 }] },
  private: { name: 'Your own stretch of ocean', kind: 'Private charter', duration: '4 hours', price: 65000, max: 6, description: 'The whole boat for your group. Settle in and make it yours.', times: [{ time: '8:00 AM', seats: 0 }, { time: '1:00 PM', seats: 6 }, { time: '4:30 PM', seats: 6 }] }
};
const initialState = () => ({ step: 0, trip: 'shared', departure: '0', party: '2', name: '', email: '', confirmed: false, waiver: false, checkout: false });
let state = initialState();
const main = document.querySelector('#main');
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const trip = () => trips[state.trip];
const departure = () => trip().times[Number(state.departure)];
function selectionError() {
  const party = Number(state.party);
  if (!Number.isInteger(party) || party < 1 || party > trip().max) return `Choose a whole number of guests between 1 and ${trip().max}.`;
  if (!departure() || departure().seats === 0) return 'This sample departure is sold out. Choose another time.';
  if (party > departure().seats) return `Only ${departure().seats} sample seats remain at ${departure().time}. Choose fewer guests or another departure.`;
  return '';
}
function quote() {
  if (selectionError()) return null;
  const subtotal = trip().price * (state.trip === 'shared' ? Number(state.party) : 1);
  const fee = 1000;
  const tax = Math.round((subtotal + fee) * 0.06);
  return { subtotal, fee, tax, total: subtotal + fee + tax };
}
function pricing() {
  const q = quote();
  return q ? `<dl class="price-lines"><div class="money-row"><dt>${state.trip === 'shared' ? `${escapeHTML(state.party)} × ${money(trip().price)}` : 'Whole boat'}</dt><dd>${money(q.subtotal)}</dd></div><div class="money-row"><dt>Booking fee</dt><dd>${money(q.fee)}</dd></div><div class="money-row"><dt>Sample tax (6%)</dt><dd>${money(q.tax)}</dd></div><div class="money-row total"><dt>Sample total</dt><dd>${money(q.total)}</dd></div></dl><p class="hint">USD · Full amount in this simulation. No deposit, later balance, or added tip. Tax is illustrative.</p>` : '<p class="hint">Choose an available departure and valid party size to see your sample total.</p>';
}
function summary() {
  return `<aside class="summary" aria-label="Your trip summary"><div class="summary-top"><p class="eyebrow">Your time on the water</p><p class="summary-title">${trip().name}</p><p>${trip().kind} · ${trip().duration}<br>Aboard the fictional Saltline One</p></div><div class="summary-body"><dl><dt>Sample date</dt><dd>Saturday, September 26, 2026</dd><dt>Departure</dt><dd>${departure()?.time || 'Choose a time'} · Eastern Time (EDT)</dd><dt>Your group</dt><dd>${escapeHTML(state.party || '—')} guest${Number(state.party) === 1 ? '' : 's'}${state.trip === 'private' ? ' · whole boat' : ''}</dd></dl><hr class="summary-rule">${pricing()}<hr class="summary-rule"><p class="hint">Sample availability only. This demo does not hold seats or reserve a boat.</p></div></aside>`;
}
function tripScreen() {
  return `<p class="eyebrow">One good day, out on the water</p><h1 tabindex="-1">Find your kind<br>of escape.</h1><p class="intro">A few seats or the whole boat. Pick your trip, bring your people, and we’ll walk through the rest.</p><form id="trip-form" novalidate><fieldset><legend>1. Choose your experience</legend><div class="trip-options">${Object.entries(trips).map(([id,t]) => `<label class="trip-card"><input type="radio" name="trip" value="${id}" ${state.trip === id ? 'checked' : ''}><span><strong>${t.kind}</strong><small>${t.description}</small><span class="price">${money(t.price)} / ${id === 'shared' ? 'guest' : 'boat'}</span></span></label>`).join('')}</div></fieldset><fieldset><legend>2. Make it your day</legend><p class="hint" style="margin:0 0 15px">Sample date: Saturday, September 26, 2026. All times Eastern (EDT).</p><div class="field-grid"><div><label class="field-label" for="departure">Departure</label><select id="departure" name="departure">${trip().times.map((d,i) => `<option value="${i}" ${state.departure === String(i) ? 'selected' : ''}>${d.time} · ${d.seats === 0 ? 'Sold out' : state.trip === 'private' ? 'Available' : `${d.seats} seats left`}</option>`).join('')}</select></div><div><label class="field-label" for="party">Number of guests</label><input id="party" name="party" type="number" min="1" max="6" step="1" inputmode="numeric" value="${escapeHTML(state.party)}" aria-describedby="party-help"><p class="hint" id="party-help">1–6 guests, including everyone in your group.</p></div></div></fieldset><div id="selection-error" class="error" role="alert" ${selectionError() ? '' : 'hidden'}>${selectionError()}</div><div class="actions"><button class="primary" type="submit">Continue to guest details →</button></div></form>`;
}
function detailsScreen() {
  return `<p class="eyebrow">A little introduction</p><h1 tabindex="-1">Who’s coming aboard?</h1><p class="intro">Start with the person making the booking. Use fictional details for this demo. No email will be sent.</p><form id="details-form" novalidate autocomplete="off"><div class="field-grid"><div><label class="field-label" for="guest-name">Booker’s name</label><input id="guest-name" name="guestName" type="text" maxlength="100" required autocomplete="off" placeholder="Alex Example" value="${escapeHTML(state.name)}"></div><div><label class="field-label" for="guest-email">Email address</label><input id="guest-email" name="guestEmail" type="email" maxlength="254" required autocomplete="off" placeholder="alex@example.com" value="${escapeHTML(state.email)}"></div></div><p class="hint">No account needed. Only these two sample fields are collected.</p><div id="details-error" class="error" role="alert" hidden></div><div class="notice">Your group: ${escapeHTML(state.party)} guests. This concept does not collect participant identities, medical information, or certifications.</div><div class="actions"><button class="text-button" data-back="0" type="button">← Back to trip</button><button class="primary" type="submit">Review sample booking →</button></div></form>`;
}
function reviewScreen() {
  return `<p class="eyebrow">Everything in one place</p><h1 tabindex="-1">A final look.</h1><p class="intro">Check your day on the water and the sample price before trying the confirmation.</p><div class="review-block"><div class="review-heading"><h2>Your trip</h2><button class="text-button" data-back="0">Edit trip</button></div><p>${trip().kind} · ${trip().duration}<br>September 26, 2026 · ${departure().time} EDT<br>${escapeHTML(state.party)} guests</p></div><div class="review-block"><div class="review-heading"><h2>Guest details</h2><button class="text-button" data-back="1">Edit details</button></div><p>${escapeHTML(state.name)}<br>${escapeHTML(state.email)}</p></div><section class="section"><h2>Sample booking policy</h2><p class="intro">In this example, changes and cancellations would be available up to 48 hours before departure. Weather changes would come from the operator. These are fictional terms for testing the experience.</p></section><form id="checkout-form"><div class="review-block" aria-label="Checkout amount"><div class="money-row total" style="border:0;margin:0;padding:0"><span>Sample total</span><span>${money(quote().total)}</span></div><p class="hint">USD · Includes the booking fee and illustrative tax. Full amount simulated; no later balance.</p></div><div class="notice"><strong>Simulated checkout</strong><p>No card details, charge, capacity hold, or real booking. Completing this step only creates a demo confirmation on this page.</p></div><label class="check-label"><input type="checkbox" id="checkout-ack" required ${state.checkout ? 'checked' : ''}><span>I understand this is a sample booking and no payment will be taken.</span></label><div class="actions"><button class="text-button" data-back="1" type="button">← Back to details</button><button class="primary" type="submit">Simulate booking →</button></div></form>`;
}
function readyScreen() {
  return `<div class="success-mark" aria-hidden="true">✓</div><p class="eyebrow">Demo reference · SAMPLE-001</p><h1 tabindex="-1">Your sample trip<br>is all set.</h1><p class="intro">Thanks, ${escapeHTML(state.name)}. This is a demo confirmation. No booking was made, no payment was taken, and no email was sent.</p><span class="status-chip">Demo confirmed · ${money(quote().total)} simulated</span><section class="section"><h2>Before you arrive</h2><p class="intro">Try the sample acknowledgment, then check the arrival details below.</p><div class="review-block"><h3>Sample waiver acknowledgment</h3><p>This placeholder demonstrates where a guest would review an operator’s waiver. It is not a legal waiver, signature, or release of rights.</p><label class="check-label" style="margin-top:18px"><input type="checkbox" id="waiver-ack" ${state.waiver ? 'checked' : ''}><span>I have read this nonbinding sample acknowledgment.</span></label><p class="hint" id="waiver-status" role="status">${state.waiver ? 'Sample acknowledged. No legal document was signed.' : 'Sample acknowledgment not yet completed.'}</p></div></section><section class="section" id="arrival"><h2>Arrival instructions</h2><ol class="arrival-list"><li><strong>Arrive 30 minutes early.</strong> For this sample trip, that is ${({ '8:00 AM': '7:30 AM', '1:00 PM': '12:30 PM', '4:30 PM': '4:00 PM' })[departure().time]} EDT on September 26.</li><li><strong>Meet at Saltline Marina, Dock C.</strong> This is a fictional meeting point. Do not travel to it.</li><li><strong>Bring sun protection, water, and nonslip shoes.</strong> Your actual operator would provide the final trip checklist.</li></ol></section><section class="section"><h2>Important links</h2><ul class="links"><li><a href="#arrival">Meeting point &amp; arrival checklist</a><p>Sample instructions above; no real marina or map.</p></li><li><a href="https://myfwc.com/license/recreational/saltwater-fishing/" target="_blank" rel="noopener noreferrer">Florida fishing license information ↗ <span class="hint">(opens a new tab)</span></a><p>Check with your operator which requirements apply.</p></li><li><span>Contact your operator · placeholder</span><p>A verified contact method would appear here. No messages can be sent in this demo.</p></li></ul></section><div class="actions"><button class="text-button" data-back="0" type="button">Edit sample trip</button><button class="primary" id="new-booking" type="button">Start a new demo</button></div>`;
}
function render(focus = true) {
  const screens = [tripScreen, detailsScreen, reviewScreen, readyScreen];
  main.innerHTML = `<nav aria-label="Booking progress"><ol class="steps">${['Your trip', 'Details', 'Review', 'Ready'].map((label,i) => `<li ${i === state.step ? 'aria-current="step"' : ''}><span class="step-number">${i + 1}</span>${label}</li>`).join('')}</ol></nav><div class="layout"><div>${screens[state.step]()}</div>${summary()}</div>`;
  bindEvents();
  if (focus) { main.querySelector('h1').focus(); window.scrollTo({ top: 0, behavior: 'instant' }); }
}
function invalidate() { state.confirmed = false; state.waiver = false; state.checkout = false; }
function go(step) { if (state.confirmed) invalidate(); state.step = step; render(); }
function updateSelection() {
  invalidate();
  main.querySelector('.summary').outerHTML = summary();
  const error = main.querySelector('#selection-error');
  error.textContent = selectionError(); error.hidden = !selectionError();
}
function bindEvents() {
  main.querySelectorAll('[data-back]').forEach(button => button.addEventListener('click', () => go(Number(button.dataset.back))));
  main.querySelectorAll('[name=trip]').forEach(input => input.addEventListener('change', () => {
    state.trip = input.value; state.departure = String(trip().times.findIndex(d => d.seats > 0)); invalidate(); render(false); main.querySelector(`[name=trip][value=${state.trip}]`).focus();
  }));
  main.querySelector('#departure')?.addEventListener('change', event => { state.departure = event.target.value; updateSelection(); });
  main.querySelector('#party')?.addEventListener('input', event => { state.party = event.target.value; updateSelection(); });
  main.querySelector('#trip-form')?.addEventListener('submit', event => { event.preventDefault(); if (selectionError()) { main.querySelector(Number(state.party) > 0 && Number.isInteger(Number(state.party)) && Number(state.party) <= 6 ? '#departure' : '#party').focus(); return; } go(1); });
  main.querySelector('#guest-name')?.addEventListener('input', event => { state.name = event.target.value; state.checkout = false; });
  main.querySelector('#guest-email')?.addEventListener('input', event => { state.email = event.target.value; state.checkout = false; });
  main.querySelector('#details-form')?.addEventListener('submit', event => {
    event.preventDefault(); state.name = state.name.trim(); state.email = state.email.trim();
    const name = main.querySelector('#guest-name'); const email = main.querySelector('#guest-email');
    name.value = state.name; email.value = state.email;
    if (!state.name || !email.validity.valid) { const error = main.querySelector('#details-error'); error.textContent = !state.name ? 'Enter a fictional booker’s name to continue.' : 'Enter a valid sample email address, such as alex@example.com.'; error.hidden = false; (!state.name ? name : email).focus(); return; }
    go(2);
  });
  main.querySelector('#checkout-ack')?.addEventListener('change', event => { state.checkout = event.target.checked; });
  main.querySelector('#checkout-form')?.addEventListener('submit', event => { event.preventDefault(); if (!state.checkout) return; if (selectionError()) { go(0); return; } state.confirmed = true; state.step = 3; render(); });
  main.querySelector('#waiver-ack')?.addEventListener('change', event => { state.waiver = event.target.checked; main.querySelector('#waiver-status').textContent = state.waiver ? 'Sample acknowledged. No legal document was signed.' : 'Sample acknowledgment not yet completed.'; });
  main.querySelector('#new-booking')?.addEventListener('click', reset);
}
function reset() { state = initialState(); render(); }
document.querySelector('#reset').addEventListener('click', reset);
// A history-cache restore also clears any form data, just like a new page load.
window.addEventListener('pageshow', event => { if (event.persisted) reset(); });
render(false);
