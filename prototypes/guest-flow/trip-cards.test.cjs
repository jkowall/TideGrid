'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAmount, redeem } = require('./trip-cards.js');

test('USD amounts use exact integer cents and reject ambiguous or excessive precision', () => {
  assert.equal(parseAmount('money', '0.29').value, 29);
  assert.equal(parseAmount('money', '123.4').value, 12340);
  assert.equal(parseAmount('money', '99999.99').value, 9999999);
  for (const value of ['0', '-1', '1.001', '1e2', '100,00', 'Infinity', '100000', '']) assert.ok(parseAmount('money', value).error, value);
});

test('trip units must be positive whole quantities', () => {
  assert.equal(parseAmount('trips', '12').value, 12);
  for (const value of ['0', '-1', '1.5', '2.0', '1e2', '1000', '']) assert.ok(parseAmount('trips', value).error, value);
});

test('trip redemption enforces eligibility and available balance without mutating input', () => {
  const card = { type: 'trips', eligibility: 'reef', balance: 4, history: [{ action: 'issued', amount: 4, balance: 4 }] };
  const before = JSON.stringify(card);
  assert.ok(redeem(card, '1', 'fishing').error);
  assert.ok(redeem(card, '5', 'reef').error);
  assert.ok(redeem(card, '1.5', 'reef').error);
  const result = redeem(card, '4', 'reef').card;
  assert.equal(result.balance, 0);
  assert.equal(result.history.length, 2);
  assert.equal(result.history[1].balance, 0);
  assert.ok(redeem(result, '1', 'reef').error);
  assert.equal(JSON.stringify(card), before);
});

test('USD redemptions retain cents across repeated deductions and cannot cross zero', () => {
  let card = { type: 'money', balance: 30, history: [] };
  card = redeem(card, '0.10').card;
  card = redeem(card, '0.10').card;
  assert.equal(card.balance, 10);
  assert.ok(redeem(card, '0.11').error);
  card = redeem(card, '0.10').card;
  assert.equal(card.balance, 0);
  assert.ok(redeem(card, '0.01').error);
  assert.ok(redeem({ ...card, balance: 1.5 }, '0.01').error);
});
