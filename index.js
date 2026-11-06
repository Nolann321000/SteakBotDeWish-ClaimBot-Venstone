const fs = require('node:fs');
const path = require('node:path');
const { Client, GatewayIntentBits, REST, Routes, Events, Collection, Partials } = require('discord.js');
const { getTimestamp } = require('./utils/logger');
const { sendError, notifyOwner, clearBotMessages, sanitizeText } = require('./utils/discordUtils');
const { fetchMapData, createBackup } = require('./utils/mapManager');
const { renewTorIp } = require('./utils/torManager');
const dotenvConfig = require('dotenv').config({ path: path.join(__dirname, 'SteakBotDeWish.env'), quiet: true });
const getEnv = (key) => dotenvConfig.parsed?.[key] ?? process.env[key];
const config = require('./config.json');

function validateConfig(config) {
    const emptyKeys = Object.entries(config)
        .filter(([, value]) => value !== -1 && value !== 'null' && (value == null || (typeof value === 'string' && value.trim() === '')))
        .map(([key]) => key);

    if (emptyKeys.length) {
        console.error(`${getTimestamp()} [Configuration] Valeur manquante pour : ${emptyKeys.join(', ')}`);
        process.exit(1);
    }
}

validateConfig(config);

const CLIENT_ID = getEnv('CLIENT_ID');
const TOKEN = getEnv('TOKEN');
const OWNER_ID = getEnv('OWNER_ID');
const TOR_PASSWORD = getEnv('TOR_PASSWORD');
const logsFolderPath = config.logsFolderPath;
const authorizedUsers = config.authorizedUsers;
const blacklistedGuilds = config.blacklistedGuilds;
const torEnabled = config.enableTor;
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
});

client.commands = new Collection();
client.backupDir = config.backupsFolderPath;
client.mainFilePath = config.mapMarkersFilePath;
client.ownerId = OWNER_ID;
client.mapCache = null;
client.getTimestamp = getTimestamp;
client.sendError = sendError;
client.notifyOwner = (msg) => notifyOwner(client, OWNER_ID, msg);
client.fetchMapData = () => fetchMapData(client, config, logsFolderPath);

let isReady = false;
let refreshCycleCount = 0;
let isShuttingDown = false;
let isRefreshRunning = false;

function handleGlobalEvent(source, details, fatal = false) {
    console.error(`${getTimestamp()} [${source}] ${details instanceof Error ? details.stack || details.message : String(details)}`);
    if (fatal) process.exit(1);
}

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`${getTimestamp()} Signal ${signal} reçu, arrêt en cours...`);
    try {
        client.destroy();
        await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (err) {
        console.error(`${getTimestamp()} Erreur pendant l'arrêt :`, err);
    } finally {
        process.exit(0);
    }
}

process.on('unhandledRejection', reason => handleGlobalEvent('Promesse rejetée non gérée', reason));
process.on('uncaughtException', err => handleGlobalEvent('uncaughtException', err, true));
process.on('warning', warning => handleGlobalEvent('Avertissement Node.js', warning));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));

client.on(Events.Error, err => handleGlobalEvent('Erreur client Discord', err));
client.on(Events.ShardError, err => handleGlobalEvent('Erreur shard Discord', err));
client.on(Events.ShardDisconnect, (event, shardId) => handleGlobalEvent('Shard déconnecté', `Shard ${shardId} déconnecté (code ${event.code}).`));

const commandsToDeploy = [];
const commandsPath = path.join(__dirname, 'commands');
const debugCommandPath = path.join(__dirname, 'debug', 'debug.js');
const commandFeatureFlags = {
    claimlist: 'enableCommandClaimList',
    claimrefresh: 'enableCommandClaimRefresh',
    checkunclaim: 'enableCommandCheckUnclaim',
    stats: 'enableCommandStats',
};

function loadDebugMessageCommand(clearCache = false) {
    client.debugMessageCommand = null;
    if (!config.enableDebugTools) return;

    if (clearCache) delete require.cache[require.resolve(debugCommandPath)];
    try {
        const command = require(debugCommandPath);
        if (typeof command?.handleMessage === 'function') {
            client.debugMessageCommand = command;
        } else {
            console.warn(`${getTimestamp()} Le handler debug ne fournit pas handleMessage.`);
        }
    } catch (err) {
        console.error(`${getTimestamp()} Impossible de charger le handler debug :`, err.stack ?? err);
    }
}

function loadCommands(clearCache = false) {
    client.commands.clear();
    commandsToDeploy.length = 0;

    for (const file of fs.readdirSync(commandsPath)) {
        if (!file.endsWith('.js')) continue;

        const commandPath = path.join(commandsPath, file);
        if (clearCache) delete require.cache[require.resolve(commandPath)];

        let command;
        try {
            command = require(commandPath);
        } catch (err) {
            console.error(`${getTimestamp()} Impossible de charger la commande ${file} :`, err.stack ?? err);
            continue;
        }

        const { data, execute } = command ?? {};
        if (!data?.name || typeof execute !== 'function' || typeof data.toJSON !== 'function') {
            console.warn(`${getTimestamp()} La commande ${file} est invalide (data/execute manquant), ignorée.`);
            continue;
        }

        const configFlag = commandFeatureFlags[data.name];
        if (configFlag && !config[configFlag]) continue;

        client.commands.set(data.name, command);
        commandsToDeploy.push(data.toJSON());
    }

    loadDebugMessageCommand(clearCache);
}

loadCommands();

async function deployCommands() {
    console.log(`${client.getTimestamp()} Chargement des commandes...`);
    try {
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandsToDeploy });
        console.log(`${client.getTimestamp()} Commandes chargées avec succès !`);
        return true;
    } catch (err) {
        await client.notifyOwner(`${client.getTimestamp()} Erreur au chargement des commandes : \`${sanitizeText(err.message, 300)}\``);
        return false;
    }
}

client.reloadCommands = async () => {
    loadCommands(true);
    if (!await deployCommands()) throw new Error('Le déploiement des commandes auprès de Discord a échoué.');
    return commandsToDeploy.length;
};

function notifyUnauthorized(interaction) {
    return client.notifyOwner(
        `⚠️ **Tentative d'accès non autorisé**\n` +
        `• **Pseudo :** \`${sanitizeText(interaction.user.displayName)}\`\n` +
        `• **Nom d'utilisateur :** \`${sanitizeText(interaction.user.username)}\`\n` +
        `• **ID:** \`${interaction.user.id}\`\n` +
        `• **Commande:** \`/${sanitizeText(interaction.commandName)}\``
    );
}

client.on(Events.InteractionCreate, async interaction => {
    try {
        if (!isReady) return;

        // Seules les commandes slash et l'autocomplétion nous concernent ici
        // (boutons / menus sont gérés par les collectors de chaque commande, filtrés sur l'utilisateur d'origine).
        if (!interaction.isChatInputCommand() && !interaction.isAutocomplete()) return;

        if (!authorizedUsers.includes(interaction.user.id)) {
            await notifyUnauthorized(interaction);
            return;
        }

        if (interaction.guildId && blacklistedGuilds.includes(interaction.guildId)) return;

        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        if (interaction.isAutocomplete()) {
            if (command.autocomplete) {
                try {
                    await command.autocomplete(interaction, client);
                } catch (err) {
                    console.error(err);
                }
            }
            return;
        }

        console.log(`${getTimestamp()} L'utilisateur ${sanitizeText(interaction.user.displayName)} (${interaction.user.id}) a exécuté la commande /${sanitizeText(interaction.commandName)}.`);
        try {
            await command.execute(interaction, client);
        } catch (error) {
            console.error(error);
            await client.sendError(interaction).catch(console.error);
        }
    } catch (err) {
        handleGlobalEvent('Erreur InteractionCreate', err);
    }
});

client.on(Events.MessageCreate, message => {
    if (!isReady || !client.debugMessageCommand) return;

    client.debugMessageCommand.handleMessage(message, client).catch(err =>
        handleGlobalEvent('Erreur commande debug privée', err)
    );
});

async function runRefreshCycle() {
    // Garde anti-chevauchement : si le cycle précédent n'est pas fini (réseau lent...), on n'en lance pas un autre
    if (isRefreshRunning) {
        console.warn(`${getTimestamp()} Cycle précédent encore en cours, celui-ci est ignoré.`);
        return;
    }
    isRefreshRunning = true;
    try {
        refreshCycleCount++;
        console.log(`${getTimestamp()} Cycle ${refreshCycleCount}/${config.maxRefreshCycleCountBeforeRenew}`);

        // Renouvellement d'IP : uniquement si Tor est activé dans la config
        if (torEnabled && refreshCycleCount >= config.maxRefreshCycleCountBeforeRenew) {
            refreshCycleCount = 0;
            await renewTorIp(TOR_PASSWORD, config, logsFolderPath).catch(() => {});
        }
        await client.fetchMapData();
    } catch (err) {
        handleGlobalEvent('Erreur cycle de synchronisation', err);
    } finally {
        isRefreshRunning = false;
    }
}

client.once(Events.ClientReady, async () => {
    try {
        console.log(`${client.getTimestamp()} Démarrage en cours...`);

        let torReady = !torEnabled;
        if (torEnabled) {
            try {
                torReady = Boolean(await renewTorIp(TOR_PASSWORD, config, logsFolderPath));
            } catch (err) {
                console.error(`${getTimestamp()} Renouvellement d'IP Tor impossible au démarrage :`, err.message);
            }
            if (!torReady) {
                console.error(`${getTimestamp()} Tor indisponible : le rafraîchissement automatique de la map est désactivé.`);
                await client.notifyOwner('⚠️ Tor n’a pas pu démarrer. Le rafraîchissement automatique de la map et les backups automatiques sont désactivés.');
            }
        }

        if (commandsToDeploy.length > 0) await deployCommands();
        if (config.enableMessageCleanup) await clearBotMessages(client, authorizedUsers);

        const autoRefreshEnabled = config.enableAutoClaimRefresh && torReady;
        if (autoRefreshEnabled) {
            await client.fetchMapData();

            const cooldownMs = config.autoClaimRefreshCooldown * 60000;
            setInterval(runRefreshCycle, cooldownMs);
        }

        if (config.enableBackups && autoRefreshEnabled) {
            await createBackup(client);
        }

        console.log(`${client.getTimestamp()} Démarrage terminé ! Connecté en tant que ${client.user.tag}.`);
    } catch (err) {
        handleGlobalEvent('Erreur au démarrage', err);
    } finally {
        // Dans tous les cas le bot doit devenir utilisable (avant : une erreur ici le laissait muet à jamais)
        isReady = true;
    }
});

client.login(TOKEN).catch(err => handleGlobalEvent('Échec de connexion à Discord', err, true));
