const { promises: fsPromises } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Écriture atomique : on écrit dans un fichier temporaire puis on le renomme.
 * Si le bot est tué (crash, SIGKILL, coupure) en plein milieu, le fichier d'origine reste intact
 * au lieu de se retrouver tronqué/corrompu.
 */
async function atomicWriteFile(filePath, content) {
    const dir = path.dirname(filePath);
    const tmpPath = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
        await fsPromises.writeFile(tmpPath, content, 'utf8');
        await fsPromises.rename(tmpPath, filePath);
    } catch (err) {
        await fsPromises.unlink(tmpPath).catch(() => {});
        throw err;
    }
}

async function atomicWriteJson(filePath, data, indent = 0) {
    return atomicWriteFile(filePath, JSON.stringify(data, null, indent || undefined));
}

module.exports = { atomicWriteFile, atomicWriteJson };
