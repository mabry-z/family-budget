// Checks the alert readers in cadence-alerts.gs against real email wording.
// Run: node gmail-script/test-readers.cjs
const assert = require('assert');
const { CHASE, readAlert, tidyMerchant } = require('./cadence-alerts.gs');

const chasePlain = name => `Transaction alert

${name} made a $20.00 transaction

Account\tChase Sapphire Reserve Visa (...1234)
Date\tSep 30, 2026 at 4:50 AM ET
Merchant\tRAMST GOLF COURSE
Amount\t$20.00

You are receiving this alert because your transaction was more than the $1.00 level you set.`;

const chaseHtml = `<html><body><table><tr><td><span>Transaction alert</span></td></tr>
<tr><td><h1>MABRY,ZACHARY made a $1,234.56 transaction</h1></td></tr>
<tr><td>Account</td><td>Chase Sapphire Reserve Visa (...9876)</td></tr>
<tr><td>Date</td><td>Jan 5, 2027 at 12:07 AM ET</td></tr>
<tr><td>Merchant</td><td>SQ *BLUE BOTTLE COFFEE #0421</td></tr>
<tr><td>Amount</td><td>$1,234.56</td></tr></table></body></html>`;

const flatOneLine = 'Transaction alert MABRY, ZACHARY made a $7.49 transaction Account Chase Sapphire Reserve Visa (...1234) Date Mar 8, 2026 at 3:15 PM ET Merchant TRADER JOE&#39;S #552 Amount $7.49';

const cases = [
  ['Lydia, plain text', readAlert(CHASE, chasePlain('MABRY,LYDIA')), {
    card: 'Chase', account: 'Chase Sapphire Reserve Visa', last4: '1234', cardholder: 'Lydia',
    merchantRaw: 'RAMST GOLF COURSE', merchant: 'Ramst Golf Course', amountCents: 2000,
    occurredAt: '2026-09-30T08:50:00.000Z', // 4:50 AM EDT
  }],
  ['Zachary, plain text', readAlert(CHASE, chasePlain('MABRY,ZACHARY')).cardholder, 'Zachary'],
  ['Zachary, HTML, big amount, winter, midnight', readAlert(CHASE, chaseHtml), {
    card: 'Chase', account: 'Chase Sapphire Reserve Visa', last4: '9876', cardholder: 'Zachary',
    merchantRaw: 'SQ *BLUE BOTTLE COFFEE #0421', merchant: 'Blue Bottle Coffee', amountCents: 123456,
    occurredAt: '2027-01-05T05:07:00.000Z', // 12:07 AM EST
  }],
  ['one line, comma+space in name, DST start day', readAlert(CHASE, flatOneLine), {
    card: 'Chase', account: 'Chase Sapphire Reserve Visa', last4: '1234', cardholder: 'Zachary',
    merchantRaw: "TRADER JOE'S #552", merchant: "Trader Joe's", amountCents: 749,
    occurredAt: '2026-03-08T19:15:00.000Z', // 3:15 PM EDT (DST began 2 AM that day)
  }],
  ['web address store name', tidyMerchant('WWW.TKSCABLE.COM'), 'Tkscable'],
  ['amazon style', tidyMerchant('AMAZON.COM*AB12CD'), 'Amazon'],
  ['not a purchase alert', readAlert(CHASE, 'Your statement is ready. Minimum payment due $35.00 on Oct 12.'), null],
  ['alert missing merchant → flagged', readAlert(CHASE, 'MABRY,LYDIA made a $5.00 transaction\nDate\tSep 30, 2026 at 1:00 PM ET'), { unreadable: true, card: 'Chase' }],
];

let failed = 0;
for (const [name, got, want] of cases) {
  try { assert.deepStrictEqual(got, want); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n  got:  ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
process.exit(failed ? 1 : 0);
