const { ChannelType } = require('discord.js');
const path = require('node:path');
const fsPromises = require('node:fs').promises;

const rootDir = path.join(__dirname, '..');
const config = require(path.join(rootDir, 'config.json'));
const { atomicWriteFile } = require(path.join(rootDir, 'utils/fileUtils'));
const { startDebugConsole } = require(path.join(rootDir, 'debug/console'));
const { readHistory, deleteHistoryEntry } = require(path.join(rootDir, 'utils/unclaimHistory'));
const logsFolderPath = path.join(rootDir, config.logsFolderName);
const RESPONSE_DELETE_DELAY_MS = 60 * 1000;

async function removeUnclaimLogLine(entry) {
    const logPaths = [
        config.logsFolderPath ? path.join(config.logsFolderPath, config.unclaimLogsFileName) : null,
        path.join(logsFolderPath, config.unclaimLogsFileName),
    ].filter((filePath, index, paths) => filePath && paths.indexOf(filePath) === index);
    let logPath = null;
    let raw = null;
    for (const candidatePath of logPaths) {
        try {
            raw = await fsPromises.readFile(candidatePath, 'utf8');
            logPath = candidatePath;
            break;
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
    }
    if (logPath === null) return null;

    const eventDate = new Date(entry.date);
    if (Number.isNaN(eventDate.getTime())) return null;

    const lines = raw.split(/\r?\n/);
    let matchingIndex = -1;
    let closestDistance = Infinity;
    for (let index = 0; index < lines.length; index++) {
        const match = lines[index].match(/^\[(\d{2})\/(\d{2})\/(\d{4})\]\s*\[(\d{2}):(\d{2}):(\d{2})\]\s*Les claims du joueur (.+?) ont sauté !$/);
        if (!match || match[7].toLowerCase() !== String(entry.owner).toLowerCase()) continue;

        const [, day, month, year, hour, minute, second] = match;
        const logDate = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
        const distance = Math.abs(logDate.getTime() - eventDate.getTime());
        if (distance < closestDistance) {
            matchingIndex = index;
            closestDistance = distance;
        }
    }

    if (matchingIndex < 0 || closestDistance > 5 * 60 * 1000) return null;

    const lineEnding = raw.includes('\r\n') ? '\r\n' : '\n';
    lines.splice(matchingIndex, 1);
    await atomicWriteFile(logPath, lines.join(lineEnding));
    return true;
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} Ko`;
    return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
}

function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    return [hours, minutes, remainingSeconds].map(value => String(value).padStart(2, '0')).join(':');
}

function scheduleDeletion(message, delayMs = RESPONSE_DELETE_DELAY_MS) {
    const timer = setTimeout(() => message.delete().catch(() => {}), delayMs);
    timer.unref?.();
}

async function replyWithExpiry(message, options, delayMs = RESPONSE_DELETE_DELAY_MS) {
    const response = await message.reply({ ...options, allowedMentions: { parse: [] } });
    scheduleDeletion(response, delayMs);
    return response;
}

const debugCommands = {
    runtime: {
        description: 'Affiche la version Node, la plateforme, la durée de fonctionnement et la mémoire.',
        run: async interaction => {
            const memory = process.memoryUsage();
            return interaction.editReply(
                `Runtime\n` +
                `• Node : ${process.version}\n` +
                `• Plateforme : ${process.platform} ${process.arch}\n` +
                `• Uptime : ${formatDuration(Math.floor(process.uptime()))}\n` +
                `• Mémoire RSS : ${formatBytes(memory.rss)}\n` +
                `• Heap utilisé : ${formatBytes(memory.heapUsed)} / ${formatBytes(memory.heapTotal)}`
            );
        },
    },

    commands: {
        description: 'Liste les commandes slash et les commandes debug privées chargées.',
        run: async (interaction, client) => {
            const slashCommands = [...client.commands.keys()].sort();
            const debugNames = Object.keys(debugCommands).sort();
            return interaction.editReply(
                `Commandes slash (${slashCommands.length})\n${slashCommands.map(name => `• /${name}`).join('\n') || '• aucune'}\n\n` +
                `Commandes debug privées (${debugNames.length})\n${debugNames.map(name => `• ${name}`).join('\n')}`
            );
        },
    },

    mapstats: {
        description: 'Compte les claims, propriétaires, surfaces et marqueurs incomplets de la map.',
        run: async (interaction, client) => {
            let data = client.mapCache;
            if (!data) {
                data = JSON.parse(await fsPromises.readFile(client.mainFilePath, 'utf8'));
            }
            const layers = Array.isArray(data) ? data : [data];
            const layer = layers.find(item => item?.id === 'griefprevention');
            if (!layer?.markers) return interaction.editReply('❌ Couche griefprevention introuvable.');

            const markers = Object.values(layer.markers).filter(Boolean);
            const owners = new Set();
            let adminClaims = 0;
            let missingOwners = 0;
            let measured = 0;
            let totalArea = 0;
            const ownerRegex = /Propriétaire\s*:\s*<span[^>]*>(.*?)<\/span>/i;

            for (const marker of markers) {
                const match = String(marker.popup ?? '').match(ownerRegex);
                const owner = match?.[1]?.replace(/<[^>]+>/g, '').trim() ?? '';
                if (!owner) missingOwners++;
                else if (owner.toLowerCase() === 'claim administratif') adminClaims++;
                else owners.add(owner.toLowerCase());

                const [first, second] = marker.points ?? [];
                if ([first?.x, first?.z, second?.x, second?.z].every(Number.isFinite)) {
                    totalArea += (Math.abs(first.x - second.x) + 1) * (Math.abs(first.z - second.z) + 1);
                    measured++;
                }
            }

            return interaction.editReply(
                `Statistiques map\n` +
                `• Claims : ${markers.length}\n` +
                `• Propriétaires joueurs : ${owners.size}\n` +
                `• Claims administratifs : ${adminClaims}\n` +
                `• Sans propriétaire lisible : ${missingOwners}\n` +
                `• Surfaces mesurées : ${measured}/${markers.length}\n` +
                `• Surface mesurée cumulée : ${new Intl.NumberFormat('fr-FR').format(totalArea)} blocs²`
            );
        },
    },

    reloadmarkers: {
        description: 'Recharge le cache map depuis le fichier markers local, sans contacter la map dynamique.',
        run: async (interaction, client) => {
            const data = JSON.parse(await fsPromises.readFile(client.mainFilePath, 'utf8'));
            client.mapCache = data;

            const layers = Array.isArray(data) ? data : [data];
            const layer = layers.find(item => item?.id === 'griefprevention');
            const markerCount = Object.keys(layer?.markers ?? {}).length;

            return interaction.editReply(
                `✅ Cache map rechargé depuis le fichier local, sans appel à la map dynamique.\n` +
                `• Marqueurs griefprevention : ${markerCount}`
            );
        },
    },

    history: {
        description: 'Résume l’historique des unclaims, ou détaille un pseudo donné.',
        run: async (interaction, client, ownerInput = '') => {
            const history = await readHistory(config.unclaimHistoryFilePath);
            const ownerQuery = ownerInput.trim().toLowerCase();
            const entries = ownerQuery
                ? (history[ownerQuery] ?? [])
                : Object.values(history).flatMap(value => Array.isArray(value) ? value : []);
            if (ownerQuery && entries.length === 0) return interaction.editReply(`Aucun historique trouvé pour ${ownerInput}.`);

            const claims = entries.reduce((sum, entry) => sum + (Number(entry.claimsLost) || entry.markers?.length || 0), 0);
            const markers = entries.flatMap(entry => Array.isArray(entry.markers) ? entry.markers : []);
            const missingAreas = markers.filter(marker => !Number.isFinite(marker?.area)).length;
            const latest = entries.map(entry => new Date(entry.date)).filter(date => !Number.isNaN(date.getTime())).sort((a, b) => b - a)[0];
            const owners = ownerQuery ? 1 : Object.values(history).filter(Array.isArray).length;

            return interaction.editReply(
                `${ownerQuery ? `Historique de ${entries.at(-1)?.owner ?? ownerInput}` : 'Historique global'}\n` +
                `• Joueurs : ${owners}\n` +
                `• Événements : ${entries.length}\n` +
                `• Claims perdus : ${claims}\n` +
                `• Surfaces manquantes : ${missingAreas}/${markers.length}\n` +
                `• Dernier événement : ${latest ? latest.toLocaleString('fr-FR') : 'aucun'}`
            );
        },
    },

    unclaims: {
        description: 'Liste les unclaims numérotés d’un pseudo pour identifier une entrée à supprimer.',
        run: async (interaction, client, argumentsText = '') => {
            const args = argumentsText.trim().split(/\s+/).filter(Boolean);
            const ownerInput = args[0];
            const requestedPage = args.length > 1 ? Number(args[1]) : 1;
            if (!ownerInput || !Number.isInteger(requestedPage) || requestedPage < 1) {
                return interaction.editReply('Utilisation : unclaims <pseudo> [page]');
            }

            const history = await readHistory(config.unclaimHistoryFilePath);
            const entries = history[ownerInput.toLowerCase()];
            if (!Array.isArray(entries) || entries.length === 0) {
                return interaction.editReply(`Aucun unclaim trouvé pour ${ownerInput}.`);
            }

            const pageSize = 20;
            const pageCount = Math.ceil(entries.length / pageSize);
            if (requestedPage > pageCount) {
                return interaction.editReply(`Page invalide. ${ownerInput} a ${pageCount} page(s) d’unclaims.`);
            }

            const startIndex = (requestedPage - 1) * pageSize;
            const lines = entries.slice(startIndex, startIndex + pageSize).map((entry, offset) => {
                const index = startIndex + offset + 1;
                const date = new Date(entry.date);
                const dateText = Number.isNaN(date.getTime()) ? 'date inconnue' : date.toLocaleString('fr-FR');
                const claimCount = Number(entry.claimsLost) || entry.markers?.length || 0;
                return `#${index} • ${dateText} • ${claimCount} zone(s)${entry.usernameChange ? ' • changement de compte' : ''}`;
            });

            return interaction.editReply(
                `Unclaims de ${entries.at(-1)?.owner ?? ownerInput} (${entries.length} événement(s))\n` +
                `${lines.join('\n')}\n\n` +
                `Page ${requestedPage}/${pageCount} • suppression : deleteunclaim ${ownerInput} <numéro>`
            );
        },
    },

    deleteunclaim: {
        description: 'Liste les IDs d’unclaim d’un pseudo, ou supprime un ID de l’historique et des logs.',
        run: async (interaction, client, argumentsText = '') => {
            const [owner, rawIndex, ...extra] = argumentsText.trim().split(/\s+/).filter(Boolean);
            if (!owner || extra.length > 0) {
                return interaction.editReply('Utilisation : deleteunclaim <pseudo> [ID]');
            }

            if (!rawIndex) {
                const history = await readHistory(config.unclaimHistoryFilePath);
                const ownerKey = owner.toLowerCase();
                const entries = Object.hasOwn(history, ownerKey) && Array.isArray(history[ownerKey])
                    ? history[ownerKey]
                    : [];
                if (entries.length === 0) return interaction.editReply(`Aucun unclaim trouvé pour ${owner}.`);

                const lines = entries.map((entry, index) => {
                    const date = new Date(entry.date);
                    const dateText = Number.isNaN(date.getTime()) ? 'date inconnue' : date.toLocaleString('fr-FR');
                    const claimCount = Number(entry.claimsLost) || entry.markers?.length || 0;
                    return `#${index + 1} • ${dateText} • ${claimCount} zone(s)${entry.usernameChange ? ' • changement de compte' : ''}`;
                });

                return interaction.editReply(
                    `Unclaims de ${entries.at(-1)?.owner ?? owner} (${entries.length} événement(s))\n` +
                    `${lines.join('\n')}\n\n` +
                    `Suppression : deleteunclaim ${owner} <ID>`
                );
            }

            const index = Number(rawIndex);
            if (!Number.isInteger(index) || index < 1) {
                return interaction.editReply('L’ID doit être un nombre entier positif. Utilisation : deleteunclaim <pseudo> [ID]');
            }

            const result = await deleteHistoryEntry(config.unclaimHistoryFilePath, owner, index);
            if (!result) {
                return interaction.editReply(`Aucun unclaim #${index} trouvé pour ${owner}. Rien n’a été supprimé.`);
            }

            let logRemoved = false;
            let logMessage = 'Aucune ligne correspondante trouvée dans unclaim.logs.';
            try {
                logRemoved = await removeUnclaimLogLine(result.entry);
                if (logRemoved) logMessage = 'Ligne supprimée de unclaim.logs.';
            } catch (err) {
                logMessage = `Impossible de mettre à jour unclaim.logs : ${err.message}`;
            }

            const date = new Date(result.entry.date);
            const dateText = Number.isNaN(date.getTime()) ? 'date inconnue' : date.toLocaleString('fr-FR');
            console.log(`${client.getTimestamp()} [DEBUG] deleteunclaim : entrée #${index} supprimée pour ${owner}.`);
            return interaction.editReply(
                `✅ Unclaim #${index} de ${result.entry.owner} supprimé (${dateText}).\n` +
                logMessage
            );
        },
    },

    backups: {
        description: 'Compte les backups JSON et affiche la plus récente ainsi que leur taille cumulée.',
        run: async (interaction, client) => {
            const backups = [];
            async function scan(directory) {
                const entries = await fsPromises.readdir(directory, { withFileTypes: true }).catch(() => []);
                for (const entry of entries) {
                    const fullPath = path.join(directory, entry.name);
                    if (entry.isDirectory()) await scan(fullPath);
                    else if (entry.isFile() && entry.name.endsWith('.json')) {
                        const stat = await fsPromises.stat(fullPath).catch(() => null);
                        if (stat) backups.push({ name: entry.name, size: stat.size, mtime: stat.mtime });
                    }
                }
            }

            await scan(client.backupDir);
            backups.sort((a, b) => b.mtime - a.mtime);
            const totalBytes = backups.reduce((sum, backup) => sum + backup.size, 0);
            return interaction.editReply(
                `Backups\n` +
                `• Fichiers JSON : ${backups.length}\n` +
                `• Taille cumulée : ${formatBytes(totalBytes)}\n` +
                `• Plus récente : ${backups[0] ? `${backups[0].name} (${backups[0].mtime.toLocaleString('fr-FR')})` : 'aucune'}`
            );
        },
    },

    reloadcommands: {
        description: 'Recharge les modules de commandes et redéploie les commandes slash activées.',
        run: async (interaction, client) => {
            await interaction.editReply('🔄 Rechargement des commandes en cours...');
            const count = await client.reloadCommands();
            return interaction.editReply(`✅ ${count} commande(s) slash rechargée(s) et redéployée(s).`);
        },
    },

    migratelogs: {
        description: 'Migre le fichier unclaim logs vers le nouveau système unclaimHistory.json.',
        run: async (interaction, client) => {
            const timestamp = client.getTimestamp();
            await interaction.editReply(`🔄 Migration des logs en cours...`);

            const logsFilePath = path.join(logsFolderPath, config.unclaimLogsFileName);
            let rawLogs;
            try {
                rawLogs = await fsPromises.readFile(logsFilePath, 'utf8');
            } catch (err) {
                return interaction.editReply(`❌ Impossible de lire le fichier de logs : \`${err.message}\``);
            }

            const lineRegex = /^\[(\d{2})\/(\d{2})\/(\d{4})\]\s*\[([\d:]+)\]\s*Les claims du joueur (.+?) ont sauté/;
            const allEntries = [];
            for (const line of rawLogs.split('\n')) {
                const match = line.match(lineRegex);
                if (!match) continue;
                const [, dd, mm, yyyy, time, pseudo] = match;
                const isoDate = `${yyyy}-${mm}-${dd}T${time}`;
                allEntries.push({ pseudo, isoDate, dd, mm, yyyy });
            }
            console.log(`${timestamp} [DEBUG] migratelogs : ${allEntries.length} entrée(s) au total.`);
            console.log(`${timestamp} [DEBUG] migratelogs : ${new Set(allEntries.map(e => e.pseudo)).size} joueur(s) unique(s) trouvé(s).`);

            if (allEntries.length === 0) {
                return interaction.editReply(`❌ Aucune entrée trouvée dans le fichier de logs.`);
            }

            const { readHistory, writeHistory } = require(path.join(rootDir, 'utils/unclaimHistory'));
            const HISTORY_FILE = config.unclaimHistoryFilePath;
            const ownerRegex = /Propriétaire\s*:\s*<span[^>]*>(.*?)<\/span>/i;
            const cleanHTML = (t) => t
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/<[^>]+>/g, '')
                .trim();

            async function indexBackups(dir) {
                const index = new Map();
                const entries = await fsPromises.readdir(dir, { withFileTypes: true }).catch(() => []);
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        const sub = await indexBackups(fullPath);
                        for (const [k, v] of sub) index.set(k, v);
                    } else if (entry.isFile() && entry.name.endsWith('.json')) {
                        index.set(entry.name, fullPath);
                    }
                }
                return index;
            }

            const backupIndex = await indexBackups(client.backupDir);
            console.log(`${timestamp} [DEBUG] migratelogs : ${backupIndex.size} backup(s) indexée(s).`);

            const dailyRegex = /^backup_\d{2}-\d{2}-\d{4}\.json$/;
            const dailyBackups = new Map();
            const archiveBackups = new Map();
            for (const [name, fullPath] of backupIndex) {
                if (dailyRegex.test(name)) dailyBackups.set(name, fullPath);
                else archiveBackups.set(name, fullPath);
            }

            const MOIS_FR = [
                'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
                'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
            ];

            function getArchiveNames(date) {
                const day    = date.getDate();
                const moitie = day <= 15 ? 'début' : 'fin';

                const moisCourant     = MOIS_FR[date.getMonth()];
                const archiveCourante = `backup_${moitie}_${moisCourant}_${date.getFullYear()}.json`;

                const dateMoisPrec = new Date(date.getFullYear(), date.getMonth() - 1, 1);
                const moisPrec     = MOIS_FR[dateMoisPrec.getMonth()];
                const archivePrec  = `backup_fin_${moisPrec}_${dateMoisPrec.getFullYear()}.json`;

                return [archiveCourante, archivePrec];
            }

            function extractMarkers(backupData, pseudoLower) {
                const layer = Array.isArray(backupData)
                    ? backupData.find(l => l.id === 'griefprevention')
                    : (backupData?.id === 'griefprevention' ? backupData : null);

                const markers = [];
                if (!layer?.markers) return markers;

                for (const m of Object.values(layer.markers)) {
                    const match = (m.popup || '').match(ownerRegex);
                    if (!match) continue;
                    const name = cleanHTML(match[1]);
                    if (name.toLowerCase() === pseudoLower) markers.push(m);
                }
                return markers;
            }

            const MAX_CACHED_BACKUPS = 5;
            const loadedBackups = new Map();
            function cacheBackup(filePath, data) {
                loadedBackups.set(filePath, data);
                if (loadedBackups.size > MAX_CACHED_BACKUPS) {
                    loadedBackups.delete(loadedBackups.keys().next().value);
                }
            }
            async function tryLoad(filePath) {
                if (loadedBackups.has(filePath)) return loadedBackups.get(filePath);
                try {
                    const data = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
                    cacheBackup(filePath, data);
                    return data;
                } catch {
                    cacheBackup(filePath, null);
                    return null;
                }
            }

            const history = await readHistory(HISTORY_FILE);

            let migrated = 0, noMarkers = 0;
            const skippedList = [];
            const pd = (n) => String(n).padStart(2, '0');

            for (const { pseudo, isoDate, dd, mm, yyyy } of allEntries) {
                const baseDate = new Date(`${yyyy}-${mm}-${dd}T${isoDate.split('T')[1]}`);
                const pseudoLower = pseudo.toLowerCase();

                let markers = [];
                let foundBackupName = null;

                for (let offset = 0; offset <= 4; offset++) {
                    const d = new Date(baseDate.getTime() - offset * 86400000);
                    const tryName = `backup_${pd(d.getDate())}-${pd(d.getMonth() + 1)}-${d.getFullYear()}.json`;
                    const tryPath = dailyBackups.get(tryName);
                    if (!tryPath) continue;
                    const data = await tryLoad(tryPath);
                    if (!data) continue;
                    const found = extractMarkers(data, pseudoLower);
                    if (found.length > 0) {
                        markers = found;
                        foundBackupName = tryName;
                        if (offset > 0) console.log(`${timestamp} [DEBUG] migratelogs : backup J-${offset} utilisée pour ${pseudo} (${tryName}).`);
                        break;
                    }
                }

                if (markers.length === 0) {
                    for (const archiveName of getArchiveNames(baseDate)) {
                        const archivePath = archiveBackups.get(archiveName);
                        if (!archivePath) continue;
                        const data = await tryLoad(archivePath);
                        if (!data) continue;
                        const found = extractMarkers(data, pseudoLower);
                        if (found.length > 0) {
                            markers = found;
                            foundBackupName = archiveName;
                            console.log(`${timestamp} [DEBUG] migratelogs : archive ciblée utilisée pour ${pseudo} (${archiveName}).`);
                            break;
                        }
                    }
                }

                if (markers.length === 0) {
                    for (const [archiveName, archivePath] of archiveBackups) {
                        const data = await tryLoad(archivePath);
                        if (!data) continue;
                        const found = extractMarkers(data, pseudoLower);
                        if (found.length > 0) {
                            markers = found;
                            foundBackupName = archiveName;
                            console.log(`${timestamp} [DEBUG] migratelogs : archive de secours utilisée pour ${pseudo} (${archiveName}).`);
                            break;
                        }
                    }
                }

                if (markers.length === 0) {
                    for (const [dailyName, dailyPath] of dailyBackups) {
                        const data = await tryLoad(dailyPath);
                        if (!data) continue;
                        const found = extractMarkers(data, pseudoLower);
                        if (found.length > 0) {
                            markers = found;
                            foundBackupName = dailyName;
                            console.log(`${timestamp} [DEBUG] migratelogs : journalière de secours utilisée pour ${pseudo} (${dailyName}).`);
                            break;
                        }
                    }
                }

                if (markers.length === 0) {
                    console.warn(`${timestamp} [DEBUG] migratelogs : "${pseudo}" introuvable dans toutes les sources — skip.`);
                    skippedList.push(`\`${pseudo}\` — ${dd}/${mm}/${yyyy} (aucun marker trouvé)`);
                    noMarkers++;
                    continue;
                }

                const key = pseudo.toLowerCase();
                if (!history[key]) history[key] = [];

                const entry = {
                    owner: pseudo,
                    date: new Date(isoDate).toISOString(),
                    claimsLost: markers.length,
                    usernameChange: false,
                    markers: markers.map(m => {
                        const first = m.points?.[0];
                        const second = m.points?.[1];
                        const hasBounds = [first?.x, first?.z, second?.x, second?.z].every(Number.isFinite);

                        return {
                            x: hasBounds ? Math.round((first.x + second.x) / 2) : null,
                            z: hasBounds ? Math.round((first.z + second.z) / 2) : null,
                            area: hasBounds ? (Math.abs(first.x - second.x) + 1) * (Math.abs(first.z - second.z) + 1) : null,
                            label: m.label ?? null,
                        };
                    }),
                };

                history[key].push(entry);
                console.log(`${timestamp} [DEBUG] migratelogs : ${pseudo} migré (${markers.length} markers) via ${foundBackupName}.`);
                migrated++;
            }

            await writeHistory(HISTORY_FILE, history);
            console.log(`${timestamp} [DEBUG] migratelogs : écriture terminée.`);

            const skippedText = skippedList.length > 0
                ? `\n\n**Skippés :**\n${skippedList.slice(0, 20).join('\n')}${skippedList.length > 20 ? `\n… et ${skippedList.length - 20} autres` : ''}`
                : '';

            return interaction.editReply(
                `✅ Migration terminée.\n` +
                `• **Migrés :** ${migrated}\n` +
                `• **Skippés (aucun marker) :** ${noMarkers}` +
                skippedText
            );
        },
    },

    patchhistory: {
        description: 'Ajoute usernameChange: false sur toutes les entrées qui n\'ont pas ce champ.',
        run: async (interaction, client) => {
            const timestamp = client.getTimestamp();
            const { readHistory, writeHistory } = require(path.join(rootDir, 'utils/unclaimHistory'));
            const HISTORY_FILE = config.unclaimHistoryFilePath;

            const history = await readHistory(HISTORY_FILE);
            let patched = 0;

            for (const entries of Object.values(history)) {
                for (const entry of entries) {
                    if (entry.usernameChange === undefined) {
                        entry.usernameChange = false;
                        patched++;
                    }
                }
            }

            await writeHistory(HISTORY_FILE, history);
            console.log(`${timestamp} [DEBUG] patchhistory : ${patched} entrée(s) mise(s) à jour.`);

            return interaction.editReply(
                `✅ Patch terminé.\n• **Entrées mises à jour :** ${patched}\n• **Déjà à jour :** ignorées`
            );
        },
    },

    fixclaimareas: {
        description: 'Récupère les surfaces manquantes de l’historique depuis les backups.',
        run: async (interaction, client) => {
            const timestamp = client.getTimestamp();
            const { readHistory, writeHistory } = require(path.join(rootDir, 'utils/unclaimHistory'));
            const historyFile = config.unclaimHistoryFilePath;
            const history = await readHistory(historyFile);
            const backups = [];
            const monthIndexes = new Map([
                ['janvier', 0], ['février', 1], ['mars', 2], ['avril', 3],
                ['mai', 4], ['juin', 5], ['juillet', 6], ['août', 7],
                ['septembre', 8], ['octobre', 9], ['novembre', 10], ['décembre', 11],
            ]);

            async function collectBackups(directory) {
                const files = await fsPromises.readdir(directory, { withFileTypes: true }).catch(() => []);
                for (const file of files) {
                    const fullPath = path.join(directory, file.name);
                    if (file.isDirectory()) {
                        await collectBackups(fullPath);
                        continue;
                    }
                    if (!file.isFile()) continue;

                    let year, month, day;
                    const daily = /^(?:backup|bakcup)_(\d{2})-(\d{2})-(\d{4})\.json$/i.exec(file.name);
                    const archive = /^(?:backup|bakcup)_(début|fin)_([^_]+)_(\d{4})\.json$/i.exec(file.name);
                    if (daily) {
                        day = Number(daily[1]);
                        month = Number(daily[2]) - 1;
                        year = Number(daily[3]);
                    } else if (archive) {
                        const period = archive[1].toLowerCase();
                        month = monthIndexes.get(archive[2].toLowerCase());
                        year = Number(archive[3]);
                        day = period === 'début' ? 1 : 16;
                    } else {
                        continue;
                    }

                    if (month === undefined) continue;
                    backups.push({ path: fullPath, day: Date.UTC(year, month, day) });
                }
            }

            await collectBackups(client.backupDir);
            backups.sort((a, b) => b.day - a.day);

            async function buildBackupIndex(backup) {
                const index = new Map();
                try {
                    const data = JSON.parse(await fsPromises.readFile(backup.path, 'utf8'));
                    const layer = Array.isArray(data)
                        ? data.find(item => item?.id === 'griefprevention')
                        : (data?.id === 'griefprevention' ? data : null);
                    const ownerRegex = /Propriétaire\s*:\s*<span[^>]*>(.*?)<\/span>/i;

                    for (const marker of Object.values(layer?.markers ?? {})) {
                        const match = String(marker?.popup ?? '').match(ownerRegex);
                        const points = marker?.points;
                        if (!match || !Array.isArray(points) || points.length < 2) continue;

                        const first = points[0];
                        const second = points[1];
                        if (![first?.x, first?.z, second?.x, second?.z].every(Number.isFinite)) continue;

                        const owner = match[1].replace(/<[^>]+>/g, '').trim().toLowerCase();
                        const x = Math.round((first.x + second.x) / 2);
                        const z = Math.round((first.z + second.z) / 2);
                        const area = (Math.abs(first.x - second.x) + 1) * (Math.abs(first.z - second.z) + 1);
                        const key = `${owner}|${x}|${z}`;
                        const areas = index.get(key) ?? [];
                        areas.push(area);
                        index.set(key, areas);
                    }
                } catch (err) {
                    console.warn(`${timestamp} [DEBUG] fixclaimareas : backup illisible (${path.basename(backup.path)}): ${err.message}`);
                }
                return index;
            }

            let missing = 0;
            let repaired = 0;
            let unresolved = 0;
            let backupsAnalyzed = 0;
            let pending = [];

            for (const [ownerKey, entries] of Object.entries(history)) {
                if (!Array.isArray(entries)) continue;

                for (const entry of entries) {
                    const eventDate = new Date(entry?.date);
                    if (Number.isNaN(eventDate.getTime()) || !Array.isArray(entry.markers)) continue;
                    const eventDay = Date.UTC(eventDate.getUTCFullYear(), eventDate.getUTCMonth(), eventDate.getUTCDate());
                    const owner = String(entry.owner ?? ownerKey).toLowerCase();

                    for (const marker of entry.markers) {
                        if (Number.isFinite(marker?.area)) continue;
                        missing++;

                        if (!Number.isFinite(marker?.x) || !Number.isFinite(marker?.z)) {
                            unresolved++;
                            continue;
                        }

                        pending.push({ marker, eventDay, key: `${owner}|${marker.x}|${marker.z}` });
                    }
                }
            }

            for (const backup of backups) {
                if (pending.length === 0) break;
                if (!pending.some(item => backup.day <= item.eventDay)) continue;

                const index = await buildBackupIndex(backup);
                backupsAnalyzed++;
                const stillPending = [];
                for (const item of pending) {
                    if (backup.day > item.eventDay) {
                        stillPending.push(item);
                        continue;
                    }

                    const matchingAreas = index.get(item.key);
                    const uniqueAreas = matchingAreas ? [...new Set(matchingAreas)] : [];
                    if (uniqueAreas.length === 1) {
                        item.marker.area = uniqueAreas[0];
                        repaired++;
                    } else {
                        stillPending.push(item);
                    }
                }
                pending = stillPending;
            }
            unresolved += pending.length;

            let backupPath = null;
            if (repaired > 0) {
                const debugArchiveDir = path.join(rootDir, 'old', 'debug');
                await fsPromises.mkdir(debugArchiveDir, { recursive: true });
                backupPath = path.join(debugArchiveDir, `${path.basename(historyFile)}.before-fixclaimareas-${Date.now()}`);
                await fsPromises.copyFile(historyFile, backupPath);
                await writeHistory(historyFile, history);
            }

            console.log(`${timestamp} [DEBUG] fixclaimareas : ${repaired}/${missing} surface(s) réparée(s), ${unresolved} introuvable(s) ou ambiguë(s).`);
            return interaction.editReply(
                `✅ Vérification terminée.\n` +
                `• **Surfaces récupérées :** ${repaired} / ${missing}\n` +
                `• **Introuvables ou ambiguës :** ${unresolved}\n` +
                `• **Backups analysés :** ${backupsAnalyzed}` +
                (backupPath ? `\n• **Copie de sécurité :** old/debug/${path.basename(backupPath)}` : '')
            );
        },
    },

};

async function executeDebugConsoleCommand(input, client) {
    const commandInput = String(input).trim();
    const separator = commandInput.search(/\s/);
    const commandName = (separator < 0 ? commandInput : commandInput.slice(0, separator)).toLowerCase();
    const argumentsText = separator < 0 ? '' : commandInput.slice(separator).trim();

    if (!commandName || commandName === 'debug' || commandName === 'help') {
        return [
            ...Object.entries(debugCommands).map(([name, command]) => `${name} — ${command.description}`),
            'reloadconsole — Recharge le site complet depuis son fichier HTML.',
        ].join('\n');
    }

    if (commandName === 'reloadconsole') {
        return { reloadConsole: true, message: 'Console actualisée depuis debug/console.html.' };
    }

    const entry = Object.hasOwn(debugCommands, commandName) ? debugCommands[commandName] : null;
    if (!entry) throw new Error(`Commande inconnue. Disponibles : ${Object.keys(debugCommands).join(', ')}`);

    let output = '';
    const interaction = {
        editReply: async content => { output = String(content); return output; },
        scheduleDeletion: () => {},
    };
    await entry.run(interaction, client, argumentsText);
    return output || 'Commande terminée.';
}

module.exports = {
    async handleMessage(message, client) {
        if (
            message.author.bot ||
            message.author.id !== client.ownerId ||
            message.channel.type !== ChannelType.DM
        ) return;

        if (message.content.trim().toLowerCase() !== '!debug') return;

        await message.delete().catch(() => {});
        try {
                const session = await startDebugConsole(
                    command => executeDebugConsoleCommand(command, client),
                    { config }
                );
            return replyWithExpiry(message, {
                content: `🖥 Console debug Tailscale active pendant ${Math.ceil(session.durationMs / 60000)} minutes :\n${session.url}\n\nCommandes debug autorisées uniquement.`,
            }, session.durationMs);
        } catch (err) {
            return replyWithExpiry(message, { content: `❌ Impossible de démarrer la console : ${err.message}` });
        }
    },
};