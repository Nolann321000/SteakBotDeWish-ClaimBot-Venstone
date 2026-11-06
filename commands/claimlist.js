const {
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
} = require('discord.js');
const { promises: fsPromises } = require('node:fs');
const path = require('node:path');
const { collectComponents } = require('../utils/discordUtils');
const config = require('../config.json');

const ADMIN_CLAIM_NAME = 'claim administratif';

const PERM_REGEX_MAP = {
    trust: /Membre\(s\)\s*:\s*<span[^>]*>(.*?)<\/span>/i,
    containertrust: /Accès aux coffres\s*:\s*<span[^>]*>(.*?)<\/span>/i,
    accesstrust: /Accès aux boutons\s*:\s*<span[^>]*>(.*?)<\/span>/i,
    permissiontrust: /Gérant\(s\)\s*:\s*<span[^>]*>(.*?)<\/span>/i,
    owner: null
};

const PERM_TITLE_MAP = {
    trust: "Claim(s) où {user} est Membre",
    containertrust: "Claim(s) où {user} a Accès aux coffres",
    accesstrust: "Claim(s) où {user} a Accès aux boutons",
    permissiontrust: "Claim(s) où {user} est Gérant",
    owner: "Claim(s) de {user}"
};

const cleanHTML = (text) => text.replace(/<[^>]+>/g, '').trim();

function getClaimArea(marker) {
    const [first, second] = marker?.points ?? [];
    if (![first?.x, first?.z, second?.x, second?.z].every(Number.isFinite)) return null;

    return (Math.abs(first.x - second.x) + 1) * (Math.abs(first.z - second.z) + 1);
}

function getClaimCenter(marker) {
    const [first, second] = marker?.points ?? [];
    if ([first?.x, first?.z, second?.x, second?.z].every(Number.isFinite)) {
        return { x: (first.x + second.x) / 2, z: (first.z + second.z) / 2 };
    }

    const x = marker?.x ?? marker?.point?.x;
    const z = marker?.z ?? marker?.point?.z;
    return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
}

function distanceFromOrigin(claim) {
    return Number.isFinite(claim.x) && Number.isFinite(claim.z)
        ? Math.hypot(claim.x, claim.z)
        : Infinity;
}

function buildAdvancedClaimPages(claims) {
    const categories = [
        { title: 'X+ / Z+', matches: claim => claim.x >= 0 && claim.z >= 0 },
        { title: 'X- / Z+', matches: claim => claim.x < 0 && claim.z >= 0 },
        { title: 'X- / Z-', matches: claim => claim.x < 0 && claim.z < 0 },
        { title: 'X+ / Z-', matches: claim => claim.x >= 0 && claim.z < 0 },
    ];
    const pages = [];

    for (const category of categories) {
        const categoryClaims = claims
            .filter(claim => Number.isFinite(claim.x) && Number.isFinite(claim.z) && category.matches(claim))
            .sort((a, b) => distanceFromOrigin(a) - distanceFromOrigin(b));
        const categoryLines = [
            `**${category.title}**`,
            ...(categoryClaims.length ? categoryClaims.map(claim => claim.line) : ['Aucun claim dans ce quadrant.']),
        ];
        const categoryPages = buildPages(categoryLines, Number.MAX_SAFE_INTEGER);
        pages.push(categoryPages[0]);
        for (const continuation of categoryPages.slice(1)) {
            pages.push([`**${category.title} (suite)**`, ...continuation]);
        }
    }

    const unknownClaims = claims.filter(claim => !Number.isFinite(claim.x) || !Number.isFinite(claim.z));
    if (unknownClaims.length > 0) {
        const unknownPages = buildPages([
            '**Coordonnées inconnues**',
            ...unknownClaims.map(claim => claim.line),
        ], Number.MAX_SAFE_INTEGER);
        pages.push(...unknownPages);
    }

    return pages;
}

function groupNearbyClaims(claims, maxDistance = 100) {
    const groups = [];

    for (const claim of claims) {
        if (!Number.isFinite(claim.x) || !Number.isFinite(claim.z)) {
            groups.push([claim]);
            continue;
        }

        let closestGroup = null;
        let closestDistance = Infinity;
        for (const group of groups) {
            if (!group.every(member => Number.isFinite(member.x) && Number.isFinite(member.z))) continue;

            const distances = group.map(member => Math.hypot(claim.x - member.x, claim.z - member.z));
            if (distances.some(distance => distance >= maxDistance)) continue;

            const averageDistance = distances.reduce((total, distance) => total + distance, 0) / distances.length;
            if (averageDistance < closestDistance) {
                closestGroup = group;
                closestDistance = averageDistance;
            }
        }

        if (closestGroup) closestGroup.push(claim);
        else groups.push([claim]);
    }

    return groups.map(group => {
        if (group.length === 1) return group[0];

        const x = group.reduce((total, claim) => total + claim.x, 0) / group.length;
        const z = group.reduce((total, claim) => total + claim.z, 0) / group.length;
        const mapX = Math.round(x);
        const mapZ = Math.round(z);
        const url = `https://map.venstone.xyz/#minecraft_overworld;flat;${mapX},64,${mapZ};4`;
        return { x, z, line: `📍 [Groupe de ${group.length} claims](${url})` };
    }).sort((a, b) => distanceFromOrigin(a) - distanceFromOrigin(b));
}

/**
 * L'option "backup" est du texte libre côté Discord (l'autocomplétion n'est qu'une suggestion) :
 * sans contrôle, "../config.json" ou "../../etc/xxx" permettait de lire n'importe quel fichier .json du serveur.
 * On n'accepte qu'un nom de fichier .json situé directement dans le dossier des backups.
 */
function resolveBackupPath(backupDir, fileName) {
    if (typeof fileName !== 'string' || !fileName.endsWith('.json') || path.basename(fileName) !== fileName || fileName.includes('\0')) {
        throw new Error(`Nom de backup refusé : "${String(fileName).slice(0, 80)}"`);
    }
    const root = path.resolve(backupDir);
    const full = path.resolve(root, fileName);
    if (path.dirname(full) !== root) throw new Error('Backup hors du dossier autorisé');
    return full;
}

function logError(tag, err) {
    console.error(`[claimlist] ${tag}:`, err?.message ?? err, err?.rawError?.errors ?? '');
}

// Découpe les claims en pages de `limit` lignes maximum ET de moins de 4000 caractères
// (limite Discord : 4096 dans la description d'un embed, sinon l'envoi échoue).
function buildPages(claims, limit) {
    const pages = [];
    let current = [];
    let length = 0;
    for (const line of claims) {
        const added = line.length + 1;
        if (current.length > 0 && (current.length >= limit || length + added > 4000)) {
            pages.push(current);
            current = [];
            length = 0;
        }
        current.push(line.length > 1000 ? line.slice(0, 999) + '…' : line);
        length += added;
    }
    if (current.length > 0) pages.push(current);
    return pages;
}

function buildPageEmbed({ title, color, thumbnail, footerPrefix, claimCount, pages }, page, totalPages) {
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(String(title).slice(0, 256))
        .setThumbnail(thumbnail)
        .setDescription(pages[page].join('\n'));

    const footerParts = [`${footerPrefix}Total : ${claimCount} claims`];
    if (totalPages > 1) footerParts.push(`Page ${page + 1} / ${totalPages}`);
    embed.setFooter({ text: footerParts.join(' • ') });

    return embed;
}

function buildPaginationRow(interactionId, page, totalPages, isGrouped) {
    const buttons = [];

    if (totalPages > 1) {
        buttons.push(new ButtonBuilder()
            .setCustomId(`claimlist-prev-${interactionId}`)
            .setLabel('◀')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0));
    }

    buttons.push(new ButtonBuilder()
        .setCustomId(`claimlist-group-${interactionId}`)
        .setLabel(isGrouped ? 'Mode Avancé' : 'Mode simple')
        .setStyle(ButtonStyle.Secondary));

    if (totalPages > 1) {
        buttons.push(new ButtonBuilder()
            .setCustomId(`claimlist-next-${interactionId}`)
            .setLabel('▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === totalPages - 1));
    }

    return new ActionRowBuilder().addComponents(buttons);
}

const data = new SlashCommandBuilder()
    .setName('claimlist')
    .setDescription("Affiche la liste des claims pour un joueur en fonction d'une permission.")
    .addStringOption(opt => opt.setName('pseudo').setDescription('Le pseudo du joueur').setRequired(true).setMinLength(1).setMaxLength(32))
    .addStringOption(opt => opt.setName('permission').setDescription('Type de permission recherchée').addChoices(
        { name: 'Propriétaire', value: 'owner' },
        { name: 'Gérant', value: 'permissiontrust' },
        { name: 'Membre', value: 'trust' },
        { name: 'Accès aux coffres', value: 'containertrust' },
        { name: 'Accès aux boutons', value: 'accesstrust' }
    ));

if (config.enableBackups) {
    data.addStringOption(opt => 
        opt.setName('backup')
           .setDescription('Backup dans laquelle le bot fera sa recherche')
           .setAutocomplete(true)
           .setMaxLength(100)
    );
}

data
    .setIntegrationTypes([0, 1])
    .setContexts([0, 1, 2]);

module.exports = {
    data: data,
    
    async autocomplete(interaction, client) {
        try {
            const focusedValue = interaction.options.getFocused().toLowerCase();
            const files = await fsPromises.readdir(client.backupDir);
            const filtered = files
                .filter(f => f.endsWith('.json') && f.toLowerCase().includes(focusedValue))
                .sort((a, b) => b.localeCompare(a))
                .slice(0, 25)
                .map(f => ({ name: f, value: f }));
            return interaction.respond(filtered);
        } catch (err) {
            return interaction.respond([]);
        }
    },

    async execute(interaction, client) {
        const username = interaction.options.getString('pseudo').trim();
        const permission = interaction.options.getString('permission') || 'owner';
        const backupFile = interaction.options.getString('backup');

        if (username.toLowerCase() === ADMIN_CLAIM_NAME && permission !== 'owner') {
            return interaction.reply({ content: `❌ Vous ne pouvez pas faire ça !`, flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            let dataSource;
            
            if (backupFile) {
                try {
                    dataSource = JSON.parse(await fsPromises.readFile(resolveBackupPath(client.backupDir, backupFile), 'utf8'));
                } catch (err) {
                    console.error(`${client.getTimestamp()} Impossible de lire la backup "${backupFile}" :`, err.message);
                    return client.sendError(interaction);
                }
            } else {
                if (!client.mapCache) {
                    try {
                        client.mapCache = JSON.parse(await fsPromises.readFile(client.mainFilePath, 'utf8'));
                    } catch (err) {
                        console.error(`${client.getTimestamp()} Impossible de lire le fichier principal :`, err.message);
                        return client.sendError(interaction);
                    }
                }
                dataSource = client.mapCache;
            }

            const layer = Array.isArray(dataSource) ? dataSource.find(l => l.id === "griefprevention") : (dataSource?.id === "griefprevention" ? dataSource : null);
            if (!layer?.markers) return client.sendError(interaction);

            if (!Object.hasOwn(PERM_TITLE_MAP, permission)) return client.sendError(interaction);
            const regex = PERM_REGEX_MAP[permission];
            // fonction de remplacement : évite l'interprétation des motifs spéciaux ($&, $', ...) présents dans le pseudo
            const baseTitle = PERM_TITLE_MAP[permission].replace('{user}', () => username);
            const prefix = backupFile ? `[Backup] ` : "";
            const isAdminClaim = username.toLowerCase() === ADMIN_CLAIM_NAME;
            const embedTitle = isAdminClaim ? `${prefix}Claim(s) Administratif(s)` : `${prefix}${baseTitle}`;
            
            const lowerUsername = username.toLowerCase();
            const foundClaims = [];

            for (const m of Object.values(layer.markers)) {
                if (!m) continue;
                const html = String(m.popup || "");
                const ownerMatch = html.match(/Propriétaire\s*:\s*<span[^>]*>(.*?)<\/span>/i);
                const ownerName = ownerMatch ? cleanHTML(ownerMatch[1]) : "Claim administratif";

                let isMatched = false;
                if (permission === 'owner') {
                    isMatched = ownerName.toLowerCase() === lowerUsername;
                } else {
                    const match = html.match(regex);
                    isMatched = match && cleanHTML(match[1]).toLowerCase().split(/,\s*/).includes(lowerUsername);
                }

                if (isMatched) {
                    const center = getClaimCenter(m);
                    const x = Math.round(center?.x ?? 0);
                    const z = Math.round(center?.z ?? 0);
                    const urlLink = `📍 [X: ${x}, Z: ${z}](https://map.venstone.xyz/#minecraft_overworld;flat;${x},64,${z};4)`;

                    foundClaims.push({
                        area: getClaimArea(m),
                        x: center?.x ?? null,
                        z: center?.z ?? null,
                        line: permission === 'owner' ? urlLink : `${urlLink} • Propriétaire : **${ownerName}**`,
                    });
                }
            }

            if (!foundClaims.length) {
                return interaction.editReply(`🔎 Aucun claim trouvé pour "**${username}**" avec cette permission.`);
            }

            foundClaims.sort((a, b) => distanceFromOrigin(a) - distanceFromOrigin(b));
            const claimLines = foundClaims.map(claim => claim.line);
            const groupedClaimLines = groupNearbyClaims(foundClaims, 100).map(claim => claim.line);
            const limit = config.maxLinkPerEmbed;
            let isGrouped = true;
            const groupedPages = buildPages(groupedClaimLines, limit);
            const advancedPages = buildAdvancedClaimPages(foundClaims);
            let pages = groupedPages;
            let page = 0;

            const avatarName = isAdminClaim ? 'Limeen_' : encodeURIComponent(username);
            const view = {
                title: embedTitle,
                color: backupFile ? '#7289DA' : '#FFA500',
                thumbnail: `https://mc-heads.net/avatar/${avatarName}/100`,
                footerPrefix: backupFile ? `Backup : ${backupFile} • ` : "",
                claimCount: claimLines.length,
            };

            const message = await interaction.editReply({
                embeds: [buildPageEmbed({ ...view, pages }, page, pages.length)],
                components: [buildPaginationRow(interaction.id, page, pages.length, isGrouped)],
            });

            collectComponents(message, interaction, async btn => {
                if (btn.customId === `claimlist-group-${interaction.id}`) {
                    isGrouped = !isGrouped;
                    pages = isGrouped ? groupedPages : advancedPages;
                    page = 0;
                } else if (btn.customId === `claimlist-next-${interaction.id}`) {
                    page = Math.min(page + 1, pages.length - 1);
                } else if (btn.customId === `claimlist-prev-${interaction.id}`) {
                    page = Math.max(page - 1, 0);
                }

                await btn.update({
                    embeds: [buildPageEmbed({ ...view, pages }, page, pages.length)],
                    components: [buildPaginationRow(interaction.id, page, pages.length, isGrouped)],
                });
            }, err => logError('pagination', err), ComponentType.Button);
        } catch (err) {
            console.error(`${client.getTimestamp()} Une erreur est survenue lors de l'exécution de la commande /claimlist :`, err);
            client.sendError(interaction); 
        }
    }
};