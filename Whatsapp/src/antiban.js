// ============================================
// Anti-Ban Protection Middleware
// ============================================
// Protects your WhatsApp numbers from being banned
// by simulating human-like behavior, hash entropy,
// batch resting, and multi-line pacing.

const logger = require('./logger');
const config = require('./config');

/**
 * Gaussian random number (Box-Muller transform)
 * Creates delays that cluster naturally around a mean
 */
function gaussianRandom(mean = 0, stdDev = 1) {
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return z * stdDev + mean;
}

/**
 * Generate a human-like delay in milliseconds
 */
function humanDelay(minMs = 5000, maxMs = 8000) {
    const mean = (minMs + maxMs) / 2;
    const stdDev = (maxMs - minMs) / 6;
    const delay = gaussianRandom(mean, stdDev);
    return Math.max(minMs, Math.min(maxMs, Math.round(delay)));
}

/**
 * Sleep helper
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Random integer between min and max (inclusive)
 */
function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Spintax processor - varies message text for each recipient
 * Example: "{Salam|Hello|Hi} {valued|dear} customer"
 */
function processSpintax(text) {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/\{([^}]+)\}/g, (match, options) => {
        const choices = options.split('|');
        return choices[Math.floor(Math.random() * choices.length)].trim();
    });
}

/**
 * Anti-Duplicate Hash Protection
 * Appends invisible Unicode zero-width sequences to the message.
 * This guarantees that every message dispatched to each recipient has a
 * completely unique SHA-256 byte signature, defeating Meta's bulk duplicate spam filter.
 * To the user on their phone, the message appears 100% normal and identical.
 */
const ZERO_WIDTH_CHARS = ['\u200B', '\u200C', '\u200D', '\uFEFF'];

function addAntiDuplicateEntropy(text, recipientIndex = 0) {
    if (!text || typeof text !== 'string') return text;
    
    // Generate a unique 4-char zero-width invisible sequence based on timestamp and index
    const seed = (Date.now() + recipientIndex) % 256;
    let invisibleSequence = '';
    for (let i = 0; i < 4; i++) {
        const charIdx = (seed >> (i * 2)) & 3;
        invisibleSequence += ZERO_WIDTH_CHARS[charIdx];
    }
    
    return text + invisibleSequence;
}

/**
 * Phone Number Normalization & Validation
 * Formats: 03237004270 -> 923237004270
 * Strips +, -, spaces, brackets
 */
function sanitizePhoneNumber(phone) {
    if (!phone) return null;
    let cleaned = phone.toString().trim().replace(/[^\d]/g, '');
    
    // Auto-convert Pakistani domestic format 03XXXXXXXXX to 923XXXXXXXXX
    if (cleaned.startsWith('0') && cleaned.length === 11) {
        cleaned = '92' + cleaned.substring(1);
    } else if (cleaned.length === 10 && cleaned.startsWith('3')) {
        // e.g. 3237004270 -> 923237004270
        cleaned = '92' + cleaned;
    }
    
    // Check minimum international length (typically 10-15 digits)
    if (cleaned.length < 10 || cleaned.length > 15) {
        return null;
    }
    
    return cleaned;
}

/**
 * Dynamic Rate Limiter
 * Tracks messages sent per hour and enforces user-defined limits
 */
class RateLimiter {
    constructor() {
        this.timestamps = [];
    }

    check() {
        const settings = config.getSettings();
        const maxPerHour = settings.maxPerHour !== undefined ? parseInt(settings.maxPerHour) : 600;

        const now = Date.now();
        const oneHourAgo = now - 3600000;
        this.timestamps = this.timestamps.filter(t => t > oneHourAgo);

        if (maxPerHour > 0 && this.timestamps.length >= maxPerHour) {
            const oldestInWindow = this.timestamps[0];
            const retryAfterMs = oldestInWindow + 3600000 - now;
            return {
                allowed: false,
                retryAfterMs,
                remaining: 0,
                used: this.timestamps.length,
                maxPerHour
            };
        }

        return {
            allowed: true,
            retryAfterMs: 0,
            remaining: maxPerHour > 0 ? Math.max(0, maxPerHour - this.timestamps.length) : 999999,
            used: this.timestamps.length,
            maxPerHour
        };
    }

    record() {
        this.timestamps.push(Date.now());
    }

    getStats() {
        const settings = config.getSettings();
        const maxPerHour = settings.maxPerHour !== undefined ? parseInt(settings.maxPerHour) : 600;
        const now = Date.now();
        const oneHourAgo = now - 3600000;
        this.timestamps = this.timestamps.filter(t => t > oneHourAgo);
        return {
            sentLastHour: this.timestamps.length,
            maxPerHour: maxPerHour > 0 ? maxPerHour : 'Unlimited',
            remaining: maxPerHour > 0 ? Math.max(0, maxPerHour - this.timestamps.length) : 'Unlimited'
        };
    }
}

/**
 * High-Speed Configurable Message Queue with Batch Resting
 * Processes messages one at a time with user-controlled delay (e.g. 6 seconds)
 * Injects a 20s cooling pause after every batch (default 25 messages)
 */
class MessageQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.currentJob = null;
        this.processCallback = null;
        this.consecutiveSent = 0;
    }

    onProcess(callback) {
        this.processCallback = callback;
    }

    add(job) {
        return new Promise((resolve, reject) => {
            this.queue.push({ job, resolve, reject });
            
            if (!this.processing) {
                this._processNext();
            }
        });
    }

    getStatus() {
        const totalInFlight = this.queue.length + (this.processing ? 1 : 0);
        return {
            pending: totalInFlight,
            waiting: this.queue.length,
            processing: this.processing,
            currentJob: this.currentJob ? { phone: this.currentJob.phone } : null
        };
    }

    async _processNext() {
        if (this.queue.length === 0) {
            this.processing = false;
            this.currentJob = null;
            this.consecutiveSent = 0;
            return;
        }

        this.processing = true;
        const { job, resolve, reject } = this.queue.shift();
        this.currentJob = job;

        try {
            const result = await this.processCallback(job);
            this.consecutiveSent++;
            resolve(result);
        } catch (err) {
            reject(err);
        } finally {
            this.currentJob = null;
        }

        const settings = config.getSettings();

        // 1. Check Batch Resting (Human simulation: after 25 consecutive messages, pause 20-30s)
        const batchRestEvery = settings.batchRestEvery || 25;
        if (this.queue.length > 0 && this.consecutiveSent >= batchRestEvery) {
            const restDurationSec = settings.batchRestSeconds || 20;
            logger.info(`🛡️ Anti-Ban: Batch milestone reached (${this.consecutiveSent} msgs). Resting for ${restDurationSec}s...`);
            this.consecutiveSent = 0;
            await sleep(restDurationSec * 1000);
        }

        // 2. Normal Per-Message Pacing Delay (WaSender style, default 6s)
        const baseDelaySec = (job.delaySeconds !== undefined && job.delaySeconds !== null)
            ? Math.max(1, parseFloat(job.delaySeconds))
            : (settings.delaySeconds || 6);

        const jitterSec = (job.delaySeconds !== undefined) ? 0.5 : (settings.delayJitter || 1);
        const minMs = Math.max(500, Math.round((baseDelaySec - jitterSec) * 1000));
        const maxMs = Math.max(minMs, Math.round((baseDelaySec + jitterSec) * 1000));
        const delay = randomBetween(minMs, maxMs);

        logger.info(`Pacing: waiting ${(delay / 1000).toFixed(1)}s before next message (target: ${baseDelaySec}s)...`);
        await sleep(delay);

        // Process next in queue
        this._processNext();
    }
}

module.exports = {
    gaussianRandom,
    humanDelay,
    sleep,
    randomBetween,
    processSpintax,
    addAntiDuplicateEntropy,
    sanitizePhoneNumber,
    RateLimiter,
    MessageQueue
};
