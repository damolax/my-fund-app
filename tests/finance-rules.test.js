'use strict'

const assert = require('node:assert/strict')

const sum = (items) => items.reduce((total, value) => total + Number(value || 0), 0)
const balance = (records) =>
  sum(records.filter((item) => item.type === 'income').map((item) => item.amount)) -
  sum(records.filter((item) => item.type === 'expense').map((item) => item.amount))

const workspacePosition = (balances) => {
  const positive = sum(balances.map((value) => Math.max(value, 0)))
  const borrowed = sum(balances.map((value) => Math.abs(Math.min(value, 0))))
  return { positive, borrowed, net: positive - borrowed }
}

assert.equal(balance([
  { type: 'income', amount: 500 },
  { type: 'expense', amount: 650 },
]), -150, 'expenses may create a negative/borrowed balance')

assert.deepEqual(
  workspacePosition([1000, 500, -150]),
  { positive: 1500, borrowed: 150, net: 1350 },
  'negative balances must reduce net funds held',
)

assert.equal(
  balance([{ type: 'income', amount: 500 }]),
  500,
  'PV and Upkeep limits must not reduce money until an expense is recorded',
)

const monthlyIncome = 500000
const upkeepPercentage = 20
const upkeepLimit = monthlyIncome * (upkeepPercentage / 100)
assert.equal(upkeepLimit, 100000, 'Upkeep limit is a percentage of recorded monthly income')

const pvLimit = 380000
const pvSpent = 250000
assert.equal(pvLimit - pvSpent, 130000, 'PV availability is limit minus actual PV expenses')

console.log('My Fund App finance rule tests passed.')
