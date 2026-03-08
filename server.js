const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname)); // serve all HTML files

// In‑memory store for rooms (each room identified by room name)
const rooms = {};

// Global scoreboard per room (we'll store inside room)

function createRoom() {
    return {
        players: {
            rizwan: { connected: false, socketId: null },
            anha: { connected: false, socketId: null }
        },
        chatMessages: [],
        scoreboard: { rizwan: 0, anha: 0 },
        currentGame: null, // { name, state }
        gameTimers: {}     // for intervals per game
    };
}

// ---------- Game Logic ----------

// Tic Tac Toe
function createTicTacToe() {
    return {
        board: Array(9).fill(null),
        turn: 'X', // X = Anha, O = Rizwan
        winner: null,
        winningLine: null
    };
}
function handleTicTacToeMove(roomState, player, index) {
    const game = roomState.currentGame.state;
    if (game.winner) return false;
    const symbol = player === 'anha' ? 'X' : 'O';
    if (game.turn !== symbol) return false;
    if (index < 0 || index > 8 || game.board[index] !== null) return false;

    game.board[index] = symbol;
    const winLines = [
        [0,1,2],[3,4,5],[6,7,8],
        [0,3,6],[1,4,7],[2,5,8],
        [0,4,8],[2,4,6]
    ];
    for (let line of winLines) {
        const [a,b,c] = line;
        if (game.board[a] && game.board[a] === game.board[b] && game.board[a] === game.board[c]) {
            game.winner = symbol;
            game.winningLine = line;
            roomState.scoreboard[player] += 1;
            break;
        }
    }
    if (!game.winner && !game.board.includes(null)) {
        game.winner = 'draw';
    }
    game.turn = game.turn === 'X' ? 'O' : 'X';
    return true;
}

// Connect Four
function createConnect4() {
    return {
        board: Array(6).fill().map(() => Array(7).fill(null)),
        turn: 'anha',
        winner: null
    };
}
function handleConnect4Move(roomState, player, col) {
    const game = roomState.currentGame.state;
    if (game.winner) return false;
    if (player !== game.turn) return false;
    if (col < 0 || col > 6) return false;

    let row = -1;
    for (let r = 5; r >= 0; r--) {
        if (game.board[r][col] === null) {
            row = r;
            break;
        }
    }
    if (row === -1) return false;

    const disc = player === 'anha' ? 'green' : 'blue';
    game.board[row][col] = disc;

    // Check win (4 in a row)
    const directions = [[1,0],[0,1],[1,1],[1,-1]];
    for (let [dr, dc] of directions) {
        let count = 1;
        for (let step = 1; step < 4; step++) {
            const nr = row + dr * step, nc = col + dc * step;
            if (nr < 0 || nr >= 6 || nc < 0 || nc >= 7 || game.board[nr][nc] !== disc) break;
            count++;
        }
        for (let step = 1; step < 4; step++) {
            const nr = row - dr * step, nc = col - dc * step;
            if (nr < 0 || nr >= 6 || nc < 0 || nc >= 7 || game.board[nr][nc] !== disc) break;
            count++;
        }
        if (count >= 4) {
            game.winner = player;
            roomState.scoreboard[player] += 1;
            break;
        }
    }

    if (!game.winner && game.board.every(row => row.every(cell => cell !== null))) {
        game.winner = 'draw';
    }
    game.turn = game.turn === 'anha' ? 'rizwan' : 'anha';
    return true;
}

// Battleship (5x5, ships: 3-length and 2-length)
function createBattleship() {
    return {
        phase: 'placement', // 'placement' or 'battle'
        boards: {
            rizwan: { ships: [], hits: Array(5).fill().map(() => Array(5).fill(null)) },
            anha: { ships: [], hits: Array(5).fill().map(() => Array(5).fill(null)) }
        },
        placed: { rizwan: false, anha: false },
        turn: 'anha',
        winner: null
    };
}
function handleBattleshipAction(roomState, player, action) {
    const game = roomState.currentGame.state;
    if (game.winner) return false;
    if (game.phase === 'placement') {
        if (action.type === 'place') {
            if (game.placed[player]) return false;
            // Validate ship placements (basic: no overlap, within bounds)
            const ships = action.ships; // array of { positions: [{r,c}] }
            // Simple validation: all positions distinct and within 0-4
            const positions = new Set();
            for (let ship of ships) {
                for (let pos of ship.positions) {
                    const key = `${pos.r},${pos.c}`;
                    if (pos.r < 0 || pos.r > 4 || pos.c < 0 || pos.c > 4) return false;
                    if (positions.has(key)) return false;
                    positions.add(key);
                }
            }
            game.boards[player].ships = ships.map(ship => ({ ...ship, hits: 0 }));
            game.placed[player] = true;
            if (game.placed.rizwan && game.placed.anha) {
                game.phase = 'battle';
            }
            return true;
        }
    } else if (game.phase === 'battle') {
        if (player !== game.turn) return false;
        if (action.type === 'attack') {
            const { r, c } = action;
            if (r < 0 || r > 4 || c < 0 || c > 4) return false;
            const opponent = player === 'rizwan' ? 'anha' : 'rizwan';
            const board = game.boards[opponent];
            if (board.hits[r][c] !== null) return false; // already attacked

            let hit = false;
            for (let ship of board.ships) {
                for (let pos of ship.positions) {
                    if (pos.r === r && pos.c === c) {
                        hit = true;
                        ship.hits++;
                        break;
                    }
                }
            }
            board.hits[r][c] = hit ? 'hit' : 'miss';

            // Check if all ships sunk
            const allSunk = board.ships.every(ship => ship.hits === ship.positions.length);
            if (allSunk) {
                game.winner = player;
                roomState.scoreboard[player] += 1;
            }
            game.turn = opponent;
            return true;
        }
    }
    return false;
}

// Pong (server‑authoritative)
function createPong() {
    return {
        ball: { x: 400, y: 200, dx: 3, dy: 2 },
        paddles: { rizwan: 150, anha: 150 },
        scores: { rizwan: 0, anha: 0 },
        width: 800,
        height: 400,
        paddleHeight: 80,
        running: true,
        lastUpdate: Date.now()
    };
}
function updatePong(game, deltaTime) {
    if (!game.running) return;
    // Move ball
    game.ball.x += game.ball.dx * (deltaTime / 16); // normalize to ~60fps
    game.ball.y += game.ball.dy * (deltaTime / 16);

    // Wall collisions
    if (game.ball.y <= 0 || game.ball.y >= game.height) {
        game.ball.dy *= -1;
        game.ball.y = Math.max(0, Math.min(game.height, game.ball.y));
    }

    // Paddle collisions (simplified)
    const paddleWidth = 10;
    if (game.ball.x <= 20 && game.ball.x >= 10) {
        if (game.ball.y >= game.paddles.rizwan && game.ball.y <= game.paddles.rizwan + game.paddleHeight) {
            game.ball.dx = Math.abs(game.ball.dx);
            game.ball.x = 21; // push out
        }
    }
    if (game.ball.x >= game.width - 20 && game.ball.x <= game.width - 10) {
        if (game.ball.y >= game.paddles.anha && game.ball.y <= game.paddles.anha + game.paddleHeight) {
            game.ball.dx = -Math.abs(game.ball.dx);
            game.ball.x = game.width - 21;
        }
    }

    // Score
    if (game.ball.x < 0) {
        game.scores.anha += 1;
        game.ball = { x: 400, y: 200, dx: 3, dy: 2 };
    }
    if (game.ball.x > game.width) {
        game.scores.rizwan += 1;
        game.ball = { x: 400, y: 200, dx: -3, dy: 2 };
    }
}
function handlePongAction(game, player, action) {
    if (action.type === 'movePaddle') {
        let y = action.y;
        y = Math.max(0, Math.min(game.height - game.paddleHeight, y));
        game.paddles[player] = y;
        return true;
    }
    return false;
}

// Memory Match
function createMemory() {
    const symbols = ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼'];
    let deck = [...symbols, ...symbols];
    deck = deck.sort(() => Math.random() - 0.5);
    const cards = deck.map((symbol, idx) => ({ id: idx, symbol, flipped: false, matched: false }));
    return {
        cards,
        turn: 'anha',
        firstPick: null,
        secondPick: null,
        scores: { rizwan: 0, anha: 0 },
        gameOver: false
    };
}
function handleMemoryAction(roomState, player, action) {
    const game = roomState.currentGame.state;
    if (game.gameOver) return false;
    if (player !== game.turn) return false;
    if (action.type === 'flip') {
        const idx = action.index;
        if (idx < 0 || idx >= 16) return false;
        if (game.cards[idx].matched || game.cards[idx].flipped) return false;

        if (game.firstPick === null) {
            game.firstPick = idx;
            game.cards[idx].flipped = true;
        } else if (game.secondPick === null && idx !== game.firstPick) {
            game.secondPick = idx;
            game.cards[idx].flipped = true;

            const card1 = game.cards[game.firstPick];
            const card2 = game.cards[game.secondPick];
            if (card1.symbol === card2.symbol) {
                // match
                card1.matched = true;
                card2.matched = true;
                game.scores[player] += 1;
                if (game.scores.rizwan + game.scores.anha === 8) {
                    game.gameOver = true;
                    // award point to winner
                    if (game.scores.rizwan > game.scores.anha) {
                        roomState.scoreboard.rizwan += 1;
                    } else if (game.scores.anha > game.scores.rizwan) {
                        roomState.scoreboard.anha += 1;
                    }
                }
                game.firstPick = null;
                game.secondPick = null;
                // turn remains same (extra turn)
            } else {
                // will reset after timeout on client
            }
        }
        return true;
    }
    if (action.type === 'resetPicks') {
        if (game.firstPick !== null && game.secondPick !== null) {
            game.cards[game.firstPick].flipped = false;
            game.cards[game.secondPick].flipped = false;
            game.firstPick = null;
            game.secondPick = null;
            game.turn = game.turn === 'anha' ? 'rizwan' : 'anha';
        }
        return true;
    }
    return false;
}

// ---------- Socket.io ----------
io.on('connection', (socket) => {
    let currentRoom = null;
    let currentPlayer = null;

    socket.on('join', ({ room, player }) => {
        if (player !== 'rizwan' && player !== 'anha') {
            socket.emit('private', 'This arcade is private.');
            return;
        }
        if (!rooms[room]) rooms[room] = createRoom();
        const roomState = rooms[room];

        // If already connected with another socket, we'll just update
        if (roomState.players[player].connected) {
            // optionally disconnect old socket? we'll just replace
        }
        roomState.players[player].connected = true;
        roomState.players[player].socketId = socket.id;
        currentRoom = room;
        currentPlayer = player;
        socket.join(room);

        // Send init data
        socket.emit('init', {
            chat: roomState.chatMessages,
            scoreboard: roomState.scoreboard,
            presence: {
                rizwan: roomState.players.rizwan.connected,
                anha: roomState.players.anha.connected
            },
            currentGame: roomState.currentGame
        });

        // Notify others
        io.to(room).emit('presence', {
            rizwan: roomState.players.rizwan.connected,
            anha: roomState.players.anha.connected
        });

        // System message
        const msg = {
            sender: '🎮 Arcade',
            text: `${player} joined.`,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        roomState.chatMessages.push(msg);
        io.to(room).emit('chatMessage', msg);
    });

    socket.on('chatMessage', (text) => {
        if (!currentRoom || !currentPlayer) return;
        const roomState = rooms[currentRoom];
        const msg = {
            sender: currentPlayer,
            text: text.substring(0, 200),
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        roomState.chatMessages.push(msg);
        io.to(currentRoom).emit('chatMessage', msg);
    });

    socket.on('startGame', (gameName) => {
        if (!currentRoom || !currentPlayer) return;
        const roomState = rooms[currentRoom];
        // Only start if both players connected? We'll allow anyway.
        let gameState;
        switch (gameName) {
            case 'tictactoe': gameState = createTicTacToe(); break;
            case 'connect4': gameState = createConnect4(); break;
            case 'battleship': gameState = createBattleship(); break;
            case 'pong': gameState = createPong(); break;
            case 'memory': gameState = createMemory(); break;
            default: return;
        }
        roomState.currentGame = { name: gameName, state: gameState };
        // Clear any previous game timer
        if (roomState.gameTimers[gameName]) clearInterval(roomState.gameTimers[gameName]);
        // For Pong, start server update loop
        if (gameName === 'pong') {
            roomState.gameTimers.pong = setInterval(() => {
                if (!roomState.currentGame || roomState.currentGame.name !== 'pong') {
                    clearInterval(roomState.gameTimers.pong);
                    return;
                }
                const now = Date.now();
                const delta = now - (roomState.currentGame.state.lastUpdate || now);
                roomState.currentGame.state.lastUpdate = now;
                updatePong(roomState.currentGame.state, delta);
                io.to(currentRoom).emit('gameUpdate', roomState.currentGame.state);
            }, 16); // ~60fps
        }
        io.to(currentRoom).emit('gameStarted', roomState.currentGame);
    });

    socket.on('gameMove', (move) => {
        if (!currentRoom || !currentPlayer) return;
        const roomState = rooms[currentRoom];
        if (!roomState.currentGame) return;
        const game = roomState.currentGame;
        let valid = false;
        switch (game.name) {
            case 'tictactoe':
                valid = handleTicTacToeMove(roomState, currentPlayer, move.index);
                break;
            case 'connect4':
                valid = handleConnect4Move(roomState, currentPlayer, move.column);
                break;
            case 'battleship':
                valid = handleBattleshipAction(roomState, currentPlayer, move);
                break;
            case 'pong':
                valid = handlePongAction(game.state, currentPlayer, move);
                break;
            case 'memory':
                valid = handleMemoryAction(roomState, currentPlayer, move);
                break;
        }
        if (valid) {
            io.to(currentRoom).emit('gameUpdate', game.state);
            // Also broadcast scoreboard if changed
            io.to(currentRoom).emit('scoreboard', roomState.scoreboard);
        }
    });

    socket.on('leaveGame', () => {
        if (!currentRoom) return;
        const roomState = rooms[currentRoom];
        if (roomState.currentGame) {
            // Stop pong loop if any
            if (roomState.currentGame.name === 'pong' && roomState.gameTimers.pong) {
                clearInterval(roomState.gameTimers.pong);
                delete roomState.gameTimers.pong;
            }
            roomState.currentGame = null;
            io.to(currentRoom).emit('gameEnded');
        }
    });

    socket.on('disconnect', () => {
        if (currentRoom && currentPlayer) {
            const roomState = rooms[currentRoom];
            if (roomState) {
                roomState.players[currentPlayer].connected = false;
                roomState.players[currentPlayer].socketId = null;
                io.to(currentRoom).emit('presence', {
                    rizwan: roomState.players.rizwan.connected,
                    anha: roomState.players.anha.connected
                });
                const msg = {
                    sender: '🎮 Arcade',
                    text: `${currentPlayer} left.`,
                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                };
                roomState.chatMessages.push(msg);
                io.to(currentRoom).emit('chatMessage', msg);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
