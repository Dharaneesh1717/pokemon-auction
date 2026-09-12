const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// ======================================================
// GAME SETTINGS
// ======================================================

const STARTING_MONEY = 1000;
const BID_INCREMENT = 10;
const BID_TIME = 100;

// ======================================================
// RECONNECT SETTINGS
// ======================================================

const RECONNECT_GRACE_PERIOD = 8000;

// ======================================================
// TEAM / MONEY RULE
// ======================================================

const TEAM_SIZE = 6;
const MINIMUM_POKEMON_COST = 20; // minimum base price a Pokémon can have (randomBasePrice min)

// ======================================================
// PROFILE PICTURES (put these files in public/images/avatars/)
// ======================================================

const AVATAR_FILES = [
    "avatar-01.png",
    "avatar-02.png",
    "avatar-03.png",
    "avatar-04.png",
    "avatar-05.png",
    "avatar-06.png",
    "avatar-07.png",
    "avatar-08.png",
    "avatar-09.png",
    "avatar-10.png",
    "avatar-11.png",
    "avatar-12.png"
];

function pickRandomAvatar(lobby) {
    const used = new Set(
        (lobby?.players || [])
            .map(p => p.avatar)
            .filter(Boolean)
    );

    const available = AVATAR_FILES.filter(
        f => !used.has(f)
    );

    const pool =
        available.length > 0
            ? available
            : AVATAR_FILES;

    return pool[
        crypto.randomInt(pool.length)
    ];
}

// ======================================================
// POKEMON DATA
// ======================================================

let pokemonList = [];
let pokemonDataReady = false;

// ======================================================
// ABSOLUTELY RANDOM SHUFFLE
// ======================================================

function shufflePokemon(array) {
    // Triple Fisher–Yates with crypto RNG for stronger mixing
    for (let pass = 0; pass < 3; pass++) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = crypto.randomInt(i + 1);
            [array[i], array[j]] = [array[j], array[i]];
        }
    }
    return array;
}

/*
 * Fair global deck: every Pokémon appears equally often.
 * Draw without replacement until the deck is empty, then reshuffle all 251.
 * No species can show up again until every other species has had a turn
 * in this cycle (across all lobbies on this server).
 */
let pokemonDeck = [];

function refillPokemonDeck() {
    pokemonDeck = shufflePokemon([...pokemonList]);
    console.log(
        "Pokémon deck refilled:",
        pokemonDeck.length,
        "species (equal chance cycle)."
    );
}

function buildAuctionPool(playerCount) {
    if (!pokemonList.length) {
        return [];
    }

    // Enough for full teams + skips, but we pull from the shared fair deck
    const needed = Math.min(
        pokemonList.length,
        Math.max(
            (Number(playerCount) || 2) * 12,
            48
        )
    );

    const selected = [];

    while (selected.length < needed) {
        if (pokemonDeck.length === 0) {
            refillPokemonDeck();
        }
        selected.push(pokemonDeck.pop());
    }

    // Fresh base prices for this auction only (clues unchanged)
    return selected.map(p => ({
        ...p,
        basePrice: randomBasePrice()
    }));
}

// ======================================================
// RANDOM BASE PRICE
// ======================================================

function randomBasePrice() {
    return crypto.randomInt(2, 16) * 10;
}

// ======================================================
// POKEMON CLUE GENERATOR
// ======================================================

function generateClues(data) {
    const clues = [];

    const shapeMap = {
        squiggle: "Its body has a somewhat unusual shape.",
        quadruped: "It moves on four legs.",
        humanoid: "Its body shape is somewhat humanoid.",
        wings: "It has a body shape suited for flight.",
        serpentine: "Its body has a long, snake-like shape.",
        fish: "Its body resembles a fish.",
        bug_wings: "Its body has features associated with insects.",
        armor: "Its body has a sturdy or armored appearance.",
        ball: "Its body is roughly round.",
        upright: "It has an upright body shape.",
        blob: "Its body has a soft, rounded appearance.",
        legless: "It does not have visible legs.",
        two_wings: "It has prominent wings."
    };

    if (data.color) {
        clues.push(
            `This Pokémon is mainly ${data.color} in colour.`
        );
    }

    if (
        data.shape &&
        shapeMap[data.shape]
    ) {
        clues.push(
            shapeMap[data.shape]
        );
    }

    if (data.height !== undefined) {
        if (data.height <= 5) {
            clues.push(
                "This Pokémon is relatively small."
            );
        } else if (data.height >= 15) {
            clues.push(
                "This Pokémon is very large."
            );
        } else {
            clues.push(
                "This Pokémon has an average-sized body."
            );
        }
    }

    if (data.weight !== undefined) {
        if (data.weight >= 1000) {
            clues.push(
                "This Pokémon is extremely heavy."
            );
        } else if (data.weight >= 500) {
            clues.push(
                "This Pokémon has considerable weight."
            );
        }
    }

    if (data.habitat) {
        const habitatMap = {
            cave: "It is associated with caves.",
            forest: "It is associated with forests.",
            grassland: "It is associated with grasslands.",
            mountain: "It is associated with mountains.",
            rare: "It is considered a rare Pokémon.",
            rough_terrain: "It is associated with rough terrain.",
            sea: "It is associated with the sea.",
            urban: "It can be associated with urban areas.",
            waters_edge: "It is associated with the water's edge."
        };

        if (
            habitatMap[data.habitat]
        ) {
            clues.push(
                habitatMap[data.habitat]
            );
        }
    }

    const description =
        (data.description || "").toLowerCase();

    if (
        description.includes("fang") ||
        description.includes("teeth") ||
        description.includes("tooth")
    ) {
        clues.push(
            "It is known for having sharp teeth or fangs."
        );
    }

    if (
        description.includes("claw") ||
        description.includes("pincer")
    ) {
        clues.push(
            "It has sharp claws or pincers."
        );
    }

    if (description.includes("horn")) {
        clues.push(
            "It has a noticeable horn."
        );
    }

    if (description.includes("tail")) {
        clues.push(
            "Its tail is an important feature."
        );
    }

    if (
        description.includes("wing") ||
        description.includes("fly") ||
        description.includes("flying")
    ) {
        clues.push(
            "It has a strong connection with flying."
        );
    }

    if (
        description.includes("fire") ||
        description.includes("flame")
    ) {
        clues.push(
            "Fire is associated with this Pokémon."
        );
    }

    if (
        description.includes("water") ||
        description.includes("sea") ||
        description.includes("ocean")
    ) {
        clues.push(
            "Water is strongly associated with this Pokémon."
        );
    }

    if (
        description.includes("electric") ||
        description.includes("thunder") ||
        description.includes("lightning")
    ) {
        clues.push(
            "Electricity is associated with this Pokémon."
        );
    }

    if (
        description.includes("dark") ||
        description.includes("night") ||
        description.includes("shadow")
    ) {
        clues.push(
            "Darkness or shadows are associated with it."
        );
    }

    if (
        description.includes("sleep") ||
        description.includes("dream")
    ) {
        clues.push(
            "It has an association with sleep or dreams."
        );
    }

    if (
        description.includes("poison") ||
        description.includes("toxic")
    ) {
        clues.push(
            "Poison is associated with this Pokémon."
        );
    }

    if (
        description.includes("strong") ||
        description.includes("powerful") ||
        description.includes("strength")
    ) {
        clues.push(
            "It is known for considerable strength."
        );
    }

    const uniqueClues =
        [...new Set(clues)];

    shufflePokemon(uniqueClues);

    return uniqueClues.slice(0, 4);
}

// ======================================================
// FETCH WITH RETRIES
// ======================================================

async function fetchWithRetry(url, retries = 3) {
    for (
        let attempt = 1;
        attempt <= retries;
        attempt++
    ) {
        const controller = new AbortController();

        const timeout = setTimeout(() => {
            controller.abort();
        }, 10000);

        try {
            const response = await fetch(url, {
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) {
                throw new Error(
                    `HTTP ${response.status} for ${url}`
                );
            }

            return await response.json();

        } catch (error) {
            clearTimeout(timeout);

            console.log(
                `Fetch failed (${attempt}/${retries}):`,
                url
            );

            if (attempt === retries) {
                throw error;
            }

            await new Promise(resolve =>
                setTimeout(resolve, 1000)
            );
        }
    }
}

// ======================================================
// LOAD POKEMON FROM POKEAPI
// ======================================================

async function loadPokemonData() {
    console.log("--------------------------------");
    console.log("Loading Pokémon data from PokeAPI...");
    console.log("--------------------------------");

    const loadedPokemon = [];

    const TOTAL_POKEMON = 251;
    const BATCH_SIZE = 10;

    for (
        let start = 1;
        start <= TOTAL_POKEMON;
        start += BATCH_SIZE
    ) {
        const end = Math.min(
            start + BATCH_SIZE - 1,
            TOTAL_POKEMON
        );

        console.log(
            `Loading Pokémon ${start}-${end}...`
        );

        const promises = [];

        for (
            let id = start;
            id <= end;
            id++
        ) {
            promises.push(
                (async () => {
                    try {
                        const pokemon =
                            await fetchWithRetry(
                                `https://pokeapi.co/api/v2/pokemon/${id}`
                            );

                        const species =
                            await fetchWithRetry(
                                `https://pokeapi.co/api/v2/pokemon-species/${id}`
                            );

                        const englishEntry =
                            species.flavor_text_entries.find(
                                entry =>
                                    entry.language.name === "en"
                            );

                        let description =
                            englishEntry
                                ? englishEntry.flavor_text
                                : "";

                        description =
                            description
                                .replace(/\n/g, " ")
                                .replace(/\f/g, " ");

                        const data = {
                            id: pokemon.id,

                            name:
                                pokemon.name
                                    .charAt(0)
                                    .toUpperCase() +
                                pokemon.name.slice(1),

                            color:
                                species.color
                                    ? species.color.name
                                    : null,

                            shape:
                                species.shape
                                    ? species.shape.name
                                    : null,

                            habitat:
                                species.habitat
                                    ? species.habitat.name
                                    : null,

                            height:
                                pokemon.height,

                            weight:
                                pokemon.weight,

                            description:
                                description,

                            sprite:
                                pokemon.sprites.front_default,

                            type:
                                pokemon.types &&
                                pokemon.types.length > 0
                                    ? pokemon.types[0].type.name
                                    : null,

                            officialArtwork:
                                pokemon.sprites &&
                                pokemon.sprites.other &&
                                pokemon.sprites.other["official-artwork"]
                                    ? pokemon.sprites.other["official-artwork"].front_default
                                    : null,

                            cry:
                                pokemon.cries &&
                                pokemon.cries.latest
                                    ? pokemon.cries.latest
                                    : (
                                        pokemon.cries &&
                                        pokemon.cries.legacy
                                            ? pokemon.cries.legacy
                                            : null
                                    ),

                            // Base stats for local fallback ranking
                            stats: (() => {
                                const s = {};
                                if (Array.isArray(pokemon.stats)) {
                                    for (const entry of pokemon.stats) {
                                        const key =
                                            entry.stat &&
                                            entry.stat.name;
                                        if (key) {
                                            s[key] =
                                                entry.base_stat ||
                                                0;
                                        }
                                    }
                                }
                                return s;
                            })(),

                            bst: (() => {
                                if (
                                    !Array.isArray(
                                        pokemon.stats
                                    )
                                ) {
                                    return 0;
                                }
                                return pokemon.stats.reduce(
                                    (sum, entry) =>
                                        sum +
                                        (entry.base_stat ||
                                            0),
                                    0
                                );
                            })(),

                            basePrice:
                                randomBasePrice()
                        };

                        data.clues =
                            generateClues(data);

                        data.hint =
                            data.clues.length > 0
                                ? data.clues.join(" ")
                                : "A mysterious Pokémon awaits.";

                        return data;

                    } catch (error) {
                        console.log(
                            `Failed to load Pokémon #${id}:`,
                            error.message
                        );

                        return null;
                    }
                })()
            );
        }

        const results =
            await Promise.all(promises);

        for (const pokemon of results) {
            if (pokemon) {
                loadedPokemon.push(pokemon);
            }
        }
    }

    loadedPokemon.sort(
        (a, b) => a.id - b.id
    );

    pokemonList =
        loadedPokemon;

    pokemonDataReady =
        true;

    console.log("--------------------------------");
    console.log(
        `Loaded ${pokemonList.length} Pokémon.`
    );
    console.log("Pokémon data is ready.");
    console.log("--------------------------------");
}

// ======================================================
// LOBBIES
// ======================================================

const lobbies = new Map();

// ======================================================
// LOBBY CODE
// ======================================================

function generateLobbyCode() {
    const characters =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code;

    do {
        code = "";

        for (let i = 0; i < 6; i++) {
            code +=
                characters[
                    Math.floor(
                        Math.random() *
                        characters.length
                    )
                ];
        }

    } while (lobbies.has(code));

    return code;
}

// ======================================================
// FIND PLAYER
// ======================================================

function getPlayer(lobby, playerId) {
    return lobby.players.find(
        player =>
            player.playerId === playerId
    );
}

// ======================================================
// MONEY RESERVE
// ======================================================

function getRequiredReserve(player) {
    // Money that must remain AFTER winning the next Pokémon
    // = ₹20 × (empty slots after this purchase)
    const remainingAfterWin =
        Math.max(
            0,
            TEAM_SIZE - player.pokemon.length - 1
        );

    return (
        remainingAfterWin *
        MINIMUM_POKEMON_COST
    );
}

// ======================================================
// MAXIMUM BID
// ======================================================

function getMaximumBid(player) {
    // Max bid = money - (₹20 × slots left after this buy)
    // Last Pokémon (1 slot left): reserve = 0 → can spend everything
    // 2 slots left, ₹60: reserve = ₹20 → max bid = ₹40
    const reserve =
        getRequiredReserve(player);

    return Math.max(
        0,
        player.money - reserve
    );
}

// ======================================================
// SEND LOBBY UPDATE
// ======================================================

function sendLobbyUpdate(code) {
    const lobby =
        lobbies.get(code);

    if (!lobby) return;

    io.to(code).emit(
        "lobbyUpdate",
        {
            code:
                lobby.code,

            maxPlayers:
                lobby.maxPlayers,

            hostPlayerId:
                lobby.hostPlayerId,

            started:
                lobby.started,

            auctionFinished:
                !!lobby.auctionFinished,

            players:
                lobby.players.map(
                    player => ({
                        playerId:
                            player.playerId,

                        name:
                            player.name,

                        avatar:
                            player.avatar ||
                            null,

                        money:
                            player.money,

                        pokemonCount:
                            player.pokemon.length,

                        returnedToLobby:
                            !!player.returnedToLobby
                    })
                )
        }
    );
}

// ======================================================
// SEND AUCTION UPDATE
// ======================================================

function sendAuctionUpdate(code) {
    const lobby =
        lobbies.get(code);

    if (
        !lobby ||
        !lobby.auction
    ) {
        return;
    }

    io.to(code).emit(
        "auctionState",
        {
            pokemonHidden:
                true,

            hint:
                lobby.auction.pokemon.hint,

            basePrice:
                lobby.auction.basePrice,

            currentBid:
                lobby.auction.currentBid,

            highestBidder:
                lobby.auction.highestBidder,

            timeLeft:
                lobby.auction.timeLeft,

            auctionActive:
                lobby.auction.active,

            pokemonType:
                lobby.auction.pokemon.type,

            skippedPlayers:
                Array.from(
                    lobby.auction.skippedPlayers ||
                    []
                ),

            players:
                lobby.players.map(
                    player => ({
                        playerId:
                            player.playerId,

                        name:
                            player.name,

                        avatar:
                            player.avatar ||
                            null,

                        money:
                            player.money,

                        pokemonCount:
                            player.pokemon.length,

                        pokemon:
                            player.pokemon,

                        requiredReserve:
                            getRequiredReserve(player),

                        maximumBid:
                            getMaximumBid(player),

                        isHighestBidder:
                            lobby.auction.highestBidder ===
                            player.playerId
                    })
                )
        }
    );
}

// ======================================================
// START NEXT POKEMON
// ======================================================

function startNextPokemon(code) {
    const lobby =
        lobbies.get(code);

    if (!lobby) return;

    if (
        lobby.auction &&
        lobby.auction.timer
    ) {
        clearInterval(
            lobby.auction.timer
        );
        lobby.auction.timer = null;
    }

    // ==================================================
    // FIND NEXT AFFORDABLE POKÉMON
    // Skip any whose base price no one can pay
    // ==================================================

    while (
        lobby.auctionIndex <
        lobby.auctionPokemon.length
    ) {

        // Everyone already has a full team
        if (
            lobby.players.every(
                p => p.pokemon.length >= TEAM_SIZE
            )
        ) {
            finishAuction(code);
            return;
        }

        const pokemon =
            lobby.auctionPokemon[
                lobby.auctionIndex
            ];

        const anyoneCanAfford =
            lobby.players.some(
                p =>
                    p.pokemon.length < TEAM_SIZE &&
                    getMaximumBid(p) >= pokemon.basePrice
            );

        if (!anyoneCanAfford) {
            console.log(
                "INTERNAL SKIP (unaffordable):",
                pokemon.name,
                "base ₹" + pokemon.basePrice
            );
            lobby.auctionIndex++;
            continue;
        }

        // ---- Start this Pokémon ----

        lobby.auction = {
            pokemon:
                pokemon,

            basePrice:
                pokemon.basePrice,

            currentBid:
                pokemon.basePrice,

            highestBidder:
                null,

            timeLeft:
                BID_TIME,

            active:
                true,

            timer:
                null,

            skippedPlayers:
                new Set()
        };

        // Auto-skip: full team OR cannot afford base price
        lobby.players.forEach(
            player => {

                if (
                    player.pokemon.length >=
                    TEAM_SIZE
                ) {
                    lobby.auction.skippedPlayers.add(
                        player.playerId
                    );
                    return;
                }

                if (
                    getMaximumBid(player) <
                    pokemon.basePrice
                ) {
                    lobby.auction.skippedPlayers.add(
                        player.playerId
                    );
                }
            }
        );

        // If somehow everyone is skipped, move on
        if (
            lobby.auction.skippedPlayers.size >=
            lobby.players.length
        ) {
            console.log(
                "INTERNAL SKIP (all skipped):",
                pokemon.name
            );
            lobby.auction.active = false;
            lobby.auctionIndex++;
            continue;
        }

        console.log("--------------------------------");
        console.log("NEW POKEMON");
        console.log("Lobby:", code);
        console.log("Pokemon:", pokemon.name);
        console.log(
            "Base Price:",
            pokemon.basePrice
        );
        console.log(
            "Timer:",
            BID_TIME
        );
        console.log("--------------------------------");

        sendAuctionUpdate(code);

        // If only one player can still bid and no highest bidder yet,
        // they still need a chance to bid (or timer will skip).
        // Immediate win only applies when there is a highest bidder.

        lobby.auction.timer =
            setInterval(() => {
                const currentLobby =
                    lobbies.get(code);

                if (!currentLobby) {
                    return;
                }

                const auction =
                    currentLobby.auction;

                if (
                    !auction ||
                    !auction.active
                ) {
                    return;
                }

                auction.timeLeft--;

                sendAuctionUpdate(code);

                if (
                    auction.timeLeft <= 0
                ) {
                    finishPokemon(code);
                }

            }, 1000);

        return;
    }

    // No more Pokémon left
    finishAuction(code);
}

// ======================================================
// FINISH CURRENT POKEMON
// ======================================================

function finishPokemon(code) {
    const lobby =
        lobbies.get(code);

    if (
        !lobby ||
        !lobby.auction
    ) {
        return;
    }

    const auction =
        lobby.auction;

    if (!auction.active) {
        return;
    }

    auction.active =
        false;

    if (auction.timer) {
        clearInterval(
            auction.timer
        );

        auction.timer =
            null;
    }

    // ==================================================
    // POKEMON SOLD
    // ==================================================

    if (auction.highestBidder) {
        const winner =
            getPlayer(
                lobby,
                auction.highestBidder
            );

        if (winner) {
            const price =
                auction.currentBid;

            const pokemon =
                auction.pokemon;

            const reserveAfterPurchase =
                Math.max(
                    0,
                    TEAM_SIZE -
                    (winner.pokemon.length + 1)
                ) *
                MINIMUM_POKEMON_COST;

            if (
                winner.money - price <
                reserveAfterPurchase
            ) {
                console.log(
                    "SAFETY BLOCK:",
                    winner.name,
                    "could not afford",
                    pokemon.name
                );

                auction.highestBidder =
                    null;

                io.to(code).emit(
                    "auctionError",
                    "This purchase would prevent you from completing your 6-Pokémon team."
                );

                // Give clients a clear skipped outcome so UI is not stuck
                io.to(code).emit(
                    "pokemonSkipped",
                    {
                        pokemon:
                            pokemon.name,

                        officialArtwork:
                            pokemon.officialArtwork,

                        type:
                            pokemon.type,

                        cry:
                            pokemon.cry ||
                            null,

                        pokemonId:
                            pokemon.id ||
                            null
                    }
                );

            } else {
                winner.money -=
                    price;

                winner.pokemon.push({
                    name:
                        pokemon.name,

                    officialArtwork:
                        pokemon.officialArtwork ||
                        null,

                    sprite:
                        pokemon.sprite ||
                        null,

                    type:
                        pokemon.type ||
                        null,

                    id:
                        pokemon.id ||
                        null,

                    bst:
                        pokemon.bst ||
                        0,

                    stats:
                        pokemon.stats ||
                        null
                });

                console.log("--------------------------------");
                console.log("POKEMON SOLD");
                console.log(
                    "Pokemon:",
                    pokemon.name
                );
                console.log(
                    "Winner:",
                    winner.name
                );
                console.log(
                    "Price:",
                    price
                );
                console.log(
                    "Remaining Money:",
                    winner.money
                );
                console.log(
                    "Pokemon Count:",
                    winner.pokemon.length
                );
                console.log("--------------------------------");

                io.to(code).emit(
                    "pokemonSold",
                    {
                        pokemon:
                            pokemon.name,

                        winner:
                            winner.name,

                        winnerId:
                            winner.playerId,

                        price:
                            price,

                        sprite:
                            pokemon.sprite,

                        officialArtwork:
                            pokemon.officialArtwork,

                        pokemonId:
                            pokemon.id,

                        type:
                            pokemon.type,

                        cry:
                            pokemon.cry ||
                            null,

                        team:
                            winner.pokemon,

                        remainingMoney:
                            winner.money
                    }
                );
            }
        }

    } else {

        // ==================================================
        // NOBODY BID
        // ==================================================

        console.log("--------------------------------");
        console.log("POKEMON SKIPPED");
        console.log(
            "Pokemon:",
            auction.pokemon.name
        );
        console.log("--------------------------------");

        io.to(code).emit(
            "pokemonSkipped",
            {
                pokemon:
                    auction.pokemon.name,

                officialArtwork:
                    auction.pokemon.officialArtwork,

                type:
                    auction.pokemon.type,

                cry:
                    auction.pokemon.cry ||
                    null,

                pokemonId:
                    auction.pokemon.id ||
                    null
            }
        );
    }

    sendAuctionUpdate(code);
    if (
    lobby.players.every(
        player => player.pokemon.length >= TEAM_SIZE
    )
) {
    finishAuction(code);
    return;
}

    // ==================================================
    // NEXT POKEMON
    // ==================================================

    setTimeout(() => {
        const currentLobby =
            lobbies.get(code);

        if (!currentLobby) {
            return;
        }

        currentLobby.auctionIndex++;

        startNextPokemon(code);

    }, 6200);
}

// ======================================================
// VICTORY JUSTIFICATION (explains WHY this team ranked #1)
// ======================================================

function pickVictoryReason(top, allScored) {
    const name = top.name || "This trainer";
    const bst = top.totalBst || 0;
    const count = top.pokemonCount || 0;
    const types = top.typeCount || 0;

    return (
        `${name} won with the highest team power (BST ${bst}` +
        `, ${count} Pokémon, ${types} type${types === 1 ? "" : "s"}).`
    );
}

// ======================================================
// TOURNAMENT RANKING (local – no API keys needed)
// Score = total BST + full-team bonus + type coverage
// ======================================================

function rankTeams(players) {
    const scored = players.map(player => {
        const list = player.pokemon || [];
        let totalBst = 0;
        const types = new Set();

        for (const p of list) {
            totalBst +=
                Number(p.bst) || 0;
            if (p.type) {
                types.add(p.type);
            }
        }

        const fullTeamBonus =
            list.length >= TEAM_SIZE
                ? 80
                : list.length * 5;
        const coverageBonus =
            types.size * 12;

        const score =
            totalBst +
            fullTeamBonus +
            coverageBonus;

        return {
            playerId: player.playerId,
            name: player.name,
            avatar: player.avatar || null,
            score,
            totalBst,
            pokemonCount: list.length,
            typeCount: types.size
        };
    });

    scored.sort(
        (a, b) => b.score - a.score
    );

    return scored;
}

// ======================================================
// FINISH AUCTION + ANNOUNCE TOURNAMENT CHAMPION
// ======================================================

function finishAuction(code) {
    const lobby =
        lobbies.get(code);

    if (!lobby) return;

    lobby.auctionFinished =
        true;

    // Nobody is back in lobby yet
    lobby.players.forEach(player => {
        player.returnedToLobby = false;
    });

    console.log("--------------------------------");
    console.log("AUCTION FINISHED");
    console.log("Lobby:", code);
    console.log("Ranking teams...");
    console.log("--------------------------------");

    const playersPayload =
        lobby.players.map(player => ({
            playerId:
                player.playerId,
            name:
                player.name,
            avatar:
                player.avatar || null,
            money:
                player.money,
            pokemon:
                player.pokemon
        }));

    const scored = rankTeams(
        lobby.players
    );

    const rankings = scored.map(
        (s, i) => ({
            playerId: s.playerId,
            name: s.name,
            place: i + 1,
            score: s.score,
            totalBst: s.totalBst
        })
    );

    let winner = null;
    let reason = "";

    if (scored.length > 0) {
        const top = scored[0];
        winner = {
            playerId: top.playerId,
            name: top.name,
            avatar: top.avatar
        };
        reason = pickVictoryReason(top, scored);
    }

    console.log(
        "Tournament champion:",
        winner ? winner.name : "none"
    );

    io.to(code).emit(
        "auctionFinished",
        {
            players: playersPayload,
            winner: winner,
            rankings: rankings,
            reason: reason,
            judgedBy: "local"
        }
    );
}

// ======================================================
// REMOVE PLAYER BEFORE GAME
// ======================================================

function removePlayer(code, playerId) {
    const lobby =
        lobbies.get(code);

    if (!lobby) return;

    // Block only during an active auction (not during post-auction wait)
    if (lobby.started && !lobby.auctionFinished) {
        return;
    }

    const index =
        lobby.players.findIndex(
            player =>
                player.playerId ===
                playerId
        );

    if (index === -1) {
        return;
    }

    const removed =
        lobby.players[index];

    lobby.players.splice(
        index,
        1
    );

    console.log(
        "Removed player:",
        removed.name
    );

    // ==================================================
    // TRANSFER HOST
    // ==================================================

    if (
        lobby.hostPlayerId ===
            playerId &&
        lobby.players.length > 0
    ) {
        lobby.hostPlayerId =
            lobby.players[0].playerId;

        console.log(
            "New host:",
            lobby.players[0].name
        );
    }

    // ==================================================
    // DELETE EMPTY LOBBY
    // ==================================================

    if (
        lobby.players.length === 0
    ) {
        lobbies.delete(code);

        console.log(
            "Lobby deleted:",
            code
        );

        return;
    }

    // If waiting after auction and everyone left has returned, unlock
    if (lobby.auctionFinished) {
        const allBack =
            lobby.players.every(
                p => p.returnedToLobby === true
            );

        if (allBack) {
            lobby.started = false;
            lobby.auctionFinished = false;
            lobby.auctionIndex = 0;
            lobby.auction = null;
            lobby.auctionPokemon = buildAuctionPool(
                lobby.players.length || lobby.maxPlayers
            );

            lobby.players.forEach(p => {
                p.returnedToLobby = false;
                p.money = STARTING_MONEY;
                p.pokemon = [];
            });

            console.log(
                "All remaining players ready — lobby unlocked:",
                code
            );
        }
    }

    sendLobbyUpdate(code);
}

// ======================================================
// SOCKET CONNECTION
// ======================================================

io.on("connection", socket => {

    console.log(
        "Socket connected:",
        socket.id
    );

    // ==================================================
    // REGISTER PLAYER
    // ==================================================

    socket.on(
        "registerPlayer",
        data => {

            if (
                !data ||
                !data.playerId
            ) {
                return;
            }

            socket.playerId =
                data.playerId;

            socket.playerName =
                data.name;

            console.log(
                "Player registered:",
                data.name,
                "(" +
                    data.playerId +
                ")"
            );
        }
    );

    // ==================================================
    // CREATE LOBBY
    // ==================================================

    socket.on(
        "createLobby",
        data => {

            if (!data) {
                socket.emit(
                    "lobbyError",
                    "Invalid lobby information."
                );
                return;
            }

            const playerId =
                data.playerId;

            const name =
                data.name;

            const maxPlayers =
                Number(
                    data.maxPlayers
                );

            if (
                !playerId ||
                !name ||
                maxPlayers < 2 ||
                maxPlayers > 8
            ) {
                socket.emit(
                    "lobbyError",
                    "Invalid lobby information."
                );

                return;
            }

            if (!pokemonDataReady) {
                socket.emit(
                    "lobbyError",
                    "Pokémon data is still loading. Please wait a moment and try again."
                );

                return;
            }

            const code =
                generateLobbyCode();

            // ==================================================
            // EACH LOBBY GETS ITS OWN RANDOM POKEMON ORDER
            // ==================================================

            const randomizedPokemon =
                buildAuctionPool(maxPlayers);

            const lobby = {
                code:
                    code,

                maxPlayers:
                    maxPlayers,

                hostPlayerId:
                    playerId,

                players: [
                    {
                        playerId:
                            playerId,

                        name:
                            name,

                        avatar:
                            pickRandomAvatar(null),

                        socketId:
                            socket.id,

                        money:
                            STARTING_MONEY,

                        pokemon:
                            []
                    }
                ],

                started:
                    false,

                auctionFinished:
                    false,

                auctionIndex:
                    0,

                auctionPokemon:
                    randomizedPokemon,

                auction:
                    null
            };

            lobbies.set(
                code,
                lobby
            );

            socket.playerId =
                playerId;

            socket.playerName =
                name;

            socket.lobbyCode =
                code;

            socket.join(code);

            console.log("--------------------------------");
            console.log("CREATING LOBBY");
            console.log(
                "Player:",
                name
            );
            console.log(
                "Lobby:",
                code
            );
            console.log(
                "Players required:",
                maxPlayers
            );
            console.log(
                "Pokemon order randomized."
            );
            console.log("--------------------------------");

            socket.emit(
                "lobbyCreated",
                {
                    code:
                        code
                }
            );

            sendLobbyUpdate(code);
        }
    );

    // ==================================================
    // JOIN LOBBY
    // ==================================================

    socket.on(
        "joinLobby",
        data => {

            if (!data) {
                socket.emit(
                    "lobbyError",
                    "Invalid lobby information."
                );
                return;
            }

            const playerId =
                data.playerId;

            const name =
                data.name;

            const code =
                String(
                    data.code || ""
                )
                    .trim()
                    .toUpperCase();

            const lobby =
                lobbies.get(code);

            if (!lobby) {
                socket.emit(
                    "lobbyError",
                    "Lobby not found."
                );

                return;
            }

            if (lobby.started) {
                socket.emit(
                    "lobbyError",
                    "Auction already started."
                );

                return;
            }

            // ==================================================
            // CHECK EXISTING PLAYER BEFORE FULL LOBBY CHECK
            // ==================================================

            const existing =
                getPlayer(
                    lobby,
                    playerId
                );

            if (
                !existing &&
                lobby.players.length >=
                lobby.maxPlayers
            ) {
                socket.emit(
                    "lobbyError",
                    "Lobby is full."
                );

                return;
            }

            if (existing) {

                existing.socketId =
                    socket.id;

                if (name) {
                    existing.name =
                        name;
                }

                if (!existing.avatar) {
                    existing.avatar =
                        pickRandomAvatar(lobby);
                }

            } else {

                lobby.players.push(
                    {
                        playerId:
                            playerId,

                        name:
                            name,

                        avatar:
                            pickRandomAvatar(lobby),

                        socketId:
                            socket.id,

                        money:
                            STARTING_MONEY,

                        pokemon:
                            []
                    }
                );
            }

            socket.playerId =
                playerId;

            socket.playerName =
                name || existing?.name;

            socket.lobbyCode =
                code;

            socket.join(code);

            console.log("--------------------------------");
            console.log("PLAYER JOINED");
            console.log(
                "Player:",
                name || existing?.name
            );
            console.log(
                "Lobby:",
                code
            );
            console.log(
                "Players:",
                lobby.players.length +
                "/" +
                lobby.maxPlayers
            );
            console.log("--------------------------------");

            socket.emit(
                "lobbyJoined",
                {
                    code:
                        code
                }
            );

            sendLobbyUpdate(code);
        }
    );

    // ==================================================
    // RECONNECT
    // ==================================================

    socket.on(
        "reconnectToLobby",
        data => {

            if (
                !data ||
                !data.playerId ||
                !data.lobbyCode
            ) {
                return;
            }

            const playerId =
                data.playerId;

            const code =
                String(
                    data.lobbyCode
                )
                    .trim()
                    .toUpperCase();

            const lobby =
                lobbies.get(code);

            if (!lobby) {
                socket.emit(
                    "lobbyError",
                    "Lobby no longer exists."
                );

                return;
            }

            const player =
                getPlayer(
                    lobby,
                    playerId
                );

            if (!player) {
                socket.emit(
                    "lobbyError",
                    "Player not found."
                );

                return;
            }

            // ==================================================
            // UPDATE SOCKET ID
            // ==================================================

            player.socketId =
                socket.id;

            socket.playerId =
                playerId;

            socket.playerName =
                player.name;

            socket.lobbyCode =
                code;

            socket.join(code);

            console.log(
                player.name,
                "reconnected to",
                code
            );

            if (
                lobby.started &&
                lobby.auction &&
                lobby.auction.active
            ) {
                sendAuctionUpdate(code);
            } else {
                sendLobbyUpdate(code);
            }
        }
    );

    // ==================================================
    // CHANGE LOBBY SIZE
    // ==================================================

    socket.on(
        "changeLobbySize",
        data => {

            if (!data) return;

            const code =
                String(
                    data.lobbyCode || ""
                )
                    .trim()
                    .toUpperCase();

            const playerId =
                data.playerId;

            const newSize =
                Number(
                    data.maxPlayers
                );

            const lobby =
                lobbies.get(code);

            if (!lobby) {
                return;
            }

            if (
                lobby.hostPlayerId !==
                playerId
            ) {
                return;
            }

            // Allow size change before game OR while waiting after auction
            if (lobby.started && !lobby.auctionFinished) {
                return;
            }

            if (
                newSize < 2 ||
                newSize > 8
            ) {
                return;
            }

            if (
                newSize <
                lobby.players.length
            ) {
                socket.emit(
                    "lobbyError",
                    "Lobby size cannot be smaller than the number of players already inside."
                );

                return;
            }

            lobby.maxPlayers =
                newSize;

            console.log(
                "Lobby size changed:",
                code,
                "->",
                newSize
            );

            sendLobbyUpdate(code);
        }
    );

    // ==================================================
    // RETURN TO LOBBY (RESET AFTER AUCTION)
    // ==================================================

    socket.on(
        "returnToLobby",
        data => {

            if (!data) return;

            const code =
                String(
                    data.lobbyCode || ""
                )
                    .trim()
                    .toUpperCase();

            const playerId =
                data.playerId;

            const lobby =
                lobbies.get(code);

            if (!lobby) {
                return;
            }

            if (!lobby.auctionFinished) {
                return;
            }

            const player =
                getPlayer(lobby, playerId);

            if (!player) {
                return;
            }

            // Mark this player as back in the lobby
            player.returnedToLobby = true;
            player.money = STARTING_MONEY;
            player.pokemon = [];

            console.log(
                player.name,
                "returned to lobby"
            );

            // Only this player navigates back
            socket.emit("returnedToLobby");

            // When EVERY player has returned, fully unlock the lobby for a new auction
            const allBack =
                lobby.players.every(
                    p => p.returnedToLobby === true
                );

            if (allBack) {
                lobby.started = false;
                lobby.auctionFinished = false;
                lobby.auctionIndex = 0;
                lobby.auction = null;
                lobby.auctionPokemon = buildAuctionPool(
                    lobby.players.length || lobby.maxPlayers
                );

                lobby.players.forEach(p => {
                    p.returnedToLobby = false;
                    p.money = STARTING_MONEY;
                    p.pokemon = [];
                });

                console.log("--------------------------------");
                console.log("ALL PLAYERS BACK — LOBBY READY");
                console.log("Lobby:", code);
                console.log("--------------------------------");
            }

            sendLobbyUpdate(code);
        }
    );

    // ==================================================
    // EXIT GAME (leave after auction ends)
    // ==================================================

    socket.on(
        "exitGame",
        data => {

            if (!data) return;

            const code =
                String(
                    data.lobbyCode || ""
                )
                    .trim()
                    .toUpperCase();

            const playerId =
                data.playerId;

            const lobby =
                lobbies.get(code);

            if (!lobby) {
                socket.emit("exitedGame");
                return;
            }

            // Allow exit during/after finished auction, or from lobby
            const player =
                getPlayer(lobby, playerId);

            if (!player) {
                socket.emit("exitedGame");
                return;
            }

            console.log(
                player.name,
                "exited the game from",
                code
            );

            // If host exits, transfer host first
            const wasHost =
                lobby.hostPlayerId === playerId;

            // Remove player
            const index =
                lobby.players.findIndex(
                    p => p.playerId === playerId
                );

            if (index !== -1) {
                lobby.players.splice(index, 1);
            }

            if (lobby.players.length === 0) {
                lobbies.delete(code);
                socket.emit("exitedGame");
                return;
            }

            if (wasHost) {
                lobby.hostPlayerId =
                    lobby.players[0].playerId;
            }

            // If auction finished and remaining players all returned, unlock lobby
            if (lobby.auctionFinished) {
                const allBack =
                    lobby.players.every(
                        p => p.returnedToLobby === true
                    );

                if (allBack) {
                    lobby.started = false;
                    lobby.auctionFinished = false;
                    lobby.auctionIndex = 0;
                    lobby.auction = null;
                    lobby.auctionPokemon = buildAuctionPool(
                        lobby.players.length || lobby.maxPlayers
                    );

                    lobby.players.forEach(p => {
                        p.returnedToLobby = false;
                        p.money = STARTING_MONEY;
                        p.pokemon = [];
                    });
                }
            }

            socket.emit("exitedGame");
            sendLobbyUpdate(code);
        }
    );

    // ==================================================
    // TRANSFER HOST
    // ==================================================

    socket.on(
        "transferHost",
        data => {

            if (!data) return;

            const code =
                String(
                    data.lobbyCode || ""
                )
                    .trim()
                    .toUpperCase();

            const playerId =
                data.playerId;

            const newHostId =
                data.newHostId ||
                data.targetPlayerId;

            const lobby =
                lobbies.get(code);

            if (!lobby) {
                return;
            }

            // Allow transfer before game OR while waiting after auction
            if (lobby.started && !lobby.auctionFinished) {
                return;
            }

            if (
                lobby.hostPlayerId !==
                playerId
            ) {
                return;
            }

            const newHost =
                getPlayer(
                    lobby,
                    newHostId
                );

            if (!newHost) {
                return;
            }

            if (
                newHostId ===
                playerId
            ) {
                return;
            }

            lobby.hostPlayerId =
                newHostId;

            console.log("--------------------------------");
            console.log(
                "HOST TRANSFERRED"
            );
            console.log(
                "Lobby:",
                code
            );
            console.log(
                "New Host:",
                newHost.name
            );
            console.log("--------------------------------");

            sendLobbyUpdate(code);
        }
    );

    // ==================================================
    // KICK PLAYER
    // ==================================================

    socket.on(
        "kickPlayer",
        data => {

            if (!data) return;

            const code =
                String(
                    data.lobbyCode || ""
                )
                    .trim()
                    .toUpperCase();

            const playerId =
                data.playerId;

            const targetPlayerId =
                data.targetPlayerId;

            const lobby =
                lobbies.get(code);

            if (!lobby) {
                return;
            }

            // Allow kick before game OR while waiting for players to return after auction
            if (lobby.started && !lobby.auctionFinished) {
                return;
            }

            if (
                lobby.hostPlayerId !==
                playerId
            ) {
                return;
            }

            if (
                !targetPlayerId ||
                targetPlayerId === playerId
            ) {
                return;
            }

            const target =
                getPlayer(
                    lobby,
                    targetPlayerId
                );

            if (!target) {
                return;
            }

            console.log("--------------------------------");
            console.log("PLAYER KICKED");
            console.log("Lobby:", code);
            console.log("Kicked:", target.name);
            console.log("--------------------------------");

            // Notify the kicked player specifically
            if (target.socketId) {
                io.to(target.socketId).emit(
                    "playerKicked"
                );
            }

            removePlayer(
                code,
                targetPlayerId
            );
        }
    );

    // ==================================================
    // START AUCTION
    // ==================================================

    socket.on(
        "startGame",
        data => {

            if (!data) return;

            const code =
                String(
                    data.lobbyCode || ""
                )
                    .trim()
                    .toUpperCase();

            const playerId =
                data.playerId;

            const lobby =
                lobbies.get(code);

            if (!lobby) {
                return;
            }

            if (
                lobby.hostPlayerId !==
                playerId
            ) {
                socket.emit(
                    "auctionError",
                    "Only the host can start the auction."
                );

                return;
            }

            if (
                lobby.players.length !==
                lobby.maxPlayers
            ) {
                socket.emit(
                    "auctionError",
                    "Waiting for all players."
                );

                return;
            }

            if (lobby.started || lobby.auctionFinished) {
                socket.emit(
                    "auctionError",
                    "Waiting for all trainers to return to the lobby before starting a new auction."
                );
                return;
            }

            if (!pokemonDataReady) {
                socket.emit(
                    "auctionError",
                    "Pokémon data is still loading. Please wait."
                );

                return;
            }

            lobby.started =
                true;

            // Fresh random Pokémon pool every auction
            lobby.auctionIndex = 0;
            lobby.auction = null;
            lobby.auctionPokemon =
                buildAuctionPool(
                    lobby.players.length ||
                    lobby.maxPlayers
                );

            console.log("--------------------------------");
            console.log(
                "AUCTION STARTING"
            );
            console.log(
                "Lobby:",
                code
            );
            console.log(
                "Players:",
                lobby.players.length
            );
            console.log(
                "Pokemon in pool:",
                lobby.auctionPokemon.length
            );
            console.log("--------------------------------");

            io.to(code).emit(
                "gameStarting"
            );

            setTimeout(() => {
                startNextPokemon(code);
            }, 1500);
        }
    );

    // ==================================================
    // BID
    // ==================================================

    socket.on(
        "placeBid",
        data => {

            if (!data) return;

            const code =
                String(
                    data.lobbyCode || ""
                )
                    .trim()
                    .toUpperCase();

            const playerId =
                data.playerId;

            const lobby =
                lobbies.get(code);

            if (!lobby) {
                return;
            }

            const player =
                getPlayer(
                    lobby,
                    playerId
                );

            if (!player) {
                return;
            }

            const auction =
                lobby.auction;

            if (
                !auction ||
                !auction.active
            ) {
                socket.emit(
                    "auctionError",
                    "Auction is not active."
                );

                return;
            }

            if (
                auction.timeLeft <= 0
            ) {
                return;
            }

            if (
                auction.skippedPlayers.has(
                    playerId
                )
            ) {
                socket.emit(
                    "auctionError",
                    "You already skipped this Pokémon."
                );

                return;
            }

            if (
                player.pokemon.length >=
                TEAM_SIZE
            ) {
                socket.emit(
                    "auctionError",
                    "Your team already has 6 Pokémon."
                );

                return;
            }

            const isFirstBid =
                auction.highestBidder ===
                null;

            const nextBid =
                isFirstBid
                    ? auction.currentBid
                    : auction.currentBid +
                        BID_INCREMENT;

            const maximumBid =
                getMaximumBid(player);

            if (
                nextBid >
                maximumBid
            ) {
                const reserve =
                    getRequiredReserve(
                        player
                    );

                socket.emit(
                    "auctionError",
                    `Maximum safe bid is ₹${maximumBid}. You must keep ₹${reserve} reserved to complete your 6-Pokémon team.`
                );

                return;
            }

            auction.currentBid =
                nextBid;

            auction.highestBidder =
                playerId;

            auction.timeLeft =
                BID_TIME;

            console.log(
                player.name,
                "bid ₹" +
                nextBid,
                "for",
                auction.pokemon.name
            );

            // Auto-skip anyone who can no longer afford the next bid
            // Exception: the current highest bidder stays active
            const nextPossibleBid =
                auction.currentBid +
                BID_INCREMENT;

            lobby.players.forEach(
                other => {

                    if (
                        other.playerId ===
                        auction.highestBidder
                    ) {
                        return;
                    }

                    if (
                        other.pokemon.length >=
                        TEAM_SIZE
                    ) {
                        auction.skippedPlayers.add(
                            other.playerId
                        );
                        return;
                    }

                    if (
                        getMaximumBid(other) <
                        nextPossibleBid
                    ) {
                        auction.skippedPlayers.add(
                            other.playerId
                        );
                    }
                }
            );

            sendAuctionUpdate(code);


            // ==================================================
            // IMMEDIATE WIN RULE
            // ==================================================

            const requiredSkips =
                lobby.players.length - 1;

            if (
                auction.skippedPlayers.size >=
                requiredSkips
            ) {
                finishPokemon(code);
                return;
            }

            let someoneElseCanBid =
                false;

            for (
                const other of
                    lobby.players
            ) {
                if (
                    other.playerId ===
                    auction.highestBidder
                ) {
                    continue;
                }

                if (
                    other.pokemon.length >=
                    TEAM_SIZE
                ) {
                    continue;
                }

                if (
                    auction.skippedPlayers.has(
                        other.playerId
                    )
                ) {
                    continue;
                }

                if (
                    getMaximumBid(other) >=
                    nextPossibleBid
                ) {
                    someoneElseCanBid =
                        true;
                    break;
                }
            }

            if (!someoneElseCanBid) {
                console.log(
                    "No other player can outbid. Awarding immediately."
                );
                finishPokemon(code);
                return;
            }
        }
    );

    // ==================================================
    // SKIP
    // ==================================================

    socket.on(
        "skipPokemon",
        data => {

            if (!data) return;

            const code =
                String(
                    data.lobbyCode || ""
                )
                    .trim()
                    .toUpperCase();

            const playerId =
                data.playerId;

            const lobby =
                lobbies.get(code);

            if (!lobby) {
                return;
            }

            const auction =
                lobby.auction;

            if (
                !auction ||
                !auction.active
            ) {
                return;
            }

            const player =
                getPlayer(
                    lobby,
                    playerId
                );

            if (!player) {
                return;
            }

            if (
                auction.highestBidder ===
                playerId
            ) {
                socket.emit(
                    "auctionError",
                    "You are the highest bidder."
                );

                return;
            }

            if (
                auction.skippedPlayers.has(
                    playerId
                )
            ) {
                return;
            }

            auction.skippedPlayers.add(
                playerId
            );

            socket.emit(
                "playerSkipped"
            );

            console.log(
                player.name,
                "skipped",
                auction.pokemon.name
            );

            if (auction.highestBidder) {

                const requiredSkips =
                    lobby.players.length - 1;

                if (
                    auction.skippedPlayers.size >=
                    requiredSkips
                ) {
                    finishPokemon(code);
                    return;
                }

            } else {

                if (
                    auction.skippedPlayers.size >=
                    lobby.players.length
                ) {
                    finishPokemon(code);
                    return;
                }
            }
        }
    );

    // ==================================================
    // LEAVE LOBBY
    // ==================================================

    socket.on(
        "leaveLobby",
        data => {

            if (!data) return;

            const code =
                String(
                    data.lobbyCode || ""
                )
                    .trim()
                    .toUpperCase();

            const playerId =
                data.playerId;

            const lobby =
                lobbies.get(code);

            if (!lobby) {
                return;
            }

            if (lobby.started) {
                return;
            }

            removePlayer(
                code,
                playerId
            );
        }
    );

    // ==================================================
    // DISCONNECT
    // ==================================================

    socket.on(
        "disconnect",
        () => {

            console.log(
                "Socket disconnected:",
                socket.id
            );

            const code =
                socket.lobbyCode;

            const playerId =
                socket.playerId;

            if (
                !code ||
                !playerId
            ) {
                return;
            }

            const lobby =
                lobbies.get(code);

            if (!lobby) {
                return;
            }

            // ==================================================
            // DURING AUCTION
            // ==================================================

            if (lobby.started) {

                console.log(
                    socket.playerName,
                    "disconnected during auction."
                );

                return;
            }

            // ==================================================
            // PRE-GAME DISCONNECT GRACE PERIOD
            // ==================================================

            console.log(
                socket.playerName,
                "temporarily disconnected from lobby."
            );

            console.log(
                "Waiting",
                RECONNECT_GRACE_PERIOD / 1000,
                "seconds for reconnection..."
            );

            setTimeout(() => {

                const currentLobby =
                    lobbies.get(code);

                if (!currentLobby) {
                    return;
                }

                if (currentLobby.started) {
                    return;
                }

                const player =
                    getPlayer(
                        currentLobby,
                        playerId
                    );

                if (!player) {
                    return;
                }

                if (
                    player.socketId !==
                    socket.id
                ) {
                    console.log(
                        player.name,
                        "reconnected successfully. Keeping player in lobby."
                    );

                    return;
                }

                console.log(
                    player.name,
                    "did not reconnect within grace period."
                );

                removePlayer(
                    code,
                    playerId
                );

            }, RECONNECT_GRACE_PERIOD);
        }
    );
});

// ======================================================
// SERVER
// ======================================================

server.listen(
    PORT,
    () => {

        console.log("--------------------------------");
        console.log(
            "POKEMON AUCTION SERVER"
        );
        console.log(
            "http://localhost:" +
            PORT
        );
        console.log("--------------------------------");

        loadPokemonData()
            .catch(error => {

                console.error(
                    "Failed to load Pokémon data:",
                    error
                );

                pokemonDataReady =
                    false;
            });
    }
);