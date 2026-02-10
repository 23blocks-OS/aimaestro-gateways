/**
 * WhatsApp Login Script
 *
 * Standalone script to link this gateway as a WhatsApp Web device.
 * Displays a QR code in the terminal — scan it with WhatsApp
 * (Settings → Linked Devices → Link a Device).
 *
 * Usage: npm run login
 */

import {
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import { mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import pino from 'pino';
import dotenv from 'dotenv';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
dotenv.config({ path: resolve(__dirname_local, '..', '.env') });

const stateDir = process.env.STATE_DIR || resolve(process.env.HOME || '/tmp', '.whatsapp-gateway');
const authDir = resolve(stateDir, 'credentials', 'default');

if (!existsSync(authDir)) {
  mkdirSync(authDir, { recursive: true });
}

console.log('=== WhatsApp Gateway — Device Login ===');
console.log(`Auth directory: ${authDir}`);
console.log('');

const logger = pino({ level: 'silent' });
const { state, saveCreds } = await useMultiFileAuthState(authDir);
const { version } = await fetchLatestBaileysVersion();

console.log(`Baileys version: ${version.join('.')}`);
console.log('Waiting for QR code...\n');

const sock = makeWASocket({
  auth: {
    creds: state.creds,
    keys: makeCacheableSignalKeyStore(state.keys, logger as any),
  },
  version,
  logger: logger as any,
  printQRInTerminal: false,
  browser: ['AImaestro-WhatsApp', 'Gateway', '0.1.0'],
  syncFullHistory: false,
  markOnlineOnConnect: false,
});

let qrAttempts = 0;
const MAX_QR_ATTEMPTS = 5;

sock.ev.on('creds.update', saveCreds);

sock.ev.on('connection.update', (update) => {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    qrAttempts++;
    if (qrAttempts > MAX_QR_ATTEMPTS) {
      console.error(`\nFailed after ${MAX_QR_ATTEMPTS} QR attempts. Try again.`);
      process.exit(1);
    }

    // Dynamic import for qrcode-terminal (CommonJS module)
    const qrcode = require('qrcode-terminal');
    console.log(`\n--- QR Code (attempt ${qrAttempts}/${MAX_QR_ATTEMPTS}) ---`);
    console.log('Scan with WhatsApp → Settings → Linked Devices → Link a Device\n');
    qrcode.generate(qr, { small: true });
  }

  if (connection === 'open') {
    const selfJid = sock.user?.id || 'unknown';
    console.log('\n=== Connected! ===');
    console.log(`Logged in as: ${selfJid}`);
    console.log('Credentials saved. You can now start the gateway with: npm start');
    console.log('');

    // Give Baileys a moment to persist credentials, then exit
    setTimeout(() => {
      sock.end(undefined);
      process.exit(0);
    }, 2000);
  }

  if (connection === 'close') {
    const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;

    if (statusCode === DisconnectReason.loggedOut) {
      console.error('\nLogged out. Credentials cleared. Run login again.');
      process.exit(1);
    }

    // Other disconnects during login — just exit
    if (statusCode !== undefined) {
      console.error(`\nDisconnected (code: ${statusCode}). Try login again.`);
      process.exit(1);
    }
  }
});

// Timeout after 3 minutes
setTimeout(() => {
  console.error('\nLogin timed out after 3 minutes. Try again.');
  sock.end(undefined);
  process.exit(1);
}, 180_000);
