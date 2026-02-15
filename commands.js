export const commands = [
    {
        name: 'ping',
        description: 'Replies with Pong!',
    },
    {
        name: 'tod',
        description: 'Spin RAMBOT E someone',
        options: [
            {
                name: "member",
                description: "Who?",
                type: 6,
                required: true,

            },
        ]
    },
    {
        name: 'inspire',
        description: 'Get a quote',
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
];
