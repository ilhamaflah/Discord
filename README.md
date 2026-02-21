# TOD Bot

![TOD Bot Feature](./cyka.jpg)

![Node](https://img.shields.io/badge/Node-22+-3C873A?style=for-the-badge&logo=node.js&logoColor=white)
![Discord](https://img.shields.io/badge/Discord.js-v14-5865F2?style=for-the-badge&logo=discord&logoColor=white)
![Music](https://img.shields.io/badge/Audio-NodeLink-FF6B6B?style=for-the-badge)
![Mode](https://img.shields.io/badge/Mode-Multiplayer-0EA5E9?style=for-the-badge)

> 🎯 Your all-in-one Discord arena bot for utility, music, and Catan nights.

## 🌈 Features

- 💬 Slash-command workflow (`/ping`, `/calculate`, `/tod`, `/inspire`)
- 🎵 Music system with NodeLink + Moonlink
- 🔎 `/music play` supports URL or search query
- 🎛️ Search pick buttons for top results
- 📇 Compact now-playing chat cards
- 📄 Queue pagination with Previous/Next buttons
- 🧹 Queue tools: `bump`, `remove`, `purge`
- 🔁 Auto now-playing card when finished track advances to next queue item
- 🎲 Catan mini-game with lobby, setup, turn flow, trade, robber, and dev cards
- 🗳️ Ongoing-game disband requires all active players to approve

## 🧭 Command Overview

### 🛠️ Utility

- `/ping`
- `/calculate left:<number> operator:<add|subtract|multiply|divide> right:<number>`
- `/tod member:<user>`
- `/inspire`

### 🎵 Music

- `/music join`
- `/music leave`
- `/music play source:<url-or-query>`
- `/music pause`
- `/music resume`
- `/music skip`
- `/music next`
- `/music queue`
- `/music nowplaying`
- `/music purge`
- `/music bump position:<queue-index>` (autocomplete)
- `/music remove position:<queue-index>` (autocomplete)

### 🎲 Catan

- `/catan create`
- `/catan join`
- `/catan leave`
- `/catan disband`
- `/catan start`
- `/catan roll`
- `/catan place type:<road|settlement|city> at:<id>`
- `/catan build ...` (backward-compatible)
- `/catan trade-bank give:<resource> get:<resource>`
- `/catan trade-player target:<user> give:<map> get:<map>`
- `/catan dev-buy`
- `/catan dev-play ...`
- `/catan robber tile:<1-19> [target:<user>]`
- `/catan setup-status`
- `/catan endturn`
- `/catan status`
- `/catan board`
- `/catan hand`

## 📦 Requirements

- 🟢 Node.js `>= 22`
- 📦 npm
- 🤖 Discord application + bot token
- 🔌 Running NodeLink server (local, remote, or Docker)

## 🔐 .env Template

Create `.env` in project root:

```env
BOT_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_client_id
APP_ID=your_discord_application_id
PUBLIC_KEY=your_discord_public_key
CLIENT_SECRET=your_discord_client_secret

NODELINK_HOST=127.0.0.1
NODELINK_PORT=2333
NODELINK_PASSWORD=change_me
NODELINK_SECURE=false
NODELINK_ID=main
NODELINK_PATH_VERSION=v4

NODELINK_DEFAULT_SEARCH_PLATFORM=youtubemusic
NODELINK_RETRY_AMOUNT=10
NODELINK_RETRY_DELAY_MS=5000
NODELINK_RESUME_TIMEOUT_MS=60000

MUSIC_DEFAULT_VOLUME=100
MUSIC_IDLE_LEAVE_MS=60000
MUSIC_DEBUG=1
```

## 🖥️ Run Locally

1. Install dependencies:
```bash
npm ci
```
2. Ensure NodeLink is running and matches `.env`.
3. Start the bot:
```bash
npm start
```

✅ Slash commands are registered at startup.

## 🐳 Run with Docker

Bot only (connects to external NodeLink):
```bash
docker compose -f compose.yaml up -d --build
```

Full stack (bot + NodeLink):
```bash
docker compose -f compose.stack.yaml up -d --build
```

## 🗂️ Project Files

- `app.js`: app bootstrap, Discord events, routing
- `commands.js`: slash command definitions
- `music.js`: music manager, queue UI, component interactions
- `catan.js`: Catan gameplay logic and interactions
- `compose.yaml`: bot container setup
- `compose.stack.yaml`: bot + NodeLink stack
- `Dockerfile`: production image for bot

## 🛡️ Security

- 🚫 Do not commit real tokens/passwords
- 🔄 Rotate secrets if exposed
- 🔒 Keep `.env` local and ignored by git
