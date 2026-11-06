const net = require('node:net');
const axios = require('axios');
const { getTimestamp, getShortDate, writeLog } = require('./logger');

/**
 * Retourne l'agent SOCKS5 (Tor) si Tor est activé, sinon undefined (connexion directe).
 * socks-proxy-agent n'est chargé que si nécessaire.
 */
function getProxyAgent(config) {
    if (!config.enableTor) return undefined;
    const { SocksProxyAgent } = require('socks-proxy-agent');
    return new SocksProxyAgent(config.torProxyUrl);
}

async function checkTorIp(config, logsFolder, retries = 3) {
    const timestamp = getTimestamp();
    let agent;
    try {
        agent = getProxyAgent(config);
    } catch (err) {
        console.error(`${timestamp} Impossible de créer l'agent Tor :`, err.message);
        return null;
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.get('https://api.ipify.org?format=json', {
                httpAgent: agent,
                httpsAgent: agent,
                timeout: 10000,
                maxContentLength: 1024,
                maxRedirects: 0,
            });

            const newIp = String(response.data?.ip ?? '').slice(0, 64);
            if (!newIp) throw new Error('Réponse ipify invalide');
            console.log(`${timestamp} Application terminée ! Nouvelle adresse ip : ${newIp}`);

            if (config.enableIpLogs) {
                const logLine = `${getShortDate()} ${timestamp} ${newIp}`;
                await writeLog(logsFolder, config.ipLogsFileName, logLine);
            }
            return newIp;
        } catch (err) {
            if (attempt === retries) {
                console.error(`${timestamp} Impossible de vérifier la nouvelle adresse ip après ${retries} essais :`, err.message);
                return null;
            }
            console.warn(`${timestamp} ⚠️ Vérification IP échouée (tentative ${attempt}/${retries}). Nouvel essai dans 3s...`);
            await new Promise(res => setTimeout(res, 3000));
        }
    }
    return null;
}

// Échappe le mot de passe pour le protocole de contrôle Tor (chaîne entre guillemets) et refuse les CR/LF
// qui permettraient d'injecter des commandes supplémentaires.
function quoteControlString(value) {
    const str = String(value);
    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Demande une nouvelle identité (NEWNYM) à Tor puis vérifie la nouvelle IP.
 * Ne fait RIEN si enableTor n'est pas true. Ne rejette jamais : retourne l'IP, ou null en cas d'échec.
 */
async function renewTorIp(torPassword, config, logsFolder) {
    if (!config.enableTor) return null;

    const authLine = `AUTHENTICATE ${quoteControlString(torPassword)}\r\n`;

    console.log(`${getTimestamp()} Obtention et application d'une nouvelle adresse ip en cours...`);

    const controlHost = config.torControlHost;
    const controlPort = config.torControlPort;
    const socketTimeoutMs = 10000;

    const response = await new Promise((resolve) => {
        const socket = net.connect({ host: controlHost, port: controlPort });
        let buffer = '';
        let settled = false;

        const finish = (value) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(value);
        };

        socket.setTimeout(socketTimeoutMs, () => {
            console.error(`${getTimestamp()} Timeout : aucune réponse du port de contrôle Tor après ${socketTimeoutMs / 1000}s.`);
            finish(null);
        });
        socket.on('error', (err) => {
            console.error(`${getTimestamp()} Erreur socket Tor :`, err.message);
            finish(null);
        });
        socket.on('connect', () => {
            socket.write(authLine + 'SIGNAL NEWNYM\r\nQUIT\r\n');
        });
        socket.on('data', (data) => {
            buffer += data.toString();
            if (buffer.length > 4096) finish(null); // réponse anormalement longue
        });
        socket.on('close', () => finish(buffer));
    });

    if (response === null) return null;

    // On exige que AUTHENTICATE *et* SIGNAL NEWNYM aient répondu 250 (dans cet ordre).
    const lines = response.split('\r\n').filter(Boolean);
    if (!(lines[0]?.startsWith('250') && lines[1]?.startsWith('250'))) {
        console.error(`${getTimestamp()} Erreur Tor :`, response.trim().slice(0, 300));
        return null;
    }

    await new Promise(res => setTimeout(res, 5000));
    return checkTorIp(config, logsFolder);
}

module.exports = { renewTorIp, getProxyAgent };
