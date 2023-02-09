import fetch from 'node-fetch';
import * as dotenv from 'dotenv';
import {Client, GatewayIntentBits, REST, Routes, userMention} from 'discord.js';
import { commands } from './commands.js'

dotenv.config();
//const config = require("./config/config");
const client = new Client({ intents: [GatewayIntentBits.Guilds] });


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
    const objectifiedJson = JSON.parse(stringifiedObject)
    console.log(`Message received: ${interaction.commandName}`);
    console.log(stringifiedObject)
    console.log(objectifiedJson._hoistedOptions[0].user.id)
    if (!interaction.guild) return;
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'inspire') {
        await getQuote().then(quote => interaction.reply(quote))
    }
    if (interaction.commandName === 'ping') {
        await interaction.reply('Pong!');
    }
    if (interaction.commandName === 'tod') {
        await interaction.reply(`z!spin RAMBOT E ${userMention(objectifiedJson._hoistedOptions[0].user.id)}`);
    }
});

client.login(process.env.BOT_TOKEN).then(r =>
console.log("Login Successful " + r))