const { SlashCommandBuilder, MessageFlags } = require('discord.js');

// Évite qu'un utilisateur enchaîne les /claimrefresh (chaque appel interroge le serveur de la map)
const COOLDOWN_MS = 30 * 1000;
let lastRefreshAt = 0;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('claimrefresh')
        .setDescription('Synchronise le fichier des claims avec la map dynamique (map.venstone.xyz).')
        .setIntegrationTypes([0, 1])
        .setContexts([0, 1, 2]),
        
    async execute(interaction, client) {
        const remaining = COOLDOWN_MS - (Date.now() - lastRefreshAt);
        if (remaining > 0) {
            return interaction.reply({
                content: `⏳ Une synchronisation vient d'avoir lieu, réessaie dans ${Math.ceil(remaining / 1000)}s.`,
                flags: MessageFlags.Ephemeral,
            });
        }
        lastRefreshAt = Date.now();

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const success = await client.fetchMapData();     
        if (success) {
            await interaction.editReply("📍 **Mise à jour réussie !** Le fichier des claims est désormais synchronisé avec la map dynamique.");
        } else {
            await client.sendError(interaction);
        }
    }
};
