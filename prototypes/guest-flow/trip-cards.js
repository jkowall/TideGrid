'use strict';

// In-memory balance demonstrations, isolated from bookings, payments and remedies.
const TripCards = (() => {
  const D = typeof TideGrid !== 'undefined' ? TideGrid : null;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
  const sharedTrips = () => D ? D.experiences.filter(trip => trip.type === 'shared') : [];
  const tripName = id => D?.experience(id)?.name || id;
  const amountLabel = (type, value) => type === 'money' ? money(value) : `${value} ${value === 1 ? 'trip' : 'trips'}`;
  function parseAmount(type, raw) {
    const text = String(raw ?? '').trim();
    if (type === 'trips') {
      if (!/^\d{1,3}$/.test(text) || Number(text) < 1) return { error: 'Enter a whole number of trips from 1 to 999.' };
      return { value: Number(text) };
    }
    if (type !== 'money' || !/^\d{1,5}(?:\.\d{1,2})?$/.test(text)) return { error: 'Enter a USD amount from 0.01 to 99,999.99, with at most two decimal places.' };
    const [whole, fraction = ''] = text.split('.');
    const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    return value > 0 ? { value } : { error: 'Enter an amount greater than zero.' };
  }
  function redeem(card, raw, experienceId = '') {
    if (!card || !Number.isSafeInteger(card.balance) || card.balance < 0) return { error: 'This sample card has an invalid balance.' };
    const parsed = parseAmount(card.type, raw);
    if (parsed.error) return parsed;
    if (card.type === 'trips' && experienceId !== card.eligibility) return { error: 'Choose the experience eligible for this trip card.' };
    if (parsed.value > card.balance) return { error: 'The redemption exceeds this card’s available balance.' };
    const balance = card.balance - parsed.value;
    return { card: { ...card, balance, history: [...card.history, { action: 'redeemed', amount: parsed.value, balance }] } };
  }
  function seedCards() {
    return [
      { id: 'TC-001', name: 'Avery Sample', type: 'trips', eligibility: 'reef', balance: 4, history: [{ action: 'issued', amount: 5, balance: 5 }, { action: 'redeemed', amount: 1, balance: 4 }] },
      { id: 'TC-002', name: 'Morgan Sample', type: 'money', eligibility: '', balance: 20000, history: [{ action: 'issued', amount: 25000, balance: 25000 }, { action: 'redeemed', amount: 5000, balance: 20000 }] }
    ];
  }
  const emptyIssue = () => ({ name: '', type: 'trips', amount: '', eligibility: 'reef' });
  let cards = seedCards(), selectedId = 'TC-001', issue = emptyIssue(), feedback = '', nextId = 3, issueOpen = false, redemptionDrafts = {};
  const selected = () => cards.find(card => card.id === selectedId);
  function cardButton(card) {
    return `<button type="button" class="tc-card ${card.type === 'money' ? 'tc-money-card' : ''}" id="tc-card-${card.id}" data-tc-card="${card.id}" aria-pressed="${card.id === selectedId}"><span class="tc-card-heading"><span>${card.type === 'trips' ? 'Whole-trip card' : 'USD value card'}</span><span>${card.id}</span></span><strong class="tc-card-balance">${amountLabel(card.type, card.balance)}</strong><span class="tc-card-owner">${esc(card.name)}</span><span class="tc-card-eligibility">${card.type === 'trips' ? esc(tripName(card.eligibility)) : 'USD balance · no cash value in this demo'}</span><span class="tc-card-demo">${card.balance ? 'Sample balance' : 'Fully used · sample'} <span aria-hidden="true">↗</span></span></button>`;
  }
  function detail(card) {
    return `<section class="tc-detail" aria-labelledby="tc-detail-title"><p class="op-kicker">Selected card · ${card.id}</p><h3 id="tc-detail-title">${esc(card.name)}</h3><p class="tc-detail-balance">${amountLabel(card.type, card.balance)} available</p><p class="op-footnote">${card.type === 'trips' ? `Eligible for ${esc(tripName(card.eligibility))}. One trip per participant; extras, fees and tax are separate.` : 'Use part or all of this dollar balance.'}</p><form id="tc-redeem-form"><h4>Try a sample redemption</h4>${card.type === 'trips' ? `<label class="field-label" for="tc-redeem-experience">Example experience</label><select id="tc-redeem-experience">${sharedTrips().map(trip => `<option value="${trip.id}" ${trip.id === (redemptionDrafts[card.id]?.experience || card.eligibility) ? 'selected' : ''}>${esc(trip.name)}</option>`).join('')}</select>` : ''}<label class="field-label" for="tc-redeem-amount">${card.type === 'trips' ? 'Whole trips to use' : 'USD amount to use'}</label><input id="tc-redeem-amount" value="${esc(redemptionDrafts[card.id]?.amount || '')}" type="text" inputmode="${card.type === 'trips' ? 'numeric' : 'decimal'}" maxlength="8" required placeholder="${card.type === 'trips' ? '1' : '25.00'}" ${card.balance === 0 ? 'disabled' : ''}><p class="op-footnote">Changes this sample balance only.</p><button class="secondary" type="submit" ${card.balance === 0 ? 'disabled' : ''}>Simulate redemption</button></form><div class="tc-history"><h4>Sample balance history</h4><ol>${card.history.map((entry, index) => `<li><span class="tc-history-description"><strong>${entry.action === 'issued' ? 'Issued in demo' : 'Simulated redemption'}</strong><small>Entry ${index + 1} · balance ${amountLabel(card.type, entry.balance)}</small></span><span>${entry.action === 'issued' ? '+' : '−'}${amountLabel(card.type, entry.amount)}</span></li>`).reverse().join('')}</ol></div></section>`;
  }
  function render() {
    return `<section class="op-panel trip-cards-panel" aria-labelledby="tc-title"><header class="tc-heading"><div><h2 id="tc-title" tabindex="-1">Trip cards</h2><p>Trips or dollars, saved for another day.</p></div><span class="op-pill">Local balance demo</span></header><p class="tc-demo-note">Sample balances only. Cards are not connected to checkout or cancellation credit.</p><p class="op-feedback" role="status" ${feedback ? '' : 'hidden'}>${esc(feedback)}</p><div class="tc-workspace"><div class="tc-cards-column"><div class="tc-card-list" aria-label="Sample customer cards">${cards.map(cardButton).join('')}</div><details class="tc-issue" ${issueOpen ? 'open' : ''}><summary>Issue a sample card</summary><form id="tc-issue-form"><label class="field-label" for="tc-issue-name">Fictional customer name</label><input id="tc-issue-name" type="text" required maxlength="80" value="${esc(issue.name)}" placeholder="Alex Sample" autocomplete="off"><div class="tc-form-row"><div><label class="field-label" for="tc-issue-type">Card balance type</label><select id="tc-issue-type"><option value="trips" ${issue.type === 'trips' ? 'selected' : ''}>Whole trips</option><option value="money" ${issue.type === 'money' ? 'selected' : ''}>USD value</option></select></div><div><label class="field-label" for="tc-issue-amount">${issue.type === 'trips' ? 'Starting trips' : 'Starting USD value'}</label><input id="tc-issue-amount" type="text" inputmode="${issue.type === 'trips' ? 'numeric' : 'decimal'}" required maxlength="8" value="${esc(issue.amount)}" placeholder="${issue.type === 'trips' ? '5' : '250.00'}"></div></div>${issue.type === 'trips' ? `<label class="field-label" for="tc-issue-eligibility">Eligible experience</label><select id="tc-issue-eligibility">${sharedTrips().map(trip => `<option value="${trip.id}" ${trip.id === issue.eligibility ? 'selected' : ''}>${esc(trip.name)}</option>`).join('')}</select>` : ''}<p class="op-footnote">Whole trips or dollars to two decimal places. No payment collected.</p><button class="primary" type="submit">Issue sample card</button></form></details></div>${detail(selected())}</div></section>`;
  }
  function bind(root, { refresh }) {
    const redraw = (text = '', focus = '') => { feedback = text; refresh(); if (focus) root.querySelector(focus)?.focus(); };
    const invalid = (input, error) => { input.setCustomValidity(error); input.reportValidity(); };
    root.querySelector('.tc-issue')?.addEventListener('toggle', event => { issueOpen = event.target.open; });
    root.querySelector('#tc-redeem-amount')?.addEventListener('input', event => { redemptionDrafts[selectedId] = { ...redemptionDrafts[selectedId], amount: event.target.value }; });
    root.querySelector('#tc-redeem-experience')?.addEventListener('change', event => { redemptionDrafts[selectedId] = { ...redemptionDrafts[selectedId], experience: event.target.value }; });
    root.querySelectorAll('[data-tc-card]').forEach(button => button.addEventListener('click', () => { selectedId = button.dataset.tcCard; redraw('', selected().balance ? '#tc-redeem-amount' : `#tc-card-${selectedId}`); }));
    root.querySelectorAll('#tc-issue-form input, #tc-redeem-form input, #tc-redeem-form select').forEach(input => input.addEventListener('input', () => input.setCustomValidity('')));
    root.querySelector('#tc-issue-name')?.addEventListener('input', event => { issue.name = event.target.value; });
    root.querySelector('#tc-issue-amount')?.addEventListener('input', event => { issue.amount = event.target.value; });
    root.querySelector('#tc-issue-eligibility')?.addEventListener('change', event => { issue.eligibility = event.target.value; });
    root.querySelector('#tc-issue-type')?.addEventListener('change', event => { issue.type = event.target.value === 'money' ? 'money' : 'trips'; issue.amount = ''; redraw('', '#tc-issue-type'); });
    root.querySelector('#tc-issue-form')?.addEventListener('submit', event => {
      event.preventDefault();
      const nameInput = root.querySelector('#tc-issue-name'), amountInput = root.querySelector('#tc-issue-amount');
      const name = nameInput.value.trim().slice(0, 80), amount = parseAmount(issue.type, amountInput.value);
      if (!name) return invalid(nameInput, 'Enter a fictional customer name.');
      if (amount.error) return invalid(amountInput, amount.error);
      if (issue.type === 'trips' && !sharedTrips().some(trip => trip.id === issue.eligibility)) return;
      const card = { id: `TC-${String(nextId++).padStart(3, '0')}`, name, type: issue.type, eligibility: issue.type === 'trips' ? issue.eligibility : '', balance: amount.value, history: [{ action: 'issued', amount: amount.value, balance: amount.value }] };
      cards = [...cards, card]; selectedId = card.id; issue = emptyIssue(); issueOpen = false;
      redraw(`Sample card issued to ${name} with ${amountLabel(card.type, card.balance)}. No payment was collected.`, `#tc-card-${card.id}`);
    });
    root.querySelector('#tc-redeem-form')?.addEventListener('submit', event => {
      event.preventDefault();
      const input = root.querySelector('#tc-redeem-amount'), card = selected();
      const experience = root.querySelector('#tc-redeem-experience');
      const result = redeem(card, input.value, experience?.value || '');
      if (result.error) return invalid(card.type === 'trips' && experience?.value !== card.eligibility ? experience : input, result.error);
      cards = cards.map(item => item.id === card.id ? result.card : item);
      delete redemptionDrafts[card.id];
      redraw(`Simulated redemption recorded. ${amountLabel(card.type, result.card.balance)} remains on ${card.name}’s card. No booking was paid or changed.`, result.card.balance ? '#tc-redeem-amount' : `#tc-card-${card.id}`);
    });
  }
  function reset() { cards = seedCards(); selectedId = 'TC-001'; issue = emptyIssue(); feedback = ''; nextId = 3; issueOpen = false; redemptionDrafts = {}; }
  return { render, bind, reset, parseAmount, redeem };
})();
if (typeof module !== 'undefined') module.exports = TripCards;
