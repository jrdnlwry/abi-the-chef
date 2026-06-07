'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 32 * 1024;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 5;
const attempts = new Map();

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function cleanHeader(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function cleanValue(value, maxLength = 4000) {
  return String(value || '').trim().slice(0, maxLength);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateSubmission(input) {
  const data = {
    name: cleanValue(input.name, 120),
    email: cleanValue(input.email, 254),
    phone: cleanValue(input.phone, 60),
    eventDate: cleanValue(input['event-date'], 20),
    guests: cleanValue(input.guests, 10),
    location: cleanValue(input.location, 160),
    occasion: cleanValue(input.occasion, 100),
    method: cleanValue(input.method, 100),
    dietary: cleanValue(input.dietary),
    message: cleanValue(input.message),
    website: cleanValue(input.website, 200)
  };

  if (data.website) return { spam: true };
  if (!data.name || !isEmail(data.email) || !/^\d{4}-\d{2}-\d{2}$/.test(data.eventDate)) return null;

  const guestCount = Number(data.guests);
  if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 10000 || !data.message) return null;
  data.guests = String(guestCount);
  return data;
}

function formatMessage(data) {
  const fields = [
    ['Name', data.name],
    ['Email', data.email],
    ['Phone', data.phone],
    ['Event date', data.eventDate],
    ['Number of guests', data.guests],
    ['Location / city', data.location],
    ['Occasion type', data.occasion],
    ['Preferred consultation method', data.method],
    ['Dietary restrictions or preferences', data.dietary],
    ['Message / vision for the dinner', data.message]
  ];

  return fields.map(([label, value]) => `${label}:\r\n${value || 'Not provided'}`).join('\r\n\r\n');
}

function encodeHeader(value) {
  return `=?UTF-8?B?${Buffer.from(cleanHeader(value), 'utf8').toString('base64')}?=`;
}

function createResponseReader(socket) {
  let buffer = '';
  let pending;

  const processBuffer = () => {
    if (!pending) return;
    const lines = buffer.split('\r\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      pending.lines.push(line);
      if (/^\d{3} /.test(line)) {
        const current = pending;
        pending = null;
        current.resolve({ code: Number(line.slice(0, 3)), message: current.lines.join('\n') });
        return;
      }
    }
  };

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    processBuffer();
  });
  socket.on('error', (error) => {
    if (!pending) return;
    const current = pending;
    pending = null;
    current.reject(error);
  });

  return () => new Promise((resolve, reject) => {
    if (pending) {
      reject(new Error('SMTP response already pending'));
      return;
    }
    pending = { lines: [], resolve, reject };
    processBuffer();
  });
}

async function sendEmail(data) {
  const host = env('SMTP_HOST');
  const port = Number(env('SMTP_PORT', '465'));
  const user = env('SMTP_USER');
  const password = env('SMTP_PASS');
  const from = env('SMTP_FROM', user);
  const recipient = env('CONTACT_TO', 'hello@abithechef.com');

  if (!host || !port || !user || !password || !isEmail(from) || !isEmail(recipient)) {
    throw new Error('Email delivery is not configured');
  }

  const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
  const readResponse = createResponseReader(socket);
  const timeout = setTimeout(() => socket.destroy(new Error('SMTP connection timed out')), 15000);

  const expect = async (allowed) => {
    const response = await readResponse();
    if (!allowed.includes(response.code)) throw new Error(`SMTP error ${response.code}: ${response.message}`);
    return response;
  };
  const command = async (value, allowed = [250]) => {
    socket.write(`${value}\r\n`);
    return expect(allowed);
  };

  try {
    await new Promise((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });
    await expect([220]);
    await command(`EHLO ${env('SMTP_HELO', 'abithechef.com')}`);
    await command('AUTH LOGIN', [334]);
    await command(Buffer.from(user).toString('base64'), [334]);
    await command(Buffer.from(password).toString('base64'), [235]);
    await command(`MAIL FROM:<${from}>`);
    await command(`RCPT TO:<${recipient}>`, [250, 251]);
    await command('DATA', [354]);

    const subject = `Dining consultation request from ${cleanHeader(data.name)}`;
    const message = [
      `From: Abi The Chef Website <${from}>`,
      `To: ${recipient}`,
      `Reply-To: ${cleanHeader(data.email)}`,
      `Subject: ${encodeHeader(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      formatMessage(data).replace(/^\./gm, '..')
    ].join('\r\n');

    socket.write(`${message}\r\n.\r\n`);
    await expect([250]);
    await command('QUIT', [221]);
  } finally {
    clearTimeout(timeout);
    socket.end();
  }
}

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

function isRateLimited(address) {
  const now = Date.now();
  const recent = (attempts.get(address) || []).filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
  recent.push(now);
  attempts.set(address, recent);
  return recent.length > RATE_LIMIT;
}

async function handleContact(request, response) {
  const address = request.socket.remoteAddress || 'unknown';
  if (isRateLimited(address)) return json(response, 429, { error: 'Too many requests. Please try again in a few minutes.' });

  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) return json(response, 413, { error: 'Request is too large.' });
  }

  let input;
  try {
    input = JSON.parse(body);
  } catch {
    return json(response, 400, { error: 'Invalid request.' });
  }

  const data = validateSubmission(input);
  if (data && data.spam) return json(response, 200, { ok: true });
  if (!data) return json(response, 400, { error: 'Please check the required fields and try again.' });

  try {
    await sendEmail(data);
    return json(response, 200, { ok: true });
  } catch (error) {
    console.error('Contact email failed:', error.message);
    return json(response, 500, { error: 'Your request could not be sent right now. Please try again later.' });
  }
}

function serveFile(request, response) {
  const requestPath = request.url === '/' ? '/index.html' : new URL(request.url, 'http://localhost').pathname;
  const filePath = path.resolve(ROOT, `.${decodeURIComponent(requestPath)}`);
  if (!filePath.startsWith(`${ROOT}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

const server = http.createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/api/contact') {
    handleContact(request, response);
    return;
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    serveFile(request, response);
    return;
  }
  response.writeHead(405, { Allow: 'GET, HEAD, POST' }).end('Method not allowed');
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Abi The Chef is running at http://localhost:${PORT}`));
}

module.exports = { formatMessage, sendEmail, server, validateSubmission };
