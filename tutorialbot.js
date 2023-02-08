require("dotenv").config();
const discord = require("discord.js");
const client = new discord.Client()
const config = require("./config/config");

client.login(process.env.BOT_TOKEN);
//OR
//client.login(config.TOD_BOT.TOKEN);
//client.disconnect();
client.on("ready", () => {
    console.log(`${client.user.tag} has logged in.`);
});

client.on("message", async function(message){
    await console.log(`${message.author.username}: ${message.content}`);
    if(message.author.bot) return;
    if(message.content === "tod"){
        message.channel.send("AANCOK");
    }
    else if(message.content === "todtrivia"){
        message.channel.send("Siapa orang yang memiliki gelar GrandMaster breakdown di server ini?\n```A. Aan\nB. AANCOK\nC. RAMBOT\nD. BREKELE```");
    }
    else if(message.content === "todroll"){
        const testrandom = Math.floor(Math.random() * 6) + 1;
        message.channel.send(testrandom);
    }
});

console.log(process.env.BOT_TOKEN);