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
        description: 'Play a simplified Catan game',
        options: [
            {
                type: 1,
                name: 'create',
                description: 'Create a new lobby',
            },
            {
                type: 1,
                name: 'join',
                description: 'Join the lobby',
            },
            {
                type: 1,
                name: 'leave',
                description: 'Leave the lobby',
            },
            {
                type: 1,
                name: 'start',
                description: 'Start the game',
            },
            {
                type: 1,
                name: 'roll',
                description: 'Roll dice and gain resources',
            },
            {
                type: 1,
                name: 'build',
                description: 'Build something',
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
                ],
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
                description: 'Show a visual board',
            },
            {
                type: 1,
                name: 'hand',
                description: 'Show your resources',
            },
        ],
    },

    // Music
    {
        name: 'join',
        description: 'Join your voice channel',
    },
    {
        name: 'leave',
        description: 'Leave the voice channel',
    },
    {
        name: 'play',
        description: 'Play or queue an audio URL or local file',
        options: [
            {
                name: 'source',
                description: 'Direct audio URL or local file path',
                type: 3,
                required: true,
            },
        ],
    },
    {
        name: 'pause',
        description: 'Pause playback',
    },
    {
        name: 'resume',
        description: 'Resume playback',
    },
    {
        name: 'skip',
        description: 'Skip current track',
    },
    {
        name: 'queue',
        description: 'Show the queue',
    },
];
