/**
 * Baileys Session Management
 *
 * Creates and manages the WhatsApp Web connection via Baileys.
 * Handles auth state persistence, reconnection, and lifecycle events.
 */

import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import { mkdirSync, existsSync, copyFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import pino from 'pino';
import type { GatewayConfig } from './types.js';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'logged_out';

interface SessionState {
  sock: WASocket | null;
  status: ConnectionStatus;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  selfJid: string | null;
}

const state: SessionState = {
  sock: null,
  status: 'disconnected',
  reconnectAttempt: 0,
  reconnectTimer: null,
  selfJid: null,
};

const MAX_RECONNECT_ATTEMPTS = 50;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

/**
 * Get the auth directory for Baileys credentials.
 */
function getAuthDir(config: GatewayConfig): string {
  const dir = resolve(config.whatsapp.stateDir, 'credentials', 'default');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Backup creds.json before saving to prevent corruption.
 */
function backupCreds(authDir: string): void {
  const credsPath = resolve(authDir, 'creds.json');
  const backupPath = resolve(authDir, 'creds.json.bak');
  try {
    if (existsSync(credsPath)) {
      const raw = readFileSync(credsPath, 'utf-8');
      JSON.parse(raw); // Validate JSON before backing up
      copyFileSync(credsPath, backupPath);
    }
  } catch {
    // Keep existing backup if creds.json is corrupted
  }
}

/**
 * Create the Baileys socket and connect.
 */
export async function createSession(
  config: GatewayConfig,
  opts: {
    printQr?: boolean;
    onQr?: (qr: string) => void;
    onMessage?: (msg: any) => void;
  } = {}
): Promise<WASocket> {
  const authDir = getAuthDir(config);

  const logger = pino({ level: config.debug ? 'info' : 'silent' });

  const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, logger as any),
    },
    version,
    logger: logger as any,
    printQRInTerminal: false,
    browser: ['AImaestro-WhatsApp', 'Gateway', '0.1.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  // Save credentials on update
  sock.ev.on('creds.update', async () => {
    backupCreds(authDir);
    await saveCreds();
  });

  // Handle connection state changes
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      state.status = 'connecting';
      opts.onQr?.(qr);
      if (opts.printQr) {
        const qrcode = require('qrcode-terminal');
        console.log('\nScan this QR code with WhatsApp (Settings → Linked Devices):\n');
        qrcode.generate(qr, { small: true });
      }
    }

    if (connection === 'open') {
      state.status = 'connected';
      state.reconnectAttempt = 0;
      state.selfJid = sock.user?.id || null;
      console.log(`[SESSION] Connected as ${state.selfJid}`);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        state.status = 'logged_out';
        state.sock = null;
        console.error('[SESSION] Logged out. Run "npm run login" to re-link.');
        return;
      }

      state.status = 'disconnected';
      console.warn(`[SESSION] Disconnected (code: ${statusCode}). Reconnecting...`);
      scheduleReconnect(config, opts);
    }
  });

  // Listen for incoming messages
  if (opts.onMessage) {
    sock.ev.on('messages.upsert', (upsert) => {
      if (upsert.type !== 'notify') return;
      for (const msg of upsert.messages) {
        opts.onMessage!(msg);
      }
    });
  }

  // Handle WebSocket errors
  if (sock.ws && typeof (sock.ws as any).on === 'function') {
    (sock.ws as any).on('error', (err: Error) => {
      console.error('[SESSION] WebSocket error:', err.message);
    });
  }

  state.sock = sock;
  return sock;
}

/**
 * Schedule a reconnection attempt with exponential backoff.
 */
function scheduleReconnect(
  config: GatewayConfig,
  opts: { onMessage?: (msg: any) => void }
): void {
  if (state.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`[SESSION] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
    return;
  }

  const delay = Math.min(
    RECONNECT_BASE_MS * Math.pow(2, state.reconnectAttempt),
    RECONNECT_MAX_MS
  );

  state.reconnectAttempt++;
  console.log(`[SESSION] Reconnecting in ${delay}ms (attempt ${state.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`);

  state.reconnectTimer = setTimeout(async () => {
    try {
      await createSession(config, opts);
    } catch (err) {
      console.error('[SESSION] Reconnect failed:', (err as Error).message);
      scheduleReconnect(config, opts);
    }
  }, delay);
}

/**
 * Get the current Baileys socket (or null if not connected).
 */
export function getSocket(): WASocket | null {
  return state.sock;
}

/**
 * Get the current connection status.
 */
export function getStatus(): ConnectionStatus {
  return state.status;
}

/**
 * Get the self JID (our own WhatsApp number).
 */
export function getSelfJid(): string | null {
  return state.selfJid;
}

/**
 * Gracefully close the session.
 */
export async function closeSession(): Promise<void> {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.sock) {
    state.sock.end(undefined);
    state.sock = null;
  }
  state.status = 'disconnected';
}
