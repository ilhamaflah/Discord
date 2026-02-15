import fetch from 'node-fetch';
import fs from 'node:fs';
import path from 'node:path';
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
import { Innertube, UniversalCache } from 'youtubei.js';

const queues = new Map();
const MAX_PLAYLIST_ITEMS = 50;
const YT_CACHE_DIR = path.join(process.cwd(), 'data', 'yt-cache');
let innertubePromise = null;
let innertubeAndroidNoPlayerPromise = null;
let cachedCookieHeader = undefined;

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

function isWindowsPath(source) {
    return /^[a-zA-Z]:[\\/]/.test(source);
}

function normalizeHttpUrl(source) {
    if (isHttpUrl(source)) return source;
    const trimmed = source.trim();
    if (isWindowsPath(trimmed)) return null;
    if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(trimmed)) {
        return `http://${trimmed}`;
    }
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(trimmed)) {
        return `http://${trimmed}`;
    }
    if (/^[\w.-]+:\d+(\/|$)/.test(trimmed)) {
        return `http://${trimmed}`;
    }
    return null;
}

function isYouTubeUrl(source) {
    const lowered = source.toLowerCase();
    return lowered.includes('youtube.com') || lowered.includes('youtu.be') || lowered.includes('music.youtube.com');
}

function extractYouTubeId(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./, '');
        if (host === 'youtu.be') {
            return parsed.pathname.slice(1);
        }
        if (parsed.pathname.startsWith('/shorts/')) {
            return parsed.pathname.split('/')[2] || null;
        }
        if (parsed.searchParams.has('v')) {
            return parsed.searchParams.get('v');
        }
    } catch {
        return null;
    }
    return null;
}

function extractYouTubePlaylistId(url) {
    try {
        const parsed = new URL(url);
        const listId = parsed.searchParams.get('list');
        if (listId) return listId;
        if (parsed.pathname.startsWith('/playlist')) {
            return parsed.searchParams.get('list');
        }
    } catch {
        return null;
    }
    return null;
}

function cookieArrayToHeader(cookies) {
    if (!Array.isArray(cookies)) return '';
    return cookies
        .filter(cookie => cookie && cookie.name && cookie.value)
        .map(cookie => `${cookie.name}=${cookie.value}`)
        .join('; ');
}

function getTextFromNode(textNode) {
    if (!textNode) return '';
    if (typeof textNode === 'string') return textNode;
    if (typeof textNode.text === 'string') return textNode.text;
    if (typeof textNode.toString === 'function') return textNode.toString();
    return '';
}

function loadYouTubeCookies() {
    const cookieFile = process.env.YTDL_COOKIE_FILE;
    const rawCookie = process.env.YTDL_COOKIE;
    let cookieSource = '';

    if (cookieFile && fs.existsSync(cookieFile)) {
        cookieSource = fs.readFileSync(cookieFile, 'utf8');
    } else if (rawCookie) {
        cookieSource = rawCookie;
    }

    const trimmed = cookieSource.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                const names = new Set(parsed.map(cookie => cookie?.name).filter(Boolean));
                if (!names.has('CONSENT')) {
                    console.warn('YouTube cookie is missing CONSENT; playback may 403. Re-export cookies after accepting consent.');
                }
                return cookieArrayToHeader(parsed);
            }
            if (Array.isArray(parsed?.cookies)) {
                const names = new Set(parsed.cookies.map(cookie => cookie?.name).filter(Boolean));
                if (!names.has('CONSENT')) {
                    console.warn('YouTube cookie is missing CONSENT; playback may 403. Re-export cookies after accepting consent.');
                }
                return cookieArrayToHeader(parsed.cookies);
            }
        } catch (error) {
            console.warn('Failed to parse cookies JSON; falling back to raw cookie string.', error);
        }
    }

    if (!trimmed.includes('CONSENT=')) {
        console.warn('YouTube cookie is missing CONSENT; playback may 403. Re-export cookies after accepting consent.');
    }
    return trimmed;
}

function getCookieHeader() {
    if (cachedCookieHeader === undefined) {
        cachedCookieHeader = loadYouTubeCookies();
    }
    return cachedCookieHeader;
}

function getStreamHeaders() {
    const headers = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.youtube.com',
        'Referer': 'https://www.youtube.com/',
    };
    const cookie = getCookieHeader();
    if (cookie) {
        headers.Cookie = cookie;
    }
    return headers;
}

function isDecipherError(error) {
    if (!error) return false;
    const name = error.name || error.constructor?.name || '';
    const message = (error.message || '').toLowerCase();
    return (
        name === 'PlayerError' ||
        message.includes('decipher') ||
        message.includes('signature') ||
        message.includes('no valid url')
    );
}

function isForbiddenStreamError(error) {
    if (!error) return false;
    const message = (error.message || '').toLowerCase();
    return message.includes('failed to fetch audio: 403');
}

function resetYouTubeSessions(reason) {
    console.warn(`Resetting YouTube sessions (${reason}).`);
    innertubePromise = null;
    innertubeAndroidNoPlayerPromise = null;
    try {
        if (fs.existsSync(YT_CACHE_DIR)) {
            fs.rmSync(YT_CACHE_DIR, { recursive: true, force: true });
        }
    } catch (error) {
        console.warn('Failed to clear YouTube cache directory.', error);
    }
}

async function fetchStreamFromUrl(url) {
    const res = await fetch(url, { headers: getStreamHeaders() });
    if (!res.ok || !res.body) {
        throw new Error(`Failed to fetch audio: ${res.status}`);
    }
    const body = res.body;
    return typeof body.getReader === 'function'
        ? Readable.fromWeb(body)
        : body;
}

function pickDirectAudioFormat(info) {
    const streaming = info?.streaming_data || info?.streamingData;
    const formats = [
        ...(streaming?.adaptive_formats || streaming?.adaptiveFormats || []),
        ...(streaming?.formats || []),
    ];
    const candidates = formats.filter(format => {
        const hasAudio = format?.has_audio ?? format?.hasAudio ?? format?.audioBitrate;
        const mime = format?.mime_type || format?.mimeType || '';
        const isAudio = mime.includes('audio/');
        const hasCipher = Boolean(format?.signature_cipher || format?.cipher);
        return (hasAudio || isAudio) && format?.url && !hasCipher;
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
        const bitrateA = a?.bitrate || a?.audioBitrate || 0;
        const bitrateB = b?.bitrate || b?.audioBitrate || 0;
        return bitrateB - bitrateA;
    });
    return candidates[0];
}

async function getAudioFormatUrl(yt, videoId, client) {
    const info = await yt.getBasicInfo(videoId, client ? { client } : undefined);
    const direct = pickDirectAudioFormat(info);
    if (direct?.url) {
        return direct.url;
    }

    const format = info.chooseFormat({ type: 'audio', quality: 'best' });
    if (!format) {
        throw new Error('No audio format found.');
    }

    const hasCipher = Boolean(format.signature_cipher || format.cipher);
    if (yt.session?.player && hasCipher) {
        return format.decipher(yt.session.player);
    }
    if (format.url && !hasCipher) {
        return format.url;
    }

    throw new Error('No audio format URL available.');
}

async function downloadYouTubeAudio(videoId) {
    const tryPrimary = async () => {
        const yt = await getInnertube();
        const url = await getAudioFormatUrl(yt, videoId, 'ANDROID');
        return fetchStreamFromUrl(url);
    };

    const tryAndroidDirect = async () => {
        const yt = await getInnertube();
        const url = await getAudioFormatUrl(yt, videoId, 'ANDROID');
        return fetchStreamFromUrl(url);
    };

    const tryAndroidNoPlayer = async () => {
        const android = await getInnertubeAndroidNoPlayer();
        const url = await getAudioFormatUrl(android, videoId, 'ANDROID');
        return fetchStreamFromUrl(url);
    };

    try {
        return await tryPrimary();
    } catch (error) {
        if (isDecipherError(error)) {
            resetYouTubeSessions('decipher failure (primary)');
            try {
                return await tryPrimary();
            } catch (retryError) {
                error = retryError;
            }
        }
        console.warn('Primary YouTube download failed, trying direct Android URL.', error);
    }

    const fallbacks = [
        { label: 'android direct', fn: tryAndroidDirect },
        { label: 'android no-player', fn: tryAndroidNoPlayer },
    ];

    let lastError = null;
    for (const fallback of fallbacks) {
        try {
            return await fallback.fn();
        } catch (error) {
            if (isDecipherError(error) || isForbiddenStreamError(error)) {
                resetYouTubeSessions(`fallback retry (${fallback.label})`);
                try {
                    return await fallback.fn();
                } catch (retryError) {
                    error = retryError;
                }
            }
            console.warn(`Fallback ${fallback.label} failed.`, error);
            lastError = error;
        }
    }

    throw lastError || new Error('Failed to download YouTube audio.');
}

async function getInnertube() {
    if (!innertubePromise) {
        const cookie = getCookieHeader();
        const options = {
            cache: new UniversalCache(true, YT_CACHE_DIR),
        };
        if (cookie) {
            options.cookie = cookie;
        }
        innertubePromise = Innertube.create(options);
    }
    return innertubePromise;
}

async function getInnertubeAndroidNoPlayer() {
    if (!innertubeAndroidNoPlayerPromise) {
        const cookie = getCookieHeader();
        const options = {
            cache: new UniversalCache(true, YT_CACHE_DIR),
            client_type: 'ANDROID',
            retrieve_player: false,
        };
        if (cookie) {
            options.cookie = cookie;
        }
        innertubeAndroidNoPlayerPromise = Innertube.create(options);
    }
    return innertubeAndroidNoPlayerPromise;
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
    if (fs.existsSync(source)) {
        return {
            type: 'track',
            item: {
                source,
                title: path.basename(source),
            },
        };
    }

    const normalizedUrl = normalizeHttpUrl(source);
    if (normalizedUrl) {
        if (isYouTubeUrl(normalizedUrl)) {
            const playlistId = extractYouTubePlaylistId(normalizedUrl);
            if (playlistId) {
                const yt = await getInnertube();
                const playlist = await yt.getPlaylist(playlistId);
                const rawItems = playlist.items ?? playlist.videos ?? [];
                const items = rawItems
                    .map(item => {
                        const id = item?.id;
                        if (!id) return null;
                        const title = getTextFromNode(item?.title) || `https://www.youtube.com/watch?v=${id}`;
                        return {
                            source: `https://www.youtube.com/watch?v=${id}`,
                            title,
                        };
                    })
                    .filter(Boolean)
                    .slice(0, MAX_PLAYLIST_ITEMS);

                if (items.length === 0) {
                    throw new Error('Playlist has no playable items.');
                }

                const playlistTitle = getTextFromNode(playlist?.info?.title) || `Playlist ${playlistId}`;

                return {
                    type: 'playlist',
                    title: playlistTitle,
                    items,
                };
            }

            const videoId = extractYouTubeId(normalizedUrl);
            if (!videoId) {
                throw new Error('Invalid YouTube URL.');
            }

            const yt = await getInnertube();
            const info = await yt.getBasicInfo(videoId, { client: 'ANDROID' });
            const title = info?.basic_info?.title ?? normalizedUrl;

            return {
                type: 'track',
                item: {
                    source: normalizedUrl,
                    title,
                },
            };
        }

        return {
            type: 'track',
            item: {
                source: normalizedUrl,
                title: normalizedUrl,
            },
        };
    }

    const yt = await getInnertube();
    const searchResults = await yt.search(source, { type: 'video' });
    const video = searchResults.videos?.[0];
    if (!video?.id) {
        throw new Error('No YouTube results found.');
    }

    return {
        type: 'track',
        item: {
            source: `https://www.youtube.com/watch?v=${video.id}`,
            title: getTextFromNode(video.title) || source,
        },
    };
}

async function createResourceFrom(source) {
    const normalizedUrl = normalizeHttpUrl(source);
    if (normalizedUrl) {
        if (isYouTubeUrl(normalizedUrl)) {
            const videoId = extractYouTubeId(normalizedUrl);
            if (!videoId) {
                throw new Error('Invalid YouTube URL.');
            }

            const nodeStream = await downloadYouTubeAudio(videoId);
            const { stream: probedStream, type } = await demuxProbe(nodeStream);
            return createAudioResource(probedStream, { inputType: type });
        }
        const nodeStream = await fetchStreamFromUrl(normalizedUrl);
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
