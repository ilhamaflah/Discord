export const commands = [
    // Utility
    {
        name: 'ping',
        description: 'Replies with Pong!',
    },
    {
        name: 'calculate',
        description: 'Calculate a math expression',
        options: [
            {
                name: 'left',
                description: 'First number',
                type: 10,
                required: true,
            },
            {
                name: 'operator',
                description: 'Math operation',
                type: 3,
                required: true,
                choices: [
                    { name: 'Add (+)', value: 'add' },
                    { name: 'Subtract (-)', value: 'subtract' },
                    { name: 'Multiply (*)', value: 'multiply' },
                    { name: 'Divide (/)', value: 'divide' },
                ],
            },
            {
                name: 'right',
                description: 'Second number',
                type: 10,
                required: true,
            },
        ],
    },

    // Fun
    {
        name: 'tod',
        description: 'Spin RAMBOT E someone',
        options: [
            {
                name: 'member',
                description: 'Who?',
                type: 6,
                required: true,
            },
        ],
    },
    {
        name: 'inspire',
        description: 'Get a quote',
    },

    // Games
    {
        name: 'catan',
        description: 'Play Catan (base rules)',
        options: [
            { type: 1, name: 'create', description: 'Create a new lobby' },
            { type: 1, name: 'join', description: 'Join the lobby' },
            { type: 1, name: 'leave', description: 'Leave the lobby' },
            { type: 1, name: 'disband', description: 'Vote to disband an ongoing game (all players must approve)' },
            { type: 1, name: 'start', description: 'Start setup order roll phase' },
            { type: 1, name: 'roll', description: 'Roll dice (setup order or turn roll)' },
            {
                type: 1,
                name: 'place',
                description: 'Place settlement/road/city at a board coordinate',
                options: [
                    {
                        name: 'type',
                        description: 'What to place',
                        type: 3,
                        required: true,
                        choices: [
                            { name: 'Road', value: 'road' },
                            { name: 'Settlement', value: 'settlement' },
                            { name: 'City', value: 'city' },
                        ],
                    },
                    {
                        name: 'at',
                        description: 'Board ID, e.g. V12 or E34',
                        type: 3,
                        required: true,
                    },
                ],
            },
            {
                type: 1,
                name: 'build',
                description: 'Backward-compatible build command (prefer /catan place)',
                options: [
                    {
                        name: 'type',
                        description: 'What to build',
                        type: 3,
                        required: true,
                        choices: [
                            { name: 'Road', value: 'road' },
                            { name: 'Settlement', value: 'settlement' },
                            { name: 'City', value: 'city' },
                        ],
                    },
                    {
                        name: 'at',
                        description: 'Board ID, e.g. V12 or E34',
                        type: 3,
                        required: false,
                    },
                ],
            },
            {
                type: 1,
                name: 'trade-bank',
                description: 'Trade 4:1 with bank',
                options: [
                    {
                        name: 'give',
                        description: 'Resource to give x4',
                        type: 3,
                        required: true,
                        choices: [
                            { name: 'Wood', value: 'wood' },
                            { name: 'Brick', value: 'brick' },
                            { name: 'Wheat', value: 'wheat' },
                            { name: 'Sheep', value: 'sheep' },
                            { name: 'Ore', value: 'ore' },
                        ],
                    },
                    {
                        name: 'get',
                        description: 'Resource to receive',
                        type: 3,
                        required: true,
                        choices: [
                            { name: 'Wood', value: 'wood' },
                            { name: 'Brick', value: 'brick' },
                            { name: 'Wheat', value: 'wheat' },
                            { name: 'Sheep', value: 'sheep' },
                            { name: 'Ore', value: 'ore' },
                        ],
                    },
                ],
            },
            {
                type: 1,
                name: 'trade-player',
                description: 'Offer a trade to one player',
                options: [
                    {
                        name: 'target',
                        description: 'Target player',
                        type: 6,
                        required: true,
                    },
                    {
                        name: 'give',
                        description: 'Offer as resource:count list (e.g. wood:1,brick:2)',
                        type: 3,
                        required: true,
                    },
                    {
                        name: 'get',
                        description: 'Request as resource:count list',
                        type: 3,
                        required: true,
                    },
                ],
            },
            {
                type: 1,
                name: 'dev-buy',
                description: 'Buy a development card',
            },
            {
                type: 1,
                name: 'dev-play',
                description: 'Play a development card',
                options: [
                    {
                        name: 'card',
                        description: 'Development card type',
                        type: 3,
                        required: true,
                        choices: [
                            { name: 'Knight', value: 'knight' },
                            { name: 'Road Building', value: 'road_building' },
                            { name: 'Year of Plenty', value: 'year_of_plenty' },
                            { name: 'Monopoly', value: 'monopoly' },
                        ],
                    },
                    {
                        name: 'resource',
                        description: 'Resource (for monopoly/year_of_plenty)',
                        type: 3,
                        required: false,
                        choices: [
                            { name: 'Wood', value: 'wood' },
                            { name: 'Brick', value: 'brick' },
                            { name: 'Wheat', value: 'wheat' },
                            { name: 'Sheep', value: 'sheep' },
                            { name: 'Ore', value: 'ore' },
                        ],
                    },
                    {
                        name: 'resource2',
                        description: 'Second resource (year_of_plenty)',
                        type: 3,
                        required: false,
                        choices: [
                            { name: 'Wood', value: 'wood' },
                            { name: 'Brick', value: 'brick' },
                            { name: 'Wheat', value: 'wheat' },
                            { name: 'Sheep', value: 'sheep' },
                            { name: 'Ore', value: 'ore' },
                        ],
                    },
                    {
                        name: 'edge1',
                        description: 'First edge (road_building), e.g. E12',
                        type: 3,
                        required: false,
                    },
                    {
                        name: 'edge2',
                        description: 'Second edge (road_building)',
                        type: 3,
                        required: false,
                    },
                ],
            },
            {
                type: 1,
                name: 'robber',
                description: 'Move robber and optionally steal',
                options: [
                    {
                        name: 'tile',
                        description: 'Tile number 1-19',
                        type: 4,
                        required: true,
                        min_value: 1,
                        max_value: 19,
                    },
                    {
                        name: 'target',
                        description: 'Optional steal target',
                        type: 6,
                        required: false,
                    },
                ],
            },
            {
                type: 1,
                name: 'setup-status',
                description: 'Show current setup progress',
            },
            {
                type: 1,
                name: 'endturn',
                description: 'End your turn',
            },
            {
                type: 1,
                name: 'status',
                description: 'Show game status',
            },
            {
                type: 1,
                name: 'board',
                description: 'Show board coordinates and ownership',
            },
            {
                type: 1,
                name: 'hand',
                description: 'Show your private hand',
            },
        ],
    },

    // Music
    {
        name: 'music',
        description: 'Music player commands',
        options: [
            {
                type: 1,
                name: 'join',
                description: 'Join your voice channel',
            },
            {
                type: 1,
                name: 'leave',
                description: 'Leave the voice channel',
            },
            {
                type: 1,
                name: 'play',
                description: 'Play or queue from a URL, search query, or playlist',
                options: [
                    {
                        name: 'source',
                        description: 'URL or search query',
                        type: 3,
                        required: true,
                    },
                ],
            },
            {
                type: 1,
                name: 'pause',
                description: 'Pause playback',
            },
            {
                type: 1,
                name: 'resume',
                description: 'Resume playback',
            },
            {
                type: 1,
                name: 'skip',
                description: 'Skip current track',
            },
            {
                type: 1,
                name: 'next',
                description: 'Skip to the next track',
            },
            {
                type: 1,
                name: 'queue',
                description: 'Show the queue',
            },
            {
                type: 1,
                name: 'purge',
                description: 'Clear the full queue and stop playback',
            },
            {
                type: 1,
                name: 'remove',
                description: 'Remove a track by number (or choose from buttons)',
                options: [
                    {
                        name: 'position',
                        description: 'Queue number to remove (optional)',
                        type: 4,
                        required: false,
                        min_value: 1,
                    },
                ],
            },
        ],
    },
];
