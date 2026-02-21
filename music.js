import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { Connectors, Manager } from 'moonlink.js';

const MAX_PLAYLIST_ITEMS = 50;
const MAX_QUEUE_DISPLAY_ITEMS = 20;
const MAX_REMOVE_BUTTON_ITEMS = 10;
const PLAY_CHOICE_ITEMS = 5;
const PLAY_SELECTION_TTL_MS = 2 * 60 * 1000;

let manager = null;
const pendingPlaySelections = new Map();

function isMusicDebug() {
    const value = process.env.MUSIC_DEBUG;
    return value === '1' || value === 'true';
}

function debugLog(message, meta) {
    if (!isMusicDebug()) return;
    const stamp = new Date().toISOString();
    if (meta !== undefined) {
        console.log(`[music][${stamp}] ${message}`, meta);
        return;
    }
    console.log(`[music][${stamp}] ${message}`);
}

function parseBoolean(value, fallback = false) {
    if (value === undefined) return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function parseInteger(value, fallback) {
    const number = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(number) ? number : fallback;
}

function getManager() {
    if (!manager) {
        throw new Error('Music manager is not initialized. Call initializeMusic(client) first.');
    }
    return manager;
}

function buildNodeConfig() {
    return {
        host: process.env.NODELINK_HOST || process.env.LAVALINK_HOST || '127.0.0.1',
        port: parseInteger(process.env.NODELINK_PORT || process.env.LAVALINK_PORT, 2333),
        password: process.env.NODELINK_PASSWORD || process.env.LAVALINK_PASSWORD || 'youshallnotpass',
        secure: parseBoolean(process.env.NODELINK_SECURE || process.env.LAVALINK_SECURE, false),
        identifier: process.env.NODELINK_ID || process.env.LAVALINK_ID || 'main',
        pathVersion: process.env.NODELINK_PATH_VERSION || 'v4',
        retryAmount: parseInteger(process.env.NODELINK_RETRY_AMOUNT, 10),
        retryDelay: parseInteger(process.env.NODELINK_RETRY_DELAY_MS, 5000),
    };
}

function formatTrack(track) {
    if (!track) return 'Unknown track';
    return track.title || track.uri || 'Unknown track';
}

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return 'live';
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatQueuedMessage(track) {
    const title = formatTrack(track);
    if (track?.uri) {
        return `Queued: ${title}\nURL: ${track.uri}`;
    }
    return `Queued: ${title}`;
}

function isLikelyUrl(input) {
    return /^https?:\/\//i.test(input.trim());
}

function prunePendingPlaySelections() {
    const now = Date.now();
    for (const [id, selection] of pendingPlaySelections.entries()) {
        if (selection.expiresAt <= now) {
            pendingPlaySelections.delete(id);
        }
    }
}

function createPendingPlaySelection({ guildId, userId, tracks, query }) {
    prunePendingPlaySelections();
    const id = randomUUID().slice(0, 12);
    pendingPlaySelections.set(id, {
        guildId,
        userId,
        tracks,
        query,
        expiresAt: Date.now() + PLAY_SELECTION_TTL_MS,
    });
    return id;
}

function getPendingPlaySelection(id) {
    prunePendingPlaySelections();
    return pendingPlaySelections.get(id) || null;
}

function buildPlayChoiceMessage(query, tracks) {
    const lines = [`Choose one result for: **${query}**`, ''];
    lines.push(...tracks.map((track, index) => `${index + 1}. ${formatTrack(track)} (${formatDuration(track.duration)})`));
    lines.push('');
    lines.push('Click a number button below to queue that track.');
    return lines.join('\n');
}

function buildPlayChoiceComponents(selectionId, tracksCount) {
    const pickButtons = [];
    for (let i = 0; i < tracksCount; i += 1) {
        pickButtons.push(
            new ButtonBuilder()
                .setCustomId(`music_play_pick:${selectionId}:${i + 1}`)
                .setLabel(String(i + 1))
                .setStyle(ButtonStyle.Primary),
        );
    }

    const rows = [];
    if (pickButtons.length > 0) {
        rows.push(new ActionRowBuilder().addComponents(pickButtons));
    }

    rows.push(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`music_play_cancel:${selectionId}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger),
        ),
    );

    return rows;
}

function buildRemoveSelectionMessage(player, limit = MAX_REMOVE_BUTTON_ITEMS) {
    if (!player || player.queue.size === 0) {
        return 'Queue is empty.';
    }

    const visible = player.queue.tracks.slice(0, limit);
    const lines = ['Select a queue number to remove:', ''];
    lines.push(...visible.map((track, index) => `${index + 1}. ${formatTrack(track)}`));

    if (player.queue.size > visible.length) {
        lines.push('');
        lines.push(`Showing first ${visible.length} of ${player.queue.size} queued tracks.`);
    }

    return lines.join('\n');
}

function buildRemoveSelectionComponents(guildId, userId, count) {
    const rows = [];
    let currentRow = [];

    for (let i = 0; i < count; i += 1) {
        currentRow.push(
            new ButtonBuilder()
                .setCustomId(`music_remove_pick:${guildId}:${userId}:${i + 1}`)
                .setLabel(String(i + 1))
                .setStyle(ButtonStyle.Secondary),
        );

        if (currentRow.length === 5) {
            rows.push(new ActionRowBuilder().addComponents(currentRow));
            currentRow = [];
        }
    }

    if (currentRow.length > 0) {
        rows.push(new ActionRowBuilder().addComponents(currentRow));
    }

    rows.push(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`music_remove_cancel:${guildId}:${userId}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger),
        ),
    );

    return rows;
}

async function respond(interaction, content) {
    if (interaction.deferred) {
        return interaction.editReply(content);
    }
    if (interaction.replied) {
        return interaction.followUp(content);
    }
    return interaction.reply(content);
}

async function destroyPlayer(player, reason) {
    if (!player) return;
    try {
        await player.destroy(reason);
    } catch (error) {
        console.error('Failed to destroy player:', error);
    }
}

function getMemberVoiceChannel(interaction) {
    return interaction.member?.voice?.channel || null;
}

async function ensurePlayer(interaction) {
    const voiceChannel = getMemberVoiceChannel(interaction);
    if (!voiceChannel) return null;

    const moonlink = getManager();
    let player = moonlink.players.get(interaction.guildId);

    if (!player) {
        player = moonlink.players.create({
            guildId: interaction.guildId,
            voiceChannelId: voiceChannel.id,
            textChannelId: interaction.channelId,
            volume: parseInteger(process.env.MUSIC_DEFAULT_VOLUME, 100),
            autoLeave: true,
            autoPlay: false,
            selfDeaf: true,
            selfMute: false,
        });
        await player.connect({ selfDeaf: true, selfMute: false });
        return player;
    }

    if (player.voiceChannelId !== voiceChannel.id) {
        await player.disconnect();
        player.setVoiceChannelId(voiceChannel.id);
        await player.connect({ selfDeaf: true, selfMute: false });
    } else if (!player.connected) {
        await player.connect({ selfDeaf: true, selfMute: false });
    }

    if (interaction.channelId && player.textChannelId !== interaction.channelId) {
        player.setTextChannelId(interaction.channelId);
    }

    return player;
}

async function searchTracks(player, query, requester) {
    const trimmed = query.trim();
    if (!trimmed) {
        throw new Error('Provide a URL or search query.');
    }

    if (fs.existsSync(trimmed)) {
        throw new Error('Local file paths are not supported in NodeLink mode. Use a URL or search query.');
    }

    const source = process.env.NODELINK_DEFAULT_SEARCH_PLATFORM || 'youtubemusic';
    const result = isLikelyUrl(trimmed)
        ? await player.search(trimmed)
        : await player.search(trimmed, source);

    if (requester && result?.tracks?.length) {
        for (const track of result.tracks) {
            track.setRequester(requester);
        }
    }

    return result;
}

async function startPlaybackIfIdle(player) {
    if (player.playing || player.paused) return;
    const started = await player.play();
    if (!started) {
        throw new Error('Failed to start playback. Check your NodeLink node status.');
    }
}

function buildQueueMessage(player) {
    const nowPlaying = player.current;
    const upcoming = player.queue.tracks;

    if (!nowPlaying && upcoming.length === 0) {
        return 'Queue is empty.';
    }

    const lines = [];

    if (nowPlaying) {
        if (nowPlaying.uri) {
            lines.push(`Now: ${formatTrack(nowPlaying)} (${nowPlaying.uri})`);
        } else {
            lines.push(`Now: ${formatTrack(nowPlaying)}`);
        }
    }

    if (upcoming.length > 0) {
        lines.push('Up next:');
        const visible = upcoming.slice(0, MAX_QUEUE_DISPLAY_ITEMS);
        lines.push(...visible.map((track, index) => `${index + 1}. ${formatTrack(track)}`));

        if (upcoming.length > visible.length) {
            lines.push(`...and ${upcoming.length - visible.length} more`);
        }
    }

    return lines.join('\n');
}

export function initializeMusic(client) {
    if (manager) return manager;

    const nodeConfig = buildNodeConfig();
    debugLog('Initializing Moonlink manager with node config.', nodeConfig);

    manager = new Manager({
        nodes: [nodeConfig],
        options: {
            defaultPlayer: {
                volume: parseInteger(process.env.MUSIC_DEFAULT_VOLUME, 100),
                autoPlay: false,
                autoLeave: true,
                selfDeaf: true,
                selfMute: false,
                loop: 'off',
                historySize: 10,
            },
            search: {
                defaultPlatform: process.env.NODELINK_DEFAULT_SEARCH_PLATFORM || 'youtubemusic',
                resultLimit: 10,
                playlistLoadLimit: MAX_PLAYLIST_ITEMS,
            },
            playerDestruction: {
                autoDestroyOnIdle: true,
                idleTimeout: parseInteger(process.env.MUSIC_IDLE_LEAVE_MS, 60_000),
            },
            trackHandling: {
                autoSkipOnError: true,
                skipStuckTracks: true,
                trackStuckThreshold: 10_000,
                retryFailedTracks: false,
                maxRetryAttempts: 2,
            },
            resume: true,
            resumeTimeout: parseInteger(process.env.NODELINK_RESUME_TIMEOUT_MS, 60_000),
        },
    });

    manager.on('debug', message => debugLog(message));

    manager.on('nodeConnected', node => {
        console.log(`[music] Node connected: ${node.identifier} (${node.host}:${node.port})`);
    });

    manager.on('nodeDisconnect', (node, code, reason) => {
        console.error(`[music] Node disconnected: ${node.identifier} (${code}) ${reason}`);
    });

    manager.on('nodeError', (node, error) => {
        console.error(`[music] Node error: ${node.identifier}`, error);
    });

    manager.on('trackStart', (player, track) => {
        debugLog(`Track started in guild ${player.guildId}: ${formatTrack(track)}`);
    });

    manager.on('trackException', (player, track, exception) => {
        console.error(`Track exception in guild ${player.guildId}:`, exception);
        debugLog('Track exception payload.', { track: formatTrack(track), exception });
    });

    manager.on('queueEnd', player => {
        debugLog(`Queue ended in guild ${player.guildId}.`);
    });

    manager.use(new Connectors.DiscordJs(), client);
    return manager;
}

export function handleVoiceStateUpdate(oldState, newState) {
    if (!manager) return;

    const guildId = newState.guild?.id ?? oldState.guild?.id;
    if (!guildId) return;

    const player = manager.players.get(guildId);
    if (!player?.voiceChannelId) return;

    const guild = newState.guild ?? oldState.guild;
    const channel = guild?.channels?.cache?.get(player.voiceChannelId);
    if (!channel || !('members' in channel)) return;

    const nonBotMembers = channel.members.filter(member => !member.user.bot);
    debugLog(`Voice state update in guild ${guildId}. Non-bot members: ${nonBotMembers.size}.`);

    if (nonBotMembers.size > 0) return;

    debugLog(`Destroying player in guild ${guildId} because voice channel is empty.`);
    destroyPlayer(player, 'Voice channel empty').catch(error => {
        console.error('Failed to auto-destroy player on empty voice channel:', error);
    });
}

async function handlePlayComponent(interaction) {
    const pickMatch = interaction.customId.match(/^music_play_pick:([^:]+):(\d+)$/);
    const cancelMatch = interaction.customId.match(/^music_play_cancel:([^:]+)$/);

    if (!pickMatch && !cancelMatch) {
        return false;
    }

    const selectionId = pickMatch ? pickMatch[1] : cancelMatch[1];
    const selection = getPendingPlaySelection(selectionId);

    if (!selection) {
        await interaction.update({
            content: 'This search selection has expired. Run `/music play` again.',
            components: [],
        });
        return true;
    }

    if (interaction.user.id !== selection.userId) {
        await interaction.reply({
            content: 'Only the user who ran `/music play` can choose from this search menu.',
            ephemeral: true,
        });
        return true;
    }

    if (interaction.guildId !== selection.guildId) {
        await interaction.reply({
            content: 'This selection belongs to a different server.',
            ephemeral: true,
        });
        return true;
    }

    if (cancelMatch) {
        pendingPlaySelections.delete(selectionId);
        await interaction.update({ content: 'Selection canceled.', components: [] });
        return true;
    }

    const index = Number.parseInt(pickMatch[2], 10) - 1;
    const selectedTrack = selection.tracks[index];
    if (!selectedTrack) {
        await interaction.update({ content: 'Invalid selection. Run `/music play` again.', components: [] });
        pendingPlaySelections.delete(selectionId);
        return true;
    }

    try {
        const player = await ensurePlayer(interaction);
        if (!player) {
            await interaction.update({
                content: 'Join a voice channel first, then run `/music play` again.',
                components: [],
            });
            pendingPlaySelections.delete(selectionId);
            return true;
        }

        player.queue.add(selectedTrack);
        await startPlaybackIfIdle(player);

        pendingPlaySelections.delete(selectionId);
        await interaction.update({ content: formatQueuedMessage(selectedTrack), components: [] });
    } catch (error) {
        pendingPlaySelections.delete(selectionId);
        const message = error instanceof Error ? error.message : 'Failed to queue selected track.';
        await interaction.update({ content: message, components: [] });
    }

    return true;
}

async function handleRemoveComponent(interaction) {
    const pickMatch = interaction.customId.match(/^music_remove_pick:([^:]+):([^:]+):(\d+)$/);
    const cancelMatch = interaction.customId.match(/^music_remove_cancel:([^:]+):([^:]+)$/);

    if (!pickMatch && !cancelMatch) {
        return false;
    }

    const guildId = pickMatch ? pickMatch[1] : cancelMatch[1];
    const userId = pickMatch ? pickMatch[2] : cancelMatch[2];

    if (interaction.guildId !== guildId || interaction.user.id !== userId) {
        await interaction.reply({
            content: 'Only the user who opened this remove menu can use it.',
            ephemeral: true,
        });
        return true;
    }

    if (cancelMatch) {
        await interaction.update({ content: 'Remove selection canceled.', components: [] });
        return true;
    }

    const player = manager.players.get(guildId);
    if (!player || player.queue.size === 0) {
        await interaction.update({ content: 'Queue is empty.', components: [] });
        return true;
    }

    const position = Number.parseInt(pickMatch[3], 10);
    if (!Number.isFinite(position) || position < 1 || position > player.queue.size) {
        const count = Math.min(player.queue.size, MAX_REMOVE_BUTTON_ITEMS);
        await interaction.update({
            content: `Invalid position. Choose 1-${player.queue.size}.\n\n${buildRemoveSelectionMessage(player, count)}`,
            components: buildRemoveSelectionComponents(guildId, userId, count),
        });
        return true;
    }

    const removedTrack = player.queue.remove(position - 1);
    if (!removedTrack) {
        await interaction.update({ content: 'Failed to remove that track.', components: [] });
        return true;
    }

    if (player.queue.size === 0) {
        await interaction.update({
            content: `Removed: ${formatTrack(removedTrack)}\nQueue is now empty.`,
            components: [],
        });
        return true;
    }

    const count = Math.min(player.queue.size, MAX_REMOVE_BUTTON_ITEMS);
    await interaction.update({
        content: `Removed: ${formatTrack(removedTrack)}\n\n${buildRemoveSelectionMessage(player, count)}`,
        components: buildRemoveSelectionComponents(guildId, userId, count),
    });

    return true;
}

export async function handleMusicComponentInteraction(interaction) {
    if (!manager) return false;
    if (!interaction.isButton()) return false;
    if (!interaction.customId.startsWith('music_')) return false;

    const playHandled = await handlePlayComponent(interaction);
    if (playHandled) return true;

    const removeHandled = await handleRemoveComponent(interaction);
    return removeHandled;
}

export async function handleMusicCommand(interaction) {
    if (!manager) {
        await respond(interaction, 'Music manager is not initialized.');
        return;
    }

    const action = interaction.commandName === 'music'
        ? interaction.options.getSubcommand(true)
        : interaction.commandName;

    switch (action) {
        case 'join': {
            const player = await ensurePlayer(interaction);
            if (!player) {
                await respond(interaction, 'Join a voice channel first.');
                return;
            }
            await respond(interaction, 'Joined your voice channel.');
            return;
        }

        case 'leave': {
            const player = manager.players.get(interaction.guildId);
            if (!player) {
                await respond(interaction, 'I am not connected to a voice channel.');
                return;
            }
            await destroyPlayer(player, 'Manual leave command');
            await respond(interaction, 'Left the voice channel.');
            return;
        }

        case 'play': {
            const source = interaction.options.getString('source', true);
            await interaction.deferReply();

            const player = await ensurePlayer(interaction);
            if (!player) {
                await respond(interaction, 'Join a voice channel first.');
                return;
            }

            try {
                const result = await searchTracks(player, source, interaction.user);

                if (!result || result.isEmpty || result.tracks.length === 0) {
                    await respond(interaction, 'No matches found.');
                    return;
                }

                if (result.isError) {
                    const message = result.exception?.message || 'Search failed.';
                    await respond(interaction, `Search failed: ${message}`);
                    return;
                }

                if (result.isPlaylist) {
                    const tracks = result.tracks.slice(0, MAX_PLAYLIST_ITEMS);
                    player.queue.add(tracks);
                    await startPlaybackIfIdle(player);

                    const playlistName = result.playlistInfo?.name || 'Playlist';
                    await respond(interaction, `Queued ${tracks.length} tracks from playlist: ${playlistName}`);
                    return;
                }

                if (!isLikelyUrl(source)) {
                    const choices = result.tracks.slice(0, PLAY_CHOICE_ITEMS);
                    const selectionId = createPendingPlaySelection({
                        guildId: interaction.guildId,
                        userId: interaction.user.id,
                        tracks: choices,
                        query: source,
                    });

                    await respond(interaction, {
                        content: buildPlayChoiceMessage(source, choices),
                        components: buildPlayChoiceComponents(selectionId, choices.length),
                    });
                    return;
                }

                const track = result.tracks[0];
                player.queue.add(track);
                await startPlaybackIfIdle(player);
                await respond(interaction, formatQueuedMessage(track));
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Failed to play this source.';
                debugLog(`Play failed in guild ${interaction.guildId}.`, error);
                await respond(interaction, message);
            }
            return;
        }

        case 'pause': {
            const player = manager.players.get(interaction.guildId);
            if (!player || !player.current || !player.playing) {
                await respond(interaction, 'Nothing is playing.');
                return;
            }

            if (player.paused) {
                await respond(interaction, 'Already paused.');
                return;
            }

            await player.pause();
            await respond(interaction, 'Paused.');
            return;
        }

        case 'resume': {
            const player = manager.players.get(interaction.guildId);
            if (!player || !player.current) {
                await respond(interaction, 'Nothing is playing.');
                return;
            }

            if (!player.paused) {
                await respond(interaction, 'Player is not paused.');
                return;
            }

            await player.resume();
            await respond(interaction, 'Resumed.');
            return;
        }

        case 'skip':
        case 'next': {
            const player = manager.players.get(interaction.guildId);
            if (!player) {
                await respond(interaction, 'Queue is empty.');
                return;
            }

            const hasCurrent = Boolean(player.current);
            const hasQueued = player.queue.size > 0;

            if (!hasCurrent && !hasQueued) {
                await respond(interaction, 'Queue is empty.');
                return;
            }

            if (!hasCurrent && hasQueued) {
                await startPlaybackIfIdle(player);
                await respond(interaction, 'Playing next track.');
                return;
            }

            const skipped = await player.skip();
            await respond(interaction, skipped ? 'Skipped.' : 'Failed to skip.');
            return;
        }

        case 'queue': {
            const player = manager.players.get(interaction.guildId);
            if (!player) {
                await respond(interaction, 'Queue is empty.');
                return;
            }
            await respond(interaction, buildQueueMessage(player));
            return;
        }

        case 'purge': {
            const player = manager.players.get(interaction.guildId);
            if (!player) {
                await respond(interaction, 'Queue is already empty.');
                return;
            }

            const queuedCount = player.queue.size;
            const hadCurrent = Boolean(player.current);

            if (queuedCount === 0 && !hadCurrent) {
                await respond(interaction, 'Queue is already empty.');
                return;
            }

            player.queue.clear();
            if (hadCurrent) {
                await player.stop();
            }

            const purgedCount = queuedCount + (hadCurrent ? 1 : 0);
            await respond(interaction, `Purged ${purgedCount} track(s) from the queue.`);
            return;
        }

        case 'remove': {
            const position = interaction.options.getInteger('position', false);
            const player = manager.players.get(interaction.guildId);

            if (!player || player.queue.size === 0) {
                await respond(interaction, 'Queue is empty.');
                return;
            }

            if (position !== null) {
                if (position < 1 || position > player.queue.size) {
                    await respond(interaction, `Invalid position. Choose 1-${player.queue.size}.`);
                    return;
                }

                const removedTrack = player.queue.remove(position - 1);
                if (!removedTrack) {
                    await respond(interaction, 'Failed to remove that track.');
                    return;
                }

                await respond(interaction, `Removed: ${formatTrack(removedTrack)}`);
                return;
            }

            const count = Math.min(player.queue.size, MAX_REMOVE_BUTTON_ITEMS);
            await respond(interaction, {
                content: buildRemoveSelectionMessage(player, count),
                components: buildRemoveSelectionComponents(interaction.guildId, interaction.user.id, count),
            });
            return;
        }

        default:
            await respond(interaction, 'Unknown command.');
    }
}
