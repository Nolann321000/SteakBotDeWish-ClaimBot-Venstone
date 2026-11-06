const axios = require('axios');
const { promises: fsPromises, constants: fsConstants } = require('node:fs');
const path = require('node:path');
const { writeUnclaimEntries } = require('./unclaimHistory');
const { getTimestamp, getShortDate, writeLog } = require('./logger');
const { sendWithRetry, sanitizeText, chunkLines } = require('./discordUtils');
const { getProxyAgent } = require('./torManager');
const { atomicWriteFile, atomicWriteJson } = require('./fileUtils');

const cleanHTML = (text) => text.replace(/<[^>]+>/g, '').trim();
const formatPlayerName = (name) => String(name ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 32);

const MAX_MAP_BYTES = 50 * 1024 * 1024;   // la map pèse ~1,3 Mo : au-delà de 50 Mo, la réponse est anormale
const MAX_INDIVIDUAL_ALERTS = 10;         // au-delà, un seul message récapitulatif est envoyé (évite le spam de MP)
const SUSPICIOUS_MIN_LOST = 10;           // seuil minimum de joueurs disparus pour déclencher le garde-fou
const SUSPICIOUS_RATIO = 0.3;             // ... ET plus de 30 % des propriétaires connus
const SUSPICIOUS_MAX_CYCLES = 3;          // après 3 cycles consécutifs identiques, on considère que c'est réel
const SILENT_FLAG = 1 << 12;              // MessageFlags.SuppressNotifications (équivalent de @silent)

async function axiosGetWithRetry(url, options, retries = 3, delayMs = 5000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await axios.get(url, options);
        } catch (err) {
            if (attempt === retries) throw err;

            console.warn(`${getTimestamp()} ⚠️ Tentative ${attempt}/${retries} échouée pour la map (${err.message}). Nouvel essai dans ${delayMs / 1000}s...`);
            await new Promise(res => setTimeout(res, delayMs));
        }
    }
}

function findGriefLayer(data) {
    if (Array.isArray(data)) return data.find(l => l?.id === "griefprevention") ?? null;
    return data?.id === "griefprevention" ? data : null;
}

function parseGriefLayer(data) {
    const layer = findGriefLayer(data);
    const owners = new Map();
    const markersByOwner = new Map();

    if (layer?.markers) {
        for (const m of Object.values(layer.markers)) {
            const match = String(m?.popup || "").match(/Propriétaire\s*:\s*<span[^>]*>(.*?)<\/span>/i);
            if (match) {
                const pName = cleanHTML(match[1]);
                const key = pName.toLowerCase();
                owners.set(key, pName);

                if (!markersByOwner.has(key)) markersByOwner.set(key, []);
                markersByOwner.get(key).push(m);
            }
        }
    }
    return { owners, markersByOwner };
}

function getClaimBoundsKey(marker) {
    const [first, second] = marker?.points ?? [];
    if (![first?.x, first?.z, second?.x, second?.z].every(Number.isFinite)) return null;

    return [
        Math.min(first.x, second.x),
        Math.min(first.z, second.z),
        Math.max(first.x, second.x),
        Math.max(first.z, second.z),
    ].join(':');
}

function detectAccountChanges(lostOwners, oldOwners, oldMarkersByOwner, newOwners, newMarkersByOwner) {
    const changes = new Map();

    for (const owner of lostOwners) {
        const oldMarkers = oldMarkersByOwner.get(owner.toLowerCase()) ?? [];
        const oldBounds = oldMarkers.map(getClaimBoundsKey);
        if (oldBounds.length === 0 || oldBounds.some(bounds => bounds === null)) continue;

        for (const [newOwnerKey, newOwner] of newOwners) {
            if (oldOwners.has(newOwnerKey)) continue;

            const newBounds = new Set((newMarkersByOwner.get(newOwnerKey) ?? []).map(getClaimBoundsKey));
            if (oldBounds.every(bounds => newBounds.has(bounds))) {
                changes.set(owner.toLowerCase(), newOwner);
                break;
            }
        }
    }

    return changes;
}

/** Les données reçues contiennent-elles bien la couche des claims, non vide ? (sinon : page d'erreur, captcha, JSON vide...) */
function isValidMapData(data) {
    const layer = findGriefLayer(data);
    if (!layer?.markers) return false;
    return Object.keys(layer.markers).length > 0;
}

async function checkReminders(client, config, remindersFilePath) {
    const timestamp = getTimestamp();
    try {
        const data = await fsPromises.readFile(remindersFilePath, 'utf8').catch(() => null);
        if (!data) return;

        const reminders = JSON.parse(data);
        if (reminders === null || typeof reminders !== 'object' || Array.isArray(reminders)) return;

        const now = Date.now(), d = new Date(now);
        const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

        const users = (await Promise.all(config.usersNotifiedForUnclaim.map(id =>
            client.users.cache.get(id) || client.users.fetch(id).catch(() => null)
        ))).filter(Boolean);

        const notify = (msg) => {
            console.log(`${timestamp} ${msg}`);
            users.forEach(u => sendWithRetry(u, msg).catch(() => {}));
        };

        let changed = false;

        for (let [pseudo, info] of Object.entries(reminders)) {
            if (typeof info === 'string') {
                info = { date: info, dayAlertSent: false, hourAlertSent: false, tenMinAlertSent: false };
            }
            if (!info || typeof info !== 'object' || typeof info.date !== 'string') continue;

            const safePseudo = sanitizeText(pseudo, 32);
            const targetDate = new Date(info.date);
            if (Number.isNaN(targetDate.getTime())) continue;

            const timeDiff = targetDate.getTime() - now;
            const timeStr = `${String(targetDate.getHours()).padStart(2, '0')}h${String(targetDate.getMinutes()).padStart(2, '0')}`;

            if (info.date.startsWith(todayStr) && !info.dayAlertSent) {
                notify(`📅 Les claims du joueur \`${safePseudo}\` ont prévu de sauter aujourd'hui vers **${timeStr}** !`);
                info.dayAlertSent = changed = true;
            }

            if (timeDiff <= 3600000 && timeDiff > 0 && !info.hourAlertSent) {
                notify(`⏰ Les claims du joueur \`${safePseudo}\` ont prévu de sauter dans moins d'une heure (vers **${timeStr}**) !`);
                info.hourAlertSent = changed = true;
            }

            if (timeDiff <= 600000 && timeDiff > 0 && !info.tenMinAlertSent) {
                notify(`🚨 Les claims du joueur \`${safePseudo}\` vont bientôt sauter !`);
                info.tenMinAlertSent = changed = true;
            }

            reminders[pseudo] = info;
        }

        if (changed) {
            await atomicWriteJson(remindersFilePath, reminders, 4);
        }
    } catch (err) {
        console.error(`${timestamp} Erreur lors de la vérification des rappels :`, err.message);
    }
}

/**
 * Envoie les alertes d'unclaim en MP.
 * Si silentSmall est vrai, les joueurs avec moins de smallThreshold claims sont envoyés en @silent
 * (sans notification), les autres gardent une notification normale.
 */
async function sendUnclaimAlerts(discordUsers, accountChangeDiscordUsers, lostOwners, timestamp, claimCounts, silentSmall, smallThreshold, accountChanges) {
    const recipients = discordUsers.filter(Boolean);
    const accountChangeRecipients = accountChangeDiscordUsers.filter(Boolean);
    const tasks = [];

    const sendTo = (message, silent = false) => {
        const payload = silent ? { content: message, flags: SILENT_FLAG } : message;
        for (const user of recipients) {
            tasks.push(sendWithRetry(user, payload).catch(err =>
                console.error(`${timestamp} Erreur envoi Discord à ${user.id} :`, err.message)
            ));
        }
    };

    const dispatch = (owners, silent, italic = false) => {
        if (owners.length === 0) return;

        if (owners.length <= MAX_INDIVIDUAL_ALERTS) {
            for (const owner of owners) {
                const displayName = italic ? formatPlayerName(owner) : sanitizeText(owner, 32);
                const message = `⚠️ Les claims du joueur \`${displayName}\` ont sauté !`;
                sendTo(italic ? `*${message}*` : message, silent);
            }
        } else {
            // Beaucoup d'unclaims d'un coup : un message récapitulatif au lieu de dizaines de MP (anti rate-limit / anti-spam Discord)
            const lines = [`⚠️ **${owners.length} joueurs** ont vu leurs claims sauter :`, ...owners.map(owner => `• \`${italic ? formatPlayerName(owner) : sanitizeText(owner, 32)}\``)]
                .map(line => italic ? `*${line}*` : line);
            for (const chunk of chunkLines(lines)) sendTo(chunk, silent);
        }
    };

    const sendAccountChange = (message) => {
        for (const user of accountChangeRecipients) {
            tasks.push(sendWithRetry(user, message).catch(err =>
                console.error(`${timestamp} Erreur envoi notification changement de compte à ${user.id} :`, err.message)
            ));
        }
    };

    const regularUnclaimOwners = lostOwners.filter(owner => !accountChanges.has(owner.toLowerCase()));

    if (silentSmall) {
        const isSmall = (owner) => (claimCounts.get(owner) ?? 0) < smallThreshold;
        dispatch(regularUnclaimOwners.filter(o => !isSmall(o)), false);
        dispatch(regularUnclaimOwners.filter(isSmall), true);
    } else {
        dispatch(regularUnclaimOwners, false);
    }

    const accountChangeOwners = lostOwners.filter(owner => accountChanges.has(owner.toLowerCase()));
    dispatch(accountChangeOwners, true, true);

    for (const owner of lostOwners) {
        const newOwner = accountChanges.get(owner.toLowerCase());
        if (!newOwner) continue;

        sendAccountChange(`🔄 Changement de compte détecté : \`${formatPlayerName(owner)}\` » \`${formatPlayerName(newOwner)}\``);
    }

    await Promise.all(tasks);
}

async function doFetchMapData(client, config, logsFolder) {
    const timestamp = getTimestamp();
    console.log(`${timestamp} Synchronisation avec la map dynamique en cours...`);

    try {
        // Tor n'est utilisé que si enableTor === true dans config.json (sinon : connexion directe)
        const agent = getProxyAgent(config);

        const response = await axiosGetWithRetry(
            config.mapMarkersUrl,
            {
                httpAgent: agent,
                httpsAgent: agent,
                timeout: 20000,
                maxContentLength: MAX_MAP_BYTES,
                maxBodyLength: MAX_MAP_BYTES,
                maxRedirects: 3,
                responseType: 'json',
            },
            3,
            5000
        );

        const newData = response.data?.sets || response.data;

        // 1) Validation : on ne touche à rien si la réponse n'est pas une vraie map (HTML d'erreur, captcha, JSON vide...)
        if (!isValidMapData(newData)) {
            console.error(`${getTimestamp()} Réponse de la map invalide (couche "griefprevention" absente ou vide) : synchronisation ignorée, fichiers conservés.`);
            return false;
        }

        const alertsEnabled = config.enableUnclaimAlerts;
        let oldClaimsOwners = new Map();
        let oldMarkersByOwner = new Map();

        if (alertsEnabled) {
            try {
                const oldDataRaw = await fsPromises.readFile(client.mainFilePath, 'utf8');
                const oldParsed = JSON.parse(oldDataRaw);
                ({ owners: oldClaimsOwners, markersByOwner: oldMarkersByOwner } = parseGriefLayer(oldParsed));
            } catch (err) {
                console.warn(`${timestamp} Impossible de lire l'ancienne map (premier lancement ou fichier corrompu). Aucune alerte unclaim pour ce cycle.`);
            }
        }

        // 2) Garde-fou anti "faux unclaim de masse"
        const { owners: newOwners, markersByOwner: newMarkersByOwner } = parseGriefLayer(newData);
        const lostOwners = [];
        for (const [lowercaseOwner, originalOwner] of oldClaimsOwners) {
            if (!newOwners.has(lowercaseOwner)) lostOwners.push(originalOwner);
        }

        const accountChanges = config.checkAccountChange
            ? detectAccountChanges(lostOwners, oldClaimsOwners, oldMarkersByOwner, newOwners, newMarkersByOwner)
            : new Map();

        const suspicious = oldClaimsOwners.size > 0
            && lostOwners.length >= SUSPICIOUS_MIN_LOST
            && lostOwners.length > oldClaimsOwners.size * SUSPICIOUS_RATIO;

        if (suspicious) {
            client.suspiciousFetchCount = (client.suspiciousFetchCount || 0) + 1;
            if (client.suspiciousFetchCount < SUSPICIOUS_MAX_CYCLES) {
                console.warn(`${getTimestamp()} ⚠️ ${lostOwners.length}/${oldClaimsOwners.size} propriétaires disparaissent d'un coup : données jugées suspectes, synchronisation ignorée (${client.suspiciousFetchCount}/${SUSPICIOUS_MAX_CYCLES}).`);
                if (client.suspiciousFetchCount === 1 && client.notifyOwner) {
                    client.notifyOwner(`⚠️ **Données de map suspectes** : ${lostOwners.length}/${oldClaimsOwners.size} propriétaires ont disparu d'un coup. Synchronisation ignorée ; si ça persiste ${SUSPICIOUS_MAX_CYCLES} cycles, les données seront acceptées comme réelles.`);
                }
                return false;
            }
            console.warn(`${getTimestamp()} Les données restent identiques depuis ${SUSPICIOUS_MAX_CYCLES} cycles : acceptées comme réelles.`);
        }
        client.suspiciousFetchCount = 0;

        // 3) Écriture atomique (un crash au mauvais moment ne corrompt plus le fichier)
        await atomicWriteFile(client.mainFilePath, JSON.stringify(newData));
        client.mapCache = newData;

        if (alertsEnabled && lostOwners.length > 0) {
            const logsEnabled = config.enableUnclaimLogs;
            const [discordUsers, accountChangeDiscordUsers] = await Promise.all([
                lostOwners.length > 0
                    ? Promise.all(config.usersNotifiedForUnclaim.map(id => client.users.cache.get(id) || client.users.fetch(id).catch(() => null)))
                    : Promise.resolve([]),
                accountChanges.size > 0
                    ? Promise.all((config.usersNotifiedForAccountChanges ?? []).map(id => client.users.cache.get(id) || client.users.fetch(id).catch(() => null)))
                    : Promise.resolve([]),
            ]);

            for (const originalOwner of lostOwners) {
                console.log(`${timestamp} ⚠️ Les claims du joueur ${sanitizeText(originalOwner, 32)} ont sauté !`);
            }

            // Historique : une seule lecture/écriture pour tous les joueurs. Une erreur ici ne doit pas empêcher les alertes.
            try {
                await writeUnclaimEntries(
                    config.unclaimHistoryFilePath,
                    lostOwners.map(owner => ({
                        owner,
                        markers: oldMarkersByOwner.get(owner.toLowerCase()) || [],
                        usernameChange: accountChanges.has(owner.toLowerCase()),
                    }))
                );
            } catch (err) {
                console.error(`${timestamp} Impossible d'écrire l'historique des unclaims :`, err.message);
            }

            if (logsEnabled) {
                for (const originalOwner of lostOwners) {
                    const logLine = `${getShortDate()} ${timestamp} Les claims du joueur ${sanitizeText(originalOwner, 32)} ont sauté !`;
                    await writeLog(logsFolder, config.unclaimLogsFileName, logLine);
                }
            }

            // Nombre de claims (marqueurs) que le joueur avait avant de disparaître : sert au mode @silent des petits joueurs
            const claimCounts = new Map(
                lostOwners.map(owner => [owner, (oldMarkersByOwner.get(owner.toLowerCase()) || []).length])
            );

            await sendUnclaimAlerts(discordUsers, accountChangeDiscordUsers, lostOwners, timestamp, claimCounts, config.makeSmallUnclaimSilent, config.smallUnclaimThreshold, accountChanges);
        }

        console.log(`${getTimestamp()} Synchronisation avec la map dynamique terminée !`);
        await checkReminders(client, config, config.remindersFilePath);

        return true;
    } catch (err) {
        console.error(`${getTimestamp()} Échec définitif de la synchronisation après plusieurs tentatives :`, err.message);
    }
    return false;
}

/**
 * Synchronise la map. Si une synchronisation est déjà en cours (intervalle + /claimrefresh en même temps...),
 * on réutilise la même promesse au lieu d'en lancer une seconde (qui provoquerait des alertes en double).
 */
function fetchMapData(client, config, logsFolder) {
    if (client.mapFetchInFlight) return client.mapFetchInFlight;
    client.mapFetchInFlight = doFetchMapData(client, config, logsFolder)
        .catch((err) => {
            console.error(`${getTimestamp()} Erreur inattendue pendant la synchronisation :`, err.message);
            return false;
        })
        .finally(() => { client.mapFetchInFlight = null; });
    return client.mapFetchInFlight;
}

const MONTHS_FR = [
    'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
    'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

function getDailyBackupDate(fileName) {
    const match = fileName.match(/^backup_(\d{2})-(\d{2})-(\d{4})\.json$/);
    if (!match) return null;

    return { day: Number(match[1]), month: Number(match[2]), year: Number(match[3]) };
}

async function archivePreviousMonth(backupDir, now) {
    const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const monthName = MONTHS_FR[previousMonth.getMonth()];
    const monthYear = `${monthName}_${previousMonth.getFullYear()}`;
    const archiveDir = path.join(backupDir, `Archives ${monthName[0].toLocaleUpperCase('fr-FR')}${monthName.slice(1)} ${previousMonth.getFullYear()}`);
    const entries = await fsPromises.readdir(backupDir, { withFileTypes: true });
    const lastDay = new Date(previousMonth.getFullYear(), previousMonth.getMonth() + 1, 0).getDate();
    for (const entry of entries) {
        if (!entry.isFile()) continue;

        const date = getDailyBackupDate(entry.name);
        const isPreviousMonthDaily = date?.month === previousMonth.getMonth() + 1 && date.year === previousMonth.getFullYear();
        if (!isPreviousMonthDaily) continue;

        const sourcePath = path.join(backupDir, entry.name);
        if (date.day === lastDay) {
            const monthEndBackup = path.join(backupDir, `backup_fin_${monthYear}.json`);
            try {
                await fsPromises.copyFile(sourcePath, monthEndBackup, fsConstants.COPYFILE_EXCL);
                console.log(`${getTimestamp()} Backup de fin de mois conservée à la racine : backup_fin_${monthYear}.json`);
            } catch (err) {
                if (err.code !== 'EEXIST') throw err;
            }
        }

        const targetPath = path.join(archiveDir, entry.name);

        await fsPromises.mkdir(archiveDir, { recursive: true });
        try {
            await fsPromises.access(targetPath);
            console.warn(`${getTimestamp()} Archive déjà présente, backup conservée à la racine : ${entry.name}`);
        } catch {
            await fsPromises.rename(sourcePath, targetPath);
            console.log(`${getTimestamp()} Backup archivée : ${entry.name} -> ${path.basename(archiveDir)}/${entry.name}`);
        }
    }
}

async function createBackup(client) {
    const timestamp = getTimestamp();
    try {
        console.log(`${timestamp} Démarrage de la backup quotidienne...`);
        await fsPromises.mkdir(client.backupDir, { recursive: true });

        const now = new Date();
        await archivePreviousMonth(client.backupDir, now);

        const dateFileName = `backup_${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}.json`;
        const firstOfMonthFileName = `backup_début_${MONTHS_FR[now.getMonth()]}_${now.getFullYear()}.json`;
        const dateFilePath = path.join(client.backupDir, dateFileName);
        const firstOfMonthFilePath = path.join(client.backupDir, firstOfMonthFileName);

        if (now.getDate() > 1) {
            const firstDayFileName = `backup_01-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}.json`;
            const firstDayFilePath = path.join(client.backupDir, firstDayFileName);
            try {
                await fsPromises.access(firstDayFilePath);
                await fsPromises.access(firstOfMonthFilePath);
            } catch {
                await fsPromises.rename(firstDayFilePath, firstOfMonthFilePath).catch(() => {});
            }
        }

        const backupFilePath = now.getDate() === 1 ? firstOfMonthFilePath : dateFilePath;
        const fileName = path.basename(backupFilePath);

        // Si la backup du jour existe déjà, on ne refait rien
        try {
            await fsPromises.access(backupFilePath);
            console.log(`${getTimestamp()} Backup du jour déjà présente, on skip. (${fileName})`);
            return;
        } catch {
            // Le fichier n'existe pas encore, on continue normalement
        }

        try {
            await fsPromises.access(client.mainFilePath);
        } catch (err) {
            console.warn(`${timestamp} Fichier principal introuvable. Tentative de récupération via fetch...`);
            if (!(await client.fetchMapData())) {
                return console.error(`${timestamp} Échec de la récupération. La backup est annulée.`);
            }
        }

        // Copie atomique : jamais de backup à moitié écrite
        const tmpPath = `${backupFilePath}.tmp`;
        try {
            await fsPromises.copyFile(client.mainFilePath, tmpPath);
            await fsPromises.rename(tmpPath, backupFilePath);
        } catch (err) {
            await fsPromises.unlink(tmpPath).catch(() => {});
            throw err;
        }
        console.log(`${getTimestamp()} Backup quotidienne terminée ! (${fileName})`);
    } catch (err) {
        console.error(`${getTimestamp()} Erreur lors de la backup :`, err.message);
    }
}

module.exports = { fetchMapData, createBackup };