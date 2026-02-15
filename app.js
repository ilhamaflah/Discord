// --- Imports ---
import fetch from 'node-fetch';
import * as dotenv from 'dotenv';
import { Client, GatewayIntentBits, REST, Routes, userMention } from 'discord.js';
import { commands } from './commands.js';
import express from 'express';
import { handleMusicCommand } from './music.js';
import { handleCatanCommand } from './catan.js';

// --- App bootstrap ---
const app = express();
dotenv.config();
//const config = require("./config/config");
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

// --- Web server (keep-alive / health) ---
app.set('port', 3000);
app.listen(app.get('port'), function() {
    console.log('Server started on port ' + app.get('port'));
});
//client.login(process.env.BOT_TOKEN);
//OR
//client.login(config.TOD_BOT.TOKEN);
//client.disconnect();

// --- External API helpers ---
function getQuote() {
    return fetch("https://zenquotes.io/api/random")
        .then(res => {
            return res.json();
        })
        .then(data => {
            return data[0]["q"] + " -" + data[0]["a"];
        });
}

// --- Slash command registration ---
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

// --- Discord events ---
client.on('clientReady', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

client.on('interactionCreate', async interaction => {
    //console.log(`${msg.author.username}: ${msg.content.toString()}`);
    const stringifiedObject = JSON.stringify(interaction.options, null, 2);
    console.log(`Message received: ${interaction.commandName}`);
    console.log(stringifiedObject);
    if (!interaction.guild) return;
    if (!interaction.isChatInputCommand()) return;

    switch (interaction.commandName) {
        case 'inspire':
            await getQuote().then(quote => interaction.reply(quote));
            return;
        case 'ping':
            await interaction.reply('Pong!');
            return;
        case 'tod': {
            const objectifiedJson = JSON.parse(stringifiedObject);
            await interaction.reply(`z!spin RAMBOT E ${userMention(objectifiedJson._hoistedOptions[0].user.id)}`);
            console.log(objectifiedJson._hoistedOptions[0].user.id);
            return;
        }
        case 'calculate': {
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
            return;
        }
        case 'join':
        case 'leave':
        case 'play':
        case 'pause':
        case 'resume':
        case 'skip':
        case 'queue':
            try {
                await handleMusicCommand(interaction);
            } catch (error) {
                console.error('Music command failed:', error);
                if (!interaction.deferred && !interaction.replied) {
                    await interaction.reply('Music command failed. Please try again.');
                }
            }
            return;
        case 'catan':
            try {
                await handleCatanCommand(interaction);
            } catch (error) {
                console.error('Catan command failed:', error);
                if (!interaction.deferred && !interaction.replied) {
                    await interaction.reply('Catan command failed. Please try again.');
                }
            }
            return;
        default:
            await interaction.reply('Unknown command.');
    }
});

client.login(process.env.BOT_TOKEN).then(r =>
console.log("Login Successful " + r));
