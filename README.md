# 🎯 TOD Bot 🤖🎵🎲

![TOD Bot Feature](./cyka.jpg)

✨ Discord multipurpose bot with:
- 🛠️ Utility commands
- 🎵 NodeLink-powered music playback (via `moonlink.js`)
- 🎲 Playable Catan mini-game

## 🌈 Features

- 💬 Slash-command based bot (`/ping`, `/calculate`, `/tod`, `/inspire`)
- 🎧 Music system with NodeLink
- 🔎 `/music play` with search result buttons
- 📇 Compact now-playing chat card
- 📄 Queue pagination with Previous/Next buttons
- 🧹 Queue management: `bump`, `remove`, `purge`
- 🔁 Auto now-playing card when next queued track starts after a finished track
- 🏗️ Catan game system
- 👥 Lobby flow (`create`, `join`, `leave`, `start`)
- 🎲 Turn flow (`roll`, `place`, `build`, `endturn`)
- 🤝 Trade + dev cards + robber
- 🗳️ Ongoing-game disband voting that requires all active players

## 🧭 Command Overview

🛠️ Utility:
- `/ping`
- `/calculate left:<number> operator:<add|subtract|multiply|divide> right:<number>`
- `/tod member:<user>`
- `/inspire`

🎵 Music:
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

🎲 Catan:
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
- 🤖 A Discord application + bot token
- 🔌 A running NodeLink server (same machine, another machine, or Docker service)

## 🔐 Environment Variables

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

## 🖥️ Run Locally (npm)

1. Install dependencies:
```bash
npm ci
```
2. Ensure NodeLink is running and matches your `.env`.
3. Start bot:
```bash
npm start
```

✅ The bot registers global slash commands at startup.

## 🐳 Run with Docker

Bot only (connects to external NodeLink):
```bash
docker compose -f compose.yaml up -d --build
```

Full stack (bot + NodeLink together):
```bash
docker compose -f compose.stack.yaml up -d --build
```

## 🗂️ Project Files

- `app.js`: bootstrap, Discord events, command routing
- `commands.js`: slash command definitions
- `music.js`: music manager, queue UI, components, autoplay card updates
- `catan.js`: Catan game logic and interactions
- `compose.yaml`: bot service
- `compose.stack.yaml`: bot + NodeLink services
- `Dockerfile`: production image for bot

## 🛡️ Security Notes

- 🚫 Do not commit real tokens/passwords
- 🔄 Rotate secrets if they were ever exposed
- 🔒 Keep `.env` local and excluded from version control
