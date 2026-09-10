'use strict';

// Fictional marine evidence and operator drafts. Windy is an explicit external map;
// its forecast is never read into sample state or used for trip/payment commands.
const WeatherOps = (() => {
  const D = TideGrid;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const minute = 60000;
  const windyMaps = {
    wind: 'https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=default&metricTemp=default&metricWind=kt&zoom=8&overlay=wind&product=ecmwf&level=surface&lat=26.23&lon=-80.05',
    waves: 'https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=default&metricTemp=default&metricWind=kt&zoom=8&overlay=waves&product=ecmwfWaves&level=surface&lat=26.23&lon=-80.05'
  };
  let states = new Map();
  const departureTime = departure => new Date(`${departure.date}T${departure.time}:00-04:00`).getTime();
  const timestamp = instant => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(instant)) + ' EDT';
  const duration = departure => Number.parseInt(D.experience(departure.experienceId).duration, 10) * 60 * minute;
  function stateFor(departure) {
    if (!states.has(departure.id)) {
      const start = departureTime(departure);
      const later = new Date(start + 60 * minute);
      const proposedTime = `${String((later.getUTCHours() + 20) % 24).padStart(2, '0')}:${String(later.getUTCMinutes()).padStart(2, '0')}`;
      states.set(departure.id, { clock: start - 90 * minute, fetched: start - 95 * minute, issued: start - 120 * minute, validFrom: start - 120 * minute, validTo: start + duration(departure), watch: false, watchReason: '', draft: { action: 'delay', reason: '', time: proposedTime }, preview: null, proposal: null, noticeMode: '', history: [], feedback: '', windyLoaded: false, windyLayer: 'wind' });
    }
    return states.get(departure.id);
  }
  const isStale = state => state.clock - state.fetched > 60 * minute || state.clock > state.validTo;
  const impact = bookings => ({ bookings: bookings.length, guests: bookings.reduce((sum, booking) => sum + (booking.participants?.length ?? Number(booking.party || 0)), 0), total: bookings.reduce((sum, booking) => sum + Number(booking.total || 0), 0) });
  const bookingSignature = bookings => JSON.stringify(bookings.map(booking => [booking.key || booking.id, booking.participants?.length ?? booking.party, booking.total]));
  const event = (state, text) => { state.clock += minute; state.history.unshift({ time: state.clock, text }); state.history = state.history.slice(0, 8); };
  const proposedLabel = (departure, proposal) => proposal.action === 'cancel' ? 'Cancellation proposal' : `Delay proposal · ${D.timeLabel(proposal.time)} EDT, ${D.dateLabel(departure.date, { month: 'short', day: 'numeric' })}`;
  function guestNotice(departure, state) {
    if (state.noticeMode === 'proposal' && state.proposal) {
      const proposal = state.proposal;
      return `Sample operator marine update: ${proposal.action === 'cancel' ? 'Cancellation is proposed' : `A delay to ${D.timeLabel(proposal.time)} EDT on ${D.dateLabel(departure.date, { month: 'short', day: 'numeric' })} is proposed`} and awaits operator approval. Your booking time has not changed. No refund or credit has been issued. Operator reason: ${proposal.reason}`;
    }
    if (state.noticeMode === 'watch') return `Sample operator marine update: the operator has placed this departure on marine watch. Your booking time has not changed. Operator note: ${state.watchReason}`;
    if (state.noticeMode === 'clear') return 'Sample operator marine update: the operator cleared this departure’s marine watch in the demo. Your booking time has not changed. This is not a forecast or a safety assessment.';
    if (state.noticeMode === 'withdrawn') return `Sample operator marine update: the operator withdrew the proposed trip change in this demo. Your original booking time remains unchanged.${state.watch ? ' The operator’s local marine watch is still active.' : ''} No refund or credit has been issued.`;
    return '';
  }
  function evidence(departure, state) {
    const stale = isStale(state);
    const age = Math.floor((state.clock - state.fetched) / minute);
    return `<div class="weather-evidence"><div class="weather-evidence-heading"><div><h3>Sample sea state</h3><p>Fictional trip-date readings; the Windy map below is separate.</p></div><span class="weather-freshness ${stale ? 'is-stale' : ''}">${stale ? 'Stale sample data' : 'Fresh sample data'}</span></div>
      <p class="marine-sea-description">Easterly swell with short-period wind chop <span>Illustrative description only</span></p>
      <dl class="weather-values"><div><dt>Sustained wind</dt><dd>14 <span>kt</span></dd><dd class="marine-value-detail">From ENE · 068°</dd></div><div><dt>Wind gusts</dt><dd>21 <span>kt</span></dd><dd class="marine-value-detail">Sample gust speed</dd></div><div><dt>Combined wave height</dt><dd>3.2 <span>ft</span></dd><dd class="marine-value-detail">Significant wave height</dd></div><div><dt>Swell height</dt><dd>2.8 <span>ft</span></dd><dd class="marine-value-detail">7 s period · from E, 090°</dd></div><div><dt>Wind-wave chop</dt><dd>1.5 <span>ft</span></dd><dd class="marine-value-detail">3 s period · from ENE</dd></div><div><dt>Visibility</dt><dd>8 <span>nm</span></dd><dd class="marine-value-detail">Sample visibility</dd></div></dl>
      <details class="compact-details"><summary>Forecast times & source</summary><p class="op-footnote">Demo readings, not a live NOAA feed.</p><dl class="weather-timestamps"><div><dt>Forecast valid</dt><dd>${timestamp(state.validFrom)} → ${timestamp(state.validTo)}</dd></div><div><dt>Sample issued</dt><dd>${timestamp(state.issued)}</dd></div><div><dt>Sample fetched</dt><dd>${timestamp(state.fetched)} · ${age} min ago in demo</dd></div><div><dt>Simulation clock</dt><dd>${timestamp(state.clock)}</dd></div></dl></details>
      ${stale ? '<p class="weather-stale-note" role="status">Sample readings are stale. Review conditions before making a trip decision.</p>' : '<p class="op-footnote">Freshness describes data age, not trip safety.</p>'}
      <div class="weather-simulation"><button type="button" class="secondary" data-weather-fresh>Simulate fresh update</button><button type="button" class="text-button" data-weather-stale>Simulate stale data</button></div><p class="op-footnote">Demo clock · readings become stale after 60 minutes.</p></div>`;
  }
  function windyPanel(departure, state) {
    const label = state.windyLayer === 'waves' ? 'Waves' : 'Wind';
    const url = windyMaps[state.windyLayer];
    return `<section class="marine-windy" aria-labelledby="marine-windy-title"><div class="marine-windy-heading"><div><h3 id="marine-windy-title">Windy map</h3><p>Pompano Beach demo area</p></div><span class="marine-external-badge">External Windy map</span></div><p class="marine-map-date-note"><strong>Check Windy’s date and model.</strong> Its forecast is separate from this sample departure on ${D.dateLabel(departure.date, { month: 'short', day: 'numeric', year: 'numeric' })}.</p>
      <div class="marine-map-toolbar"><div class="marine-layer-switch" role="group" aria-label="Windy forecast layer"><button type="button" data-marine-layer="wind" aria-pressed="${state.windyLayer === 'wind'}">Wind</button><button type="button" data-marine-layer="waves" aria-pressed="${state.windyLayer === 'waves'}">Waves</button></div><a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="marine-map-link">Open Windy map ↗</a></div>
      ${state.windyLoaded ? `<iframe class="marine-windy-frame" src="${esc(url)}" title="Windy ${label.toLowerCase()} forecast near Pompano Beach; timeline independent of sample trip dates" loading="lazy" referrerpolicy="no-referrer"></iframe><div class="marine-map-footer"><p>If the map does not load, open it directly using the link above.</p><button class="text-button" type="button" data-marine-hide-map>Hide Windy map</button></div>` : `<div class="marine-map-placeholder"><button type="button" class="secondary" data-marine-load-map>Load Windy ${label.toLowerCase()} map</button></div>`}
      <p class="op-footnote">Public demo location only; no guest details are shared.</p></section>`;
  }
  function watchPanel(state) {
    return `<section class="weather-watch"><div class="weather-subheading"><h3>Operator marine watch</h3><span class="op-pill ${state.watch ? 'op-pill-amber' : ''}">${state.watch ? 'On watch · demo' : 'No watch set'}</span></div><p class="op-footnote">Flag a concern without changing bookings.</p>${state.watch ? `<div class="weather-operator-note"><strong>Operator’s reason</strong><p>${esc(state.watchReason)}</p></div><button type="button" class="secondary" data-weather-clear-watch>Clear local watch</button>` : `<form id="weather-watch-form"><label class="field-label" for="weather-watch-reason">Reason for watch</label><textarea id="weather-watch-reason" required maxlength="300" rows="2" placeholder="Record what you want to review.">${esc(state.watchReason)}</textarea><button class="secondary" type="submit">Set local watch</button></form>`}</section>`;
  }
  function proposalPanel(departure, bookings, state) {
    const preview = state.preview;
    const counts = impact(bookings);
    const changed = preview && preview.bookingSignature !== bookingSignature(bookings);
    return `<section class="weather-proposal"><h3>Prepare a trip change</h3><p class="op-footnote">Preview and save for review. No trip change is applied.</p><form id="weather-proposal-form"><div class="weather-form-row"><div><label class="field-label" for="weather-action">Proposed action</label><select id="weather-action"><option value="delay" ${state.draft.action === 'delay' ? 'selected' : ''}>Delay departure</option><option value="cancel" ${state.draft.action === 'cancel' ? 'selected' : ''}>Cancel departure</option></select></div>${state.draft.action === 'delay' ? `<div><label class="field-label" for="weather-delay-time">Proposed time · EDT</label><input id="weather-delay-time" type="time" required value="${esc(state.draft.time)}" min="${esc(departure.time)}" max="23:59"><span class="op-footnote">Same day · currently ${D.timeLabel(departure.time)}</span></div>` : ''}</div><label class="field-label" for="weather-change-reason">Reason for the proposed change</label><textarea id="weather-change-reason" required maxlength="300" rows="2" placeholder="Record the operator’s reason for review.">${esc(state.draft.reason)}</textarea><button class="secondary" type="submit">Preview impact</button></form>
      ${preview ? `<div class="weather-impact"><p class="op-kicker">Impact preview · no change applied</p><h4>${esc(proposedLabel(departure, preview))}</h4><p class="weather-preview-reason">${esc(preview.reason)}</p><dl class="weather-impact-counts"><div><dt>Bookings</dt><dd>${counts.bookings}</dd></div><div><dt>Guests</dt><dd>${counts.guests}</dd></div><div><dt>Sample booking value</dt><dd>${D.money(counts.total)}</dd></div></dl>${preview.action === 'cancel' ? remedyChoices(preview) : '<p>The original departure time applies until the operator approves a change.</p>'}<p>Sample bookings · nothing sent.</p>${changed ? '<p class="weather-stale-note">The booking list changed after this preview. Preview impact again before saving.</p>' : ''}<button type="button" class="primary" data-weather-save-proposal ${changed ? 'disabled' : ''}>Save proposal only</button></div>` : ''}
      ${state.proposal ? `<div class="weather-saved-proposal"><span class="weather-pending">Pending operator approval · not applied</span><h4>${esc(proposedLabel(departure, state.proposal))}</h4><p>${esc(state.proposal.reason)}</p><p>${state.proposal.impact.bookings} bookings · ${state.proposal.impact.guests} guests at save · ${timestamp(state.proposal.savedAt)}</p>${state.proposal.action === 'cancel' ? remedySummary(state.proposal) : ''}<p>Departure time, booking status, inventory and payments remain unchanged. No credit or trip-card value has been issued.</p><button type="button" class="text-button" data-weather-discard-proposal>Discard pending proposal</button></div>` : ''}</section>`;
  }
  const remedyLabel = type => type === 'credit' ? 'Customer credit · USD card' : 'Original-payment refund';
  function remedyChoices(preview) {
    return `<h4>Choose each booking’s cancellation remedy</h4><p>Choose credit or refund. Samples assume full payment in money.</p>${preview.remedies.map((item, index) => `<div class="weather-remedy"><label class="field-label" for="weather-remedy-${index}">${esc(item.name)} · ${esc(item.id)} · ${D.money(item.amount)}</label><select id="weather-remedy-${index}" data-weather-remedy="${index}"><option value="">Choose a remedy</option><option value="credit" ${item.type === 'credit' ? 'selected' : ''}>Customer credit · USD trip card</option><option value="refund" ${item.type === 'refund' ? 'selected' : ''}>Refund to original payment</option></select></div>`).join('') || '<p>No bookings need a remedy.</p>'}<details class="compact-details"><summary>Trip cards & mixed payments</summary><p>Restore trip units or dollars to their original cards. Handle mixed payments by funding portion; these allocations are outside the demo.</p></details>`;
  }
  function remedySummary(proposal) {
    return `<ul>${proposal.remedies.map(item => `<li>${esc(item.name)} · ${D.money(item.amount)} ${remedyLabel(item.type)}</li>`).join('')}</ul><p>Credit stays with the named customer for future bookings with this operator. This is a proposal only.</p>`;
  }
  function render({ departure, bookings = [], savedNotice = '' } = {}) {
    if (!departure) return '';
    const state = stateFor(departure);
    const notice = guestNotice(departure, state);
    return `<section class="op-panel weather-panel" aria-labelledby="weather-title"><header class="weather-heading"><div><h2 id="weather-title">Marine conditions</h2><p>${esc(D.experience(departure.experienceId).name)} · ${D.dateLabel(departure.date, { month: 'short', day: 'numeric' })} · ${D.timeLabel(departure.time)} EDT</p></div><span class="weather-demo-badge">Advisory marine conditions</span></header><p class="weather-advisory">Advisory only. Trip decisions stay with the operator.</p><p class="op-feedback" role="status" ${state.feedback ? '' : 'hidden'}>${esc(state.feedback)}</p>
      ${evidence(departure, state)}${windyPanel(departure, state)}<div class="weather-management">${watchPanel(state)}${proposalPanel(departure, bookings, state)}</div>
      ${notice ? `<section class="weather-guest-notice"><p class="op-kicker">Preview before saving</p><h3>Local guest marine notice</h3><blockquote>${esc(notice)}</blockquote><p class="op-footnote">Replaces this trip’s arrival notice. No message is sent.</p><button type="button" class="secondary" data-weather-save-notice>Save local guest notice</button><p class="op-footnote">${savedNotice === notice ? 'Saved to guest preparation.' : 'Not saved to guest preparation yet.'}</p></section>` : ''}
      <details class="weather-history"><summary>Local marine activity <span>${state.history.length} ${state.history.length === 1 ? 'entry' : 'entries'}</span></summary>${state.history.length ? `<ol>${state.history.map(entry => `<li><time>${timestamp(entry.time)}</time><span>${esc(entry.text)}</span></li>`).join('')}</ol>` : '<p>No operator marine actions yet. Activity is kept for this departure in this open page only.</p>'}<p class="op-footnote">Last eight events · this session only.</p></details></section>`;
  }
  function bind(root, { departure, bookings = [], refresh, onNotice }) {
    if (!departure) return;
    const state = stateFor(departure);
    const redraw = (feedback, focus) => { state.feedback = feedback; refresh(); if (focus) root.querySelector(focus)?.focus(); };
    root.querySelectorAll('[data-marine-layer]').forEach(button => button.addEventListener('click', () => {
      const layer = button.dataset.marineLayer;
      if (layer !== 'wind' && layer !== 'waves') return;
      state.windyLayer = layer;
      redraw('', `[data-marine-layer="${layer}"]`);
    }));
    root.querySelector('[data-marine-load-map]')?.addEventListener('click', () => {
      state.windyLoaded = true;
      redraw('Windy map requested. Its forecast timeline is independent of the sample trip date.', `[data-marine-layer="${state.windyLayer}"]`);
    });
    root.querySelector('[data-marine-hide-map]')?.addEventListener('click', () => {
      state.windyLoaded = false;
      redraw('', '[data-marine-load-map]');
    });
    root.querySelector('[data-weather-fresh]')?.addEventListener('click', () => {
      state.clock += 5 * minute; state.fetched = state.clock; state.issued = state.clock; state.validFrom = state.clock; state.validTo = state.clock + 6 * 60 * minute;
      event(state, 'Fresh fixture update simulated. Forecast values are fictional; no provider was called.');
      redraw('Fresh sample update recorded. The watch and any change proposal are unchanged.', '[data-weather-fresh]');
    });
    root.querySelector('[data-weather-stale]')?.addEventListener('click', () => {
      state.clock += 3 * 60 * minute;
      event(state, 'Clock advanced three hours to show stale sample data.');
      redraw('Stale sample data shown. No watch, trip change or customer message was created.', '[data-weather-stale]');
    });
    root.querySelector('#weather-watch-reason')?.addEventListener('input', event => { state.watchReason = event.target.value.slice(0, 300); event.target.setCustomValidity(''); });
    root.querySelector('#weather-watch-form')?.addEventListener('submit', formEvent => {
      formEvent.preventDefault();
      const field = root.querySelector('#weather-watch-reason');
      const reason = field.value.trim().slice(0, 300);
      if (!reason) { field.setCustomValidity('Record the operator’s reason for this watch.'); field.reportValidity(); return; }
      state.watch = true; state.watchReason = reason; state.noticeMode = 'watch';
      event(state, `Operator set a local watch: ${reason}`);
      redraw('Local marine watch set. Sales and bookings are unchanged. Review the guest notice below before saving.', '[data-weather-clear-watch]');
    });
    root.querySelector('[data-weather-clear-watch]')?.addEventListener('click', () => {
      state.watch = false; state.noticeMode = 'clear';
      event(state, 'Operator cleared the local marine watch. No safety assessment was made.');
      redraw('Local watch cleared. Any saved trip-change proposal is still pending. Guest notices update only when explicitly saved.', '#weather-watch-reason');
    });
    root.querySelector('#weather-action')?.addEventListener('change', event => { state.draft.action = event.target.value === 'cancel' ? 'cancel' : 'delay'; state.preview = null; redraw('', '#weather-action'); });
    root.querySelector('#weather-delay-time')?.addEventListener('input', event => { state.draft.time = event.target.value; state.preview = null; event.target.setCustomValidity(''); root.querySelector('[data-weather-save-proposal]')?.setAttribute('disabled', ''); });
    root.querySelector('#weather-change-reason')?.addEventListener('input', event => { state.draft.reason = event.target.value.slice(0, 300); state.preview = null; event.target.setCustomValidity(''); root.querySelector('[data-weather-save-proposal]')?.setAttribute('disabled', ''); });
    root.querySelectorAll('[data-weather-remedy]').forEach(field => field.addEventListener('change', () => {
      const item = state.preview?.remedies?.[Number(field.dataset.weatherRemedy)];
      if (item) item.type = ['credit', 'refund'].includes(field.value) ? field.value : '';
      field.setCustomValidity('');
    }));
    root.querySelector('#weather-proposal-form')?.addEventListener('submit', formEvent => {
      formEvent.preventDefault();
      const reasonField = root.querySelector('#weather-change-reason');
      const reason = reasonField.value.trim().slice(0, 300);
      if (!reason) { reasonField.setCustomValidity('Record a reason for the proposed change.'); reasonField.reportValidity(); return; }
      const timeField = root.querySelector('#weather-delay-time');
      if (state.draft.action === 'delay' && (!timeField || !/^\d{2}:\d{2}$/.test(timeField.value) || timeField.value <= departure.time || new Date(`${departure.date}T${timeField.value}:00-04:00`).getTime() <= state.clock || !timeField.checkValidity())) { timeField?.setCustomValidity('Choose a same-day time later than the scheduled departure and the simulation clock.'); timeField?.reportValidity(); return; }
      state.draft.reason = reason;
      if (timeField) state.draft.time = timeField.value;
      state.preview = { ...state.draft, bookingSignature: bookingSignature(bookings), remedies: state.draft.action === 'cancel' ? bookings.map(booking => ({ key: booking.key || booking.id, id: booking.id, name: booking.name, amount: Number(booking.total || 0), type: '' })) : [] };
      redraw('Impact preview ready. Nothing has been saved or applied.', '[data-weather-save-proposal]');
    });
    root.querySelector('[data-weather-save-proposal]')?.addEventListener('click', () => {
      if (!state.preview || state.preview.bookingSignature !== bookingSignature(bookings)) return;
      if (state.preview.action === 'cancel') {
        const missing = state.preview.remedies.findIndex(item => !['credit', 'refund'].includes(item.type));
        if (missing >= 0) {
          const field = root.querySelector(`#weather-remedy-${missing}`);
          field?.setCustomValidity('Choose credit or refund for this booking before saving.');
          field?.reportValidity();
          return;
        }
      }
      if (state.preview.action === 'delay' && new Date(`${departure.date}T${state.preview.time}:00-04:00`).getTime() <= state.clock) {
        state.preview = null;
        redraw('The simulation clock has passed the proposed time. Choose a later time and preview again.', '#weather-delay-time');
        return;
      }
      event(state, `${state.preview.action === 'cancel' ? 'Cancellation' : 'Delay'} proposal saved for operator approval. No trip or financial change was applied.`);
      state.proposal = { ...state.preview, remedies: state.preview.remedies.map(item => ({ ...item })), impact: impact(bookings), savedAt: state.clock };
      state.preview = null; state.noticeMode = 'proposal';
      redraw('Proposal saved locally, pending operator approval. Bookings and payments are unchanged.', '[data-weather-save-notice]');
    });
    root.querySelector('[data-weather-discard-proposal]')?.addEventListener('click', () => {
      if (!state.proposal) return;
      const action = state.proposal.action;
      state.proposal = null; state.preview = null; state.noticeMode = 'withdrawn';
      event(state, `Operator discarded the pending ${action === 'cancel' ? 'cancellation' : 'delay'} proposal. No trip change was applied.`);
      redraw('Pending proposal discarded. The existing guest notice is unchanged; save the withdrawal notice below to update it.', '[data-weather-save-notice]');
    });
    root.querySelector('[data-weather-save-notice]')?.addEventListener('click', () => {
      const text = guestNotice(departure, state);
      if (!text || !onNotice) return;
      onNotice(text);
      event(state, 'Previewed marine notice saved to the local guest arrival screen. Nothing sent.');
      redraw('Local guest marine notice saved. No email, message or trip change was sent or applied.', '[data-weather-save-notice]');
    });
  }
  return { render, bind, status: departureId => ({ watch: states.get(departureId)?.watch || false, proposal: states.get(departureId)?.proposal?.action || null }), reset: () => { states = new Map(); } };
})();
