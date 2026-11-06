const {
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
} = require('discord.js');
const { getEntriesByDate, getAllDates, getPlayerEntries, getAllOwners } = require('../utils/unclaimHistory');
const { collectComponents } = require('../utils/discordUtils');
const config = require('../config.json');

function logError(tag, err) {
    console.error(`[checkunclaim] ${tag}:`, err?.message ?? err, err?.rawError?.errors ?? '');
}

function parseDate(input) {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input);
    if (!match) return null;

    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const year = parseInt(match[3], 10);

    const date = new Date(year, month - 1, day);
    if (
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day
    ) {
        return null;
    }
    return date;
}

function buildCoordPages(coordLines) {
    const pages = [];
    let current = '';
    for (const line of coordLines) {
        const next = current ? current + '\n' + line : line;
        if (next.length > 1024) {
            if (current) pages.push(current);
            current = line;
        } else {
            current = next;
        }
    }
    if (current) pages.push(current);
    return pages;
}

function buildCoordLines(markers) {
    return [...(markers ?? [])]
        .sort((a, b) => (b?.area ?? -1) - (a?.area ?? -1))
        .map(m => {
            const label = m.label ? `**${String(m.label).replace(/[*_`~|>\\]/g, '').slice(0, 100)}** — ` : '';
            const coords = (m.x != null && m.z != null)
                ? `📍 [X: ${m.x}, Z: ${m.z}](https://map.venstone.xyz/#minecraft_overworld;flat;${m.x},64,${m.z};4)`
                : '*Coordonnées inconnues*';
            const area = Number.isFinite(m.area) ? `${new Intl.NumberFormat('fr-FR').format(m.area)} blocs²` : 'Taille inconnue';
            return `${label}${coords} • ${area}`;
        });
}

function buildGroupedCoordLines(markers, maxDistance = 100) {
    const claims = (markers ?? []).map((marker, index) => ({
        x: marker?.x,
        z: marker?.z,
        area: Number.isFinite(marker?.area) ? marker.area : null,
        line: buildCoordLines([marker])[0] ?? `Claim ${index + 1}`,
    }));
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

    return groups
        .map(group => ({
            group,
            area: group.reduce((total, claim) => total + (claim.area ?? 0), 0),
        }))
        .sort((a, b) => b.area - a.area)
        .map(({ group, area }) => {
            if (group.length === 1) return group[0].line;

            const x = Math.round(group.reduce((total, claim) => total + claim.x, 0) / group.length);
            const z = Math.round(group.reduce((total, claim) => total + claim.z, 0) / group.length);
            const measuredAreas = group.filter(claim => claim.area !== null).length;
            const areaLabel = measuredAreas === 0
                ? 'surface inconnue'
                : `${measuredAreas < group.length ? '≥ ' : ''}${new Intl.NumberFormat('fr-FR').format(area)} blocs²`;
            const url = `https://map.venstone.xyz/#minecraft_overworld;flat;${x},64,${z};4`;
            return `📍 [Groupe de ${group.length} claims](${url}) • ${areaLabel}`;
        });
}

function buildCoordPagesForMode(markers, isGrouped) {
    const coordLines = isGrouped ? buildGroupedCoordLines(markers) : buildCoordLines(markers);
    return buildCoordPages(coordLines.length > 0 ? coordLines : ['*Aucune coordonnée disponible*']);
}

function buildPlayerEmbed(entry, pages, page, totalPages) {
    const date = new Date(entry.date);
    const currentPage = pages[page] ?? '*Aucune coordonnée disponible*';

    const embed = new EmbedBuilder()
        .setColor('#e74c3c')
        .setTitle(`Vue d'ensemble de l'unclaim de ${entry.owner}`)
        .setThumbnail(`https://mc-heads.net/avatar/${encodeURIComponent(entry.owner)}/100`)
        .addFields(
            { name: '⌚️ Date de l\'unclaim', value: `<t:${Math.floor(date.getTime() / 1000)}:F>`, inline: true },
            { name: '🏴 Zones unclaim', value: `\`${entry.claimsLost}\``, inline: true },
            { name: 'Coordonnées :', value: currentPage },
        );

    if (totalPages > 1) {
        embed.setFooter({ text: `Page ${page + 1} / ${totalPages}` });
    }

    return embed;
}

function buildPaginationRow(interactionId, page, totalPages, isGrouped) {
    const buttons = [];

    if (totalPages > 1) {
        buttons.push(new ButtonBuilder()
            .setCustomId(`coords-prev-${interactionId}`)
            .setLabel('◀')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0));
    }

    buttons.push(new ButtonBuilder()
        .setCustomId(`coords-mode-${interactionId}`)
        .setLabel(isGrouped ? 'Mode Avancé' : 'Mode simple')
        .setStyle(ButtonStyle.Secondary));

    if (totalPages > 1) {
        buttons.push(new ButtonBuilder()
            .setCustomId(`coords-next-${interactionId}`)
            .setLabel('▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === totalPages - 1));
    }

    return new ActionRowBuilder().addComponents(buttons);
}

function buildSelectRow(customId, selectOptions) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder('Sélectionne un pseudo pour voir plus de détails')
            .addOptions(selectOptions)
    );
}

// Les valeurs sont des index (et non des pseudos) pour éviter COMPONENT_OPTION_VALUE_DUPLICATED
// quand un même joueur apparaît plusieurs fois à la même date.
function buildEntryOptions(entries) {
    return entries.slice(0, 25).map((e, idx) => {
        const time = new Date(e.date).toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Europe/Paris',
        });
        return {
            label: e.owner,
            description: `${time} — ${e.claimsLost} Zone(s) unclaim${e.usernameChange ? ' — Changement de compte' : ''}`,
            value: String(idx),
        };
    });
}

function buildDateBrowseEmbed(dateStr, entries, dateIndex, totalDates, client) {
    const lines = entries.map(e => {
        const ts = Math.floor(new Date(e.date).getTime() / 1000);
        return `• **${e.owner}** — \`${e.claimsLost}\` Zone(s) unclaim — <t:${ts}:t>`;
    });

    const totalZones = entries.reduce((sum, e) => sum + e.claimsLost, 0);

    const embed = new EmbedBuilder()
        .setColor('#e74c3c')
        .setTitle(`Vue d'ensemble du ${dateStr}`)
        .setThumbnail(client.user.displayAvatarURL())
        .addFields(
            { name: '👥 Nombre d\'unclaims', value: `\`${entries.length}\``, inline: true },
            { name: '🏴 Zones totales unclaim', value: `\`${totalZones}\``, inline: true },
            { name: 'Joueurs :', value: lines.join('\n').slice(0, 1024) || '*Aucun unclaim*' },
        );

    if (entries.length > 25) {
        embed.setFooter({
            text: `Seuls les 25 premiers joueurs sont sélectionnables ci-dessous (${entries.length} au total).`,
        });
    } else {
        embed.setFooter({ text: `Date : ${dateStr} (${dateIndex + 1} / ${totalDates})` });
    }

    return embed;
}

function buildDateNavRow(interactionId, dateIndex, totalDates) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`date-prev-${interactionId}`)
            .setLabel('◀')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(dateIndex === 0),
        new ButtonBuilder()
            .setCustomId(`date-next-${interactionId}`)
            .setLabel('▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(dateIndex === totalDates - 1),
    );
}

async function sendPaginatedEntry(i, entry) {
    let isGrouped = true;
    let pages = buildCoordPagesForMode(entry.markers, isGrouped);
    let page = 0;

    const reply = await i.followUp({
        embeds: [buildPlayerEmbed(entry, pages, page, pages.length)],
        components: [buildPaginationRow(i.id, page, pages.length, isGrouped)],
        flags: MessageFlags.Ephemeral,
    });

    collectComponents(reply, i, async btn => {
        if (btn.customId === `coords-mode-${i.id}`) {
            isGrouped = !isGrouped;
            pages = buildCoordPagesForMode(entry.markers, isGrouped);
            page = 0;
        } else if (btn.customId === `coords-next-${i.id}`) {
            page = Math.min(page + 1, pages.length - 1);
        } else if (btn.customId === `coords-prev-${i.id}`) {
            page = Math.max(page - 1, 0);
        }

        await btn.update({
            embeds: [buildPlayerEmbed(entry, pages, page, pages.length)],
            components: [buildPaginationRow(i.id, page, pages.length, isGrouped)],
        });
    }, err => logError('pagination coordonnées', err), ComponentType.Button, () => reply.edit({ components: [] }));
}

const data = new SlashCommandBuilder()
    .setName('checkunclaim')
    .setDescription('Affiche les unclaims à une date donnée ou pour un joueur donné.')
    .addStringOption(opt =>
        opt
            .setName('date')
            .setDescription('La date au format dd/mm/yyyy')
            .setRequired(false)
            .setMaxLength(10)
            .setAutocomplete(true)
    )
    .addStringOption(opt =>
        opt
            .setName('pseudo')
            .setDescription('Le pseudo du joueur')
            .setRequired(false)
            .setMaxLength(32)
            .setAutocomplete(true)
    )
    .setIntegrationTypes([0, 1])
    .setContexts([0, 1, 2]);

module.exports = {
    data,

    async autocomplete(interaction) {
        try {
            const focused = interaction.options.getFocused(true);

            if (focused.name === 'date') {
                const dates = await getAllDates(config.unclaimHistoryFilePath);
                const filtered = dates
                    .filter(d => d.startsWith(focused.value))
                    .slice(0, 25);
                return interaction.respond(filtered.map(d => ({ name: d, value: d })));
            }

            if (focused.name === 'pseudo') {
                const owners = await getAllOwners(config.unclaimHistoryFilePath);
                const filtered = owners
                    .filter(o => o.toLowerCase().startsWith(focused.value.toLowerCase()))
                    .slice(0, 25);
                return interaction.respond(filtered.map(o => ({ name: o, value: o })));
            }

            return interaction.respond([]);
        } catch {
            try { return await interaction.respond([]); } catch {}
        }
    },

    async execute(interaction, client) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const rawDate   = interaction.options.getString('date');
        const rawPseudo = interaction.options.getString('pseudo');

        // ─────────────── Mode parcours (aucun argument) ───────────────
        if (!rawDate && !rawPseudo) {
            const allDates = await getAllDates(config.unclaimHistoryFilePath);

            if (allDates.length === 0) {
                return interaction.editReply(`❌ Aucun unclaim enregistré.`);
            }

            const totalDates = allDates.length;
            let dateIndex    = 0;

            async function getEntriesForIndex(idx) {
                const [dd, mm, yyyy] = allDates[idx].split('/');
                const target = new Date(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd));
                return getEntriesByDate(config.unclaimHistoryFilePath, target);
            }

            function buildBrowseView(entries) {
                const components = [];
                if (entries.length > 0) {
                    components.push(buildSelectRow(`browse-select-${interaction.id}`, buildEntryOptions(entries)));
                }
                components.push(buildDateNavRow(interaction.id, dateIndex, totalDates));

                return {
                    embeds: [buildDateBrowseEmbed(allDates[dateIndex], entries, dateIndex, totalDates, client)],
                    components,
                };
            }

            let entries = await getEntriesForIndex(dateIndex);

            const message = await interaction.editReply(buildBrowseView(entries));

            collectComponents(message, interaction, async i => {
                if (i.customId === `date-prev-${interaction.id}`) {
                    dateIndex = Math.max(dateIndex - 1, 0);
                    entries = await getEntriesForIndex(dateIndex);
                    return i.update(buildBrowseView(entries));
                }

                if (i.customId === `date-next-${interaction.id}`) {
                    dateIndex = Math.min(dateIndex + 1, totalDates - 1);
                    entries = await getEntriesForIndex(dateIndex);
                    return i.update(buildBrowseView(entries));
                }

                if (i.customId === `browse-select-${interaction.id}`) {
                    const entry = entries[parseInt(i.values[0], 10)];
                    await i.update(buildBrowseView(entries));

                    if (!entry) {
                        return i.followUp({
                            content: `❌ Impossible de retrouver les données de ce joueur.`,
                            flags: MessageFlags.Ephemeral,
                        });
                    }

                    await sendPaginatedEntry(i, entry);
                }
            }, err => logError('parcours par date', err));

            return;
        }

        // ─────────────── Mode pseudo ───────────────
        if (rawPseudo) {
            const playerEntries = await getPlayerEntries(config.unclaimHistoryFilePath, rawPseudo);

            if (playerEntries.length === 0) {
                return interaction.editReply(`❌ Aucun unclaim trouvé pour le joueur **${rawPseudo}**.`);
            }

            if (playerEntries.length === 1) {
                const entry = playerEntries[0];
                let isGrouped = true;
                let pages = buildCoordPagesForMode(entry.markers, isGrouped);
                let page = 0;

                const message = await interaction.editReply({
                    embeds: [buildPlayerEmbed(entry, pages, page, pages.length)],
                    components: [buildPaginationRow(interaction.id, page, pages.length, isGrouped)],
                });

                collectComponents(message, interaction, async btn => {
                    if (btn.customId === `coords-mode-${interaction.id}`) {
                        isGrouped = !isGrouped;
                        pages = buildCoordPagesForMode(entry.markers, isGrouped);
                        page = 0;
                    } else if (btn.customId === `coords-next-${interaction.id}`) {
                        page = Math.min(page + 1, pages.length - 1);
                    } else if (btn.customId === `coords-prev-${interaction.id}`) {
                        page = Math.max(page - 1, 0);
                    }

                    await btn.update({
                        embeds: [buildPlayerEmbed(entry, pages, page, pages.length)],
                        components: [buildPaginationRow(interaction.id, page, pages.length, isGrouped)],
                    });
                }, err => logError('pagination pseudo', err), ComponentType.Button);

                return;
            }

            const sortedEntries = [...playerEntries].sort((a, b) => new Date(b.date) - new Date(a.date));

            const selectOptions = sortedEntries.slice(0, 25).map((e, i) => {
                const d    = new Date(e.date);
                const dd   = String(d.getDate()).padStart(2, '0');
                const mm   = String(d.getMonth() + 1).padStart(2, '0');
                const yyyy = d.getFullYear();
                const time = d.toLocaleTimeString('fr-FR', {
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZone: 'Europe/Paris',
                });
                return {
                    label: `${dd}/${mm}/${yyyy} ${time}`,
                    description: `${e.claimsLost} Zone(s) unclaim${e.usernameChange ? ' — Changement de compte' : ''}`,
                    value: String(i),
                };
            });

            const embed = new EmbedBuilder()
                .setColor('#e74c3c')
                .setTitle(`Unclaims de ${sortedEntries[0].owner}`)
                .setThumbnail(`https://mc-heads.net/avatar/${encodeURIComponent(sortedEntries[0].owner)}/100`)
                .setDescription(
                    `**${sortedEntries.length}** unclaim(s) enregistré(s).\nSélectionne une date pour voir le détail.`
                );

            if (sortedEntries.length > 25) {
                embed.setFooter({
                    text: `Seuls les 25 unclaims les plus récents sont sélectionnables (${sortedEntries.length} au total).`,
                });
            }

            const customId = `checkunclaim-pseudo-${interaction.id}`;
            const message = await interaction.editReply({
                embeds: [embed],
                components: [buildSelectRow(customId, selectOptions)],
            });

            collectComponents(message, interaction, async i => {
                const idx = parseInt(i.values[0], 10);
                const entry = sortedEntries[idx];

                await i.update({
                    embeds: [embed],
                    components: [buildSelectRow(customId, selectOptions)],
                });

                if (!entry) {
                    return i.followUp({
                        content: `❌ Impossible de retrouver cet unclaim.`,
                        flags: MessageFlags.Ephemeral,
                    });
                }

                await sendPaginatedEntry(i, entry);
            }, err => logError('sélection pseudo', err), ComponentType.StringSelect);

            return;
        }

        // ─────────────── Mode date ───────────────
        const parsedDate = parseDate(rawDate);
        if (!parsedDate) {
            return interaction.editReply(
                `❌ Format de date invalide ! Utilise le format \`dd/mm/yyyy\` (ex: 25/12/2024).`
            );
        }

        const entries = await getEntriesByDate(config.unclaimHistoryFilePath, parsedDate);
        if (entries.length === 0) {
            return interaction.editReply(`❌ Aucun claim n'a sauté le \`${rawDate}\` !`);
        }

        const lines = entries.map(e => {
            const ts = Math.floor(new Date(e.date).getTime() / 1000);
            return `• **${e.owner}** — \`${e.claimsLost}\` Zone(s) unclaim — <t:${ts}:t>`;
        });

        const totalZones = entries.reduce((sum, e) => sum + e.claimsLost, 0);

        const embed = new EmbedBuilder()
            .setColor('#e74c3c')
            .setTitle(`Vue d'ensemble du ${rawDate}`)
            .setThumbnail(client.user.displayAvatarURL())
            .addFields(
                { name: '👥 Nombre d\'unclaims', value: `\`${entries.length}\``, inline: true },
                { name: '🏴 Zones totales unclaim', value: `\`${totalZones}\``, inline: true },
                { name: 'Joueurs :', value: lines.join('\n').slice(0, 1024) || '*Aucun unclaim*' },
            );

        const selectOptions = buildEntryOptions(entries);

        if (entries.length > 25) {
            embed.setFooter({
                text: `Seuls les 25 premiers joueurs sont sélectionnables ci-dessous (${entries.length} au total).`,
            });
        }

        const customId = `checkunclaim-date-${interaction.id}`;
        const message = await interaction.editReply({
            embeds: [embed],
            components: [buildSelectRow(customId, selectOptions)],
        });

        collectComponents(message, interaction, async i => {
            const entry = entries[parseInt(i.values[0], 10)];

            await i.update({
                embeds: [embed],
                components: [buildSelectRow(customId, selectOptions)],
            });

            if (!entry) {
                return i.followUp({
                    content: `❌ Impossible de retrouver les données de ce joueur.`,
                    flags: MessageFlags.Ephemeral,
                });
            }
            await sendPaginatedEntry(i, entry);
        }, err => logError('sélection date', err), ComponentType.StringSelect);
    },
};