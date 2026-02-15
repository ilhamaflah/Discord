import fetch from 'node-fetch';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    getVoiceConnection,
    demuxProbe,
} from '@discordjs/voice';
import ytdl from '@distube/ytdl-core';
import ytsr from '@distube/ytsr';
import ytpl from '@distube/ytpl';

const queues = new Map();
const MAX_PLAYLIST_ITEMS = 50;

async function respond(interaction, content) {
    if (interaction.deferred) {
        return interaction.editReply(content);
    }
    if (interaction.replied) {
        return interaction.followUp(content);
    }
    return interaction.reply(content);
}

function isHttpUrl(source) {
    return source.startsWith('http://') || source.startsWith('https://');
}

function isYouTubeUrl(source) {
    const lowered = source.toLowerCase();
    return lowered.includes('youtube.com') || lowered.includes('youtu.be') || lowered.includes('music.youtube.com');
}

function formatTrackLabel(track) {
    return track.title ? track.title : track.source;
}

function getQueue(guildId) {
    if (!queues.has(guildId)) {
        const player = createAudioPlayer({
            behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
        });

        const queue = {
            player,
            connection: null,
            tracks: [],
        };

        player.on(AudioPlayerStatus.Idle, () => {
            playNext(guildId).catch(err => console.error('Play next error:', err));
        });

        player.on('error', err => {
            console.error('Audio player error:', err);
        });

        queues.set(guildId, queue);
    }

    return queues.get(guildId);
}

function ensureConnection(interaction, queue) {
    const channel = interaction.member?.voice?.channel;
    if (!channel) return null;

    if (!queue.connection || queue.connection.joinConfig.channelId !== channel.id) {
        queue.connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: interaction.guildId,
            adapterCreator: interaction.guild.voiceAdapterCreator,
        });
        queue.connection.subscribe(queue.player);
    }

    return queue.connection;
}

async function resolvePlayRequest(source) {
    if (isHttpUrl(source)) {
        if (isYouTubeUrl(source)) {
            if (ytpl.validateID(source)) {
                const playlistId = await ytpl.getPlaylistID(source);
                const playlist = await ytpl(playlistId, { limit: MAX_PLAYLIST_ITEMS });
                const items = playlist.items
                    .filter(item => item.url)
                    .map(item => ({
                        source: item.url,
                        title: item.title,
                    }));

                if (items.length === 0) {
                    throw new Error('Playlist has no playable items.');
                }

                return {
                    type: 'playlist',
                    title: playlist.title,
                    items,
                };
            }

            if (!ytdl.validateURL(source)) {
                throw new Error('Invalid YouTube URL.');
            }

            const info = await ytdl.getInfo(source);
            return {
                type: 'track',
                item: {
                    source,
                    title: info.videoDetails?.title ?? source,
                },
            };
        }

        return {
            type: 'track',
            item: {
                source,
                title: source,
            },
        };
    }

    const results = await ytsr(source, { limit: 10, type: 'video' });
    const video = results.items.find(item => item.type === 'video' && item.url);
    if (!video) {
        throw new Error('No YouTube results found.');
    }

    return {
        type: 'track',
        item: {
            source: video.url,
            title: video.name ?? source,
        },
    };
}

async function createResourceFrom(source) {
    if (isHttpUrl(source)) {
        if (isYouTubeUrl(source)) {
            if (!ytdl.validateURL(source)) {
                throw new Error('Invalid YouTube URL.');
            }
            const stream = ytdl(source, {
                filter: 'audioonly',
                quality: 'highestaudio',
                highWaterMark: 1 << 25,
            });
            const { stream: probedStream, type } = await demuxProbe(stream);
            return createAudioResource(probedStream, { inputType: type });
        }
        const res = await fetch(source);
        if (!res.ok || !res.body) {
            throw new Error(`Failed to fetch audio: ${res.status}`);
        }
        const body = res.body;
        const nodeStream = typeof body.getReader === 'function'
            ? Readable.fromWeb(body)
            : body;
        const { stream, type } = await demuxProbe(nodeStream);
        return createAudioResource(stream, { inputType: type });
    }

    if (fs.existsSync(source)) {
        return createAudioResource(fs.createReadStream(source));
    }

    throw new Error('Source must be a direct audio URL or a valid local file path.');
}

async function playNext(guildId) {
    const queue = queues.get(guildId);
    if (!queue || queue.tracks.length === 0) return;

    const next = queue.tracks.shift();
    try {
        const resource = await createResourceFrom(next.source);
        queue.player.play(resource);
    } catch (error) {
        console.error('Failed to play track:', error);
        await playNext(guildId);
    }
}

export async function handleMusicCommand(interaction) {
    switch (interaction.commandName) {
        case 'join': {
            const queue = getQueue(interaction.guildId);
            const connection = ensureConnection(interaction, queue);
            if (!connection) {
                await respond(interaction, 'Join a voice channel first.');
                return;
            }
            await respond(interaction, 'Joined your voice channel.');
            return;
        }
        case 'leave': {
            const connection = getVoiceConnection(interaction.guildId);
            if (connection) connection.destroy();
            queues.delete(interaction.guildId);
            await respond(interaction, 'Left the voice channel.');
            return;
        }
        case 'play': {
            const source = interaction.options.getString('source', true);
            await interaction.deferReply();
            const queue = getQueue(interaction.guildId);
            const connection = ensureConnection(interaction, queue);
            if (!connection) {
                await respond(interaction, 'Join a voice channel first.');
                return;
            }
            try {
                const resolved = await resolvePlayRequest(source);
                if (resolved.type === 'playlist') {
                    queue.tracks.push(...resolved.items);
                    await respond(interaction,
                        `Queued ${resolved.items.length} tracks from playlist: ${resolved.title}.`
                    );
                } else {
                    queue.tracks.push(resolved.item);
                    await respond(interaction, `Queued: ${formatTrackLabel(resolved.item)}`);
                }

                if (queue.player.state.status === AudioPlayerStatus.Idle) {
                    await playNext(interaction.guildId);
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Failed to play this source.';
                await respond(interaction, message);
            }
            return;
        }
        case 'pause': {
            const queue = getQueue(interaction.guildId);
            queue.player.pause(true);
            await respond(interaction, 'Paused.');
            return;
        }
        case 'resume': {
            const queue = getQueue(interaction.guildId);
            queue.player.unpause();
            await respond(interaction, 'Resumed.');
            return;
        }
        case 'skip': {
            const queue = getQueue(interaction.guildId);
            queue.player.stop(true);
            await respond(interaction, 'Skipped.');
            return;
        }
        case 'queue': {
            const queue = getQueue(interaction.guildId);
            if (queue.tracks.length === 0) {
                await respond(interaction, 'Queue is empty.');
                return;
            }
            const list = queue.tracks.map((track, index) => `${index + 1}. ${formatTrackLabel(track)}`).join('\n');
            await respond(interaction, `Queue:\n${list}`);
            return;
        }
        default:
            await respond(interaction, 'Unknown command.');
    }
}
