
import fs from 'node:fs';
import path from 'node:path';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

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

const RESOURCE_ICON = {
    wood: '🌲',
    brick: '🧱',
    wheat: '🌾',
    sheep: '🐑',
    ore: '⛰️',
    desert: '🏜️',
};

const BUILDING_ICON = {
    settlement: '🏠',
    city: '🏰',
};

const PLAYER_MARKERS = ['🔴', '🔵', '🟢', '🟡', '⚪'];

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
    return RESOURCES.map(k => `${k} ${map[k] ?? 0}`).join(', ');
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
        return 'Setup complete. Normal turn flow begins. First player should /catan roll.';
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

function getPlayerMarker(game, playerId) {
    const index = game.players.findIndex(player => player.id === playerId);
    return PLAYER_MARKERS[index] ?? PLAYER_MARKERS[PLAYER_MARKERS.length - 1];
}

function formatPointsLine(game, player) {
    const marker = getPlayerMarker(game, player.id);
    const longestRoad = game.awards.longestRoadOwnerId === player.id ? ' 🛣️LongestRoad' : '';
    const largestArmy = game.awards.largestArmyOwnerId === player.id ? ' 🛡️LargestArmy' : '';
    return `${marker} ${player.name}: ${getPlayerPoints(game, player)} VP | 🏠${player.settlements.length} 🏰${player.cities.length} 🛤️${player.roads.length}${longestRoad}${largestArmy}`;
}

function formatHexCell(game, hex) {
    const icon = RESOURCE_ICON[hex.resource] ?? '?';
    const token = hex.number === null ? '--' : String(hex.number).padStart(2, '0');
    const robber = hex.id === game.board.robberHexId ? '🦹' : '  ';
    return `${robber}${hex.id}${icon}${token}`;
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
        const settlementList = player.settlements.map(v => `${BUILDING_ICON.settlement}${v}`).join(' ') || '-';
        const cityList = player.cities.map(v => `${BUILDING_ICON.city}${v}`).join(' ') || '-';
        return `${marker} ${player.name} | settlements: ${settlementList} | cities: ${cityList}`;
    }).join('\n');
}

function renderRoadOwnership(game) {
    const lines = Object.values(game.board.edges)
        .filter(edge => edge.ownerId)
        .map(edge => {
            const marker = getPlayerMarker(game, edge.ownerId);
            return `${marker}${edge.id}(${edge.vertexIds.join('-')})`;
        })
        .join('\n');
    return lines || 'none';
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
        'Legend: 🌲 wood | 🧱 brick | 🌾 wheat | 🐑 sheep | ⛰️ ore | 🏜️ desert | 🦹 robber',
        `Players: ${markerLegend}`,
        '',
        'Placements:',
        renderPlayerPlacements(game),
        '',
        'Roads:',
        renderRoadOwnership(game),
    ].join('\n');
}

function createTradeButtons(guildId, offerId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`catan_trade_accept:${guildId}:${offerId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`catan_trade_reject:${guildId}:${offerId}`).setLabel('Reject/Cancel').setStyle(ButtonStyle.Danger)
    );
}
async function handleCreate(interaction, state, guildId, userId, displayName) {
    const existing = getGame(state, guildId);
    if (existing && existing.phase !== PHASE.FINISHED) {
        await interaction.reply('A game already exists. Use /catan join, /catan start, or /catan status.');
        return;
    }
    setGame(state, guildId, createLobbyGame([createPlayer(userId, displayName)]));
    saveState(state);
    await interaction.reply('Catan v2 lobby created. Others can join with /catan join (2-4 players).');
}

async function handleJoin(interaction, state, guildId, userId, displayName) {
    const game = getGame(state, guildId);
    if (!game || game.phase !== PHASE.LOBBY) {
        await interaction.reply('No open lobby. Create one with /catan create.');
        return;
    }
    if (game.players.some(p => p.id === userId)) {
        await interaction.reply('You are already in the lobby.');
        return;
    }
    if (game.players.length >= 4) {
        await interaction.reply('Lobby is full (2-4 players only).');
        return;
    }
    game.players.push(createPlayer(userId, displayName));
    saveState(state);
    await interaction.reply(`${displayName} joined the lobby. (${game.players.length}/4)`);
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
    await interaction.reply('Game started. Each player rolls once with /catan roll to determine first turn order.');
}

async function handleRoll(interaction, state, guildId, userId) {
    const game = getGame(state, guildId);
    if (!game) {
        await interaction.reply('No game found. Use /catan create.');
        return;
    }

    if (game.phase === PHASE.SETUP_ORDER_ROLL) {
        const player = getPlayer(game, userId);
        if (!player) {
            await interaction.reply('You are not in this game.');
            return;
        }
        if (game.setup.rolls[userId] !== null) {
            await interaction.reply('You already rolled for setup order.');
            return;
        }

        const total = rollDie() + rollDie();
        game.setup.rolls[userId] = total;

        const pending = game.players.filter(p => game.setup.rolls[p.id] === null);
        if (pending.length > 0) {
            saveState(state);
            await interaction.reply(`You rolled ${total}. Waiting for ${pending.map(p => p.name).join(', ')}.`);
            return;
        }

        if (!finalizeSetupOrder(game)) {
            const values = Object.values(game.setup.rolls);
            const tiedValue = values.find((v, i) => values.indexOf(v) !== i);
            game.players.forEach(p => {
                if (game.setup.rolls[p.id] === tiedValue) game.setup.rolls[p.id] = null;
            });
            saveState(state);
            await interaction.reply(`Tie detected at ${tiedValue}. Tied players reroll with /catan roll.`);
            return;
        }

        const orderText = game.setup.order.map(id => getPlayer(game, id)?.name ?? id).join(' -> ');
        const next = setupAdvance(game);
        saveState(state);
        await interaction.reply(`Turn order: ${orderText}\n${next}`);
        return;
    }

    if (game.phase !== PHASE.TURN_ROLL) {
        await interaction.reply('Roll is not available in this phase.');
        return;
    }

    const turnError = validateTurnPlayer(game, userId);
    if (turnError) {
        await interaction.reply(turnError);
        return;
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
        saveState(state);

        const discardLines = [...discarded.entries()]
            .map(([pid, map]) => `${getPlayer(game, pid)?.name}: ${resourceMapToString(map)}`)
            .join('\n') || 'No discards required.';
        await interaction.reply(`Rolled 7. Discards applied:\n${discardLines}\nMove robber with /catan robber tile:<1-19> [target].`);
        return;
    }

    const gains = distributeResourcesByRoll(game, total);
    game.phase = PHASE.TURN_ACTION;
    saveState(state);

    const lines = game.players
        .map(player => `${player.name}: ${resourceMapToString(gains.get(player.id) ?? emptyResources())}`)
        .join('\n');
    await interaction.reply(`Rolled ${d1}+${d2}=${total}. Production:\n${lines}`);
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
        await interaction.reply('Not enough resources. Need wheat 1, sheep 1, ore 1.');
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

    await interaction.reply({ content: `You bought a development card: ${card}. It cannot be played this turn.`, ephemeral: true });
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
        await interaction.reply(`Year of Plenty played. Gained ${opts.resource} and ${opts.resource2}.`);
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
        await interaction.reply(`Monopoly played on ${opts.resource}. Took ${taken}.`);
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
        await interaction.reply(`Need 4 ${give} for a bank trade.`);
        return;
    }

    player.resources[give] -= 4;
    player.resources[get] += 1;
    saveState(state);
    await interaction.reply(`${player.name} traded 4 ${give} for 1 ${get}.`);
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
    await interaction.reply(`Turn ended. It is now ${getPlayer(game, game.turn.currentPlayerId)?.name}'s turn. Use /catan roll.`);
}

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

async function handleBoard(interaction, state, guildId) {
    const game = getGame(state, guildId);
    if (!game?.board) {
        await interaction.reply('Board not available yet. Start game with /catan start.');
        return;
    }
    await interaction.reply(`\`\`\`\n${boardLegend(game)}\n\`\`\``);
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
        ].join('\n'),
        ephemeral: true,
    });
}

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
        case 'robber': await handleRobber(interaction, state, guildId, userId); return;
        case 'endturn': await handleEndTurn(interaction, state, guildId, userId); return;
        case 'setup-status': await handleSetupStatus(interaction, state, guildId); return;
        case 'status': await handleStatus(interaction, state, guildId); return;
        case 'board': await handleBoard(interaction, state, guildId); return;
        case 'hand': await handleHand(interaction, state, guildId, userId); return;
        default: await interaction.reply('Unknown catan subcommand.');
    }
}

export async function handleCatanComponentInteraction(interaction) {
    if (!interaction.isButton()) return false;
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
