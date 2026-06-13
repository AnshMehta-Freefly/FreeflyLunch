#!/usr/bin/env node
/**
 * Freefly Lunch — zero-dependency group lunch-ordering server.
 * Serves the static front-end and a small JSON API with file persistence.
 * Usage: node server.js [port]   (default 8126)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data', 'sessions');
const PORT = parseInt(process.argv[2], 10) || 8126;
const HOST = '0.0.0.0';
const MAX_BODY = 100 * 1024; // 100KB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no ambiguous chars
const ID_RE = /^[a-z0-9]{1,12}$/;

// ---------- helpers ----------

function newSessionId() {
  let id = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return id;
}

function sessionPath(id) {
  return path.join(DATA_DIR, id + '.json');
}

function loadSession(id) {
  if (!ID_RE.test(id)) return null;
  const file = sessionPath(id);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveSession(session) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = sessionPath(session.id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2));
  fs.renameSync(tmp, file);
}

function publicOrder(o) {
  const { token, ...rest } = o;
  return rest;
}

function publicSession(s) {
  const { organizerToken, ...rest } = s;
  return { ...rest, orders: s.orders.map(publicOrder) };
}

function defaultTitle() {
  const d = new Date();
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  const month = d.toLocaleDateString('en-US', { month: 'short' });
  return `Lunch — ${weekday} ${month} ${d.getDate()}`;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return; // keep draining so we can still send a response
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw Object.assign(new Error('Body must be a JSON object'), { statusCode: 400 });
  }
}

// Throws {statusCode:400} with a friendly message on bad input.
function bad(message) {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

function validateName(name, label) {
  if (typeof name !== 'string') bad(`${label} is required`);
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 40) {
    bad(`${label} must be between 1 and 40 characters`);
  }
  return trimmed;
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
    bad('Items must be a list of 1 to 20 entries');
  }
  return items.map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      bad(`Item ${i + 1} must be an object`);
    }
    if (typeof item.description !== 'string' || !item.description.trim()) {
      bad(`Item ${i + 1} needs a description`);
    }
    const description = item.description.trim();
    if (description.length > 80) bad(`Item ${i + 1} description is too long (max 80 characters)`);

    let amount = item.amount;
    if (amount === undefined || amount === null || amount === '') {
      amount = null;
    } else {
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1000) {
        bad(`Item ${i + 1} amount must be a number between 0 and 1000`);
      }
      amount = Math.round(amount * 100) / 100;
    }

    let note = item.note;
    if (note === undefined || note === null) note = '';
    if (typeof note !== 'string') bad(`Item ${i + 1} note must be text`);
    note = note.trim();
    if (note.length > 120) bad(`Item ${i + 1} note is too long (max 120 characters)`);

    // Whether this item is part of the lunchbox (vs. charged separately).
    // Decided by the client from the menu; stored so the splitter can group boxes.
    const box = item.box === true;

    return { description, amount, note, box };
  });
}

// Order-level note (e.g. "no onions in the butter chicken, extra spicy goat curry").
function validateOrderNote(note) {
  if (note === undefined || note === null) return '';
  if (typeof note !== 'string') bad('Order note must be text');
  const trimmed = note.trim();
  if (trimmed.length > 280) bad('Order note is too long (max 280 characters)');
  return trimmed;
}

// ---------- API handlers ----------

async function handleApi(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean); // e.g. ['api','sessions','abc123','orders']

  if (req.method === 'GET' && pathname === '/api/health') {
    // lanBase lets the UI build shareable links even when the organizer is on localhost
    const lan = lanAddress();
    return sendJson(res, 200, { ok: true, app: 'freefly-lunch', lanBase: lan ? `http://${lan}:${PORT}` : null });
  }

  // POST /api/sessions
  if (req.method === 'POST' && pathname === '/api/sessions') {
    const body = await readJsonBody(req);
    const organizer = validateName(body.organizer, 'Organizer name');
    let title = defaultTitle();
    if (body.title !== undefined && body.title !== null && String(body.title).trim()) {
      title = String(body.title).trim().slice(0, 80);
    }
    const session = {
      id: newSessionId(),
      title,
      organizer,
      status: 'open',
      createdAt: Date.now(),
      organizerToken: crypto.randomUUID(),
      orders: [],
    };
    saveSession(session);
    return sendJson(res, 201, { session: publicSession(session), organizerToken: session.organizerToken });
  }

  // Routes under /api/sessions/<id>...
  if (parts[0] === 'api' && parts[1] === 'sessions' && parts.length >= 3) {
    const id = parts[2];
    const session = ID_RE.test(id) ? loadSession(id) : null;
    if (!session) return sendJson(res, 404, { error: 'Session not found' });

    const token = req.headers['x-auth-token'] || '';
    const isOrganizer = token === session.organizerToken;

    // GET /api/sessions/<id>
    if (req.method === 'GET' && parts.length === 3) {
      return sendJson(res, 200, { session: publicSession(session) });
    }

    // PUT /api/sessions/<id>/status
    if (req.method === 'PUT' && parts.length === 4 && parts[3] === 'status') {
      if (!isOrganizer) return sendJson(res, 401, { error: 'Not allowed' });
      const body = await readJsonBody(req);
      if (body.status !== 'open' && body.status !== 'closed') {
        bad('Status must be "open" or "closed"');
      }
      session.status = body.status;
      saveSession(session);
      return sendJson(res, 200, { session: publicSession(session) });
    }

    // POST /api/sessions/<id>/orders
    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'orders') {
      if (session.status === 'closed') {
        return sendJson(res, 409, { error: 'Ordering is closed for this session' });
      }
      const body = await readJsonBody(req);
      const now = Date.now();
      const order = {
        id: crypto.randomUUID(),
        name: validateName(body.name, 'Name'),
        items: validateItems(body.items),
        note: validateOrderNote(body.note),
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      };
      session.orders.push(order);
      saveSession(session);
      return sendJson(res, 201, { order: publicOrder(order), token: order.token });
    }

    // PUT/DELETE /api/sessions/<id>/orders/<orderId>
    if (parts.length === 5 && parts[3] === 'orders') {
      const order = session.orders.find((o) => o.id === parts[4]);
      if (!order) return sendJson(res, 404, { error: 'Order not found' });
      if (!isOrganizer && token !== order.token) {
        return sendJson(res, 401, { error: 'Not allowed' });
      }
      // Order owners can only change things while the session is open.
      if (session.status === 'closed' && !isOrganizer) {
        return sendJson(res, 409, { error: 'Ordering is closed for this session' });
      }

      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        if (body.name !== undefined) order.name = validateName(body.name, 'Name');
        if (body.items !== undefined) order.items = validateItems(body.items);
        if (body.note !== undefined) order.note = validateOrderNote(body.note);
        order.updatedAt = Date.now();
        saveSession(session);
        return sendJson(res, 200, { order: publicOrder(order) });
      }
      if (req.method === 'DELETE') {
        session.orders = session.orders.filter((o) => o.id !== order.id);
        saveSession(session);
        return sendJson(res, 200, { ok: true });
      }
    }
  }

  return sendJson(res, 404, { error: 'Not found' });
}

// ---------- static files ----------

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';

  const resolved = path.resolve(ROOT, '.' + rel);
  // Path traversal guard: resolved path must stay inside ROOT,
  // and the data/ directory (session files contain secret tokens) is off limits.
  const dataRoot = path.join(ROOT, 'data');
  if (
    (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) ||
    resolved === dataRoot ||
    resolved.startsWith(dataRoot + path.sep)
  ) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  const ext = path.extname(resolved).toLowerCase();
  if (!MIME[ext] || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  res.writeHead(200, { 'Content-Type': MIME[ext] });
  fs.createReadStream(resolved).pipe(res);
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Auth-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return sendJson(res, 400, { error: 'Bad request' });
  }

  try {
    // Short link: /o/<sessionId> → order page
    const shortMatch = pathname.match(/^\/o\/([a-z0-9]{1,12})$/);
    if (shortMatch && req.method === 'GET') {
      res.writeHead(302, { Location: `/order.html?s=${shortMatch[1]}` });
      return res.end();
    }

    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, pathname);
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, pathname);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    if (err && err.statusCode && err.statusCode < 500) {
      return sendJson(res, err.statusCode, { error: err.message });
    }
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.url}`, err);
    return sendJson(res, 500, { error: 'Internal error' });
  }
});

function lanAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

// Turn the common startup failures into a clear, actionable message instead
// of an unhandled 'error' event that dumps a stack trace and crashes.
server.on('error', (err) => {
  console.error('');
  if (err.code === 'EADDRINUSE') {
    console.error(`  ✖ Port ${PORT} is already in use.`);
    console.error(`    Freefly Lunch may already be running, or another app has the port.`);
    console.error(`    Start it on a different port:  node server.js ${PORT + 1}`);
    console.error(`    Or find what's using it:       (Linux/macOS) lsof -i :${PORT}`);
  } else if (err.code === 'EACCES') {
    console.error(`  ✖ Not allowed to bind port ${PORT}.`);
    console.error(`    Ports below 1024 need elevated privileges — pick a higher one:  node server.js 8126`);
  } else {
    console.error(`  ✖ Could not start the server: ${err.message}`);
  }
  console.error('');
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const lan = lanAddress();
  console.log('');
  console.log('  🍱 Freefly Lunch is running!');
  console.log('  ----------------------------------------');
  console.log(`  Local:   http://localhost:${PORT}`);
  if (lan) console.log(`  Network: http://${lan}:${PORT}`);
  console.log('  ----------------------------------------');
  console.log('  Share the Network URL in the lunch channel.');
  console.log('');
});
