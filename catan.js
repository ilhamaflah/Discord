
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

// --- Persistence and global constants ---
const DATA_DIR = path.join(process.cwd(), 'data');
const CATAN_FILE = path.join(DATA_DIR, 'catan.json');

const STATE_VERSION = 2;
const RESOURCES = ['wood', 'brick', 'wheat', 'sheep', 'ore'];
const DEV_CARD_TYPES = ['knight', 'road_building', 'year_of_plenty', 'monopoly', 'victory_point'];
const DISBAND_VOTE_WINDOW_MS = 5 * 60 * 1000;

const PHASE = {
    LOBBY: 'lobby',
    SETUP_ORDER_ROLL: 'setup_order_roll',
    SETUP_PLACEMENT: 'setup_placement',
    TURN_ROLL: 'turn_roll',
    TURN_ACTION: 'turn_action',
    ROBBER_MOVE: 'robber_move',
    FINISHED: 'finished',
};

const AXIAL_HEXES = [
    [0, -2], [1, -2], [2, -2],
    [-1, -1], [0, -1], [1, -1], [2, -1],
    [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0],
    [-2, 1], [-1, 1], [0, 1], [1, 1],
    [-2, 2], [-1, 2], [0, 2],
];

const HEX_RESOURCES = [
    'wood', 'wood', 'wood', 'wood',
    'brick', 'brick', 'brick',
    'sheep', 'sheep', 'sheep', 'sheep',
    'wheat', 'wheat', 'wheat', 'wheat',
    'ore', 'ore', 'ore',
    'desert',
];

const HEX_TOKENS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

const COSTS = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, wheat: 1, sheep: 1 },
    city: { wheat: 2, ore: 3 },
    dev_buy: { wheat: 1, sheep: 1, ore: 1 },
};

const DEV_DECK_TEMPLATE = [
    ...Array(14).fill('knight'),
    ...Array(2).fill('road_building'),
    ...Array(2).fill('year_of_plenty'),
    ...Array(2).fill('monopoly'),
    ...Array(5).fill('victory_point'),
];
const DEV_CARD_COUNTS = {
    knight: 14,
    road_building: 2,
    year_of_plenty: 2,
    monopoly: 2,
    victory_point: 5,
};

const RESOURCE_ICON = {
    wood: '\u{1F333}',
    brick: '\u{1F9F1}',
    wheat: '\u{1F33E}',
    sheep: '\u{1F411}',
    ore: '\u{26CF}\u{FE0F}',
    desert: '\u{1F3DC}\u{FE0F}',
};

const BUILDING_ICON = {
    settlement: '🏠',
    city: '🏰',
};

const PLAYER_MARKERS = ['🔴', '🔵', '🟢', '🟡', '⚪'];
const PLAYER_COLORS = ['#d94a4a', '#3b82f6', '#2fa36b', '#d4a619', '#9ca3af'];
const RESOURCE_COLORS = {
    wood: '#6f9c50',
    brick: '#c9774f',
    wheat: '#e2c468',
    sheep: '#9acb72',
    ore: '#9aa4b1',
    desert: '#d8c3a0',
};

// --- Core data helpers ---
function emptyResources() {
    return { wood: 0, brick: 0, wheat: 0, sheep: 0, ore: 0 };
}

function emptyDevCards() {
    return { knight: 0, road_building: 0, year_of_plenty: 0, monopoly: 0, victory_point: 0 };
}

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function createPlayer(id, name) {
    return {
        id,
        name,
        resources: emptyResources(),
        devCards: emptyDevCards(),
        lockedDevCards: emptyDevCards(),
        piecesRemaining: { settlement: 5, city: 4, road: 15 },
        settlements: [],
        cities: [],
        roads: [],
        playedKnights: 0,
    };
}

function createLobbyGame(players) {
    return {
        phase: PHASE.LOBBY,
        players,
        board: null,
        setup: null,
        turn: null,
        turnOrder: [],
        devDeck: [],
        awards: { longestRoadOwnerId: null, longestRoadLength: 0, largestArmyOwnerId: null },
        tradeState: { pendingOffer: null },
        disbandVote: null,
        robberContext: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        winnerId: null,
    };
}

function migrateV1toV2(raw) {
    const migrated = { version: STATE_VERSION, guilds: {} };
    const guilds = raw?.guilds ?? {};
    Object.entries(guilds).forEach(([guildId, guildState]) => {
        const game = guildState?.game;
        if (!game) {
            migrated.guilds[guildId] = {};
            return;
        }
        if (game.phase) {
            migrated.guilds[guildId] = guildState;
            return;
        }
        if (game.status === 'lobby') {
            migrated.guilds[guildId] = {
                game: createLobbyGame((game.players ?? []).map(p => createPlayer(p.id, p.name ?? 'Player'))),
                migrationNote: 'Legacy lobby migrated to v2.',
            };
            return;
        }
        migrated.guilds[guildId] = {
            migrationNote: 'Legacy active game is incompatible with v2. Create a new game with /catan create.',
        };
    });
    return migrated;
}

function loadState() {
    ensureDataDir();
    if (!fs.existsSync(CATAN_FILE)) return { version: STATE_VERSION, guilds: {} };
    try {
        const parsed = JSON.parse(fs.readFileSync(CATAN_FILE, 'utf8'));
        if (!parsed?.version || parsed.version < STATE_VERSION) {
            const migrated = migrateV1toV2(parsed);
            saveState(migrated);
            return migrated;
        }
        if (parsed.guilds) {
            for (const guild of Object.values(parsed.guilds)) {
                if (guild.game && !Array.isArray(guild.game.players)) {
                    guild.game.players = [];
                }
                if (guild.game && !Object.prototype.hasOwnProperty.call(guild.game, 'disbandVote')) {
                    guild.game.disbandVote = null;
                }
            }
        }
        return parsed;
    } catch (error) {
        console.error('Failed to read catan state. Starting fresh.', error);
        return { version: STATE_VERSION, guilds: {} };
    }
}

function saveState(state) {
    ensureDataDir();
    state.version = STATE_VERSION;
    fs.writeFileSync(CATAN_FILE, JSON.stringify(state, null, 2));
}

function getGuildState(state, guildId) {
    if (!state.guilds[guildId]) state.guilds[guildId] = {};
    return state.guilds[guildId];
}

function getGame(state, guildId) {
    return getGuildState(state, guildId).game ?? null;
}

function setGame(state, guildId, game) {
    getGuildState(state, guildId).game = game;
}

function removeGame(state, guildId) {
    delete getGuildState(state, guildId).game;
}

// --- Generic utilities ---
function shuffle(arr) {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function rollDie() {
    return Math.floor(Math.random() * 6) + 1;
}

function canAfford(resources, cost) {
    return Object.keys(cost).every(k => (resources[k] ?? 0) >= cost[k]);
}

function spendResources(resources, cost) {
    Object.keys(cost).forEach(k => {
        resources[k] -= cost[k];
    });
}

function addResources(resources, delta) {
    Object.keys(delta).forEach(k => {
        resources[k] = (resources[k] ?? 0) + delta[k];
    });
}

function resourceMapToString(map) {
    return RESOURCES.map(k => `${resourceDisplayName(k)} ${map[k] ?? 0}`).join(', ');
}

function resourceDisplayName(resource) {
    const icon = RESOURCE_ICON[resource];
    return icon ? `${icon} ${resource}` : resource;
}

function resourceLegendLine(includeDesert = true) {
    const list = includeDesert ? [...RESOURCES, 'desert'] : RESOURCES;
    return list.map(resourceDisplayName).join(' | ');
}

function costToString(costMap) {
    return RESOURCES
        .filter(resource => (costMap[resource] ?? 0) > 0)
        .map(resource => `${resourceDisplayName(resource)} ${costMap[resource]}`)
        .join(', ');
}

function getBuildCostLines() {
    return [
        'Build Costs:',
        `Road: ${costToString(COSTS.road)}`,
        `Settlement: ${costToString(COSTS.settlement)}`,
        `City: ${costToString(COSTS.city)}`,
        `Development card: ${costToString(COSTS.dev_buy)}`,
    ];
}

function getDevCardGuideLines() {
    return [
        'Development Cards Guide:',
        `Deck (25): knight ${DEV_CARD_COUNTS.knight}, road_building ${DEV_CARD_COUNTS.road_building}, year_of_plenty ${DEV_CARD_COUNTS.year_of_plenty}, monopoly ${DEV_CARD_COUNTS.monopoly}, victory_point ${DEV_CARD_COUNTS.victory_point}`,
        '',
        'General rules:',
        `- Buy with /catan dev-buy (cost: ${costToString(COSTS.dev_buy)}).`,
        '- Bought cards go to "Locked dev cards" and cannot be played this turn.',
        '- Locked cards become playable after turn ends.',
        '- /catan dev-play is only usable during your TURN_ACTION.',
        `- Resource legend: ${resourceLegendLine(false)}.`,
        '',
        'Cards:',
        '- knight: /catan dev-play card:knight -> starts robber move. Then use /catan robber tile:<1-19> [target]. Counts toward Largest Army.',
        '- road_building: /catan dev-play card:road_building edge1:E12 edge2:E34 -> place 2 free legal roads.',
        '- year_of_plenty: /catan dev-play card:year_of_plenty resource:wood resource2:ore -> gain 2 chosen resources.',
        '- monopoly: /catan dev-play card:monopoly resource:wheat -> take all wheat from other players.',
        '- victory_point: not playable with /catan dev-play. It gives +1 VP automatically while owned.',
    ];
}

function devCardsToString(map) {
    return DEV_CARD_TYPES.map(k => `${k} ${map[k] ?? 0}`).join(', ');
}

function parseResourceMap(input) {
    if (!input || typeof input !== 'string') return null;
    const map = emptyResources();
    const parts = input.split(',').map(v => v.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    for (const part of parts) {
        const [rawResource, rawCount] = part.split(':').map(v => v?.trim().toLowerCase());
        const count = Number(rawCount);
        if (!RESOURCES.includes(rawResource) || !Number.isInteger(count) || count <= 0) return null;
        map[rawResource] += count;
    }
    return map;
}

function totalResourceCount(resources) {
    return RESOURCES.reduce((sum, key) => sum + (resources[key] ?? 0), 0);
}

function drawRandomResource(resources) {
    const bag = [];
    RESOURCES.forEach(res => {
        for (let i = 0; i < (resources[res] ?? 0); i += 1) bag.push(res);
    });
    if (bag.length === 0) return null;
    return bag[Math.floor(Math.random() * bag.length)];
}

function getPlayer(game, userId) {
    return game.players.find(p => p.id === userId) ?? null;
}

function isOngoingGame(game) {
    return game.phase !== PHASE.LOBBY && game.phase !== PHASE.FINISHED;
}

function normalizeActiveDisbandVote(game) {
    const vote = game.disbandVote;
    if (!vote || typeof vote !== 'object') {
        game.disbandVote = null;
        return null;
    }

    if (!vote.initiatedBy || !Array.isArray(vote.approvals) || !Number.isFinite(vote.expiresAt)) {
        game.disbandVote = null;
        return null;
    }

    if (!game.players.some(player => player.id === vote.initiatedBy)) {
        game.disbandVote = null;
        return null;
    }

    vote.approvals = [...new Set(vote.approvals.filter(id => game.players.some(player => player.id === id)))];
    if (!vote.approvals.includes(vote.initiatedBy)) {
        vote.approvals.push(vote.initiatedBy);
    }

    if (Date.now() > vote.expiresAt) {
        game.disbandVote = null;
        return null;
    }

    return vote;
}

function pendingDisbandApprovals(game, vote) {
    return game.players.filter(player => !vote.approvals.includes(player.id));
}

function formatDisbandVoteLine(game, vote) {
    const pending = pendingDisbandApprovals(game, vote);
    const expiresAtUnix = Math.floor(vote.expiresAt / 1000);
    const pendingText = pending.length > 0
        ? pending.map(player => `<@${player.id}>`).join(', ')
        : 'none';
    return `Disband vote: ${vote.approvals.length}/${game.players.length} approvals | Pending: ${pendingText} | Expires: <t:${expiresAtUnix}:R>`;
}

function currentPlayer(game) {
    return game.turn ? getPlayer(game, game.turn.currentPlayerId) : null;
}

function getVertex(game, vertexId) {
    return game.board.vertices[vertexId] ?? null;
}

function getEdge(game, edgeId) {
    return game.board.edges[edgeId] ?? null;
}

function getPlayerPoints(game, player) {
    const settlementPts = player.settlements.length;
    const cityPts = player.cities.length * 2;
    const vpCards = player.devCards.victory_point + player.lockedDevCards.victory_point;
    const longestRoad = game.awards.longestRoadOwnerId === player.id ? 2 : 0;
    const largestArmy = game.awards.largestArmyOwnerId === player.id ? 2 : 0;
    return settlementPts + cityPts + vpCards + longestRoad + largestArmy;
}

function buildBoardTopology() {
    const vertexByTempKey = new Map();
    const edgeByTempKey = new Map();
    const hexesRaw = [];
    const size = 1000;
    const sqrt3 = Math.sqrt(3);

    function pointKey(x, y) {
        return `${Math.round(x)}:${Math.round(y)}`;
    }

    function edgeKey(a, b) {
        return a < b ? `${a}|${b}` : `${b}|${a}`;
    }

    AXIAL_HEXES.forEach(([q, r], index) => {
        const hexId = `H${index + 1}`;
        const cx = size * sqrt3 * (q + r / 2);
        const cy = size * 1.5 * r;
        const vertexTempKeys = [];
        const edgeTempKeys = [];

        for (let i = 0; i < 6; i += 1) {
            const angle = ((60 * i) - 30) * Math.PI / 180;
            const vx = cx + size * Math.cos(angle);
            const vy = cy + size * Math.sin(angle);
            const vKey = pointKey(vx, vy);
            vertexTempKeys.push(vKey);
            if (!vertexByTempKey.has(vKey)) {
                vertexByTempKey.set(vKey, { hexIds: [], neighborTempKeys: new Set(), edgeTempKeys: new Set() });
            }
            vertexByTempKey.get(vKey).hexIds.push(hexId);
        }

        for (let i = 0; i < 6; i += 1) {
            const a = vertexTempKeys[i];
            const b = vertexTempKeys[(i + 1) % 6];
            const eKey = edgeKey(a, b);
            edgeTempKeys.push(eKey);
            if (!edgeByTempKey.has(eKey)) {
                edgeByTempKey.set(eKey, { vertexTempKeys: [a, b], hexIds: [] });
            }
            edgeByTempKey.get(eKey).hexIds.push(hexId);
            vertexByTempKey.get(a).neighborTempKeys.add(b);
            vertexByTempKey.get(b).neighborTempKeys.add(a);
            vertexByTempKey.get(a).edgeTempKeys.add(eKey);
            vertexByTempKey.get(b).edgeTempKeys.add(eKey);
        }

        hexesRaw.push({ id: hexId, q, r, vertexTempKeys, edgeTempKeys });
    });

    const sortedVertexKeys = [...vertexByTempKey.keys()].sort();
    const vertexIdByTempKey = new Map();
    sortedVertexKeys.forEach((key, i) => vertexIdByTempKey.set(key, `V${i + 1}`));

    const vertices = {};
    sortedVertexKeys.forEach(tempKey => {
        const id = vertexIdByTempKey.get(tempKey);
        const raw = vertexByTempKey.get(tempKey);
        vertices[id] = {
            id,
            hexIds: [...raw.hexIds],
            neighborVertexIds: [...raw.neighborTempKeys].map(k => vertexIdByTempKey.get(k)).sort(),
            edgeIds: [...raw.edgeTempKeys],
            building: null,
        };
    });

    const sortedEdgeKeys = [...edgeByTempKey.keys()].sort();
    const edgeIdByTempKey = new Map();
    sortedEdgeKeys.forEach((key, i) => edgeIdByTempKey.set(key, `E${i + 1}`));

    const edges = {};
    sortedEdgeKeys.forEach(tempKey => {
        const id = edgeIdByTempKey.get(tempKey);
        const raw = edgeByTempKey.get(tempKey);
        edges[id] = {
            id,
            vertexIds: raw.vertexTempKeys.map(k => vertexIdByTempKey.get(k)),
            hexIds: [...raw.hexIds],
            ownerId: null,
        };
    });

    Object.values(vertices).forEach(vertex => {
        vertex.edgeIds = vertex.edgeIds.map(tempKey => edgeIdByTempKey.get(tempKey));
    });

    const hexes = hexesRaw.map(hex => ({
        id: hex.id,
        q: hex.q,
        r: hex.r,
        resource: 'desert',
        number: null,
        vertexIds: hex.vertexTempKeys.map(k => vertexIdByTempKey.get(k)),
        edgeIds: hex.edgeTempKeys.map(k => edgeIdByTempKey.get(k)),
    }));

    const resources = shuffle(HEX_RESOURCES);
    const tokens = shuffle(HEX_TOKENS);
    let tokenIndex = 0;
    let robberHexId = null;

    hexes.forEach(hex => {
        hex.resource = resources.pop();
        if (hex.resource === 'desert') {
            robberHexId = hex.id;
            return;
        }
        hex.number = tokens[tokenIndex];
        tokenIndex += 1;
    });

    return { hexes, vertices, edges, robberHexId, harbors: [] };
}

function normalizeAt(value) {
    return value ? value.trim().toUpperCase() : null;
}

function resolveBoardFocusTarget(game, rawAt) {
    const at = normalizeAt(rawAt);
    if (!at) return { at: null, target: null, error: null };

    if (/^V\d+$/.test(at)) {
        if (!getVertex(game, at)) return { at, target: null, error: `Unknown vertex: ${at}.` };
        return { at, target: { type: 'vertex', id: at }, error: null };
    }

    if (/^E\d+$/.test(at)) {
        if (!getEdge(game, at)) return { at, target: null, error: `Unknown edge: ${at}.` };
        return { at, target: { type: 'edge', id: at }, error: null };
    }

    return { at, target: null, error: 'Invalid focus coordinate. Use V# or E#, e.g. V12 or E34.' };
}

function validateTurnPlayer(game, userId) {
    const player = currentPlayer(game);
    if (!player) return 'No active turn player.';
    if (player.id !== userId) return `It is ${player.name}'s turn.`;
    return null;
}

function getTurnOrder(game) {
    if (game.turnOrder?.length) return game.turnOrder;
    if (game.setup?.order?.length) return game.setup.order;
    return game.players.map(p => p.id);
}

// --- Board placement and rules ---
function isSettlementPlacementLegal(game, player, vertexId, isSetup = false) {
    const vertex = getVertex(game, vertexId);
    if (!vertex) return 'Unknown vertex.';
    if (vertex.building) return 'Vertex is already occupied.';

    const neighborOccupied = vertex.neighborVertexIds.some(id => Boolean(getVertex(game, id)?.building));
    if (neighborOccupied) return 'Distance rule violated: adjacent vertex has a building.';

    if (!isSetup) {
        const connected = vertex.edgeIds.some(edgeId => getEdge(game, edgeId)?.ownerId === player.id);
        if (!connected) return 'Settlement must connect to your road network.';
    }

    return null;
}

function canContinueThroughVertex(game, playerId, vertexId) {
    const building = getVertex(game, vertexId)?.building;
    if (!building) return true;
    return building.ownerId === playerId;
}

function isRoadPlacementLegal(game, player, edgeId, setupVertexId = null) {
    const edge = getEdge(game, edgeId);
    if (!edge) return 'Unknown edge.';
    if (edge.ownerId) return 'Edge is already occupied.';

    if (setupVertexId) {
        if (!edge.vertexIds.includes(setupVertexId)) return `Setup road must connect to ${setupVertexId}.`;
        return null;
    }

    for (const endpointId of edge.vertexIds) {
        const endpoint = getVertex(game, endpointId);
        const hasOwnBuilding = endpoint?.building?.ownerId === player.id;
        const blockedByOpponentBuilding = endpoint?.building && endpoint.building.ownerId !== player.id;
        const hasOwnRoad = endpoint?.edgeIds.some(eId => {
            if (eId === edgeId) return false;
            return getEdge(game, eId)?.ownerId === player.id;
        });

        if (hasOwnBuilding) return null;
        if (hasOwnRoad && !blockedByOpponentBuilding) return null;
    }

    return 'Road must connect to your road/building and cannot pass through opponent buildings.';
}

function placeSettlement(game, player, vertexId, free = false, isSetup = false) {
    const illegal = isSettlementPlacementLegal(game, player, vertexId, isSetup);
    if (illegal) return illegal;

    if (!free) {
        if (!canAfford(player.resources, COSTS.settlement)) return 'Not enough resources for settlement.';
        spendResources(player.resources, COSTS.settlement);
    }

    if (player.piecesRemaining.settlement <= 0) return 'No settlements remaining.';

    player.piecesRemaining.settlement -= 1;
    player.settlements.push(vertexId);
    game.board.vertices[vertexId].building = { ownerId: player.id, type: 'settlement' };
    return null;
}

function placeCity(game, player, vertexId, free = false) {
    const vertex = getVertex(game, vertexId);
    if (!vertex) return 'Unknown vertex.';
    if (!vertex.building || vertex.building.ownerId !== player.id || vertex.building.type !== 'settlement') {
        return 'City must upgrade your own settlement.';
    }

    if (!free) {
        if (!canAfford(player.resources, COSTS.city)) return 'Not enough resources for city.';
        spendResources(player.resources, COSTS.city);
    }

    if (player.piecesRemaining.city <= 0) return 'No cities remaining.';

    player.piecesRemaining.city -= 1;
    player.piecesRemaining.settlement += 1;
    player.settlements = player.settlements.filter(vId => vId !== vertexId);
    player.cities.push(vertexId);
    vertex.building = { ownerId: player.id, type: 'city' };
    return null;
}

function placeRoad(game, player, edgeId, free = false, setupVertexId = null) {
    const illegal = isRoadPlacementLegal(game, player, edgeId, setupVertexId);
    if (illegal) return illegal;

    if (!free) {
        if (!canAfford(player.resources, COSTS.road)) return 'Not enough resources for road.';
        spendResources(player.resources, COSTS.road);
    }

    if (player.piecesRemaining.road <= 0) return 'No roads remaining.';

    player.piecesRemaining.road -= 1;
    player.roads.push(edgeId);
    game.board.edges[edgeId].ownerId = player.id;
    updateLongestRoadAward(game);
    return null;
}

// --- Setup and turn progression ---
function setupSnakeOrder(order) {
    return [...order, ...[...order].reverse()];
}

function maybeGiveSetupResources(game, player, settlementVertexId) {
    if ((game.setup.placedSettlements[player.id] ?? 0) !== 2) return;
    const vertex = getVertex(game, settlementVertexId);
    if (!vertex) return;

    const gained = emptyResources();
    vertex.hexIds.forEach(hexId => {
        const hex = game.board.hexes.find(h => h.id === hexId);
        if (!hex || hex.resource === 'desert') return;
        gained[hex.resource] += 1;
    });
    addResources(player.resources, gained);
}

function setupAdvance(game) {
    if (game.setup.actionIndex >= game.setup.snakeOrder.length) {
        game.phase = PHASE.TURN_ROLL;
        game.turn = { currentPlayerId: game.setup.order[0], round: 1, rolled: false, dice: null };
        game.setup = null;
        return 'Setup complete. Normal turn flow begins. First player should roll.';
    }

    game.setup.currentPlayerId = game.setup.snakeOrder[game.setup.actionIndex];
    game.setup.step = 'settlement';
    game.setup.pendingSettlementVertexId = null;
    return `Setup turn: <@${game.setup.currentPlayerId}> place settlement with /catan place type:settlement at:V#.`;
}

function distributeResourcesByRoll(game, total) {
    const gainsByPlayer = new Map();
    game.board.hexes.forEach(hex => {
        if (hex.number !== total || hex.id === game.board.robberHexId) return;

        hex.vertexIds.forEach(vertexId => {
            const vertex = getVertex(game, vertexId);
            if (!vertex?.building) return;
            const ownerId = vertex.building.ownerId;
            const amount = vertex.building.type === 'city' ? 2 : 1;
            if (!gainsByPlayer.has(ownerId)) gainsByPlayer.set(ownerId, emptyResources());
            gainsByPlayer.get(ownerId)[hex.resource] += amount;
        });
    });

    game.players.forEach(player => {
        const gain = gainsByPlayer.get(player.id);
        if (gain) addResources(player.resources, gain);
    });

    return gainsByPlayer;
}

function autoDiscardOnSeven(game) {
    const discarded = new Map();
    game.players.forEach(player => {
        const total = totalResourceCount(player.resources);
        if (total <= 7) return;
        let toDiscard = Math.floor(total / 2);
        const dropped = emptyResources();

        while (toDiscard > 0) {
            const res = drawRandomResource(player.resources);
            if (!res) break;
            player.resources[res] -= 1;
            dropped[res] += 1;
            toDiscard -= 1;
        }
        discarded.set(player.id, dropped);
    });
    return discarded;
}

// --- Awards, scoring, and endgame checks ---
function getAdjacentVictimCandidates(game, hexId, robberPlayerId) {
    const hex = game.board.hexes.find(h => h.id === hexId);
    if (!hex) return [];

    const ids = new Set();
    hex.vertexIds.forEach(vertexId => {
        const ownerId = getVertex(game, vertexId)?.building?.ownerId;
        if (!ownerId || ownerId === robberPlayerId) return;
        const owner = getPlayer(game, ownerId);
        if (!owner || totalResourceCount(owner.resources) === 0) return;
        ids.add(ownerId);
    });

    return [...ids].map(id => getPlayer(game, id)).filter(Boolean);
}

function longestRoadLengthForPlayer(game, playerId) {
    const ownedEdges = Object.values(game.board.edges).filter(edge => edge.ownerId === playerId);
    if (ownedEdges.length === 0) return 0;

    const edgeMap = new Map(ownedEdges.map(edge => [edge.id, edge]));
    const vertexToEdges = new Map();
    ownedEdges.forEach(edge => {
        edge.vertexIds.forEach(vertexId => {
            if (!vertexToEdges.has(vertexId)) vertexToEdges.set(vertexId, []);
            vertexToEdges.get(vertexId).push(edge.id);
        });
    });

    function dfs(fromVertexId, usedEdgeIds) {
        let best = 0;
        const candidates = vertexToEdges.get(fromVertexId) ?? [];
        for (const edgeId of candidates) {
            if (usedEdgeIds.has(edgeId)) continue;
            const edge = edgeMap.get(edgeId);
            if (!edge) continue;
            const [a, b] = edge.vertexIds;
            const nextVertexId = fromVertexId === a ? b : a;

            const nextUsed = new Set(usedEdgeIds);
            nextUsed.add(edgeId);

            let length = 1;
            if (canContinueThroughVertex(game, playerId, nextVertexId)) {
                length += dfs(nextVertexId, nextUsed);
            }
            if (length > best) best = length;
        }
        return best;
    }

    let maxLen = 0;
    ownedEdges.forEach(edge => {
        edge.vertexIds.forEach(startVertexId => {
            const len = dfs(startVertexId, new Set());
            if (len > maxLen) maxLen = len;
        });
    });

    return maxLen;
}

function updateLongestRoadAward(game) {
    let bestPlayerId = null;
    let bestLen = 0;

    game.players.forEach(player => {
        const len = longestRoadLengthForPlayer(game, player.id);
        if (len > bestLen) {
            bestLen = len;
            bestPlayerId = player.id;
        }
    });

    const currentOwner = game.awards.longestRoadOwnerId;
    const currentLen = game.awards.longestRoadLength;

    if (bestLen < 5) {
        game.awards.longestRoadOwnerId = null;
        game.awards.longestRoadLength = bestLen;
        return;
    }

    if (!currentOwner || bestLen > currentLen) {
        game.awards.longestRoadOwnerId = bestPlayerId;
        game.awards.longestRoadLength = bestLen;
    }
}

function updateLargestArmyAward(game) {
    let best = null;
    game.players.forEach(player => {
        if (!best || player.playedKnights > best.playedKnights) best = player;
    });
    if (!best || best.playedKnights < 3) {
        game.awards.largestArmyOwnerId = null;
        return;
    }

    const currentOwner = getPlayer(game, game.awards.largestArmyOwnerId);
    if (!currentOwner || best.playedKnights > currentOwner.playedKnights) {
        game.awards.largestArmyOwnerId = best.id;
    }
}

function moveLockedDevCardsToPlayable(player) {
    DEV_CARD_TYPES.forEach(card => {
        player.devCards[card] += player.lockedDevCards[card];
        player.lockedDevCards[card] = 0;
    });
}

function maybeFinishGame(game) {
    for (const player of game.players) {
        if (getPlayerPoints(game, player) >= 10) {
            game.phase = PHASE.FINISHED;
            game.winnerId = player.id;
            game.finishedAt = new Date().toISOString();
            return player;
        }
    }
    return null;
}

// --- Board rendering and display helpers ---
function getPlayerMarker(game, playerId) {
    const index = game.players.findIndex(player => player.id === playerId);
    return PLAYER_MARKERS[index] ?? PLAYER_MARKERS[PLAYER_MARKERS.length - 1];
}

function idNumber(id) {
    const parsed = Number.parseInt(String(id ?? '').slice(1), 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

function sortIds(ids) {
    return [...ids].sort((a, b) => idNumber(a) - idNumber(b));
}

function compactIdList(ids, prefix) {
    const values = sortIds(ids).map(id => idNumber(id));
    return `${prefix}[${values.join(',')}]`;
}

function formatPointsLine(game, player) {
    const marker = getPlayerMarker(game, player.id);
    const longestRoad = game.awards.longestRoadOwnerId === player.id ? ' LR' : '';
    const largestArmy = game.awards.largestArmyOwnerId === player.id ? ' LA' : '';
    return `${marker} ${player.name}: ${getPlayerPoints(game, player)} VP | settlements:${player.settlements.length} cities:${player.cities.length} roads:${player.roads.length}${longestRoad}${largestArmy}`;
}

function formatHexCell(game, hex) {
    const icon = RESOURCE_ICON[hex.resource] ?? '?';
    const token = hex.number === null ? '--' : String(hex.number).padStart(2, '0');
    const robber = hex.id === game.board.robberHexId ? '*' : ' ';
    return `${robber}${hex.id}${icon}${token}`;
}

function escapeXml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function polarVertex(center, radius, index) {
    const angle = (((60 * index) - 30) * Math.PI) / 180;
    return {
        x: center.x + (radius * Math.cos(angle)),
        y: center.y + (radius * Math.sin(angle)),
    };
}

function getPlayerColor(game, playerId) {
    const index = game.players.findIndex(player => player.id === playerId);
    return PLAYER_COLORS[index] ?? PLAYER_COLORS[PLAYER_COLORS.length - 1];
}

function buildBoardGeometry(game) {
    const radius = 82;
    const sqrt3 = Math.sqrt(3);
    const centers = new Map();
    const vertexAccumulator = new Map();

    game.board.hexes.forEach(hex => {
        const center = {
            x: radius * sqrt3 * (hex.q + (hex.r / 2)),
            y: radius * 1.5 * hex.r,
        };
        centers.set(hex.id, center);

        hex.vertexIds.forEach((vertexId, i) => {
            const point = polarVertex(center, radius, i);
            const acc = vertexAccumulator.get(vertexId) ?? { sumX: 0, sumY: 0, count: 0 };
            acc.sumX += point.x;
            acc.sumY += point.y;
            acc.count += 1;
            vertexAccumulator.set(vertexId, acc);
        });
    });

    const vertices = new Map();
    vertexAccumulator.forEach((acc, vertexId) => {
        vertices.set(vertexId, {
            x: acc.sumX / acc.count,
            y: acc.sumY / acc.count,
        });
    });

    return { radius, centers, vertices };
}

function getBoardBounds(geometry) {
    const xs = [];
    const ys = [];
    geometry.centers.forEach(center => {
        xs.push(center.x - geometry.radius, center.x + geometry.radius);
        ys.push(center.y - geometry.radius, center.y + geometry.radius);
    });
    geometry.vertices.forEach(vertex => {
        xs.push(vertex.x);
        ys.push(vertex.y);
    });

    return {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
    };
}

function placementLegendLines(game) {
    return game.players.map(player => {
        const vp = getPlayerPoints(game, player);
        const longestRoad = game.awards.longestRoadOwnerId === player.id ? ' LR' : '';
        const largestArmy = game.awards.largestArmyOwnerId === player.id ? ' LA' : '';
        return `${player.name}: ${vp} VP (${player.settlements.length}S/${player.cities.length}C/${player.roads.length}R)${longestRoad}${largestArmy}`;
    });
}

function textWidthEstimate(text, fontSize) {
    return String(text ?? '').length * fontSize * 0.62;
}

function pushLabelBadge(lines, {
    x,
    y,
    text,
    anchor = 'middle',
    fontSize = 12,
    paddingX = 5,
    paddingY = 3,
    fill = '#ffffff',
    stroke = '#111827',
    textFill = '#111827',
    strokeWidth = 1.5,
    opacity = 0.96,
}) {
    const width = textWidthEstimate(text, fontSize) + (paddingX * 2);
    const height = fontSize + (paddingY * 2);
    let left = x - (width / 2);
    if (anchor === 'start') left = x;
    if (anchor === 'end') left = x - width;
    const top = y - (height / 2);

    lines.push(
        `<rect x="${left.toFixed(1)}" y="${top.toFixed(1)}" width="${width.toFixed(1)}" height="${height.toFixed(1)}" rx="5" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`
    );
    lines.push(
        `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" style="font:700 ${fontSize}px Arial,sans-serif;fill:${textFill}">${escapeXml(text)}</text>`
    );
}

function renderBoardSvg(game, focusTarget = null) {
    const geometry = buildBoardGeometry(game);
    const bounds = getBoardBounds(geometry);
    const paddingX = 120;
    const paddingY = 100;
    const legendWidth = 520;
    const boardWidth = (bounds.maxX - bounds.minX) + (paddingX * 2);
    const boardHeight = (bounds.maxY - bounds.minY) + (paddingY * 2);
    const width = Math.ceil(boardWidth + legendWidth);
    const height = Math.ceil(Math.max(boardHeight, 900));
    const boardOffsetX = paddingX - bounds.minX;
    const boardOffsetY = ((height - boardHeight) / 2) + paddingY - bounds.minY;
    const legendX = Math.floor(boardWidth + 30);

    const toCanvasX = x => x + boardOffsetX;
    const toCanvasY = y => y + boardOffsetY;
    const lines = [];
    const pointFmt = point => `${toCanvasX(point.x).toFixed(1)},${toCanvasY(point.y).toFixed(1)}`;
    const current = currentPlayer(game);
    const boardCenter = {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
    };
    const robberHex = game.board.hexes.find(hex => hex.id === game.board.robberHexId) ?? null;
    const robberLabel = robberHex ? `${robberHex.id} (${robberHex.resource}${robberHex.number ? ` ${robberHex.number}` : ''})` : '-';
    const focusLabel = focusTarget ? `${focusTarget.type === 'vertex' ? 'Vertex' : 'Edge'} ${focusTarget.id}` : 'none';

    lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
    lines.push('<defs>');
    lines.push('<style>');
    lines.push('.tile-id{font:600 16px Arial,sans-serif;fill:#1f2937}');
    lines.push('.tile-num{font:700 22px Arial,sans-serif;fill:#111827}');
    lines.push('.small{font:600 12px Arial,sans-serif;fill:#111827}');
    lines.push('.legend{font:600 14px Arial,sans-serif;fill:#111827}');
    lines.push('.legend-title{font:700 22px Arial,sans-serif;fill:#111827}');
    lines.push('</style>');
    lines.push('</defs>');
    lines.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#f4efe6"/>`);
    lines.push(`<rect x="${legendX}" y="24" width="${legendWidth - 42}" height="${height - 48}" rx="14" fill="#ffffff" stroke="#d1d5db" stroke-width="2"/>`);

    game.board.hexes
        .slice()
        .sort((a, b) => a.r - b.r || a.q - b.q)
        .forEach(hex => {
            const center = geometry.centers.get(hex.id);
            const polygon = hex.vertexIds
                .map((_, i) => polarVertex(center, geometry.radius - 2, i))
                .map(pointFmt)
                .join(' ');
            const fill = RESOURCE_COLORS[hex.resource] ?? '#d1d5db';
            const robberStroke = hex.id === game.board.robberHexId ? '#9f1239' : '#374151';
            const robberStrokeWidth = hex.id === game.board.robberHexId ? 5 : 2;
            const cx = toCanvasX(center.x);
            const cy = toCanvasY(center.y);

            lines.push(`<polygon points="${polygon}" fill="${fill}" stroke="${robberStroke}" stroke-width="${robberStrokeWidth}"/>`);
            lines.push(`<text x="${cx}" y="${cy - 30}" text-anchor="middle" class="tile-id">${escapeXml(hex.id)}</text>`);
            if (hex.number !== null) {
                lines.push(`<circle cx="${cx}" cy="${cy + 2}" r="24" fill="#fff8db" stroke="#92400e" stroke-width="2"/>`);
                lines.push(`<text x="${cx}" y="${cy + 10}" text-anchor="middle" class="tile-num">${hex.number}</text>`);
            }
            if (hex.id === game.board.robberHexId) {
                lines.push(`<circle cx="${cx}" cy="${cy - 58}" r="10" fill="#7f1d1d" stroke="#111827" stroke-width="2"/>`);
            }
        });

    sortIds(Object.keys(game.board.edges)).forEach(edgeId => {
        const edge = getEdge(game, edgeId);
        if (!edge) return;
        const a = geometry.vertices.get(edge.vertexIds[0]);
        const b = geometry.vertices.get(edge.vertexIds[1]);
        if (!a || !b) return;

        const ax = toCanvasX(a.x);
        const ay = toCanvasY(a.y);
        const bx = toCanvasX(b.x);
        const by = toCanvasY(b.y);
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const dx = bx - ax;
        const dy = by - ay;
        const length = Math.max(Math.hypot(dx, dy), 1);
        const nx = (-dy / length);
        const ny = (dx / length);
        const labelX = mx + (nx * 14);
        const labelY = my + (ny * 14);
        const ownerColor = edge.ownerId ? getPlayerColor(game, edge.ownerId) : '#9ca3af';
        const ownerWidth = edge.ownerId ? 10 : 3;
        const ownerOpacity = edge.ownerId ? '1' : '0.55';
        const focused = focusTarget?.type === 'edge' && focusTarget.id === edgeId;

        if (focused) {
            lines.push(`<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="#ef4444" stroke-width="18" stroke-linecap="round" opacity="0.45"/>`);
        }

        lines.push(`<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${ownerColor}" stroke-width="${ownerWidth}" stroke-linecap="round" opacity="${ownerOpacity}"/>`);
        pushLabelBadge(lines, {
            x: labelX,
            y: labelY,
            text: edgeId,
            fontSize: 12,
            fill: focused ? '#dc2626' : '#ffffff',
            stroke: focused ? '#7f1d1d' : '#111827',
            textFill: focused ? '#ffffff' : '#111827',
            opacity: focused ? 1 : 0.95,
        });
    });

    sortIds(Object.keys(game.board.vertices)).forEach(vertexId => {
        const vertex = getVertex(game, vertexId);
        const point = geometry.vertices.get(vertexId);
        if (!vertex || !point) return;
        const x = toCanvasX(point.x);
        const y = toCanvasY(point.y);
        const dirX = point.x - boardCenter.x;
        const dirY = point.y - boardCenter.y;
        const dirLen = Math.max(Math.hypot(dirX, dirY), 1);
        const labelX = x + ((dirX / dirLen) * 16);
        const labelY = y + ((dirY / dirLen) * 16);
        const focused = focusTarget?.type === 'vertex' && focusTarget.id === vertexId;

        if (focused) {
            lines.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="20" fill="none" stroke="#dc2626" stroke-width="4"/>`);
        }

        if (vertex.building) {
            const color = getPlayerColor(game, vertex.building.ownerId);
            if (vertex.building.type === 'city') {
                lines.push(`<rect x="${(x - 10).toFixed(1)}" y="${(y - 10).toFixed(1)}" width="20" height="20" rx="2" fill="${color}" stroke="#111827" stroke-width="2"/>`);
            } else {
                lines.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="${color}" stroke="#111827" stroke-width="2"/>`);
            }
        } else {
            lines.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="#1f2937"/>`);
        }

        pushLabelBadge(lines, {
            x: labelX,
            y: labelY,
            text: vertexId,
            fontSize: 12,
            fill: focused ? '#dc2626' : '#ffffff',
            stroke: focused ? '#7f1d1d' : '#111827',
            textFill: focused ? '#ffffff' : '#111827',
            opacity: focused ? 1 : 0.95,
        });
    });

    lines.push(`<text x="${legendX + 24}" y="60" class="legend-title">Catan Board</text>`);
    lines.push(`<text x="${legendX + 24}" y="90" class="legend">Phase: ${escapeXml(game.phase)}</text>`);
    lines.push(`<text x="${legendX + 24}" y="115" class="legend">Round: ${escapeXml(game.turn?.round ?? '-')}</text>`);
    lines.push(`<text x="${legendX + 24}" y="140" class="legend">Current: ${escapeXml(current?.name ?? '-')}</text>`);
    lines.push(`<text x="${legendX + 24}" y="165" class="legend">Robber: ${escapeXml(robberLabel)}</text>`);
    lines.push(`<text x="${legendX + 24}" y="190" class="legend">Focus: ${escapeXml(focusLabel)}</text>`);
    lines.push(`<text x="${legendX + 24}" y="215" class="legend">Placement: settlement/city => V#, road => E#</text>`);

    let legendY = 250;
    placementLegendLines(game).forEach((line, i) => {
        const player = game.players[i];
        const color = getPlayerColor(game, player.id);
        lines.push(`<rect x="${legendX + 24}" y="${legendY - 12}" width="14" height="14" fill="${color}" stroke="#111827" stroke-width="1"/>`);
        lines.push(`<text x="${legendX + 45}" y="${legendY}" class="legend">${escapeXml(line)}</text>`);
        legendY += 28;
    });

    legendY += 6;
    lines.push(`<text x="${legendX + 24}" y="${legendY}" class="small">Resource Colors</text>`);
    legendY += 22;
    Object.keys(RESOURCE_COLORS).forEach(resource => {
        lines.push(`<rect x="${legendX + 24}" y="${legendY - 12}" width="14" height="14" fill="${RESOURCE_COLORS[resource]}" stroke="#111827" stroke-width="1"/>`);
        lines.push(`<text x="${legendX + 45}" y="${legendY}" class="legend">${escapeXml(resource)}</text>`);
        legendY += 22;
    });

    lines.push('</svg>');
    return lines.join('');
}

const PIXEL_FONT_5X7 = {
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
    '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
    D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
    H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
    J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
    K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
    W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
    X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    '#': ['01010', '11111', '01010', '01010', '11111', '01010', '00000'],
    ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
    '.': ['00000', '00000', '00000', '00000', '00000', '00100', '00100'],
    '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function hexToRgba(hex, alpha = 255) {
    const clean = String(hex).replace('#', '');
    if (clean.length === 3) {
        const r = Number.parseInt(clean[0] + clean[0], 16);
        const g = Number.parseInt(clean[1] + clean[1], 16);
        const b = Number.parseInt(clean[2] + clean[2], 16);
        return [r, g, b, alpha];
    }
    const r = Number.parseInt(clean.slice(0, 2), 16);
    const g = Number.parseInt(clean.slice(2, 4), 16);
    const b = Number.parseInt(clean.slice(4, 6), 16);
    return [r, g, b, alpha];
}

function createRasterCanvas(width, height, backgroundHex) {
    const pixels = new Uint8Array(width * height * 4);
    const [r, g, b, a] = hexToRgba(backgroundHex);
    for (let i = 0; i < width * height; i += 1) {
        const offset = i * 4;
        pixels[offset] = r;
        pixels[offset + 1] = g;
        pixels[offset + 2] = b;
        pixels[offset + 3] = a;
    }
    return { width, height, pixels };
}

function setPixel(canvas, x, y, color) {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= canvas.width || iy >= canvas.height) return;

    const offset = ((iy * canvas.width) + ix) * 4;
    const alpha = (color[3] ?? 255) / 255;
    const inv = 1 - alpha;
    canvas.pixels[offset] = Math.round((color[0] * alpha) + (canvas.pixels[offset] * inv));
    canvas.pixels[offset + 1] = Math.round((color[1] * alpha) + (canvas.pixels[offset + 1] * inv));
    canvas.pixels[offset + 2] = Math.round((color[2] * alpha) + (canvas.pixels[offset + 2] * inv));
    canvas.pixels[offset + 3] = 255;
}

function drawFilledRect(canvas, x, y, width, height, color) {
    const startX = Math.max(0, Math.floor(x));
    const endX = Math.min(canvas.width - 1, Math.ceil(x + width));
    const startY = Math.max(0, Math.floor(y));
    const endY = Math.min(canvas.height - 1, Math.ceil(y + height));
    for (let py = startY; py <= endY; py += 1) {
        for (let px = startX; px <= endX; px += 1) {
            setPixel(canvas, px, py, color);
        }
    }
}

function drawRectStroke(canvas, x, y, width, height, strokeWidth, color) {
    drawFilledRect(canvas, x, y, width, strokeWidth, color);
    drawFilledRect(canvas, x, y + height - strokeWidth, width, strokeWidth, color);
    drawFilledRect(canvas, x, y, strokeWidth, height, color);
    drawFilledRect(canvas, x + width - strokeWidth, y, strokeWidth, height, color);
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
    const t = Math.max(0, Math.min(1, (((px - x1) * dx) + ((py - y1) * dy)) / ((dx * dx) + (dy * dy))));
    const cx = x1 + (t * dx);
    const cy = y1 + (t * dy);
    return Math.hypot(px - cx, py - cy);
}

function drawLineWidth(canvas, x1, y1, x2, y2, width, color) {
    const half = width / 2;
    const minX = Math.floor(Math.min(x1, x2) - half - 1);
    const maxX = Math.ceil(Math.max(x1, x2) + half + 1);
    const minY = Math.floor(Math.min(y1, y2) - half - 1);
    const maxY = Math.ceil(Math.max(y1, y2) + half + 1);
    for (let py = minY; py <= maxY; py += 1) {
        for (let px = minX; px <= maxX; px += 1) {
            if (distanceToSegment(px + 0.5, py + 0.5, x1, y1, x2, y2) <= half) {
                setPixel(canvas, px, py, color);
            }
        }
    }
}

function drawFilledCircle(canvas, cx, cy, radius, color) {
    const minX = Math.floor(cx - radius);
    const maxX = Math.ceil(cx + radius);
    const minY = Math.floor(cy - radius);
    const maxY = Math.ceil(cy + radius);
    const r2 = radius * radius;
    for (let py = minY; py <= maxY; py += 1) {
        for (let px = minX; px <= maxX; px += 1) {
            const dx = px - cx;
            const dy = py - cy;
            if ((dx * dx) + (dy * dy) <= r2) {
                setPixel(canvas, px, py, color);
            }
        }
    }
}

function drawCircleStroke(canvas, cx, cy, radius, strokeWidth, color) {
    const outer = radius;
    const inner = Math.max(0, radius - strokeWidth);
    const minX = Math.floor(cx - outer);
    const maxX = Math.ceil(cx + outer);
    const minY = Math.floor(cy - outer);
    const maxY = Math.ceil(cy + outer);
    const o2 = outer * outer;
    const i2 = inner * inner;
    for (let py = minY; py <= maxY; py += 1) {
        for (let px = minX; px <= maxX; px += 1) {
            const dx = px - cx;
            const dy = py - cy;
            const d2 = (dx * dx) + (dy * dy);
            if (d2 <= o2 && d2 >= i2) {
                setPixel(canvas, px, py, color);
            }
        }
    }
}

function edgeSign(ax, ay, bx, by, cx, cy) {
    return ((cx - ax) * (by - ay)) - ((cy - ay) * (bx - ax));
}

function fillTriangle(canvas, a, b, c, color) {
    const minX = Math.floor(Math.min(a.x, b.x, c.x));
    const maxX = Math.ceil(Math.max(a.x, b.x, c.x));
    const minY = Math.floor(Math.min(a.y, b.y, c.y));
    const maxY = Math.ceil(Math.max(a.y, b.y, c.y));
    const area = edgeSign(a.x, a.y, b.x, b.y, c.x, c.y);
    if (area === 0) return;
    const positive = area > 0;
    for (let py = minY; py <= maxY; py += 1) {
        for (let px = minX; px <= maxX; px += 1) {
            const x = px + 0.5;
            const y = py + 0.5;
            const w0 = edgeSign(b.x, b.y, c.x, c.y, x, y);
            const w1 = edgeSign(c.x, c.y, a.x, a.y, x, y);
            const w2 = edgeSign(a.x, a.y, b.x, b.y, x, y);
            if ((positive && w0 >= 0 && w1 >= 0 && w2 >= 0) || (!positive && w0 <= 0 && w1 <= 0 && w2 <= 0)) {
                setPixel(canvas, px, py, color);
            }
        }
    }
}

function drawFilledConvexPolygon(canvas, points, color) {
    if (points.length < 3) return;
    const center = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    center.x /= points.length;
    center.y /= points.length;
    for (let i = 0; i < points.length; i += 1) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        fillTriangle(canvas, center, a, b, color);
    }
}

function drawPolygonStroke(canvas, points, strokeWidth, color) {
    for (let i = 0; i < points.length; i += 1) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        drawLineWidth(canvas, a.x, a.y, b.x, b.y, strokeWidth, color);
    }
}

function measureBitmapText(text, scale) {
    const chars = String(text ?? '').toUpperCase().split('');
    if (chars.length === 0) return { width: 0, height: 7 * scale };
    const charWidth = 5 * scale;
    const spacing = scale;
    return {
        width: (chars.length * charWidth) + ((chars.length - 1) * spacing),
        height: 7 * scale,
    };
}

function drawBitmapText(canvas, text, x, y, scale, color, align = 'left') {
    const upper = String(text ?? '').toUpperCase();
    const size = measureBitmapText(upper, scale);
    let cursorX = x;
    if (align === 'center') cursorX -= size.width / 2;
    if (align === 'right') cursorX -= size.width;

    const spacing = scale;
    for (const char of upper) {
        const glyph = PIXEL_FONT_5X7[char] ?? PIXEL_FONT_5X7[' '];
        for (let row = 0; row < glyph.length; row += 1) {
            for (let col = 0; col < glyph[row].length; col += 1) {
                if (glyph[row][col] === '1') {
                    drawFilledRect(canvas, cursorX + (col * scale), y + (row * scale), scale, scale, color);
                }
            }
        }
        cursorX += (5 * scale) + spacing;
    }
}

function normalizeBitmapText(text) {
    return String(text ?? '')
        .toUpperCase()
        .replace(/[^A-Z0-9 #:\-._]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function drawLabelBadgeRaster(canvas, {
    x,
    y,
    text,
    anchor = 'center',
    scale = 2,
    paddingX = 4,
    paddingY = 3,
    fillColor = [255, 255, 255, 245],
    strokeColor = [17, 24, 39, 255],
    textColor = [17, 24, 39, 255],
}) {
    const label = String(text ?? '').toUpperCase();
    const textSize = measureBitmapText(label, scale);
    const width = textSize.width + (paddingX * 2);
    const height = textSize.height + (paddingY * 2);
    let left = x - (width / 2);
    if (anchor === 'start') left = x;
    if (anchor === 'end') left = x - width;
    const top = y - (height / 2);

    drawFilledRect(canvas, left, top, width, height, fillColor);
    drawRectStroke(canvas, left, top, width, height, 1, strokeColor);
    drawBitmapText(canvas, label, left + paddingX, top + paddingY, scale, textColor, 'left');
}

function createCrc32Table() {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
    }
    return table;
}

const CRC32_TABLE = createCrc32Table();

function crc32(buffer) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buffer.length; i += 1) {
        crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makePngChunk(type, data) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crcValue = crc32(Buffer.concat([typeBuffer, data]));
    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE(crcValue, 0);
    return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function encodePng(canvas) {
    const { width, height, pixels } = canvas;
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y += 1) {
        const rowStart = y * (width * 4 + 1);
        raw[rowStart] = 0;
        for (let x = 0; x < width; x += 1) {
            const src = ((y * width) + x) * 4;
            const dst = rowStart + 1 + (x * 4);
            raw[dst] = pixels[src];
            raw[dst + 1] = pixels[src + 1];
            raw[dst + 2] = pixels[src + 2];
            raw[dst + 3] = pixels[src + 3];
        }
    }

    const compressed = zlib.deflateSync(raw, { level: 9 });
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    return Buffer.concat([
        signature,
        makePngChunk('IHDR', ihdr),
        makePngChunk('IDAT', compressed),
        makePngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function renderBoardPng(game, focusTarget = null) {
    const geometry = buildBoardGeometry(game);
    const bounds = getBoardBounds(geometry);
    const padding = 170;
    const scale = 2.15;
    const legendWidth = 500;
    const boardPixelWidth = Math.ceil((bounds.maxX - bounds.minX + (padding * 2)) * scale);
    const boardPixelHeight = Math.ceil((bounds.maxY - bounds.minY + (padding * 2)) * scale);
    const width = Math.max(1900, boardPixelWidth + legendWidth);
    const height = Math.max(1200, boardPixelHeight);
    const canvas = createRasterCanvas(width, height, '#f4efe6');
    const panelX = width - legendWidth + 22;
    const panelY = 24;
    const panelWidth = legendWidth - 44;
    const panelHeight = height - 48;
    const boardCenter = {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
    };
    const darkText = hexToRgba('#111827');
    const panelBorder = hexToRgba('#cbd5e1');
    const panelFill = [255, 255, 255, 245];

    const toCanvas = point => ({
        x: (point.x - bounds.minX + padding) * scale,
        y: (point.y - bounds.minY + padding) * scale,
    });

    const toCanvasX = x => (x - bounds.minX + padding) * scale;
    const toCanvasY = y => (y - bounds.minY + padding) * scale;
    drawFilledRect(canvas, panelX, panelY, panelWidth, panelHeight, panelFill);
    drawRectStroke(canvas, panelX, panelY, panelWidth, panelHeight, 2, panelBorder);

    game.board.hexes
        .slice()
        .sort((a, b) => a.r - b.r || a.q - b.q)
        .forEach(hex => {
            const center = geometry.centers.get(hex.id);
            const points = hex.vertexIds
                .map((_, i) => polarVertex(center, geometry.radius - 2, i))
                .map(toCanvas);
            const fill = hexToRgba(RESOURCE_COLORS[hex.resource] ?? '#d1d5db');
            const stroke = hex.id === game.board.robberHexId ? hexToRgba('#9f1239') : hexToRgba('#374151');
            const strokeWidth = hex.id === game.board.robberHexId ? 4 : 2;
            const cx = toCanvasX(center.x);
            const cy = toCanvasY(center.y);

            drawFilledConvexPolygon(canvas, points, fill);
            drawPolygonStroke(canvas, points, strokeWidth, stroke);

            drawBitmapText(canvas, hex.id, cx, cy - (38 * scale), 3, hexToRgba('#1f2937'), 'center');

            if (hex.number !== null) {
                drawFilledCircle(canvas, cx, cy + (2 * scale), 26 * scale, hexToRgba('#fff8db'));
                drawCircleStroke(canvas, cx, cy + (2 * scale), 26 * scale, 2, hexToRgba('#92400e'));
                drawBitmapText(
                    canvas,
                    String(hex.number),
                    cx,
                    cy - (7 * scale),
                    4,
                    hexToRgba('#111827'),
                    'center'
                );
            }

            if (hex.id === game.board.robberHexId) {
                drawFilledCircle(canvas, cx, cy - (58 * scale), 10 * scale, hexToRgba('#7f1d1d'));
                drawCircleStroke(canvas, cx, cy - (58 * scale), 10 * scale, 2, hexToRgba('#111827'));
            }
        });

    sortIds(Object.keys(game.board.edges)).forEach(edgeId => {
        const edge = getEdge(game, edgeId);
        if (!edge) return;
        const a = geometry.vertices.get(edge.vertexIds[0]);
        const b = geometry.vertices.get(edge.vertexIds[1]);
        if (!a || !b) return;

        const ax = toCanvasX(a.x);
        const ay = toCanvasY(a.y);
        const bx = toCanvasX(b.x);
        const by = toCanvasY(b.y);
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const dx = bx - ax;
        const dy = by - ay;
        const length = Math.max(Math.hypot(dx, dy), 1);
        const nx = (-dy / length);
        const ny = (dx / length);
        const labelX = mx + (nx * 28);
        const labelY = my + (ny * 28);
        const ownerColor = edge.ownerId ? hexToRgba(getPlayerColor(game, edge.ownerId)) : [156, 163, 175, 180];
        const focused = focusTarget?.type === 'edge' && focusTarget.id === edgeId;

        if (focused) {
            drawLineWidth(canvas, ax, ay, bx, by, 24, [239, 68, 68, 120]);
        }

        drawLineWidth(canvas, ax, ay, bx, by, edge.ownerId ? 12 : 4, ownerColor);
        drawLabelBadgeRaster(canvas, {
            x: labelX,
            y: labelY,
            text: edgeId,
            scale: 3,
            fillColor: focused ? [220, 38, 38, 255] : [255, 255, 255, 245],
            strokeColor: focused ? [127, 29, 29, 255] : [17, 24, 39, 255],
            textColor: focused ? [255, 255, 255, 255] : [17, 24, 39, 255],
        });
    });

    sortIds(Object.keys(game.board.vertices)).forEach(vertexId => {
        const vertex = getVertex(game, vertexId);
        const point = geometry.vertices.get(vertexId);
        if (!vertex || !point) return;

        const x = toCanvasX(point.x);
        const y = toCanvasY(point.y);
        const dirX = point.x - boardCenter.x;
        const dirY = point.y - boardCenter.y;
        const dirLen = Math.max(Math.hypot(dirX, dirY), 1);
        const labelX = x + ((dirX / dirLen) * 34);
        const labelY = y + ((dirY / dirLen) * 34);
        const focused = focusTarget?.type === 'vertex' && focusTarget.id === vertexId;

        if (focused) {
            drawCircleStroke(canvas, x, y, 28, 5, hexToRgba('#dc2626'));
        }

        if (vertex.building) {
            const color = hexToRgba(getPlayerColor(game, vertex.building.ownerId));
            if (vertex.building.type === 'city') {
                drawFilledRect(canvas, x - 12, y - 12, 24, 24, color);
                drawRectStroke(canvas, x - 12, y - 12, 24, 24, 2, hexToRgba('#111827'));
            } else {
                drawFilledCircle(canvas, x, y, 11, color);
                drawCircleStroke(canvas, x, y, 11, 2, hexToRgba('#111827'));
            }
        } else {
            drawFilledCircle(canvas, x, y, 4.5, hexToRgba('#1f2937'));
        }

        drawLabelBadgeRaster(canvas, {
            x: labelX,
            y: labelY,
            text: vertexId,
            scale: 3,
            fillColor: focused ? [220, 38, 38, 255] : [255, 255, 255, 245],
            strokeColor: focused ? [127, 29, 29, 255] : [17, 24, 39, 255],
            textColor: focused ? [255, 255, 255, 255] : [17, 24, 39, 255],
        });
    });

    const phaseText = normalizeBitmapText(game.phase.replaceAll('_', ' '));
    const focusText = normalizeBitmapText(focusTarget ? focusTarget.id : 'NONE');
    const robberText = normalizeBitmapText(game.board.robberHexId ?? '-');
    const resourceLegend = [
        ['WOOD', RESOURCE_COLORS.wood],
        ['BRICK', RESOURCE_COLORS.brick],
        ['WHEAT', RESOURCE_COLORS.wheat],
        ['SHEEP', RESOURCE_COLORS.sheep],
        ['ORE', RESOURCE_COLORS.ore],
        ['DESERT', RESOURCE_COLORS.desert],
    ];

    let legendY = panelY + 24;
    drawBitmapText(canvas, 'CATAN LEGEND', panelX + 18, legendY, 4, darkText);
    legendY += 42;
    drawBitmapText(canvas, `PHASE ${phaseText}`, panelX + 18, legendY, 2, darkText);
    legendY += 24;
    drawBitmapText(canvas, `FOCUS ${focusText}`, panelX + 18, legendY, 2, darkText);
    legendY += 24;
    drawBitmapText(canvas, `ROBBER ${robberText}`, panelX + 18, legendY, 2, darkText);
    legendY += 34;
    drawBitmapText(canvas, 'REGION COLORS', panelX + 18, legendY, 3, darkText);
    legendY += 34;

    resourceLegend.forEach(([name, colorHex]) => {
        drawFilledRect(canvas, panelX + 20, legendY + 2, 24, 24, hexToRgba(colorHex));
        drawRectStroke(canvas, panelX + 20, legendY + 2, 24, 24, 2, darkText);
        drawBitmapText(canvas, name, panelX + 56, legendY + 6, 2, darkText);
        legendY += 34;
    });

    drawFilledRect(canvas, panelX + 20, legendY + 2, 24, 24, hexToRgba('#7f1d1d'));
    drawRectStroke(canvas, panelX + 20, legendY + 2, 24, 24, 2, darkText);
    drawBitmapText(canvas, 'ROBBER TILE', panelX + 56, legendY + 6, 2, darkText);
    legendY += 44;
    drawBitmapText(canvas, 'PLAYERS', panelX + 18, legendY, 3, darkText);
    legendY += 34;

    game.players.forEach((player, index) => {
        drawFilledRect(canvas, panelX + 20, legendY + 2, 24, 24, hexToRgba(getPlayerColor(game, player.id)));
        drawRectStroke(canvas, panelX + 20, legendY + 2, 24, 24, 2, darkText);
        const playerLabel = normalizeBitmapText(`P${index + 1} ${player.name}`).slice(0, 22);
        drawBitmapText(canvas, playerLabel, panelX + 56, legendY + 6, 2, darkText);
        legendY += 34;
    });

    return encodePng(canvas);
}

function renderHexRows(game) {
    const rows = [-2, -1, 0, 1, 2];
    const indent = { '-2': '      ', '-1': '   ', '0': '', '1': '   ', '2': '      ' };

    return rows.map(r => {
        const rowHexes = game.board.hexes
            .filter(hex => hex.r === r)
            .sort((a, b) => a.q - b.q);
        const rowText = rowHexes.map(hex => `[${formatHexCell(game, hex)}]`).join(' ');
        return `${indent[String(r)]}${rowText}`;
    }).join('\n');
}

function renderPlayerPlacements(game) {
    return game.players.map(player => {
        const marker = getPlayerMarker(game, player.id);
        const settlementList = sortIds(player.settlements).map(v => `${BUILDING_ICON.settlement}${v}`).join(' ') || '-';
        const cityList = sortIds(player.cities).map(v => `${BUILDING_ICON.city}${v}`).join(' ') || '-';
        const roadList = sortIds(player.roads).join(' ') || '-';
        return `${marker} ${player.name} | settlements: ${settlementList} | cities: ${cityList} | roads: ${roadList}`;
    }).join('\n');
}

function renderHexPlacementGuide(game) {
    const rows = [-2, -1, 0, 1, 2];
    const lines = ['PLACEMENT GUIDE (settlement/city => V#, road => E#)', ''];

    rows.forEach(r => {
        lines.push(`row ${r}:`);
        const rowHexes = game.board.hexes
            .filter(hex => hex.r === r)
            .sort((a, b) => a.q - b.q);

        rowHexes.forEach(hex => {
            const occupiedVertices = sortIds(hex.vertexIds)
                .map(vertexId => {
                    const building = getVertex(game, vertexId)?.building;
                    if (!building) return null;
                    const ownerMarker = getPlayerMarker(game, building.ownerId);
                    const kind = building.type === 'city' ? 'C' : 'S';
                    return `${vertexId}${ownerMarker}${kind}`;
                })
                .filter(Boolean)
                .join(' ');

            const occupiedEdges = sortIds(hex.edgeIds)
                .map(edgeId => {
                    const ownerId = getEdge(game, edgeId)?.ownerId;
                    if (!ownerId) return null;
                    return `${edgeId}${getPlayerMarker(game, ownerId)}R`;
                })
                .filter(Boolean)
                .join(' ');

            const line = [
                `${formatHexCell(game, hex)}`,
                compactIdList(hex.vertexIds, 'V'),
                compactIdList(hex.edgeIds, 'E'),
            ];

            if (occupiedVertices || occupiedEdges) {
                line.push(`occ:${occupiedVertices || '-'} ${occupiedEdges || '-'}`);
            }

            lines.push(`- ${line.join(' | ')}`);
        });

        lines.push('');
    });

    return lines.join('\n').trimEnd();
}

function boardLegend(game) {
    const markerLegend = game.players
        .map(player => `${getPlayerMarker(game, player.id)} ${player.name}`)
        .join(' | ');
    return [
        'CATAN BOARD',
        `Phase: ${game.phase}`,
        '',
        renderHexRows(game),
        '',
        'Legend: wood | brick | wheat | sheep | ore | desert | * robber',
        'Tip: /catan place type:settlement at:V12  or  /catan place type:road at:E34',
        `Players: ${markerLegend}`,
        '',
        'Placements:',
        renderPlayerPlacements(game),
        '',
        renderHexPlacementGuide(game),
    ].join('\n');
}

// --- Trade component builders ---
function createLobbyJoinButtons(guildId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`catan_lobby_join:${guildId}`).setLabel('Join Lobby').setStyle(ButtonStyle.Success)
    );
}

function createTradeButtons(guildId, offerId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`catan_trade_accept:${guildId}:${offerId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`catan_trade_reject:${guildId}:${offerId}`).setLabel('Reject/Cancel').setStyle(ButtonStyle.Danger)
    );
}
// --- Slash command handlers: lobby/setup ---
function joinLobbyForPlayer(state, guildId, userId, displayName) {
    const game = getGame(state, guildId);
    if (!game || game.phase !== PHASE.LOBBY) {
        return { error: 'No open lobby. Create one with /catan create.' };
    }
    if (game.players.some(p => p.id === userId)) {
        return { error: 'You are already in the lobby.' };
    }
    if (game.players.length >= 4) {
        return { error: 'Lobby is full (2-4 players only).' };
    }

    game.players.push(createPlayer(userId, displayName));
    saveState(state);
    return { message: `${displayName} joined the lobby. (${game.players.length}/4)` };
}

async function handleCreate(interaction, state, guildId, userId, displayName) {
    const existing = getGame(state, guildId);
    if (existing && existing.phase !== PHASE.FINISHED) {
        await interaction.reply('A game already exists. Use /catan join, /catan start, or /catan status.');
        return;
    }
    setGame(state, guildId, createLobbyGame([createPlayer(userId, displayName)]));
    saveState(state);
    await interaction.reply({
        content: 'Catan v2 lobby created. Others can join with /catan join or press Join Lobby below (2-4 players).',
        components: [createLobbyJoinButtons(guildId)],
    });
}

async function handleJoin(interaction, state, guildId, userId, displayName) {
    const result = joinLobbyForPlayer(state, guildId, userId, displayName);
    if (result.error) {
        await interaction.reply(result.error);
        return;
    }
    await interaction.reply(result.message);
}

async function handleLeave(interaction, state, guildId, userId, displayName) {
    const game = getGame(state, guildId);
    if (!game || game.phase !== PHASE.LOBBY) {
        await interaction.reply('You can only leave during lobby phase.');
        return;
    }

    const before = game.players.length;
    game.players = game.players.filter(p => p.id !== userId);
    if (game.players.length === before) {
        await interaction.reply('You are not in this lobby.');
        return;
    }

    if (game.players.length === 0) {
        removeGame(state, guildId);
        saveState(state);
        await interaction.reply('Lobby closed.');
        return;
    }

    saveState(state);
    await interaction.reply(`${displayName} left the lobby. (${game.players.length}/4)`);
}

function initializeStart(game) {
    game.phase = PHASE.SETUP_ORDER_ROLL;
    game.board = buildBoardTopology();
    game.setup = {
        rolls: {},
        order: [],
        snakeOrder: [],
        actionIndex: 0,
        currentPlayerId: null,
        step: null,
        pendingSettlementVertexId: null,
        placedSettlements: {},
    };
    game.players.forEach(player => {
        game.setup.rolls[player.id] = null;
        game.setup.placedSettlements[player.id] = 0;
    });
    game.turn = null;
    game.turnOrder = [];
    game.devDeck = shuffle(DEV_DECK_TEMPLATE);
    game.startedAt = new Date().toISOString();
}

function finalizeSetupOrder(game) {
    const ranked = [...game.players].sort((a, b) => game.setup.rolls[b.id] - game.setup.rolls[a.id]);
    for (let i = 0; i < ranked.length - 1; i += 1) {
        if (game.setup.rolls[ranked[i].id] === game.setup.rolls[ranked[i + 1].id]) return false;
    }
    game.setup.order = ranked.map(player => player.id);
    game.turnOrder = [...game.setup.order];
    game.setup.snakeOrder = setupSnakeOrder(game.setup.order);
    game.phase = PHASE.SETUP_PLACEMENT;
    return true;
}

function processSetupOrderRoll(game, userId) {
    const player = getPlayer(game, userId);
    if (!player) {
        return { error: 'You are not in this game.' };
    }

    if (game.setup.rolls[userId] !== null) {
        return { error: 'You already rolled for setup order.' };
    }

    const total = rollDie() + rollDie();
    game.setup.rolls[userId] = total;

    const pending = game.players.filter(p => game.setup.rolls[p.id] === null);
    if (pending.length > 0) {
        return { message: `${player.name} rolled ${total}. Waiting for ${pending.map(p => p.name).join(', ')}.` };
    }

    if (!finalizeSetupOrder(game)) {
        const values = Object.values(game.setup.rolls);
        const tiedValue = values.find((v, i) => values.indexOf(v) !== i);
        game.players.forEach(p => {
            if (game.setup.rolls[p.id] === tiedValue) game.setup.rolls[p.id] = null;
        });
        return { message: `${player.name} rolled ${total}. Tie detected at ${tiedValue}. Tied players reroll with /catan roll or the roll button.` };
    }

    const orderText = game.setup.order.map(id => getPlayer(game, id)?.name ?? id).join(' -> ');
    const next = setupAdvance(game);
    return { message: `${player.name} rolled ${total}.\nTurn order: ${orderText}\n${next}` };
}

function createSetupRollButtons(guildId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`catan_setup_roll:${guildId}`).setLabel('Roll Setup Order').setStyle(ButtonStyle.Primary)
    );
}

function createTurnRollButtons(guildId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`catan_turn_roll:${guildId}`).setLabel('Roll Turn Dice').setStyle(ButtonStyle.Primary)
    );
}

async function handleStart(interaction, state, guildId) {
    const game = getGame(state, guildId);
    if (!game || game.phase !== PHASE.LOBBY) {
        await interaction.reply('No lobby to start. Create one with /catan create.');
        return;
    }
    if (game.players.length < 2) {
        await interaction.reply('Need at least 2 players to start.');
        return;
    }

    initializeStart(game);
    saveState(state);
    await interaction.reply({
        content: 'Game started. Each player rolls once to determine first turn order. Use /catan roll or press the button below.',
        components: [createSetupRollButtons(guildId)],
    });
}

// --- Slash command handlers: turn actions ---
async function handleRoll(interaction, state, guildId, userId) {
    const game = getGame(state, guildId);
    if (!game) {
        await interaction.reply('No game found. Use /catan create.');
        return;
    }

    if (game.phase === PHASE.SETUP_ORDER_ROLL) {
        const result = processSetupOrderRoll(game, userId);
        if (result.error) {
            await interaction.reply(result.error);
            return;
        }
        saveState(state);
        if (game.phase === PHASE.TURN_ROLL) {
            await interaction.reply({
                content: `${result.message}\n${getPlayer(game, game.turn.currentPlayerId)?.name} can roll with the button below or /catan roll.`,
                components: [createTurnRollButtons(guildId)],
            });
            return;
        }
        await interaction.reply(result.message);
        return;
    }

    if (game.phase !== PHASE.TURN_ROLL) {
        await interaction.reply('Roll is not available in this phase.');
        return;
    }

    const result = processTurnRoll(game, userId);
    if (result.error) {
        await interaction.reply(result.error);
        return;
    }
    saveState(state);
    await interaction.reply(result.message);
}

function processTurnRoll(game, userId) {
    const turnError = validateTurnPlayer(game, userId);
    if (turnError) {
        return { error: turnError };
    }

    const d1 = rollDie();
    const d2 = rollDie();
    const total = d1 + d2;
    game.turn.rolled = true;
    game.turn.dice = { d1, d2, total };

    if (total === 7) {
        const discarded = autoDiscardOnSeven(game);
        game.phase = PHASE.ROBBER_MOVE;
        game.robberContext = { byPlayerId: userId, reason: 'roll_7' };

        const discardLines = [...discarded.entries()]
            .map(([pid, map]) => `${getPlayer(game, pid)?.name}: ${resourceMapToString(map)}`)
            .join('\n') || 'No discards required.';
        return { message: `Rolled 7. Discards applied:\n${discardLines}\nMove robber with /catan robber tile:<1-19> [target].` };
    }

    const gains = distributeResourcesByRoll(game, total);
    game.phase = PHASE.TURN_ACTION;

    const lines = game.players
        .map(player => `${player.name}: ${resourceMapToString(gains.get(player.id) ?? emptyResources())}`)
        .join('\n');
    return { message: `Rolled ${d1}+${d2}=${total}. Production:\n${lines}` };
}

async function doPlace(interaction, state, guildId, userId, type, at) {
    const game = getGame(state, guildId);
    if (!game) {
        await interaction.reply('No game found.');
        return;
    }
    const player = getPlayer(game, userId);
    if (!player) {
        await interaction.reply('You are not in this game.');
        return;
    }

    if (game.phase === PHASE.SETUP_PLACEMENT) {
        if (game.setup.currentPlayerId !== userId) {
            await interaction.reply(`Setup turn belongs to <@${game.setup.currentPlayerId}>.`);
            return;
        }

        if (game.setup.step === 'settlement') {
            if (type !== 'settlement') {
                await interaction.reply('Setup currently requires settlement placement.');
                return;
            }
            const err = placeSettlement(game, player, at, true, true);
            if (err) {
                await interaction.reply(err);
                return;
            }
            game.setup.pendingSettlementVertexId = at;
            game.setup.placedSettlements[player.id] += 1;
            maybeGiveSetupResources(game, player, at);
            game.setup.step = 'road';
            saveState(state);
            await interaction.reply(`Settlement placed at ${at}. Now place road with /catan place type:road at:E#.`);
            return;
        }

        if (game.setup.step === 'road') {
            if (type !== 'road') {
                await interaction.reply('Setup currently requires road placement.');
                return;
            }
            const err = placeRoad(game, player, at, true, game.setup.pendingSettlementVertexId);
            if (err) {
                await interaction.reply(err);
                return;
            }
            game.setup.actionIndex += 1;
            const next = setupAdvance(game);
            saveState(state);
            if (game.phase === PHASE.TURN_ROLL) {
                const firstPlayer = getPlayer(game, game.turn?.currentPlayerId)?.name ?? 'First player';
                await interaction.reply({
                    content: `Road placed at ${at}. ${next}\n${firstPlayer} can roll with the button below or /catan roll.`,
                    components: [createTurnRollButtons(guildId)],
                });
                return;
            }
            await interaction.reply(`Road placed at ${at}. ${next}`);
            return;
        }

        await interaction.reply('Invalid setup state.');
        return;
    }

    if (game.phase !== PHASE.TURN_ACTION) {
        await interaction.reply('Placement is only available during setup or turn action phase.');
        return;
    }

    const turnError = validateTurnPlayer(game, userId);
    if (turnError) {
        await interaction.reply(turnError);
        return;
    }

    let err;
    if (type === 'road') err = placeRoad(game, player, at, false);
    else if (type === 'settlement') err = placeSettlement(game, player, at, false, false);
    else if (type === 'city') err = placeCity(game, player, at, false);
    else err = 'Unknown place type.';

    if (err) {
        await interaction.reply(err);
        return;
    }

    const winner = maybeFinishGame(game);
    saveState(state);
    if (winner) {
        await interaction.reply(`${winner.name} wins with ${getPlayerPoints(game, winner)} VP.`);
        return;
    }

    await interaction.reply(`${player.name} placed ${type} at ${at}.`);
}

async function handlePlace(interaction, state, guildId, userId) {
    const type = interaction.options.getString('type', true);
    const at = normalizeAt(interaction.options.getString('at', true));
    await doPlace(interaction, state, guildId, userId, type, at);
}

async function handleBuildCompat(interaction, state, guildId, userId) {
    const type = interaction.options.getString('type', true);
    const at = normalizeAt(interaction.options.getString('at', false));
    if (!at) {
        await interaction.reply(`Use /catan place type:${type} at:<ID>. Example: /catan place type:settlement at:V12`);
        return;
    }
    await doPlace(interaction, state, guildId, userId, type, at);
}

async function handleDevBuy(interaction, state, guildId, userId) {
    const game = getGame(state, guildId);
    if (!game || game.phase !== PHASE.TURN_ACTION) {
        await interaction.reply('Dev card purchase is only available during turn action phase.');
        return;
    }

    const turnError = validateTurnPlayer(game, userId);
    if (turnError) {
        await interaction.reply(turnError);
        return;
    }

    const player = currentPlayer(game);
    if (!canAfford(player.resources, COSTS.dev_buy)) {
        await interaction.reply(`Not enough resources. Need ${costToString(COSTS.dev_buy)}.`);
        return;
    }
    if (game.devDeck.length === 0) {
        await interaction.reply('Development card deck is empty.');
        return;
    }

    spendResources(player.resources, COSTS.dev_buy);
    const card = game.devDeck.pop();
    player.lockedDevCards[card] += 1;

    const winner = maybeFinishGame(game);
    saveState(state);

    await interaction.reply({
        content: `You bought a development card: ${card}. It cannot be played this turn.\nUse /catan dev-cards to see effects and timing.`,
        ephemeral: true,
    });
    if (winner) {
        await interaction.followUp(`${winner.name} wins with ${getPlayerPoints(game, winner)} VP.`);
    }
}

function parseDevPlayOptions(interaction) {
    return {
        card: interaction.options.getString('card', true),
        resource: interaction.options.getString('resource', false),
        resource2: interaction.options.getString('resource2', false),
        edge1: normalizeAt(interaction.options.getString('edge1', false)),
        edge2: normalizeAt(interaction.options.getString('edge2', false)),
    };
}
async function handleDevPlay(interaction, state, guildId, userId) {
    const game = getGame(state, guildId);
    if (!game || game.phase !== PHASE.TURN_ACTION) {
        await interaction.reply('Dev card play is only available during turn action phase.');
        return;
    }

    const turnError = validateTurnPlayer(game, userId);
    if (turnError) {
        await interaction.reply(turnError);
        return;
    }

    const player = currentPlayer(game);
    const opts = parseDevPlayOptions(interaction);
    const card = opts.card;

    if (!DEV_CARD_TYPES.includes(card) || card === 'victory_point') {
        await interaction.reply('Unsupported or non-playable development card type.');
        return;
    }
    if ((player.devCards[card] ?? 0) <= 0) {
        await interaction.reply(`You do not have playable ${card}.`);
        return;
    }

    player.devCards[card] -= 1;

    if (card === 'knight') {
        player.playedKnights += 1;
        updateLargestArmyAward(game);
        game.phase = PHASE.ROBBER_MOVE;
        game.robberContext = { byPlayerId: userId, reason: 'knight' };
        saveState(state);
        await interaction.reply('Knight played. Move robber with /catan robber tile:<1-19> [target].');
        return;
    }

    if (card === 'road_building') {
        if (!opts.edge1 || !opts.edge2) {
            player.devCards[card] += 1;
            await interaction.reply('Road Building needs edge1 and edge2.');
            return;
        }

        const e1 = placeRoad(game, player, opts.edge1, true);
        if (e1) {
            player.devCards[card] += 1;
            await interaction.reply(`First road invalid: ${e1}`);
            return;
        }

        const e2 = placeRoad(game, player, opts.edge2, true);
        if (e2) {
            game.board.edges[opts.edge1].ownerId = null;
            player.roads = player.roads.filter(e => e !== opts.edge1);
            player.piecesRemaining.road += 1;
            updateLongestRoadAward(game);
            player.devCards[card] += 1;
            await interaction.reply(`Second road invalid: ${e2}`);
            return;
        }

        const winner = maybeFinishGame(game);
        saveState(state);
        if (winner) {
            await interaction.reply(`${winner.name} wins with ${getPlayerPoints(game, winner)} VP.`);
            return;
        }
        await interaction.reply(`Road Building played at ${opts.edge1} and ${opts.edge2}.`);
        return;
    }

    if (card === 'year_of_plenty') {
        if (!RESOURCES.includes(opts.resource) || !RESOURCES.includes(opts.resource2)) {
            player.devCards[card] += 1;
            await interaction.reply('Year of Plenty needs resource and resource2 from wood/brick/wheat/sheep/ore.');
            return;
        }
        player.resources[opts.resource] += 1;
        player.resources[opts.resource2] += 1;

        const winner = maybeFinishGame(game);
        saveState(state);
        if (winner) {
            await interaction.reply(`${winner.name} wins with ${getPlayerPoints(game, winner)} VP.`);
            return;
        }
        await interaction.reply(`Year of Plenty played. Gained ${resourceDisplayName(opts.resource)} and ${resourceDisplayName(opts.resource2)}.`);
        return;
    }

    if (card === 'monopoly') {
        if (!RESOURCES.includes(opts.resource)) {
            player.devCards[card] += 1;
            await interaction.reply('Monopoly needs a valid resource.');
            return;
        }

        let taken = 0;
        game.players.forEach(other => {
            if (other.id === player.id) return;
            const count = other.resources[opts.resource];
            if (count <= 0) return;
            other.resources[opts.resource] = 0;
            taken += count;
        });
        player.resources[opts.resource] += taken;

        const winner = maybeFinishGame(game);
        saveState(state);
        if (winner) {
            await interaction.reply(`${winner.name} wins with ${getPlayerPoints(game, winner)} VP.`);
            return;
        }
        await interaction.reply(`Monopoly played on ${resourceDisplayName(opts.resource)}. Took ${taken}.`);
    }
}

async function handleRobber(interaction, state, guildId, userId) {
    const game = getGame(state, guildId);
    if (!game || game.phase !== PHASE.ROBBER_MOVE) {
        await interaction.reply('Robber move is not active.');
        return;
    }
    if (game.robberContext?.byPlayerId !== userId) {
        await interaction.reply(`Robber move belongs to <@${game.robberContext?.byPlayerId}>.`);
        return;
    }

    const tile = interaction.options.getInteger('tile', true);
    const targetUser = interaction.options.getUser('target', false);
    const hexId = `H${tile}`;

    if (!game.board.hexes.find(h => h.id === hexId)) {
        await interaction.reply('Unknown tile. Use 1-19.');
        return;
    }
    if (hexId === game.board.robberHexId) {
        await interaction.reply('Robber must move to a different tile.');
        return;
    }

    game.board.robberHexId = hexId;
    let stealText = 'No card stolen.';
    const candidates = getAdjacentVictimCandidates(game, hexId, userId);

    if (candidates.length > 0) {
        let target = null;
        if (targetUser) {
            target = candidates.find(p => p.id === targetUser.id) ?? null;
            if (!target) {
                await interaction.reply('Invalid target for this tile.');
                return;
            }
        } else if (candidates.length === 1) {
            target = candidates[0];
        } else {
            await interaction.reply(`Multiple targets available: ${candidates.map(p => p.name).join(', ')}. Re-run with target.`);
            return;
        }

        const res = drawRandomResource(target.resources);
        if (res) {
            target.resources[res] -= 1;
            getPlayer(game, userId).resources[res] += 1;
            stealText = `Stole 1 ${res} from ${target.name}.`;
        }
    }

    game.phase = PHASE.TURN_ACTION;
    game.robberContext = null;
    saveState(state);
    await interaction.reply(`Robber moved to ${hexId}. ${stealText}`);
}

async function handleTradeBank(interaction, state, guildId, userId) {
    const game = getGame(state, guildId);
    if (!game || game.phase !== PHASE.TURN_ACTION) {
        await interaction.reply('Bank trade is only available during turn action phase.');
        return;
    }

    const turnError = validateTurnPlayer(game, userId);
    if (turnError) {
        await interaction.reply(turnError);
        return;
    }

    const give = interaction.options.getString('give', true);
    const get = interaction.options.getString('get', true);
    if (!RESOURCES.includes(give) || !RESOURCES.includes(get)) {
        await interaction.reply('Invalid resource choice.');
        return;
    }

    const player = currentPlayer(game);
    if (player.resources[give] < 4) {
        await interaction.reply(`Need 4 ${resourceDisplayName(give)} for a bank trade.`);
        return;
    }

    player.resources[give] -= 4;
    player.resources[get] += 1;
    saveState(state);
    await interaction.reply(`${player.name} traded 4 ${resourceDisplayName(give)} for 1 ${resourceDisplayName(get)}.`);
}

async function handleTradePlayer(interaction, state, guildId, userId) {
    const game = getGame(state, guildId);
    if (!game || game.phase !== PHASE.TURN_ACTION) {
        await interaction.reply('Player trade is only available during turn action phase.');
        return;
    }

    const turnError = validateTurnPlayer(game, userId);
    if (turnError) {
        await interaction.reply(turnError);
        return;
    }

    if (game.tradeState.pendingOffer) {
        await interaction.reply('A trade offer is already pending.');
        return;
    }

    const targetUser = interaction.options.getUser('target', true);
    if (targetUser.id === userId) {
        await interaction.reply('Cannot trade with yourself.');
        return;
    }

    const target = getPlayer(game, targetUser.id);
    if (!target) {
        await interaction.reply('Target user is not in this game.');
        return;
    }

    const give = parseResourceMap(interaction.options.getString('give', true));
    const get = parseResourceMap(interaction.options.getString('get', true));
    if (!give || !get) {
        await interaction.reply('Invalid format. Use resource:count pairs, e.g. wood:1,brick:2');
        return;
    }

    const initiator = getPlayer(game, userId);
    if (!canAfford(initiator.resources, give)) {
        await interaction.reply('You do not have enough resources for this offer.');
        return;
    }

    const offerId = `${Date.now()}`;
    game.tradeState.pendingOffer = {
        offerId,
        fromId: userId,
        toId: target.id,
        give,
        get,
        expiresAt: Date.now() + 60_000,
    };

    saveState(state);
    await interaction.reply({
        content: `Trade offer to <@${target.id}>\nGive: ${resourceMapToString(give)}\nGet: ${resourceMapToString(get)}\nExpires in 60s.`,
        components: [createTradeButtons(guildId, offerId)],
    });
}

async function handleEndTurn(interaction, state, guildId, userId) {
    const game = getGame(state, guildId);
    if (!game || game.phase !== PHASE.TURN_ACTION) {
        await interaction.reply('End turn is only available during turn action phase.');
        return;
    }

    const turnError = validateTurnPlayer(game, userId);
    if (turnError) {
        await interaction.reply(turnError);
        return;
    }

    game.tradeState.pendingOffer = null;
    game.players.forEach(moveLockedDevCardsToPlayable);

    const order = getTurnOrder(game);
    const currentIndex = order.indexOf(game.turn.currentPlayerId);
    const nextIndex = (currentIndex + 1) % order.length;
    if (nextIndex === 0) game.turn.round += 1;
    game.turn.currentPlayerId = order[nextIndex];
    game.turn.rolled = false;
    game.turn.dice = null;
    game.phase = PHASE.TURN_ROLL;

    saveState(state);
    await interaction.reply({
        content: `Turn ended. It is now ${getPlayer(game, game.turn.currentPlayerId)?.name}'s turn. Roll with the button below or /catan roll.`,
        components: [createTurnRollButtons(guildId)],
    });
}

// --- Slash command handlers: status and utility ---
async function handleSetupStatus(interaction, state, guildId) {
    const game = getGame(state, guildId);
    if (!game) {
        await interaction.reply('No game found.');
        return;
    }

    if (game.phase !== PHASE.SETUP_ORDER_ROLL && game.phase !== PHASE.SETUP_PLACEMENT) {
        await interaction.reply(`Setup is not active. Current phase: ${game.phase}.`);
        return;
    }

    if (game.phase === PHASE.SETUP_ORDER_ROLL) {
        const lines = game.players
            .map(p => `${p.name}: ${game.setup.rolls[p.id] === null ? 'pending' : game.setup.rolls[p.id]}`)
            .join('\n');
        await interaction.reply(`Setup order roll:\n${lines}`);
        return;
    }

    await interaction.reply(`Setup placement: <@${game.setup.currentPlayerId}> must place ${game.setup.step}.`);
}

async function handleDisband(interaction, state, guildId, userId) {
    const game = getGame(state, guildId);
    if (!game) {
        await interaction.reply('No game found.');
        return;
    }

    if (!isOngoingGame(game)) {
        if (game.phase === PHASE.LOBBY) {
            await interaction.reply('Disband vote is only for ongoing games. During lobby phase, players can use /catan leave.');
            return;
        }
        await interaction.reply('Game is already finished. Start a new one with /catan create.');
        return;
    }

    const player = getPlayer(game, userId);
    if (!player) {
        await interaction.reply('You are not in this game.');
        return;
    }

    const hadVote = Boolean(game.disbandVote);
    const previousVote = game.disbandVote;
    const vote = normalizeActiveDisbandVote(game);
    const voteExpired = hadVote
        && previousVote
        && Number.isFinite(previousVote.expiresAt)
        && Date.now() > previousVote.expiresAt;

    if (!vote) {
        const now = Date.now();
        game.disbandVote = {
            initiatedBy: userId,
            approvals: [userId],
            createdAt: now,
            expiresAt: now + DISBAND_VOTE_WINDOW_MS,
        };

        const pending = pendingDisbandApprovals(game, game.disbandVote);
        const prefix = voteExpired ? 'Previous disband vote expired.\n' : '';

        if (pending.length === 0) {
            removeGame(state, guildId);
            saveState(state);
            await interaction.reply(`${prefix}Disband approved by all players. Game removed.`);
            return;
        }

        saveState(state);
        await interaction.reply(
            `${prefix}Disband vote started by <@${userId}>.\n${formatDisbandVoteLine(game, game.disbandVote)}\nAll players must run /catan disband to approve.`
        );
        return;
    }

    if (vote.approvals.includes(userId)) {
        await interaction.reply(`You already approved this disband vote.\n${formatDisbandVoteLine(game, vote)}`);
        return;
    }

    vote.approvals.push(userId);
    const pending = pendingDisbandApprovals(game, vote);
    if (pending.length === 0) {
        removeGame(state, guildId);
        saveState(state);
        await interaction.reply('Disband approved by all players. Game removed by unanimous vote.');
        return;
    }

    saveState(state);
    await interaction.reply(`<@${userId}> approved disband.\n${formatDisbandVoteLine(game, vote)}`);
}

async function handleStatus(interaction, state, guildId) {
    const guildState = getGuildState(state, guildId);
    const game = guildState.game;
    if (!game) {
        const note = guildState.migrationNote ? `\nNote: ${guildState.migrationNote}` : '';
        await interaction.reply(`No game found. Use /catan create.${note}`);
        return;
    }

    const current = currentPlayer(game);
    const lines = [
        `Phase: ${game.phase} | Round: ${game.turn?.round ?? '-'} | Current: ${current?.name ?? '-'} | Robber: ${game.board?.robberHexId ?? '-'}`,
        ...game.players.map(player => formatPointsLine(game, player)),
    ];
    if (game.winnerId) lines.push(`Winner: ${getPlayer(game, game.winnerId)?.name ?? game.winnerId}`);
    const hadVote = Boolean(game.disbandVote);
    const vote = normalizeActiveDisbandVote(game);
    if (hadVote && !vote) {
        saveState(state);
    } else if (vote) {
        lines.push(formatDisbandVoteLine(game, vote));
    }

    await interaction.reply(lines.join('\n'));
}

// --- Long message splitting/output helpers ---
function splitLongText(text, maxLen = 1800) {
    const lines = text.split('\n');
    const chunks = [];
    let current = [];
    let currentLen = 0;

    lines.forEach(line => {
        const nextLen = currentLen + line.length + 1;
        if (nextLen > maxLen && current.length > 0) {
            chunks.push(current.join('\n'));
            current = [line];
            currentLen = line.length + 1;
            return;
        }
        current.push(line);
        currentLen = nextLen;
    });

    if (current.length > 0) {
        chunks.push(current.join('\n'));
    }

    return chunks;
}

async function handleBoard(interaction, state, guildId) {
    const game = getGame(state, guildId);
    if (!game?.board) {
        await interaction.reply('Board not available yet. Start game with /catan start.');
        return;
    }
    const focusRequest = interaction.options.getString('at', false);
    const focus = resolveBoardFocusTarget(game, focusRequest);
    if (focus.error) {
        await interaction.reply(focus.error);
        return;
    }
    try {
        const png = renderBoardPng(game, focus.target);
        const imageName = `catan-board-${guildId}.png`;
        const attachment = new AttachmentBuilder(png, { name: imageName });
        const current = currentPlayer(game);
        const focusLine = focus.target ? `Focus: ${focus.target.id}` : 'Focus: none (use /catan board at:V12 or at:E34)';

        await interaction.reply({
            content: [
                `Catan board visual`,
                `Phase: ${game.phase} | Round: ${game.turn?.round ?? '-'} | Current: ${current?.name ?? '-'} | Robber: ${game.board.robberHexId ?? '-'}`,
                focusLine,
                'Legend is included on the right side of the image (region colors, robber, players).',
                `Resource emojis: ${resourceLegendLine(true)}`,
                'Use /catan place type:settlement at:V12 or /catan place type:road at:E34',
            ].join('\n'),
            files: [attachment],
        });
    } catch (error) {
        console.error('Failed to render board image. Falling back to text board.', error);
        const chunks = splitLongText(boardLegend(game), 1800);
        const first = chunks[0] || 'Board unavailable.';
        await interaction.reply(`\`\`\`\n${first}\n\`\`\``);

        for (let i = 1; i < chunks.length; i += 1) {
            await interaction.followUp(`\`\`\`\n${chunks[i]}\n\`\`\``);
        }
    }
}

async function handleHand(interaction, state, guildId, userId) {
    const game = getGame(state, guildId);
    if (!game) {
        await interaction.reply('No game found.');
        return;
    }

    const player = getPlayer(game, userId);
    if (!player) {
        await interaction.reply('You are not in this game.');
        return;
    }

    await interaction.reply({
        content: [
            `Resources: ${resourceMapToString(player.resources)}`,
            `Playable dev cards: ${devCardsToString(player.devCards)}`,
            `Locked dev cards: ${devCardsToString(player.lockedDevCards)}`,
            '',
            ...getBuildCostLines(),
            'Tip: use /catan costs any time.',
            'Tip: use /catan dev-cards for dev card effects and timing.',
        ].join('\n'),
        ephemeral: true,
    });
}

async function handleCosts(interaction) {
    await interaction.reply([...getBuildCostLines(), 'Tip: use /catan dev-cards for development card details.'].join('\n'));
}

async function handleDevCards(interaction) {
    await interaction.reply(getDevCardGuideLines().join('\n'));
}

// --- Public catan command/component dispatchers ---
export async function handleCatanCommand(interaction) {
    const state = loadState();
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const displayName = interaction.member?.displayName ?? interaction.user.username;

    switch (subcommand) {
        case 'create': await handleCreate(interaction, state, guildId, userId, displayName); return;
        case 'join': await handleJoin(interaction, state, guildId, userId, displayName); return;
        case 'leave': await handleLeave(interaction, state, guildId, userId, displayName); return;
        case 'disband': await handleDisband(interaction, state, guildId, userId); return;
        case 'start': await handleStart(interaction, state, guildId); return;
        case 'roll': await handleRoll(interaction, state, guildId, userId); return;
        case 'place': await handlePlace(interaction, state, guildId, userId); return;
        case 'build': await handleBuildCompat(interaction, state, guildId, userId); return;
        case 'trade-bank': await handleTradeBank(interaction, state, guildId, userId); return;
        case 'trade-player': await handleTradePlayer(interaction, state, guildId, userId); return;
        case 'dev-buy': await handleDevBuy(interaction, state, guildId, userId); return;
        case 'dev-play': await handleDevPlay(interaction, state, guildId, userId); return;
        case 'dev-cards': await handleDevCards(interaction); return;
        case 'robber': await handleRobber(interaction, state, guildId, userId); return;
        case 'endturn': await handleEndTurn(interaction, state, guildId, userId); return;
        case 'setup-status': await handleSetupStatus(interaction, state, guildId); return;
        case 'status': await handleStatus(interaction, state, guildId); return;
        case 'costs': await handleCosts(interaction); return;
        case 'board': await handleBoard(interaction, state, guildId); return;
        case 'hand': await handleHand(interaction, state, guildId, userId); return;
        default: await interaction.reply('Unknown catan subcommand.');
    }
}

async function handleSetupRollButton(interaction) {
    const match = interaction.customId.match(/^catan_setup_roll:([^:]+)$/);
    if (!match) {
        await interaction.reply({ content: 'Invalid setup roll payload.', ephemeral: true });
        return true;
    }

    const [, guildId] = match;
    const state = loadState();
    const game = getGame(state, guildId);
    if (!game) {
        await interaction.reply({ content: 'No game found.', ephemeral: true });
        return true;
    }

    if (game.phase !== PHASE.SETUP_ORDER_ROLL) {
        await interaction.reply({ content: 'Setup order roll is not active.', ephemeral: true });
        return true;
    }

    const result = processSetupOrderRoll(game, interaction.user.id);
    if (result.error) {
        await interaction.reply({ content: result.error, ephemeral: true });
        return true;
    }

    saveState(state);
    if (game.phase === PHASE.TURN_ROLL) {
        await interaction.reply({
            content: `${result.message}\n${getPlayer(game, game.turn.currentPlayerId)?.name} can roll with the button below or /catan roll.`,
            components: [createTurnRollButtons(guildId)],
        });
        return true;
    }

    await interaction.reply(result.message);
    return true;
}

async function handleTurnRollButton(interaction) {
    const match = interaction.customId.match(/^catan_turn_roll:([^:]+)$/);
    if (!match) {
        await interaction.reply({ content: 'Invalid turn roll payload.', ephemeral: true });
        return true;
    }

    const [, guildId] = match;
    const state = loadState();
    const game = getGame(state, guildId);
    if (!game) {
        await interaction.reply({ content: 'No game found.', ephemeral: true });
        return true;
    }

    if (game.phase !== PHASE.TURN_ROLL) {
        await interaction.reply({ content: 'Turn roll is not active.', ephemeral: true });
        return true;
    }

    const result = processTurnRoll(game, interaction.user.id);
    if (result.error) {
        await interaction.reply({ content: result.error, ephemeral: true });
        return true;
    }

    saveState(state);
    await interaction.reply(result.message);
    return true;
}

async function handleLobbyJoinButton(interaction) {
    const match = interaction.customId.match(/^catan_lobby_join:([^:]+)$/);
    if (!match) {
        await interaction.reply({ content: 'Invalid lobby join payload.', ephemeral: true });
        return true;
    }

    const [, guildId] = match;
    const state = loadState();
    const displayName = interaction.member?.displayName ?? interaction.user.username;
    const result = joinLobbyForPlayer(state, guildId, interaction.user.id, displayName);
    if (result.error) {
        await interaction.reply({ content: result.error, ephemeral: true });
        return true;
    }

    await interaction.reply(result.message);
    return true;
}

// Handles catan button interactions (lobby, setup roll, turn roll, and trade flow).
export async function handleCatanComponentInteraction(interaction) {
    if (!interaction.isButton()) return false;
    if (interaction.customId.startsWith('catan_lobby_join:')) {
        return handleLobbyJoinButton(interaction);
    }
    if (interaction.customId.startsWith('catan_setup_roll:')) {
        return handleSetupRollButton(interaction);
    }
    if (interaction.customId.startsWith('catan_turn_roll:')) {
        return handleTurnRollButton(interaction);
    }
    if (!interaction.customId.startsWith('catan_trade_')) return false;

    const match = interaction.customId.match(/^catan_trade_(accept|reject):([^:]+):(.+)$/);
    if (!match) {
        await interaction.reply({ content: 'Invalid trade action payload.', ephemeral: true });
        return true;
    }

    const [, action, guildId, offerId] = match;
    const state = loadState();
    const game = getGame(state, guildId);
    if (!game?.tradeState?.pendingOffer) {
        await interaction.reply({ content: 'No pending trade offer.', ephemeral: true });
        return true;
    }

    const offer = game.tradeState.pendingOffer;
    if (offer.offerId !== offerId) {
        await interaction.reply({ content: 'This trade offer is no longer active.', ephemeral: true });
        return true;
    }

    if (Date.now() > offer.expiresAt) {
        game.tradeState.pendingOffer = null;
        saveState(state);
        await interaction.update({ content: 'Trade offer expired.', components: [] });
        return true;
    }

    if (action === 'accept') {
        if (interaction.user.id !== offer.toId) {
            await interaction.reply({ content: 'Only target player can accept.', ephemeral: true });
            return true;
        }

        const from = getPlayer(game, offer.fromId);
        const to = getPlayer(game, offer.toId);
        if (!from || !to) {
            game.tradeState.pendingOffer = null;
            saveState(state);
            await interaction.update({ content: 'Trade failed: player missing.', components: [] });
            return true;
        }

        if (!canAfford(from.resources, offer.give) || !canAfford(to.resources, offer.get)) {
            game.tradeState.pendingOffer = null;
            saveState(state);
            await interaction.update({ content: 'Trade failed: resources changed before acceptance.', components: [] });
            return true;
        }

        spendResources(from.resources, offer.give);
        addResources(from.resources, offer.get);
        spendResources(to.resources, offer.get);
        addResources(to.resources, offer.give);

        game.tradeState.pendingOffer = null;
        saveState(state);
        await interaction.update({ content: `Trade completed between ${from.name} and ${to.name}.`, components: [] });
        return true;
    }

    if (interaction.user.id !== offer.toId && interaction.user.id !== offer.fromId) {
        await interaction.reply({ content: 'Only trade participants can reject/cancel.', ephemeral: true });
        return true;
    }

    game.tradeState.pendingOffer = null;
    saveState(state);
    await interaction.update({ content: 'Trade offer cancelled.', components: [] });
    return true;
}
