// Cadence card alerts — a Google Apps Script that runs in the owner's Google
// account (script.google.com). Every minute it looks in Gmail for new card
// purchase alert emails, reads the store, amount and time out of each one,
// and sends them to Cadence's Supabase, where they wait in "N new from …"
// until someone reviews them in the app.
//
// It never sees any bank login — only the alert emails the cards already send
// (Chase and Military Star so far).
// It calls one database function, import_card_alert (migration 008), which
// only accepts purchases carrying the household's import key. The key is the
// one secret, so it isn't in this file: it's kept in Project Settings →
// Script properties as CADENCE_IMPORT_KEY. (The address and publishable key
// below are already public in js/config.js.)
//
// One-time setup (full steps in docs/card-imports-plan.md): paste this file
// in, add the CADENCE_IMPORT_KEY property, choose `setup` in the function menu
// and press Run (Google asks to allow Gmail access). setup() starts the
// every-minute check and only imports alerts that arrive after that moment,
// so old emails are never pulled in.
//
// The reading part (everything above "Gmail and sending") is plain
// JavaScript with no Google calls, so it's tested on its own — see
// gmail-script/test-readers.cjs (needs Node).

// ---------- Readers: one per card company ----------

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Chase "Transaction alert" emails:
//   MABRY,LYDIA made a $20.00 transaction
//   Account   Chase Sapphire Reserve Visa (...1234)
//   Date      Sep 30, 2026 at 4:50 AM ET
//   Merchant  RAMST GOLF COURSE
//   Amount    $20.00
const CHASE = {
  name: 'Chase',
  card: 'Chase', // must match a value in CARDS (js/config.js)
  search: 'from:chase.com',
  looksLikeAlert: text => /\bmade an? \$[\d,]+\.\d{2} transaction\b/i.test(text),
  read(text) {
    const cells = toCells(text);
    const flat = cells.join(' ');
    const head = flat.match(/([A-Z][A-Z'. -]*?)\s*,\s*([A-Z][A-Z'. -]*?)\s+made an? \$([\d,]+\.\d{2}) transaction/i);
    const amountText = fieldAfter(cells, 'Amount') || (flat.match(/\bAmount\s+(\$[\d,]+\.\d{2})/i) || [])[1];
    const merchant = fieldAfter(cells, 'Merchant') || (flat.match(/\bMerchant\s+(.+?)\s+Amount\b/i) || [])[1];
    const account = fieldAfter(cells, 'Account') || (flat.match(/\bAccount\s+(.+?)\s+Date\b/i) || [])[1];
    const date = flat.match(/\b([A-Z][a-z]{2})[a-z]* (\d{1,2}), (\d{4}) at (\d{1,2}):(\d{2}) ?([AP]M) ET\b/i);

    const amountCents = toCents(amountText) ?? (head ? toCents(head[3]) : null);
    if (amountCents == null || !merchant) return null;

    const last4 = account && (account.match(/\(\s*\.*\s*(\d{4})\s*\)/) || [])[1];
    return {
      card: this.card,
      account: account ? account.replace(/\s*\(.*$/, '').trim() : null,
      last4: last4 || null,
      cardholder: head ? titleCase(head[2]) : null, // first name, e.g. "Lydia"
      merchantRaw: merchant.trim(),
      merchant: tidyMerchant(merchant),
      amountCents,
      occurredAt: date ? easternToIso(date) : null,
    };
  },
};

// Military Star "Transaction Notification" emails. No store and no name —
// the store is typed in when the purchase is reviewed:
//   This email is to notify you that your transaction of $4.54 on your
//   MILITARY STAR account ending in 2026 has exceeded your chosen
//   transaction limit.
//   Transaction Date:         01 OCT 2026 at 04:14
//   Transaction Description:  OTHER PURCHASES
// The time has no zone written on it but is US Central (the Exchange is in
// Dallas): a purchase at 11:14 Central European time (09:14 UTC) said
// "04:14". It's turned into an exact moment in the Gmail part below
// (occurredLocal → occurred_at), because Apps Script knows the
// daylight-saving dates.
const STAR = {
  name: 'Star',
  card: 'Star Card',
  timeZone: 'America/Chicago',
  search: 'subject:"Transaction Notification" "MILITARY STAR"',
  looksLikeAlert: text => /\btransaction of \$[\d,]+\.\d{2} on your MILITARY STAR\b/i.test(toCells(text).join(' ')),
  read(text) {
    const cells = toCells(text);
    const flat = cells.join(' ');
    const amount = flat.match(/\btransaction of (\$[\d,]+\.\d{2})/i);
    const last4 = flat.match(/\baccount ending in (\d{4})\b/i);
    const date = flat.match(/\b(\d{1,2}) ([A-Z]{3})[A-Z]* (\d{4}) at (\d{1,2}):(\d{2})\b/i);
    const description = fieldAfter(cells, 'Transaction Description')
      || (flat.match(/\bTransaction Description:?\s+(.+?)(?:\s+If you did not\b|$)/i) || [])[1];

    const amountCents = amount ? toCents(amount[1]) : null;
    if (amountCents == null) return null;

    const month = date ? MONTHS[date[2].toLowerCase()] : undefined;
    const pad = n => String(n).padStart(2, '0');
    return {
      card: this.card,
      account: 'Military Star',
      last4: last4 ? last4[1] : null,
      cardholder: null,
      merchantRaw: description ? description.trim() : null, // "OTHER PURCHASES", not a store
      merchant: null,
      amountCents,
      occurredAt: null,
      occurredLocal: month === undefined ? null
        : `${date[3]}-${pad(month + 1)}-${pad(date[1])} ${pad(date[4])}:${date[5]}`,
    };
  },
};

const READERS = [CHASE, STAR];

// Text of an email as a list of "cells": one per line or table cell, blanks
// dropped. Works on plain-text bodies and on HTML bodies with tags removed.
function toCells(text) {
  let t = String(text || '');
  if (/<[a-z][\s\S]*>/i.test(t)) {
    t = t.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|tr|td|th|li|h\d|table)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
  }
  t = t.replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&#39;|&#x27;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  return t.split(/[\n\r\t]+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// The value next to a label: "Merchant: X" or "Merchant X" in one cell, or
// "Merchant" in one cell and "X" in the next.
function fieldAfter(cells, label) {
  const re = new RegExp('^' + label + '\\s*:?\\s*(.*)$', 'i');
  for (let i = 0; i < cells.length; i++) {
    const m = cells[i].match(re);
    if (!m) continue;
    if (m[1]) return m[1].trim();
    if (i + 1 < cells.length) return cells[i + 1];
  }
  return null;
}

function toCents(text) {
  const m = String(text || '').match(/\$\s*([\d,]+)\.(\d{2})/);
  return m ? Number(m[1].replace(/,/g, '')) * 100 + Number(m[2]) : null;
}

function titleCase(s) {
  return String(s).toLowerCase().trim().replace(/\s+/g, ' ')
    .replace(/(^|[\s\-/&.])([a-z])/g, (all, sep, ch) => sep + ch.toUpperCase());
}

// "SQ *BLUE BOTTLE #123" → "Blue Bottle", "WWW.TKSCABLE.COM" → "Tkscable".
// The untouched name is kept too.
function tidyMerchant(raw) {
  let s = String(raw).trim()
    .replace(/^(SQ|TST|SP|PY|PP|DD|IC|CKE|PAYPAL|GOOGLE)\s*\*\s*/i, '')
    .replace(/^WWW\./i, '')
    .replace(/\.(COM|NET|ORG|CO|US)\b.*$/i, '')
    .replace(/\s*#\s*\d+.*$/, '')
    .replace(/\s+\d{3,}\s*$/, '')
    .replace(/\s{2,}/g, ' ');
  s = titleCase(s || raw);
  return s.length > 100 ? s.slice(0, 100) : s;
}

// US Eastern time in the email → an exact moment. Daylight time runs from the
// second Sunday of March to the first Sunday of November, 2 AM local.
function easternToIso(m) {
  const month = MONTHS[m[1].toLowerCase()];
  const day = Number(m[2]);
  const year = Number(m[3]);
  let hour = Number(m[4]) % 12;
  if (m[6].toUpperCase() === 'PM') hour += 12;
  const minute = Number(m[5]);
  const nthSunday = (mon, n) => {
    const first = new Date(Date.UTC(year, mon, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + 7 * (n - 1);
  };
  const localMinutes = Date.UTC(year, month, day, hour, minute) / 60000;
  const dstStart = Date.UTC(year, 2, nthSunday(2, 2), 2) / 60000;
  const dstEnd = Date.UTC(year, 10, nthSunday(10, 1), 2) / 60000;
  const offsetHours = localMinutes >= dstStart && localMinutes < dstEnd ? 4 : 5;
  return new Date((localMinutes + offsetHours * 60) * 60000).toISOString();
}

// One email → what gets sent to Cadence, or null for emails that aren't
// purchase alerts (statements, offers, payment reminders).
function readAlert(reader, text) {
  if (!reader.looksLikeAlert(text)) return null;
  return reader.read(text) || { unreadable: true, card: reader.card };
}

// ---------- Gmail and sending (Google Apps Script only) ----------

const SUPABASE_URL = 'https://ffjaqdtdoqkvlrcfqnrx.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_lwdziY_FYlVNYoTh-Z2oTw_3SoDNDNr';
const IMPORT_URL = SUPABASE_URL + '/rest/v1/rpc/import_card_alert';
const LOOKBACK = 'newer_than:3d';
const SEEN_KEY = 'SEEN_MESSAGES'; // message id → when handled, kept 5 days
// Alerts are only moved once Cadence confirms it has them. Read ones go to
// the Trash; ones that look like purchases but can't be read go here.
// Anything else from the card company (statements, offers) is left alone.
const NEEDS_REVIEW = 'Needs review';

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('CADENCE_IMPORT_KEY')) {
    throw new Error('Add CADENCE_IMPORT_KEY in Project Settings → Script properties first.');
  }
  props.setProperty('START_AFTER', String(Date.now()));
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'checkAlerts')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkAlerts').timeBased().everyMinutes(1).create();
  Logger.log('Set up. New card alerts will be sent to Cadence every minute.');
}

function checkAlerts() {
  const props = PropertiesService.getScriptProperties();
  const importKey = props.getProperty('CADENCE_IMPORT_KEY');
  const startAfter = Number(props.getProperty('START_AFTER') || Date.now());
  const seen = JSON.parse(props.getProperty(SEEN_KEY) || '{}');
  const now = Date.now();

  for (const reader of READERS) {
    for (const thread of GmailApp.search(reader.search + ' ' + LOOKBACK, 0, 50)) {
      for (const message of thread.getMessages()) {
        const id = message.getId();
        if (seen[id] || message.getDate().getTime() < startAfter) continue;

        let item = readAlert(reader, message.getPlainBody());
        if (item && item.unreadable) item = readAlert(reader, message.getBody()) || item;
        if (!item) { seen[id] = now; continue; } // not a purchase alert
        if (item.occurredLocal) item.occurredAt = localToIso(item.occurredLocal, reader.timeZone, message.getDate());

        const res = UrlFetchApp.fetch(IMPORT_URL, {
          method: 'post',
          contentType: 'application/json',
          headers: { apikey: PUBLISHABLE_KEY },
          payload: JSON.stringify({ p_key: importKey, p_alert: toAlertRow(item, message) }),
          muteHttpExceptions: true,
        });
        const code = res.getResponseCode();
        if (code >= 200 && code < 300) {
          seen[id] = now;
          if (item.unreadable) {
            // Out of the inbox and into a folder, for a person to check.
            thread.addLabel(GmailApp.getUserLabelByName(NEEDS_REVIEW) || GmailApp.createLabel(NEEDS_REVIEW));
            thread.moveToArchive();
          } else {
            message.moveToTrash(); // Cadence has it; Gmail deletes it for good after 30 days.
          }
        } else {
          Logger.log('Cadence said ' + code + ' for "' + message.getSubject() + '": ' + res.getContentText());
          // Not marked as seen, so it's tried again next minute.
        }
      }
    }
  }

  const keepAfter = now - 5 * 24 * 3600 * 1000;
  for (const id of Object.keys(seen)) if (seen[id] < keepAfter) delete seen[id];
  props.setProperty(SEEN_KEY, JSON.stringify(seen));
}

// "2026-10-01 04:14" in the card company's time zone → an exact moment. A
// time after the email arrived can't be right, so the arrival time is used
// instead.
function localToIso(local, timeZone, received) {
  try {
    const d = Utilities.parseDate(local, timeZone, 'yyyy-MM-dd HH:mm');
    if (d.getTime() <= received.getTime() + 5 * 60 * 1000) return d.toISOString();
  } catch (e) {
    Logger.log('Couldn’t read the time "' + local + '": ' + e);
  }
  return received.toISOString();
}

// What import_card_alert expects (see migration 008).
function toAlertRow(item, message) {
  return {
    message_id: message.getId(),
    card: item.card,
    account: item.account,
    last4: item.last4,
    cardholder: item.cardholder,
    merchant: item.merchant,
    merchant_raw: item.merchantRaw,
    amount_cents: item.amountCents,
    occurred_at: item.occurredAt,
    received_at: message.getDate().toISOString(),
    subject: message.getSubject(),
    unreadable: !!item.unreadable,
  };
}

// Lets the tests load the readers outside Google.
if (typeof module !== 'undefined') {
  module.exports = { CHASE, STAR, READERS, readAlert, toCells, tidyMerchant, easternToIso, toAlertRow };
}
