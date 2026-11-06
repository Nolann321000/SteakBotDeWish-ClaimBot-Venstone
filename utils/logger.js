const { promises: fsPromises } = require('node:fs');
const path = require('node:path');

function getTimestamp() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `[${h}:${m}:${s}]`;
}

function getShortDate() {
    const now = new Date();
    return `[${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}]`;
}

async function writeLog(logDirectory, fileName, message) {
    try {
        await fsPromises.mkdir(logDirectory, { recursive: true });
        const filePath = path.join(logDirectory, fileName);
        await fsPromises.appendFile(filePath, message + '\n', 'utf8');
    } catch (err) {
        console.error(`${getTimestamp()} Erreur lors de l'écriture du log ${fileName} :`, err.message);
    }
}

module.exports = { getTimestamp, getShortDate, writeLog };