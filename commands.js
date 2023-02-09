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
];