// ============================================
// Message History Store (In-Memory + File)
// ============================================
// Keeps a record of all sent messages for debugging

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const HISTORY_FILE = path.join(__dirname, '..', 'logs', 'message_history.json');
let history = [];

/**
 * Load history from file on startup
 */
function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
            history = JSON.parse(data);
            logger.info(`Loaded ${history.length} messages from history`);
        }
    } catch (err) {
        logger.warn(`Could not load history: ${err.message}`);
        history = [];
    }
}

/**
 * Save a message record
 */
function addRecord(record) {
    history.push({
        id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
        ...record,
        timestamp: new Date().toISOString()
    });

    // Keep only last 1000 records in memory
    if (history.length > 1000) {
        history = history.slice(-1000);
    }

    // Save to file (async, don't block)
    saveToFile();
}

/**
 * Get recent messages
 */
function getRecent(limit = 50) {
    return history.slice(-limit).reverse();
}

/**
 * Get message by ID
 */
function getById(id) {
    return history.find(h => h.id === id);
}

/**
 * Get stats
 */
function getStats() {
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    const oneDayAgo = now - 86400000;

    const sentLastHour = history.filter(h => 
        new Date(h.timestamp).getTime() > oneHourAgo && h.status === 'sent'
    ).length;

    const sentLastDay = history.filter(h => 
        new Date(h.timestamp).getTime() > oneDayAgo && h.status === 'sent'
    ).length;

    const failedLastDay = history.filter(h => 
        new Date(h.timestamp).getTime() > oneDayAgo && h.status === 'failed'
    ).length;

    return {
        totalRecorded: history.length,
        sentLastHour,
        sentLast24Hours: sentLastDay,
        failedLast24Hours: failedLastDay
    };
}

function saveToFile() {
    try {
        const dir = path.dirname(HISTORY_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    } catch (err) {
        logger.warn(`Could not save history: ${err.message}`);
    }
}

module.exports = {
    loadHistory,
    addRecord,
    getRecent,
    getById,
    getStats
};
