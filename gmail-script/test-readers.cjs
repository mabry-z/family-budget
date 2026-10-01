// Checks the alert readers in cadence-alerts.gs against real email wording.
// Run: node gmail-script/test-readers.cjs
const assert = require('assert');
const { CHASE, STAR, readAlert, tidyMerchant } = require('./cadence-alerts.gs');

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

const starPlain = `Transaction Notification

This email is to notify you that your transaction of $4.54 on your MILITARY STAR account ending in 2026 has exceeded your chosen transaction limit.

Transaction Details:
Transaction Date:\t01 OCT 2026 at 04:14
Transaction Description:\tOTHER PURCHASES

If you did not make this purchase, please contact the Exchange Credit Program call center at 1-877-891-7827 (additional numbers) immediately.`;

const starHtml = `<html><body><h1>Transaction Notification</h1>
<p>This email is to notify you that your transaction of $1,204.10 on your <b>MILITARY STAR</b> account ending in 2026 has exceeded your chosen transaction limit.</p>
<table><tr><td>Transaction Date:</td><td>9 DEC 2026 at 23:05</td></tr>
<tr><td>Transaction Description:</td><td>OTHER PURCHASES</td></tr></table></body></html>`;

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
  ['Star, plain text, no store', readAlert(STAR, starPlain), {
    card: 'Star Card', account: 'Military Star', last4: '2026', cardholder: null,
    merchantRaw: 'OTHER PURCHASES', merchant: null, amountCents: 454,
    occurredAt: null, occurredLocal: '2026-10-01 04:14', // US Central; made an exact time in Apps Script
  }],
  ['Star, HTML, big amount, one-digit day', readAlert(STAR, starHtml), {
    card: 'Star Card', account: 'Military Star', last4: '2026', cardholder: null,
    merchantRaw: 'OTHER PURCHASES', merchant: null, amountCents: 120410,
    occurredAt: null, occurredLocal: '2026-12-09 23:05',
  }],
  ['Star reader ignores Chase alerts', readAlert(STAR, chasePlain('MABRY,LYDIA')), null],
  ['Star statement isn’t a purchase', readAlert(STAR, 'Your MILITARY STAR statement is ready. Payment due $35.00.'), null],
];

let failed = 0;
for (const [name, got, want] of cases) {
  try { assert.deepStrictEqual(got, want); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n  got:  ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
process.exit(failed ? 1 : 0);
