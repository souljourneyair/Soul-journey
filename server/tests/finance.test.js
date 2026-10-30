'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateWeeklyTax, settleTickBalance } = require('../finance');

test('weekly tax charges only positive profit and rounds to the nearest unit', () => {
  assert.deepEqual(calculateWeeklyTax(10_000, 0.2), {
    taxableProfit: 10_000,
    tax: 2_000,
  });
  assert.deepEqual(calculateWeeklyTax(12_345, 0.2), {
    taxableProfit: 12_345,
    tax: 2_469,
  });
  assert.deepEqual(calculateWeeklyTax(-5_000, 0.2), {
    taxableProfit: 0,
    tax: 0,
  });
  assert.deepEqual(calculateWeeklyTax(0, 0.2), {
    taxableProfit: 0,
    tax: 0,
  });
});

test('loan payment and weekly tax are both deducted when due in the same tick', () => {
  const result = settleTickBalance(100_000, {
    floor: -25_000,
    loanPayment: 7_500,
    taxPayment: 4_000,
  });

  assert.deepEqual(result, {
    money: 88_500,
    bankrupt: false,
    deductions: 11_500,
  });
});

test('debt floor is checked after combined loan and tax deductions', () => {
  const result = settleTickBalance(-8_000, {
    floor: -10_000,
    loanPayment: 1_500,
    taxPayment: 1_000,
  });

  assert.deepEqual(result, {
    money: -10_000,
    bankrupt: true,
    deductions: 2_500,
  });
});

test('reaching the debt floor exactly triggers bankruptcy', () => {
  const result = settleTickBalance(500, {
    floor: -1_000,
    loanPayment: 1_000,
    taxPayment: 500,
  });

  assert.deepEqual(result, {
    money: -1_000,
    bankrupt: true,
    deductions: 1_500,
  });
});

test('financial helpers reject non-finite values and negative deductions', () => {
  assert.throws(() => calculateWeeklyTax(Infinity, 0.2), /finite number/);
  assert.throws(() => calculateWeeklyTax(100, 1.2), /between 0 and 1/);
  assert.throws(() => settleTickBalance(100, { floor: -100, loanPayment: -1 }), /cannot be negative/);
});

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('runTick applies loan and tax deductions together before finalizing the patch', () => {
  const loanStart = serverSource.indexOf('const loan = freshAirport.loan;');
  const settlement = serverSource.indexOf('const settledBalance = settleTickBalance', loanStart);
  const oldSaveBlock = serverSource.indexOf('// Починка старых сохранений:', settlement);
  assert.ok(loanStart >= 0);
  assert.ok(settlement > loanStart);
  assert.ok(oldSaveBlock > settlement);

  const financialRegion = serverSource.slice(loanStart, oldSaveBlock);
  assert.match(financialRegion, /loanPayment = pay/);
  assert.match(financialRegion, /taxPayment = tax/);
  assert.match(financialRegion, /settleTickBalance\(newMoney,\s*\{\s*floor,\s*loanPayment,\s*taxPayment,/);
  assert.doesNotMatch(financialRegion, /patch\.money\s*=/,
    'neither scheduled deduction may overwrite the other in the airport patch');
  assert.ok(financialRegion.indexOf('settleTickBalance') < financialRegion.indexOf('Object.assign(patch'));
});
