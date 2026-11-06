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
const { collectComponents } = require('../utils/discordUtils');

const ADMIN_CLAIM_NAME = 'claim administratif';
const OWNER_REGEX = /Propriétaire\s*:\s*<span[^>]*>(.*?)<\/span>/i;

function escapeMarkdown(value) {
    return String(value).replace(/([\\`*_{}\[\]()#+\-.!|>~])/g, '\\$1');
}

function findGriefLayer(data) {
    if (Array.isArray(data)) return data.find(layer => layer?.id === 'griefprevention');
    return data?.id === 'griefprevention' ? data : null;
}

function getClaimArea(marker) {
    const [first, second] = marker?.points ?? [];
    if (![first?.x, first?.z, second?.x, second?.z].every(Number.isFinite)) return null;

    return (Math.abs(first.x - second.x) + 1) * (Math.abs(first.z - second.z) + 1);
}

function buildRankingEmbed(ranking, sortByArea, page, pageSize, formatNumber) {
    const totalPages = Math.max(1, Math.ceil(ranking.length / pageSize));
    const pageOwners = ranking.slice(page * pageSize, (page + 1) * pageSize);
    const description = pageOwners.length
        ? pageOwners.map((owner, index) => {
            const rank = page * pageSize + index + 1;
            const area = owner.measuredClaims
                ? `${formatNumber.format(owner.area)}${owner.measuredClaims < owner.count ? '*' : ''} blocs²`
                : 'N/D';
            return `**#${rank}** ${escapeMarkdown(owner.name)} · ${owner.count} claims · ${area}`;
        }).join('\n')
        : 'Aucun propriétaire de joueur trouvé.';

    return new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle(sortByArea ? 'Classement par surface claim' : 'Classement par nombre de claims')
        .setDescription(description)
        .setFooter({ text: `Page ${page + 1} / ${totalPages} • ${ranking.length} joueurs` });
}

function buildStatsRow(interactionId, page, totalPages, sortByArea) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`stats-prev-${interactionId}`)
            .setLabel('◀')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0 || totalPages <= 1),
        new ButtonBuilder()
            .setCustomId(`stats-sort-${interactionId}`)
            .setLabel(sortByArea ? 'Trier par nombre' : 'Trier par surface')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`stats-next-${interactionId}`)
            .setLabel('▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages - 1),
    );
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Affiche les statistiques et le classement des claims du serveur.')
        .setIntegrationTypes([0, 1])
        .setContexts([0, 1, 2]),

    async execute(interaction, client) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            if (!client.mapCache) {
                client.mapCache = JSON.parse(await fsPromises.readFile(client.mainFilePath, 'utf8'));
            }

            const layer = findGriefLayer(client.mapCache);
            if (!layer?.markers || typeof layer.markers !== 'object') {
                return client.sendError(interaction);
            }

            const claims = Object.values(layer.markers).filter(Boolean);
            const owners = new Map();
            let administrativeClaims = 0;
            let administrativeClaimArea = 0;

            for (const marker of claims) {
                const claimArea = getClaimArea(marker);
                const match = String(marker.popup || '').match(OWNER_REGEX);
                const ownerName = match
                    ? match[1]
                        .replace(/<[^>]+>/g, '')
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&quot;/g, '"')
                        .replace(/&#39;|&apos;/g, "'")
                        .trim()
                    : '';
                if (!ownerName || ownerName.toLowerCase() === ADMIN_CLAIM_NAME) {
                    administrativeClaims++;
                    if (claimArea !== null) administrativeClaimArea += claimArea;
                    continue;
                }

                const key = ownerName;
                const owner = owners.get(key) || { name: ownerName, count: 0, area: 0, measuredClaims: 0 };
                owner.count++;
                if (claimArea !== null) {
                    owner.area += claimArea;
                    owner.measuredClaims++;
                }
                owners.set(key, owner);
            }

            const claimCountRanking = [...owners.values()]
                .sort((a, b) => b.count - a.count || b.area - a.area || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
            const areaRanking = [...owners.values()]
                .sort((a, b) => b.area - a.area || b.count - a.count || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
            const playerClaimCount = claimCountRanking.reduce((total, owner) => total + owner.count, 0);
            const playerClaimArea = areaRanking.reduce((total, owner) => total + owner.area, 0);
            const formatNumber = new Intl.NumberFormat('fr-FR');

            const globalEmbed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('Statistiques générales')
                .addFields(
                    { name: 'Claims au total', value: formatNumber.format(claims.length), inline: true },
                    { name: 'Propriétaires uniques', value: formatNumber.format(owners.size), inline: true },
                    { name: 'Claims de joueurs', value: formatNumber.format(playerClaimCount), inline: true },
                    { name: 'Claims administratifs', value: formatNumber.format(administrativeClaims), inline: true },
                    { name: 'Surface des claims joueurs', value: `${formatNumber.format(playerClaimArea)} blocs²`, inline: true },
                    { name: 'Surface des claims admin', value: `${formatNumber.format(administrativeClaimArea)} blocs²`, inline: true }
                );

            const pageSize = 15;
            let page = 0;
            let sortByArea = false;
            const currentRanking = () => sortByArea ? areaRanking : claimCountRanking;
            const totalPages = () => Math.max(1, Math.ceil(currentRanking().length / pageSize));
            const message = await interaction.editReply({
                embeds: [globalEmbed, buildRankingEmbed(claimCountRanking, false, page, pageSize, formatNumber)],
                components: owners.size ? [buildStatsRow(interaction.id, page, totalPages(), sortByArea)] : [],
            });

            if (!owners.size) return;

            collectComponents(message, interaction, async button => {
                if (button.customId === `stats-sort-${interaction.id}`) {
                    sortByArea = !sortByArea;
                    page = 0;
                } else if (button.customId === `stats-next-${interaction.id}`) {
                    page = Math.min(page + 1, totalPages() - 1);
                } else if (button.customId === `stats-prev-${interaction.id}`) {
                    page = Math.max(page - 1, 0);
                }

                await button.update({
                    embeds: [globalEmbed, buildRankingEmbed(currentRanking(), sortByArea, page, pageSize, formatNumber)],
                    components: [buildStatsRow(interaction.id, page, totalPages(), sortByArea)],
                });
            }, err => console.error(`[stats] Erreur de pagination :`, err?.message ?? err), ComponentType.Button);
        } catch (err) {
            console.error(`${client.getTimestamp()} Erreur lors de l'exécution de /stats :`, err);
            return client.sendError(interaction);
        }
    },
};