const fsPromises = require('node:fs').promises;
const { atomicWriteJson } = require('./fileUtils');

// File d'attente simple : chaîne les opérations de lecture+écriture les unes après les autres
// pour éviter que deux appels concurrents ne se marchent dessus
// (lecture de l'ancien historique avant que l'écriture précédente soit terminée).
let writeQueue = Promise.resolve();

function enqueueWrite(task) {
    const result = writeQueue.then(task, task);
    writeQueue = result.catch(() => {}); // évite qu'une erreur bloque la file pour les tâches suivantes
    return result;
}

/** Retourne le tableau d'entrées d'un joueur (uniquement si c'est une vraie clé du fichier, pas un champ hérité). */
function ownEntries(history, key) {
    return Object.hasOwn(history, key) && Array.isArray(history[key]) ? history[key] : null;
}

/**
 * Lit l'historique complet des unclaims.
 * - Fichier absent  -> {} (premier lancement).
 * - Fichier illisible / JSON invalide -> le fichier est mis de côté (.corrupt-<date>) et une erreur est levée.
 *   (Avant : on retournait {} silencieusement, et la prochaine écriture ÉCRASAIT tout l'historique.)
 * @returns {Promise<Object>} { [owner_lowercase]: [ ...entries ] }
 */
async function readHistory(historyFilePath) {
    let raw;
    try {
        raw = await fsPromises.readFile(historyFilePath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        throw err;
    }

    if (!raw.trim()) return {};

    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error("le contenu n'est pas un objet JSON");
        }
        return parsed;
    } catch (err) {
        const backupPath = `${historyFilePath}.corrupt-${Date.now()}`;
        await fsPromises.copyFile(historyFilePath, backupPath).catch(() => {});
        throw new Error(`Historique des unclaims corrompu (${err.message}). Copie de sauvegarde : ${backupPath}`);
    }
}

async function writeHistory(historyFilePath, history) {
    await atomicWriteJson(historyFilePath, history, 4);
}

async function deleteHistoryEntry(historyFilePath, owner, index) {
    return enqueueWrite(async () => {
        const history = await readHistory(historyFilePath);
        const key = String(owner).toLowerCase();
        const entries = ownEntries(history, key);
        if (!entries || !Number.isInteger(index) || index < 1 || index > entries.length) return null;

        const [entry] = entries.splice(index - 1, 1);
        if (entries.length === 0) delete history[key];
        await writeHistory(historyFilePath, history);

        return { entry };
    });
}

function buildEntry(owner, markers, usernameChange = false) {
    const safeMarkers = Array.isArray(markers) ? markers : [];
    return {
        owner,
        date: new Date().toISOString(),
        claimsLost: safeMarkers.length,
        usernameChange,
        markers: safeMarkers.map(m => {
            const first = m?.points?.[0];
            const second = m?.points?.[1];
            const hasBounds = [first?.x, first?.z, second?.x, second?.z].every(Number.isFinite);

            return {
                x: hasBounds ? Math.round((first.x + second.x) / 2) : null,
                z: hasBounds ? Math.round((first.z + second.z) / 2) : null,
                area: hasBounds ? (Math.abs(first.x - second.x) + 1) * (Math.abs(first.z - second.z) + 1) : null,
                label: m?.label != null ? String(m.label).slice(0, 200) : null,
            };
        }),
    };
}

function pushEntry(history, entry) {
    const key = entry.owner.toLowerCase();
    let list = ownEntries(history, key);
    if (!list) {
        list = [];
        // defineProperty : sûr même si key vaut "__proto__" ou "constructor"
        Object.defineProperty(history, key, { value: list, enumerable: true, writable: true, configurable: true });
    }
    list.push(entry);
}

/**
 * Enregistre plusieurs unclaims en UNE seule lecture/écriture (beaucoup plus léger qu'une écriture par joueur).
 * @param {Array<{owner: string, markers: Array}>} items
 */
async function writeUnclaimEntries(historyFilePath, items) {
    if (!items.length) return;
    return enqueueWrite(async () => {
        const history = await readHistory(historyFilePath);
        for (const { owner, markers, usernameChange } of items) {
            pushEntry(history, buildEntry(owner, markers, usernameChange));
        }
        await writeHistory(historyFilePath, history);
    });
}

/** Retourne les entrées d'un joueur (tableau, éventuellement vide). */
async function getPlayerEntries(historyFilePath, owner) {
    const history = await readHistory(historyFilePath);
    return ownEntries(history, String(owner).toLowerCase()) ?? [];
}

/**
 * Retourne tous les owners ayant au moins une entrée.
 * @returns {Promise<string[]>} Liste des noms exacts (casse originale)
 */
async function getAllOwners(historyFilePath) {
    const history = await readHistory(historyFilePath);
    return Object.values(history)
        .map(entries => Array.isArray(entries) ? entries.at(-1)?.owner : null)
        .filter(Boolean);
}

/**
 * Retourne toutes les entrées (tous joueurs confondus) correspondant
 * à une date donnée (comparaison sur jour/mois/année local).
 * @returns {Promise<Object[]>}
 */
async function getEntriesByDate(historyFilePath, targetDate) {
    const history = await readHistory(historyFilePath);

    const targetY = targetDate.getFullYear();
    const targetM = targetDate.getMonth();
    const targetD = targetDate.getDate();

    const results = [];

    for (const entries of Object.values(history)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
            const d = new Date(entry?.date);
            if (
                d.getFullYear() === targetY &&
                d.getMonth() === targetM &&
                d.getDate() === targetD
            ) {
                results.push(entry);
            }
        }
    }

    return results;
}

/**
 * Retourne la liste des dates (dd/mm/yyyy) pour lesquelles il existe
 * au moins un unclaim, triée de la plus récente à la plus ancienne.
 * @returns {Promise<string[]>}
 */
async function getAllDates(historyFilePath) {
    const history = await readHistory(historyFilePath);
    const datesSet = new Set();

    for (const entries of Object.values(history)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
            const d = new Date(entry?.date);
            if (Number.isNaN(d.getTime())) continue;
            const dd = String(d.getDate()).padStart(2, '0');
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const yyyy = d.getFullYear();
            datesSet.add(`${dd}/${mm}/${yyyy}`);
        }
    }

    return Array.from(datesSet).sort((a, b) => {
        const [da, ma, ya] = a.split('/').map(Number);
        const [db, mb, yb] = b.split('/').map(Number);
        return new Date(yb, mb - 1, db) - new Date(ya, ma - 1, da);
    });
}

module.exports = {
    readHistory,
    writeHistory,
    deleteHistoryEntry,
    writeUnclaimEntries,
    getPlayerEntries,
    getAllOwners,
    getEntriesByDate,
    getAllDates,
};
