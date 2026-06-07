'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const tls = require('node:tls');
const fs = require('node:fs');
const { formatMessage, sendEmail, validateSubmission } = require('./server');

const validInput = {
  name: 'Jordan Guest',
  email: 'jordan@example.com',
  phone: '919-555-0100',
  'event-date': '2026-08-15',
  guests: '8',
  location: 'Raleigh',
  occasion: 'Anniversary',
  method: 'Email',
  dietary: 'No shellfish',
  message: 'We would love a seasonal tasting menu.',
  website: ''
};


test('serves weekly meal prep from the home page occasions section', () => {
  const home = fs.readFileSync('index.html', 'utf8');
  const mealPrep = fs.readFileSync('weekly-meal-prep.html', 'utf8');

  assert.match(home, /href="weekly-meal-prep\.html">Weekly meal prep/);
  assert.doesNotMatch(home, />Holiday gatherings</);
  assert.match(mealPrep, /<title>Meal Prep Raleigh NC \| Personal Chef Meal Prep &amp; Prepared Meals<\/title>/);
  assert.match(mealPrep, /Fresh weekly meal prep in Raleigh, NC from a personal chef/);
  assert.match(mealPrep, /Request a Weekly Meal Prep Menu/);
});

test('validates and normalizes a complete consultation request', () => {
  const result = validateSubmission(validInput);
  assert.equal(result.name, 'Jordan Guest');
  assert.equal(result.guests, '8');
  assert.equal(result.eventDate, '2026-08-15');
});

test('rejects malformed required fields', () => {
  assert.equal(validateSubmission({ ...validInput, email: 'invalid' }), null);
  assert.equal(validateSubmission({ ...validInput, guests: '0' }), null);
  assert.equal(validateSubmission({ ...validInput, message: '' }), null);
});

test('silently accepts honeypot submissions as spam', () => {
  assert.deepEqual(validateSubmission({ ...validInput, website: 'https://spam.example' }), { spam: true });
});

test('formats every consultation field in the email body', () => {
  const message = formatMessage(validateSubmission(validInput));
  assert.match(message, /Name:\r\nJordan Guest/);
  assert.match(message, /Dietary restrictions or preferences:\r\nNo shellfish/);
  assert.match(message, /Message \/ vision for the dinner:\r\nWe would love/);
});


test('sends a validated request through authenticated TLS SMTP', async () => {
  const originalConnect = tls.connect;
  const originalEnvironment = { ...process.env };
  const transcript = [];

  class FakeSocket extends EventEmitter {
    setEncoding() {}

    write(value) {
      transcript.push(value);
      const line = value.replace(/\r\n$/, '');
      let response = '250 OK\r\n';
      if (line.startsWith('EHLO ')) response = '250-mock.example\r\n250 AUTH LOGIN\r\n';
      else if (line === 'AUTH LOGIN' || line === Buffer.from('smtp-user').toString('base64')) response = '334 Continue\r\n';
      else if (line === Buffer.from('smtp-password').toString('base64')) response = '235 Authenticated\r\n';
      else if (line === 'DATA') response = '354 Send message\r\n';
      else if (line === 'QUIT') response = '221 Bye\r\n';
      setImmediate(() => this.emit('data', response));
      return true;
    }

    end() {}
    destroy(error) { if (error) this.emit('error', error); }
  }

  try {
    process.env.SMTP_HOST = 'mock.example';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_USER = 'smtp-user';
    process.env.SMTP_PASS = 'smtp-password';
    process.env.SMTP_FROM = 'website@example.com';
    process.env.CONTACT_TO = 'hello@abithechef.com';
    tls.connect = () => {
      const socket = new FakeSocket();
      setImmediate(() => {
        socket.emit('secureConnect');
        socket.emit('data', '220 mock.example ready\r\n');
      });
      return socket;
    };

    await sendEmail(validateSubmission(validInput));
    const sent = transcript.join('');
    assert.match(sent, /MAIL FROM:<website@example\.com>/);
    assert.match(sent, /RCPT TO:<hello@abithechef\.com>/);
    assert.match(sent, /Reply-To: jordan@example\.com/);
    assert.match(sent, /Jordan Guest/);
  } finally {
    tls.connect = originalConnect;
    process.env = originalEnvironment;
  }
});
