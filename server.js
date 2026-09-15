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

const AVATAR_DIR = path.join(
    __dirname,
    "public",
    "images",
    "avatars"
);

const AVATAR_EXT = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif"
]);

function listAvatarFiles() {
    try {
        const fs = require("fs");
        if (!fs.existsSync(AVATAR_DIR)) {
            return [];
        }
        return fs
            .readdirSync(AVATAR_DIR)
            .filter(f => {
                const ext = path
                    .extname(f)
                    .toLowerCase();
                return AVATAR_EXT.has(ext);
            })
            .sort((a, b) =>
                a.localeCompare(b, undefined, {
                    numeric: true
                })
            );
    } catch (e) {
        console.log(
            "Avatar list failed:",
            e.message
        );
        return [];
    }
}

// Refreshed on demand so new files in the folder appear automatically
function getAvatarFiles() {
    const files = listAvatarFiles();
    return files.length
        ? files
        : ["avatar-01.png"];
}

function pickRandomAvatar(lobby) {
    const AVATAR_FILES = getAvatarFiles();
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

// Public API so the client can list avatars dynamically
app.get("/api/avatars", (req, res) => {
    res.json({ avatars: getAvatarFiles() });
});

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

const REGION_MAX_IDS = {
    Kanto: 151,
    Johto: 251,
    Hoenn: 386,
    Sinnoh: 493,
    Unova: 649,
    Kalos: 721,
    Alola: 809,
    Galar: 905,
    Paldea: 1025
};

const REGION_OPTIONS = Object.keys(REGION_MAX_IDS);

function getEligiblePokemon(regionMaxId) {
    const maxId = Number(regionMaxId) || REGION_MAX_IDS.Paldea;
    return pokemonList.filter(
        p => p && Number(p.id) <= maxId
    );
}

function buildAuctionPool(playerCount, regionMaxId) {
    const eligible = getEligiblePokemon(regionMaxId);

    if (!eligible.length) {
        return [];
    }

    // Enough for full teams + skips from the region-limited set
    const needed = Math.min(
        eligible.length,
        Math.max(
            (Number(playerCount) || 2) * 12,
            48
        )
    );

    const shuffled = shufflePokemon([...eligible]);
    const selected = shuffled.slice(0, needed);

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

function getPokemonRegion(id) {
    const n = Number(id) || 0;
    if (n >= 1 && n <= 151) return "Kanto";
    if (n >= 152 && n <= 251) return "Johto";
    if (n >= 252 && n <= 386) return "Hoenn";
    if (n >= 387 && n <= 493) return "Sinnoh";
    if (n >= 494 && n <= 649) return "Unova";
    if (n >= 650 && n <= 721) return "Kalos";
    if (n >= 722 && n <= 809) return "Alola";
    if (n >= 810 && n <= 905) return "Galar";
    if (n >= 906) return "Paldea";
    return "Unknown";
}

function generateClues(data) {
    // Colour, type(s), region + one physical-trait clue.
    const clues = [];

    if (data.color) {
        const colorName =
            data.color.charAt(0).toUpperCase() +
            data.color.slice(1);
        clues.push(
            `This Pokémon is mainly ${colorName} in colour.`
        );
    }

    const typeList = Array.isArray(data.types)
        ? data.types.filter(Boolean)
        : data.type
          ? [data.type]
          : [];

    if (typeList.length === 1) {
        const t =
            typeList[0].charAt(0).toUpperCase() +
            typeList[0].slice(1);
        clues.push(`It is a ${t}-type Pokémon.`);
    } else if (typeList.length > 1) {
        const formatted = typeList
            .map(
                t =>
                    t.charAt(0).toUpperCase() +
                    t.slice(1)
            )
            .join(" / ");
        clues.push(
            `It is a ${formatted}-type Pokémon.`
        );
    }

    const region =
        data.region || getPokemonRegion(data.id);
    if (region && region !== "Unknown") {
        clues.push(
            `It originates from the ${region} region.`
        );
    }

    // Physical trait clue (shape + description keywords) — no names/stats
    const traitClues = [];
    const shape = (data.shape || "").toLowerCase();
    const desc = (data.description || "").toLowerCase();

    const shapeTraits = {
        wings: "It has prominent wings.",
        two_wings: "It has prominent wings.",
        bug_wings: "It has insect-like wings.",
        armor: "Its body looks armored or shelled.",
        quadruped: "It walks on four legs.",
        humanoid: "Its body shape is somewhat humanoid.",
        serpentine: "Its body is long and snake-like.",
        fish: "Its body resembles a fish.",
        ball: "Its body is roughly round.",
        blob: "Its body has a soft, rounded look.",
        legless: "It has no visible legs.",
        upright: "It stands in an upright posture.",
        arms: "It has noticeable arms.",
        legs: "It has distinct legs.",
        heads: "Its head is a notable feature.",
        tentacles: "It has tentacle-like features.",
        squiggle: "Its body has an unusual, winding shape."
    };

    if (shape && shapeTraits[shape]) {
        traitClues.push(shapeTraits[shape]);
    }

    if (
        desc.includes("claw") ||
        desc.includes("pincer")
    ) {
        traitClues.push(
            "It has sharp claws or pincers."
        );
    }
    if (
        desc.includes("horn") ||
        desc.includes("antler")
    ) {
        traitClues.push(
            "It has a noticeable horn or antler."
        );
    }
    if (
        desc.includes("fang") ||
        desc.includes("teeth") ||
        desc.includes("tooth")
    ) {
        traitClues.push(
            "It is known for sharp teeth or fangs."
        );
    }
    if (desc.includes("tail")) {
        traitClues.push(
            "Its tail is an important feature."
        );
    }
    if (
        desc.includes("wing") ||
        desc.includes("wings")
    ) {
        traitClues.push(
            "It has wings suited for the air."
        );
    }
    if (
        desc.includes("shell") ||
        desc.includes("armor") ||
        desc.includes("armour") ||
        desc.includes("hard")
    ) {
        traitClues.push(
            "Parts of its body appear hard or shell-like."
        );
    }
    if (
        desc.includes("fur") ||
        desc.includes("wool") ||
        desc.includes("mane")
    ) {
        traitClues.push(
            "It has fur, wool, or a mane."
        );
    }
    if (
        desc.includes("fin") ||
        desc.includes("scale")
    ) {
        traitClues.push(
            "It has fins or scales."
        );
    }

    // One unique physical trait max so it stays a clue, not a giveaway
    const uniqueTraits = [...new Set(traitClues)];
    if (uniqueTraits.length > 0) {
        const pick =
            uniqueTraits[
                crypto.randomInt(uniqueTraits.length)
            ];
        clues.push(pick);
    }

    return clues;
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

    // Try cache first for fast restarts
    const fs = require("fs");
    const cachePath = path.join(__dirname, "pokemon-cache.json");
    try {
        if (fs.existsSync(cachePath)) {
            const cached = JSON.parse(
                fs.readFileSync(cachePath, "utf8")
            );
            if (Array.isArray(cached) && cached.length > 200) {
                pokemonList = cached;
                pokemonDataReady = true;
                console.log(
                    `Loaded ${pokemonList.length} Pokémon from cache.`
                );
                console.log("Pokémon data is ready.");
                console.log("--------------------------------");
                return;
            }
        }
    } catch (e) {
        console.log("Cache read failed, fetching from API...");
    }

    const loadedPokemon = [];

    // Discover total species count from PokeAPI
    let TOTAL_POKEMON = 1025;
    try {
        const meta = await fetchWithRetry(
            "https://pokeapi.co/api/v2/pokemon-species?limit=1"
        );
        if (meta && meta.count) {
            TOTAL_POKEMON = Number(meta.count) || 1025;
        }
    } catch (e) {
        console.log(
            "Could not read species count, defaulting to",
            TOTAL_POKEMON
        );
    }

    console.log(
        `Total species to load: ${TOTAL_POKEMON}`
    );

    const BATCH_SIZE = 15;

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

                            types:
                                Array.isArray(pokemon.types)
                                    ? pokemon.types
                                          .map(t =>
                                              t &&
                                              t.type &&
                                              t.type.name
                                                  ? t.type.name
                                                  : null
                                          )
                                          .filter(Boolean)
                                    : [],

                            region:
                                getPokemonRegion(pokemon.id),

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

    // Persist cache for faster restarts
    try {
        const fs = require("fs");
        const cachePath = path.join(
            __dirname,
            "pokemon-cache.json"
        );
        fs.writeFileSync(
            cachePath,
            JSON.stringify(pokemonList)
        );
        console.log(
            "Pokémon cache written:",
            cachePath
        );
    } catch (e) {
        console.log(
            "Could not write Pokémon cache:",
            e.message
        );
    }

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

            regionMaxId:
                lobby.regionMaxId || 251,

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

    // Pool exhausted but not everyone has a full team —
    // reshuffle a fresh pool and continue (never end early).
    const stillNeed = lobby.players.some(
        p => p.pokemon.length < TEAM_SIZE
    );

    if (stillNeed) {
        lobby.poolReshuffles =
            (lobby.poolReshuffles || 0) + 1;

        console.log(
            "Pokémon pool exhausted — reshuffling for lobby",
            code,
            "(pass",
            lobby.poolReshuffles + ")"
        );

        let pool = buildAuctionPool(
            lobby.players.length || lobby.maxPlayers,
            lobby.regionMaxId
        );

        // After a few full cycles, force cheaper base prices
        // so remaining trainers can still complete their teams
        if (lobby.poolReshuffles >= 2 && pool.length) {
            pool = pool.map(p => ({
                ...p,
                basePrice: Math.min(
                    p.basePrice || 20,
                    MINIMUM_POKEMON_COST
                )
            }));
        }

        lobby.auctionPokemon = pool;
        lobby.auctionIndex = 0;

        if (
            !lobby.auctionPokemon ||
            lobby.auctionPokemon.length === 0
        ) {
            console.log(
                "No eligible Pokémon available — cannot continue auction",
                code
            );
            finishAuction(code);
            return;
        }

        // Safety: avoid infinite tight loops if somehow nobody can bid
        if (lobby.poolReshuffles > 20) {
            console.log(
                "Too many reshuffles — ending auction for lobby",
                code
            );
            finishAuction(code);
            return;
        }

        startNextPokemon(code);
        return;
    }

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

                        winnerAvatar:
                            winner.avatar ||
                            null,

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
                lobby.players.length || lobby.maxPlayers,
                lobby.regionMaxId
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

            const requestedAvatar =
                typeof data.avatar === "string"
                    ? data.avatar.trim()
                    : "";

            const avatar =
                getAvatarFiles().includes(requestedAvatar)
                    ? requestedAvatar
                    : pickRandomAvatar(null);

            const code =
                generateLobbyCode();

            // ==================================================
            // EACH LOBBY GETS ITS OWN RANDOM POKEMON ORDER
            // ==================================================

            const regionMaxId =
                REGION_MAX_IDS.Johto; // default through Johto

            const randomizedPokemon =
                buildAuctionPool(
                    maxPlayers,
                    regionMaxId
                );

            const lobby = {
                code:
                    code,

                maxPlayers:
                    maxPlayers,

                regionMaxId:
                    regionMaxId,

                hostPlayerId:
                    playerId,

                players: [
                    {
                        playerId:
                            playerId,

                        name:
                            name,

                        avatar:
                            avatar,

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

            // Block only during an ACTIVE auction.
            // After auction finishes (waiting for return), allow rejoin / new join.
            if (
                lobby.started &&
                !lobby.auctionFinished
            ) {
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

            const requestedAvatar =
                typeof data.avatar === "string"
                    ? data.avatar.trim()
                    : "";

            if (existing) {

                existing.socketId =
                    socket.id;

                if (name) {
                    existing.name =
                        name;
                }

                if (
                    requestedAvatar &&
                    getAvatarFiles().includes(requestedAvatar)
                ) {
                    existing.avatar =
                        requestedAvatar;
                } else if (!existing.avatar) {
                    existing.avatar =
                        pickRandomAvatar(lobby);
                }

                // If post-auction wait, mark them as returned
                if (lobby.auctionFinished) {
                    existing.returnedToLobby = true;
                    existing.money = STARTING_MONEY;
                    existing.pokemon = [];
                }

            } else {

                // New player joining post-auction or pre-start
                if (
                    lobby.started &&
                    !lobby.auctionFinished
                ) {
                    socket.emit(
                        "lobbyError",
                        "Auction already started."
                    );
                    return;
                }

                const avatar =
                    getAvatarFiles().includes(requestedAvatar)
                        ? requestedAvatar
                        : pickRandomAvatar(lobby);

                const newPlayer = {
                    playerId:
                        playerId,

                    name:
                        name,

                    avatar:
                        avatar,

                    socketId:
                        socket.id,

                    money:
                        STARTING_MONEY,

                    pokemon:
                        [],

                    returnedToLobby:
                        !!lobby.auctionFinished
                };

                lobby.players.push(newPlayer);
            }

            // If post-auction and everyone is now back, unlock lobby
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
                    lobby.auctionPokemon =
                        buildAuctionPool(
                            lobby.players.length ||
                                lobby.maxPlayers,
                            lobby.regionMaxId
                        );

                    lobby.players.forEach(p => {
                        p.returnedToLobby = false;
                        p.money = STARTING_MONEY;
                        p.pokemon = [];
                    });

                    console.log(
                        "All players ready after rejoin — lobby unlocked:",
                        code
                    );
                }
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
    // CHANGE REGION LIMIT (host only)
    // ==================================================

    socket.on(
        "changeRegion",
        data => {
            if (!data) return;

            const code =
                String(data.lobbyCode || "")
                    .trim()
                    .toUpperCase();

            const playerId = data.playerId;
            const regionName =
                String(data.region || "").trim();

            const lobby = lobbies.get(code);
            if (!lobby) return;

            if (lobby.hostPlayerId !== playerId) {
                return;
            }

            // Allow before game OR while waiting after auction
            if (lobby.started && !lobby.auctionFinished) {
                return;
            }

            if (!REGION_MAX_IDS[regionName]) {
                socket.emit(
                    "lobbyError",
                    "Invalid region selection."
                );
                return;
            }

            lobby.regionMaxId =
                REGION_MAX_IDS[regionName];

            // Rebuild pool for the new region limit
            lobby.auctionPokemon = buildAuctionPool(
                lobby.players.length || lobby.maxPlayers,
                lobby.regionMaxId
            );

            console.log(
                "Region limit changed:",
                code,
                "->",
                regionName,
                "(max id",
                lobby.regionMaxId + ")"
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
                    lobby.players.length || lobby.maxPlayers,
                    lobby.regionMaxId
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
                        lobby.players.length || lobby.maxPlayers,
                        lobby.regionMaxId
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
            lobby.poolReshuffles = 0;
            lobby.auction = null;
            lobby.auctionPokemon =
                buildAuctionPool(
                    lobby.players.length ||
                    lobby.maxPlayers,
                    lobby.regionMaxId
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