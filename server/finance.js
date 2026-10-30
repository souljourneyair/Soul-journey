'use strict';

function assertFinite(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

/**
 * Calculate the weekly tax from accumulated operating profit.
 * Loss-making periods are not taxed. The caller resets period accumulation
 * after the week is closed.
 */
function calculateWeeklyTax(profit, rate) {
  assertFinite('profit', profit);
  assertFinite('rate', rate);
  if (rate < 0 || rate > 1) throw new RangeError('rate must be between 0 and 1');

  const taxableProfit = Math.max(0, profit);
  return {
    taxableProfit,
    tax: Math.round(taxableProfit * rate),
  };
}

/**
 * Apply all scheduled deductions to the same pre-deduction balance.
 * The debt floor is checked once, after every due payment has been applied.
 */
function settleTickBalance(balance, {
  floor,
  loanPayment = 0,
  taxPayment = 0,
} = {}) {
  assertFinite('balance', balance);
  assertFinite('floor', floor);
  assertFinite('loanPayment', loanPayment);
  assertFinite('taxPayment', taxPayment);

  if (loanPayment < 0 || taxPayment < 0) {
    throw new RangeError('scheduled deductions cannot be negative');
  }

  const afterDeductions = balance - loanPayment - taxPayment;
  const bankrupt = afterDeductions <= floor;

  return {
    money: bankrupt ? floor : afterDeductions,
    bankrupt,
    deductions: loanPayment + taxPayment,
  };
}

module.exports = { calculateWeeklyTax, settleTickBalance };
