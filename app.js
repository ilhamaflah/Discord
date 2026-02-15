import fetch from 'node-fetch';
import * as dotenv from 'dotenv';
import {Client, GatewayIntentBits, REST, Routes, userMention} from 'discord.js';
import { commands } from './commands.js';
import express from 'express';
import fs from 'fs';
import path from 'path';

const app = express();
dotenv.config();
//const config = require("./config/config");
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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

function canAfford(resources, cost) {
    return Object.keys(cost).every(key => resources[key] >= cost[key]);
}

function spendResources(resources, cost) {
    Object.keys(cost).forEach(key => {
        resources[key] -= cost[key];
    });
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
