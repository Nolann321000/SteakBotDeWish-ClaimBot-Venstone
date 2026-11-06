const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const fsPromises = require('node:fs').promises;

const DEFAULT_SESSION_DURATION_MINUTES = 15;
const MAX_REQUEST_BYTES = 4096;
let activeSession = null;

function findTailscaleIPv4() {
    for (const [interfaceName, addresses] of Object.entries(os.networkInterfaces())) {
        for (const address of addresses ?? []) {
            const family = address.family === 'IPv4' || address.family === 4;
            const [first, second] = address.address.split('.').map(Number);
            const isTailscaleRange = first === 100 && second >= 64 && second <= 127;
            if (family && !address.internal && isTailscaleRange && /tailscale/i.test(interfaceName)) {
                return address.address;
            }
        }
    }

    return null;
}

function sendResponse(response, status, contentType, body) {
    response.writeHead(status, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https://cdn.discordapp.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
    });
    response.end(body);
}

function sendJson(response, status, payload) {
    sendResponse(response, status, 'application/json; charset=utf-8', JSON.stringify(payload));
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => {
            body += chunk;
            if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
                reject(new Error('Requête trop volumineuse.'));
                request.destroy();
            }
        });
        request.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch {
                reject(new Error('Corps JSON invalide.'));
            }
        });
        request.on('error', reject);
    });
}

async function makeConsolePage(remainingMs) {
    const initialSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const initialCountdown = `${String(Math.floor(initialSeconds / 60)).padStart(2, '0')}:${String(initialSeconds % 60).padStart(2, '0')}`;
    const html = await fsPromises.readFile(path.join(__dirname, 'console.html'), 'utf8');
    return html
        .replace('__INITIAL_COUNTDOWN__', initialCountdown)
        .replace('__REMAINING_MS__', String(Math.max(0, remainingMs)));
}

function closeSession(session) {
    clearTimeout(session.timer);
    if (activeSession === session) activeSession = null;
    session.server.close();
}

function hasSessionToken(candidate, token) {
    const candidateBuffer = Buffer.from(candidate);
    const tokenBuffer = Buffer.from(token);
    return candidateBuffer.length === tokenBuffer.length && timingSafeEqual(candidateBuffer, tokenBuffer);
}

async function handleRequest(session, request, response) {
    const requestUrl = new URL(request.url, 'http://localhost');
    const route = /^\/s\/([A-Za-z0-9_-]+)(\/run)?$/.exec(requestUrl.pathname);

    if (Date.now() >= session.expiresAt || activeSession !== session) {
        return sendJson(response, 410, { ok: false, error: 'Session expirée.' });
    }
    if (!route || !hasSessionToken(route[1], session.token)) {
        return sendJson(response, 404, { ok: false, error: 'Introuvable.' });
    }

    if (request.method === 'GET' && !route[2]) {
        const page = await makeConsolePage(session.expiresAt - Date.now());
        return sendResponse(response, 200, 'text/html; charset=utf-8', page);
    }

    if (request.method !== 'POST' || route[2] !== '/run') {
        return sendJson(response, 404, { ok: false, error: 'Introuvable.' });
    }
    if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) {
        return sendJson(response, 415, { ok: false, error: 'Content-Type JSON requis.' });
    }
    if (session.busy) return sendJson(response, 409, { ok: false, error: 'Une commande est déjà en cours.' });

    let payload;
    try {
        payload = await readJsonBody(request);
    } catch (err) {
        return sendJson(response, 400, { ok: false, error: err.message });
    }

    if (typeof payload?.command !== 'string' || payload.command.length > 2000) {
        return sendJson(response, 400, { ok: false, error: 'Commande invalide.' });
    }

    session.busy = true;
    try {
        const output = await session.executeCommand(payload.command);
        if (output?.reloadConsole === true) {
            return sendJson(response, 200, { ok: true, reloadConsole: true, output: output.message });
        }
        return sendJson(response, 200, { ok: true, output: String(output ?? 'Commande terminée.') });
    } catch (err) {
        return sendJson(response, 400, { ok: false, error: err.message });
    } finally {
        session.busy = false;
    }
}

async function startDebugConsole(executeCommand, configState) {
    const host = findTailscaleIPv4();
    if (!host) throw new Error('Aucune adresse IPv4 Tailscale trouvée sur le Raspberry Pi.');
    if (!configState?.config) throw new Error('Configuration du bot indisponible.');
    if (activeSession) closeSession(activeSession);

    const configuredDuration = Number(configState.config.debugConsoleDurationMinutes);
    const sessionDurationMs = (Number.isFinite(configuredDuration) && configuredDuration > 0
        ? configuredDuration
        : DEFAULT_SESSION_DURATION_MINUTES) * 60 * 1000;

    const token = randomBytes(32).toString('base64url');
    const session = {
        token,
        host,
        server: null,
        expiresAt: Date.now() + sessionDurationMs,
        config: configState.config,
        executeCommand,
        busy: false,
        timer: null,
    };
    session.server = http.createServer((request, response) => {
        handleRequest(session, request, response).catch(err => {
            console.error('[debug-console] Erreur interne lors du traitement HTTP :', err?.stack ?? err);
            if (!response.headersSent) sendJson(response, 500, { ok: false, error: 'Erreur interne.' });
            else response.destroy();
        });
    });
    session.server.headersTimeout = 5000;
    session.server.requestTimeout = 10000;
    session.server.maxHeadersCount = 20;

    await new Promise((resolve, reject) => {
        const onError = error => reject(error);
        session.server.once('error', onError);
        session.server.listen(0, host, () => {
            session.server.off('error', onError);
            resolve();
        });
    });

    activeSession = session;
    session.timer = setTimeout(() => closeSession(session), sessionDurationMs);
    session.timer.unref?.();

    const address = session.server.address();
    return {
        url: `http://${host}:${address.port}/s/${token}`,
        durationMs: sessionDurationMs,
    };
}

module.exports = { startDebugConsole };