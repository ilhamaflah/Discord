import fetch from 'node-fetch';
import * as dotenv from 'dotenv';
import {Client, GatewayIntentBits, REST, Routes, userMention} from 'discord.js';
import { commands } from './commands.js';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    getVoiceConnection,
    demuxProbe,
} from '@discordjs/voice';
import { Readable } from 'node:stream';

const app = express();
dotenv.config();
//const config = require("./config/config");
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

const DATA_DIR = path.join(process.cwd(), 'data');
const CATAN_FILE = path.join(DATA_DIR, 'catan.json');

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function loadState() {
    ensureDataDir();
    if (!fs.existsSync(CATAN_FILE)) {
        return { guilds: {} };
    }
    try {
        return JSON.parse(fs.readFileSync(CATAN_FILE, 'utf8'));
    } catch (error) {
        console.error('Failed to read catan state, starting fresh.', error);
        return { guilds: {} };
    }
}

function saveState(state) {
    ensureDataDir();
    fs.writeFileSync(CATAN_FILE, JSON.stringify(state, null, 2));
}

function getGame(state, guildId) {
    return state.guilds?.[guildId]?.game ?? null;
}

function setGame(state, guildId, game) {
    if (!state.guilds) state.guilds = {};
    if (!state.guilds[guildId]) state.guilds[guildId] = {};
    state.guilds[guildId].game = game;
}

function removeGame(state, guildId) {
    if (state.guilds?.[guildId]) {
        delete state.guilds[guildId].game;
    }
}

function createPlayer(id, name) {
    return {
        id,
        name,
        resources: { wood: 1, brick: 1, wheat: 1, sheep: 1, ore: 0 },
        settlements: 1,
        cities: 0,
        roads: 1,
    };
}

function getPoints(player) {
    return player.settlements + player.cities * 2;
}

function randomResource() {
    const resources = ['wood', 'brick', 'wheat', 'sheep', 'ore'];
    return resources[Math.floor(Math.random() * resources.length)];
}

function createBoard() {
    const tiles = [];
    const resources = [
        'wood', 'wood', 'wood', 'wood',
        'brick', 'brick', 'brick',
        'sheep', 'sheep', 'sheep', 'sheep',
        'wheat', 'wheat', 'wheat', 'wheat',
        'ore', 'ore', 'ore',
        'desert',
    ];
    const tokens = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

    resources.sort(() => Math.random() - 0.5);
    tokens.sort(() => Math.random() - 0.5);

    let tokenIndex = 0;
    resources.forEach(resource => {
        if (resource === 'desert') {
            tiles.push({ resource, number: null });
        } else {
            tiles.push({ resource, number: tokens[tokenIndex] });
            tokenIndex += 1;
        }
    });

    return { tiles };
}

function tileLabel(tile, highlightNumber) {
    const icons = {
        wood: '🌲',
        brick: '🧱',
        wheat: '🌾',
        sheep: '🐑',
        ore: '🪨',
        desert: '🏜️',
    };
    const number = tile.number ? tile.number.toString().padStart(2, ' ') : '  ';
    const base = `${icons[tile.resource]}${number}`;
    if (tile.number && highlightNumber && tile.number === highlightNumber) {
        return `*${base}*`;
    }
    return base;
}

function renderBoard(game) {
    if (!game.board?.tiles?.length) return 'Board not generated.';
    const tiles = game.board.tiles;
    const rows = [
        [0, 1, 2],
        [3, 4, 5, 6],
        [7, 8, 9, 10, 11],
        [12, 13, 14, 15],
        [16, 17, 18],
    ];
    const indents = ['      ', '   ', '', '   ', '      '];
    const lines = rows.map((row, index) => {
        const parts = row.map(tileIndex => tileLabel(tiles[tileIndex], game.lastRoll));
        return `${indents[index]}${parts.join('  ')}`;
    });
    return lines.join('\n');
}

function canAfford(resources, cost) {
    return Object.keys(cost).every(key => resources[key] >= cost[key]);
}

function spendResources(resources, cost) {
    Object.keys(cost).forEach(key => {
        resources[key] -= cost[key];
    });
}

const queues = new Map();

function isYouTubeUrl(source) {
    const lowered = source.toLowerCase();
    return lowered.includes('youtube.com') || lowered.includes('youtu.be') || lowered.includes('music.youtube.com');
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

async function createResourceFrom(source) {
    if (source.startsWith('http://') || source.startsWith('https://')) {
        if (isYouTubeUrl(source)) {
            throw new Error('YouTube URLs are not supported. Use a direct audio URL or a local file.');
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

app.set('port', 3000);
app.listen(app.get('port'), function() {
    console.log('Server started on port '+ app.get('port'));
});
//client.login(process.env.BOT_TOKEN);
//OR
//client.login(config.TOD_BOT.TOKEN);
//client.disconnect();

function getQuote() {
    return fetch("https://zenquotes.io/api/random")
        .then(res => {
            return res.json()
        })
        .then(data => {
            return data[0]["q"] + " -" + data[0]["a"]
        })
}

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`)
});

client.on('interactionCreate', async interaction => {
    //console.log(`${msg.author.username}: ${msg.content.toString()}`);
    const stringifiedObject = JSON.stringify(interaction.options, null, 2);
    console.log(`Message received: ${interaction.commandName}`);
    console.log(stringifiedObject)
    if (!interaction.guild) return;
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'inspire') {
        await getQuote().then(quote => interaction.reply(quote))
    }
    if (interaction.commandName === 'ping') {
        await interaction.reply('Pong!');
    }
    if (interaction.commandName === 'tod') {
        const objectifiedJson = JSON.parse(stringifiedObject)

        await interaction.reply(`z!spin RAMBOT E ${userMention(objectifiedJson._hoistedOptions[0].user.id)}`);

        console.log(objectifiedJson._hoistedOptions[0].user.id)
    }
    if (interaction.commandName === 'calculate') {
        const left = interaction.options.getNumber('left', true);
        const operator = interaction.options.getString('operator', true);
        const right = interaction.options.getNumber('right', true);

        if (operator === 'divide' && right === 0) {
            await interaction.reply('Cannot divide by zero.');
            return;
        }

        let result;
        let symbol;
        switch (operator) {
            case 'add':
                result = left + right;
                symbol = '+';
                break;
            case 'subtract':
                result = left - right;
                symbol = '-';
                break;
            case 'multiply':
                result = left * right;
                symbol = '*';
                break;
            case 'divide':
                result = left / right;
                symbol = '/';
                break;
            default:
                await interaction.reply('Unknown operator.');
                return;
        }

        const formattedResult = Number.isInteger(result)
            ? result.toString()
            : result.toFixed(6).replace(/\.?0+$/, '');

        await interaction.reply(`${left} ${symbol} ${right} = ${formattedResult}`);
    }
    if (interaction.commandName === 'join') {
        const queue = getQueue(interaction.guildId);
        const connection = ensureConnection(interaction, queue);
        if (!connection) {
            await interaction.reply('Join a voice channel first.');
            return;
        }
        await interaction.reply('Joined your voice channel.');
        return;
    }
    if (interaction.commandName === 'leave') {
        const connection = getVoiceConnection(interaction.guildId);
        if (connection) connection.destroy();
        queues.delete(interaction.guildId);
        await interaction.reply('Left the voice channel.');
        return;
    }
    if (interaction.commandName === 'play') {
        const source = interaction.options.getString('source', true);
        if (isYouTubeUrl(source)) {
            await interaction.reply('YouTube URLs are not supported. Use a direct audio URL or a local file.');
            return;
        }
        const queue = getQueue(interaction.guildId);
        const connection = ensureConnection(interaction, queue);
        if (!connection) {
            await interaction.reply('Join a voice channel first.');
            return;
        }
        queue.tracks.push({ source });
        if (queue.player.state.status === AudioPlayerStatus.Idle) {
            await playNext(interaction.guildId);
        }
        await interaction.reply(`Queued: ${source}`);
        return;
    }
    if (interaction.commandName === 'pause') {
        const queue = getQueue(interaction.guildId);
        queue.player.pause(true);
        await interaction.reply('Paused.');
        return;
    }
    if (interaction.commandName === 'resume') {
        const queue = getQueue(interaction.guildId);
        queue.player.unpause();
        await interaction.reply('Resumed.');
        return;
    }
    if (interaction.commandName === 'skip') {
        const queue = getQueue(interaction.guildId);
        queue.player.stop(true);
        await interaction.reply('Skipped.');
        return;
    }
    if (interaction.commandName === 'queue') {
        const queue = getQueue(interaction.guildId);
        if (queue.tracks.length === 0) {
            await interaction.reply('Queue is empty.');
            return;
        }
        const list = queue.tracks.map((track, index) => `${index + 1}. ${track.source}`).join('\n');
        await interaction.reply(`Queue:\n${list}`);
        return;
    }
    if (interaction.commandName === 'catan') {
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const displayName = interaction.member?.displayName ?? interaction.user.username;
        const state = loadState();
        const game = getGame(state, guildId);

        if (subcommand === 'create') {
            if (game && game.status !== 'finished') {
                await interaction.reply('A game already exists. Use /catan join or /catan start.');
                return;
            }
            const newGame = {
                status: 'lobby',
                players: [createPlayer(userId, displayName)],
                turnIndex: 0,
                round: 0,
                lastRoll: null,
                turnRolled: false,
                board: createBoard(),
                createdAt: new Date().toISOString(),
                startedAt: null,
            };
            setGame(state, guildId, newGame);
            saveState(state);
            await interaction.reply('Catan lobby created! Others can join with /catan join.');
            return;
        }

        if (subcommand === 'join') {
            if (!game || game.status !== 'lobby') {
                await interaction.reply('No open lobby. Create one with /catan create.');
                return;
            }
            if (game.players.find(player => player.id === userId)) {
                await interaction.reply('You are already in the lobby.');
                return;
            }
            if (game.players.length >= 6) {
                await interaction.reply('Lobby is full (max 6 players).');
                return;
            }
            game.players.push(createPlayer(userId, displayName));
            saveState(state);
            await interaction.reply(`${displayName} joined the lobby. (${game.players.length}/6)`);
            return;
        }

        if (subcommand === 'leave') {
            if (!game || game.status !== 'lobby') {
                await interaction.reply('You can only leave during the lobby phase.');
                return;
            }
            const beforeCount = game.players.length;
            game.players = game.players.filter(player => player.id !== userId);
            if (game.players.length === beforeCount) {
                await interaction.reply('You are not in the lobby.');
                return;
            }
            if (game.players.length === 0) {
                removeGame(state, guildId);
                saveState(state);
                await interaction.reply('Lobby closed (no players left).');
                return;
            }
            saveState(state);
            await interaction.reply(`${displayName} left the lobby. (${game.players.length}/6)`);
            return;
        }

        if (subcommand === 'start') {
            if (!game || game.status !== 'lobby') {
                await interaction.reply('No lobby to start. Create one with /catan create.');
                return;
            }
            if (game.players.length < 2) {
                await interaction.reply('Need at least 2 players to start.');
                return;
            }
            game.players.sort(() => Math.random() - 0.5);
            game.status = 'active';
            game.turnIndex = 0;
            game.round = 1;
            game.startedAt = new Date().toISOString();
            game.turnRolled = false;
            saveState(state);
            const current = game.players[game.turnIndex];
            await interaction.reply(`Game started! ${current.name} goes first.`);
            return;
        }

        if (subcommand === 'roll') {
            if (!game || game.status !== 'active') {
                await interaction.reply('No active game. Start one with /catan create.');
                return;
            }
            const current = game.players[game.turnIndex];
            if (current.id !== userId) {
                await interaction.reply(`It is ${current.name}'s turn.`);
                return;
            }
            if (game.turnRolled) {
                await interaction.reply('You already rolled this turn.');
                return;
            }
            const dieOne = Math.floor(Math.random() * 6) + 1;
            const dieTwo = Math.floor(Math.random() * 6) + 1;
            const total = dieOne + dieTwo;
            game.lastRoll = total;
            game.turnRolled = true;

            const gained = { wood: 0, brick: 0, wheat: 0, sheep: 0, ore: 0 };
            game.players.forEach(player => {
                const draws = player.settlements + player.cities * 2;
                for (let i = 0; i < draws; i += 1) {
                    const res = randomResource();
                    player.resources[res] += 1;
                    if (player.id === userId) {
                        gained[res] += 1;
                    }
                }
            });

            saveState(state);
            await interaction.reply(
                `You rolled ${total}. You gained: wood ${gained.wood}, brick ${gained.brick}, wheat ${gained.wheat}, sheep ${gained.sheep}, ore ${gained.ore}.`
            );
            return;
        }

        if (subcommand === 'build') {
            if (!game || game.status !== 'active') {
                await interaction.reply('No active game. Start one with /catan create.');
                return;
            }
            const current = game.players[game.turnIndex];
            if (current.id !== userId) {
                await interaction.reply(`It is ${current.name}'s turn.`);
                return;
            }
            const buildType = interaction.options.getString('type', true);
            const costs = {
                road: { wood: 1, brick: 1 },
                settlement: { wood: 1, brick: 1, wheat: 1, sheep: 1 },
                city: { wheat: 2, ore: 3 },
            };
            if (!costs[buildType]) {
                await interaction.reply('Unknown build type.');
                return;
            }
            if (buildType === 'city' && current.settlements < 1) {
                await interaction.reply('You need a settlement to upgrade into a city.');
                return;
            }
            if (!canAfford(current.resources, costs[buildType])) {
                await interaction.reply('Not enough resources.');
                return;
            }
            spendResources(current.resources, costs[buildType]);
            if (buildType === 'road') current.roads += 1;
            if (buildType === 'settlement') current.settlements += 1;
            if (buildType === 'city') {
                current.settlements -= 1;
                current.cities += 1;
            }
            const points = getPoints(current);
            if (points >= 10) {
                game.status = 'finished';
                saveState(state);
                await interaction.reply(`${current.name} built a ${buildType} and wins with ${points} points!`);
                return;
            }
            saveState(state);
            await interaction.reply(`${current.name} built a ${buildType}. Points: ${points}.`);
            return;
        }

        if (subcommand === 'endturn') {
            if (!game || game.status !== 'active') {
                await interaction.reply('No active game.');
                return;
            }
            const current = game.players[game.turnIndex];
            if (current.id !== userId) {
                await interaction.reply(`It is ${current.name}'s turn.`);
                return;
            }
            game.turnIndex = (game.turnIndex + 1) % game.players.length;
            if (game.turnIndex === 0) game.round += 1;
            game.turnRolled = false;
            const next = game.players[game.turnIndex];
            saveState(state);
            await interaction.reply(`Turn ended. It is now ${next.name}'s turn.`);
            return;
        }

        if (subcommand === 'status') {
            if (!game) {
                await interaction.reply('No game found. Create one with /catan create.');
                return;
            }
            const statusLines = game.players.map(player => {
                const points = getPoints(player);
                return `${player.name}: ${points} pts (S ${player.settlements}, C ${player.cities}, R ${player.roads})`;
            });
            const current = game.status === 'active' ? game.players[game.turnIndex]?.name : 'N/A';
            const lastRoll = game.lastRoll ?? 'none';
            const header = `Status: ${game.status}. Players: ${game.players.length}/6. Round: ${game.round}. Current: ${current}. Last roll: ${lastRoll}.`;
            await interaction.reply([header, ...statusLines].join('\n'));
            return;
        }

        if (subcommand === 'board') {
            if (!game) {
                await interaction.reply('No game found. Create one with /catan create.');
                return;
            }
            const boardText = renderBoard(game);
            const header = `Board view (last roll: ${game.lastRoll ?? 'none'})`;
            await interaction.reply(`\`\`\`\n${header}\n${boardText}\n\`\`\``);
            return;
        }

        if (subcommand === 'hand') {
            if (!game) {
                await interaction.reply('No game found. Create one with /catan create.');
                return;
            }
            const player = game.players.find(p => p.id === userId);
            if (!player) {
                await interaction.reply('You are not in this game.');
                return;
            }
            const res = player.resources;
            await interaction.reply({
                content: `Your resources: wood ${res.wood}, brick ${res.brick}, wheat ${res.wheat}, sheep ${res.sheep}, ore ${res.ore}.`,
                ephemeral: true,
            });
            return;
        }

        await interaction.reply('Unknown subcommand.');
    }
});

client.login(process.env.BOT_TOKEN).then(r =>
console.log("Login Successful " + r))
