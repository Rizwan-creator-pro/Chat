// ============================================
// WhatsApp Client Engine using Baileys
// ============================================
// Direct WebSocket connection to WhatsApp multi-device protocol
// No Puppeteer, No Chrome, Zero headless browser detection!

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const logger = require('./logger');
const config = require('./config');

const AUTH_DIR = path.join(__dirname, '..', 'baileys_auth');

let sock = null;
let isConnected = false;
let currentQR = null;
let currentPairingCode = null;
let clientInfo = null;

async function createClient() {
    logger.info('Initializing Baileys WhatsApp client (Direct WebSocket Engine)...');

    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(`Using WhatsApp Web protocol v${version.join('.')} (latest: ${isLatest})`);

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }), // Suppress internal debug spam
        printQRInTerminal: false,
        browser: ['Chrome (Windows)', 'Desktop', '128.0.0'],
        syncFullHistory: false,
        generateHighQualityLinkPreview: false
    });

    // Save credentials whenever updated
    sock.ev.on('creds.update', saveCreds);

    // Connection lifecycle
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            logger.info('========================================');
            logger.info('  SCAN THIS QR CODE (OR USE PAIRING CODE)');
            logger.info('========================================');
            qrcodeTerminal.generate(qr, { small: true });
            logger.info('Scan in WhatsApp > Linked Devices > Link a Device');
            logger.info('Or open http://localhost:3000 to use Pairing Code / Web QR');
        }

        if (connection === 'close') {
            isConnected = false;
            currentQR = null;
            const statusCode = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode
                : null;
            
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            logger.warn(`Connection closed due to: ${lastDisconnect?.error?.message || 'Unknown'}, code: ${statusCode}`);

            if (shouldReconnect) {
                logger.info('Reconnecting to WhatsApp in 5 seconds...');
                setTimeout(() => {
                    createClient().catch(err => logger.error(`Reconnect error: ${err.message}`));
                }, 5000);
            } else {
                logger.error('Device logged out. Clearing auth credentials...');
                try {
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                } catch (e) {}
                logger.info('Please re-link your device.');
                setTimeout(() => {
                    createClient().catch(err => logger.error(`Restart error: ${err.message}`));
                }, 2000);
            }
        } else if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            currentPairingCode = null;

            const user = sock.user || {};
            clientInfo = {
                phone: user.id ? user.id.split(':')[0] : 'Connected',
                name: user.name || 'WhatsApp Business/User'
            };

            logger.info('========================================');
            logger.info(`✅ Baileys WhatsApp CONNECTED successfully!`);
            logger.info(`📱 Phone: ${clientInfo.phone}`);
            logger.info('========================================');
        }
    });

    // Listen for incoming messages (for logging)
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                if (!msg.key.fromMe && msg.message) {
                    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                    if (text) {
                        logger.info(`📩 Incoming msg from ${msg.key.remoteJid}: ${text.substring(0, 40)}`);
                    }
                }
            }
        }
    });

    return sock;
}

/**
 * Request an 8-character Pairing Code for a phone number
 * (Alternative to scanning QR code)
 */
async function requestPairingCode(phoneNumber) {
    if (!sock) {
        throw new Error('Socket not initialized');
    }
    if (isConnected) {
        throw new Error('Device is already linked and connected!');
    }

    // Clean phone number: digits only
    let cleanPhone = phoneNumber.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) {
        cleanPhone = '92' + cleanPhone.substring(1);
    }

    logger.info(`Requesting Pairing Code for phone: ${cleanPhone}...`);
    const code = await sock.requestPairingCode(cleanPhone);
    currentPairingCode = code;
    logger.info(`🔑 Pairing Code received: ${code}`);
    return code;
}

/**
 * Send message with human-like typing simulation
 */
async function sendMessageSafe(jid, text, simulateTyping = true) {
    if (!sock || !isConnected) {
        throw new Error('WhatsApp is not connected.');
    }

    // Simulate typing
    if (simulateTyping) {
        try {
            const settings = config.getSettings();
            if (settings.enableTyping !== false) {
                await sock.sendPresenceUpdate('composing', jid);
                const typingMs = Math.round((settings.typingSeconds || 2) * 1000);
                await new Promise(r => setTimeout(r, typingMs));
                await sock.sendPresenceUpdate('paused', jid);
                await new Promise(r => setTimeout(r, 300));
            }
        } catch (e) {
            logger.warn(`Typing presence simulation failed: ${e.message}`);
        }
    }

    // Send the message
    const result = await sock.sendMessage(jid, { text });
    return result;
}

/**
 * Get QR code as a base64 Data URL for web dashboard
 */
async function getQRDataURL() {
    if (!currentQR) return null;
    try {
        return await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
    } catch (err) {
        return null;
    }
}

/**
 * Check readiness
 */
function isReady() {
    return isConnected;
}

/**
 * Get connection status
 */
async function getStatus() {
    return {
        status: isConnected ? 'connected' : 'disconnected',
        ready: isConnected,
        needsAuth: !isConnected,
        hasQR: currentQR !== null,
        pairingCode: currentPairingCode,
        phone: clientInfo ? clientInfo.phone : null,
        name: clientInfo ? clientInfo.name : null,
        engine: 'Baileys Multi-Device (No Puppeteer)'
    };
}

module.exports = {
    createClient,
    requestPairingCode,
    sendMessageSafe,
    getQRDataURL,
    isReady,
    getStatus
};
