const { MessageFlags } = require('discord.js');
const { getTimestamp } = require('./logger');

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const NO_MENTIONS = { parse: [] };

// Réessaie l'envoi d'un DM en cas de panne réseau (EAI_AGAIN, timeout...).
// Les erreurs de l'API Discord (code numérique, ex. MP fermés) ne sont pas réessayées.
async function sendWithRetry(user, message, retries = 5, baseDelayMs = 5000) {
    const payload = typeof message === 'string'
        ? { content: message.slice(0, 2000), allowedMentions: NO_MENTIONS }
        : { allowedMentions: NO_MENTIONS, ...message };

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await user.send(payload);
        } catch (err) {
            if (typeof err.code === 'number' || attempt === retries) throw err;
            const delay = baseDelayMs * 2 ** (attempt - 1);
            console.warn(`${getTimestamp()} Envoi Discord à ${user.id} échoué (${err.message}), tentative ${attempt}/${retries}, nouvel essai dans ${delay / 1000}s...`);
            await sleep(delay);
        }
    }
}

async function sendError(interaction, message = "❌ Une erreur est survenue lors de l'exécution de la commande !") {
    const payload = { content: message, flags: MessageFlags.Ephemeral };
    return interaction.deferred || interaction.replied ? interaction.editReply(payload) : interaction.reply(payload);
}

async function notifyOwner(client, ownerId, message) {
    try {
        if (!ownerId) throw new Error('OWNER_ID non défini');
        const owner = client.users.cache.get(ownerId) || await client.users.fetch(ownerId);
        await sendWithRetry(owner, message);
    } catch (err) {
        console.error(`${getTimestamp()} Erreur lors de l'envoi d'un avertissement au propriétaire :`, err.message);
    }
}

/** Neutralise le markdown/retours à la ligne d'une valeur contrôlée par un utilisateur avant de l'insérer dans un message ou un log. */
function sanitizeText(value, maxLength = 64) {
    return String(value ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[`*_~|>\\]/g, '')
        .slice(0, maxLength);
}

/** Découpe une liste de lignes en messages de moins de `maxLength` caractères. */
function chunkLines(lines, maxLength = 1900) {
    const chunks = [];
    let current = '';
    for (const line of lines) {
        const safeLine = line.length > maxLength ? line.slice(0, maxLength - 1) + '…' : line;
        const next = current ? `${current}\n${safeLine}` : safeLine;
        if (next.length > maxLength) {
            if (current) chunks.push(current);
            current = safeLine;
        } else {
            current = next;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

async function clearBotMessages(client, authorizedUsers) {
    console.log(`${getTimestamp()} Nettoyage des messages privés du bot...`);
    const userIds = Array.isArray(authorizedUsers) ? authorizedUsers : [];

    for (const userId of userIds) {
        try {
            const user = await client.users.fetch(userId);
            const channel = await user.createDM();
            const fetched = await channel.messages.fetch({ limit: 100 });

            const botMessages = fetched.filter(msg => msg.author.id === client.user.id);
            // allSettled : un message impossible à supprimer ne bloque pas les autres
            // (discord.js gère lui-même la file des rate limits)
            await Promise.allSettled(botMessages.map(msg => msg.delete()));
        } catch (err) {
            console.error(`${getTimestamp()} Impossible de nettoyer les messages pour l'utilisateur "${userId}" :`, err.message);
        }
    }
    console.log(`${getTimestamp()} Nettoyage des messages terminé !`);
}

function collectComponents(message, interaction, onCollect, onError, componentType, onEnd = () => interaction.editReply({ components: [] })) {
    const options = {
        time: 5 * 60 * 1000,
        filter: component => component.user.id === interaction.user.id,
    };
    if (componentType) options.componentType = componentType;

    const collector = message.createMessageComponentCollector(options);
    collector.on('collect', async component => {
        try {
            await onCollect(component);
        } catch (err) {
            onError(err);
        }
    });
    collector.on('end', async () => {
        try { await onEnd(); } catch {}
    });
}

module.exports = { sendWithRetry, sendError, notifyOwner, clearBotMessages, sanitizeText, chunkLines, collectComponents };
