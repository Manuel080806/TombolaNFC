const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const mysql = require('mysql2');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '', 
    database: 'tombola' 
};
let dbConnection;
function handleDisconnect() {
    dbConnection = mysql.createConnection(dbConfig);
    dbConnection.connect(err => {
        if (err) {
            console.error('Errore di connessione al DB:', err);
            setTimeout(handleDisconnect, 2000);
        } else {
            console.log('Connesso al database MySQL!');
            const createPartiteTable = `
                CREATE TABLE IF NOT EXISTS partite (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    data_inizio DATETIME,
                    data_fine DATETIME
                );
            `;
            const createEstrazioniTable = `
                CREATE TABLE IF NOT EXISTS estrazioni (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    partita_id INT,
                    numero INT,
                    orario DATETIME,
                    FOREIGN KEY (partita_id) REFERENCES partite(id) ON DELETE CASCADE
                );
            `;
            dbConnection.query(createPartiteTable);
            dbConnection.query(createEstrazioniTable);
        }
    });
    dbConnection.on('error', err => {
        console.error('Errore del database:', err);
        if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNREFUSED') {
            handleDisconnect();
        } else {
            throw err;
        }
    });
}
handleDisconnect();
let currentMatchId = null;
let extractedNumbers = [];
function loadLastGame() {
    const query = `
        SELECT id FROM partite 
        WHERE data_fine IS NULL
        ORDER BY id DESC
        LIMIT 1
    `;
    dbConnection.query(query, (err, results) => {
        if (err) {
            console.error('Errore nel caricamento della partita:', err);
            return;
        }
        if (results.length > 0) {
            currentMatchId = results[0].id;
            const estrazioniQuery = `
                SELECT numero FROM estrazioni
                WHERE partita_id = ?
                ORDER BY orario ASC
            `;
            dbConnection.query(estrazioniQuery, [currentMatchId], (err, estrazioniResults) => {
                if (err) {
                    console.error('Errore nel caricamento delle estrazioni:', err);
                    return;
                }
                extractedNumbers = estrazioniResults.map(row => row.numero);
                console.log(`Partita ${currentMatchId} caricata dal DB con ${extractedNumbers.length} numeri.`);
            });
        } else {
            console.log('Nessuna partita attiva trovata. Pronto per iniziarne una nuova.');
        }
    });
}
loadLastGame();
app.use(express.static('public'));
app.use(express.json());
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/nfc', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'nfc.html'));
});
app.get('/viewer', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});
const clients = new Map();
function broadcastUpdate() {
    const message = JSON.stringify({
        type: 'gameUpdate',
        data: {
            numbers: Array.from({ length: 90 }, (_, i) => ({ 
                number: i + 1, 
                called: extractedNumbers.includes(i + 1)
            })),
            calledNumbers: extractedNumbers
        }
    });
    clients.forEach((clientInfo, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(message);
        }
    });
}
wss.on('connection', (ws) => {
    console.log('Nuova connessione WebSocket');
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const clientInfo = clients.get(ws);
            switch (data.type) {
                case 'authenticate':
                    clients.set(ws, { role: data.role });
                    broadcastUpdate();
                    console.log(`Client autenticato come: ${data.role}`);
                    break;
                case 'callNumber':
                    if (clientInfo && clientInfo.role === 'admin') {
                        const num = parseInt(data.number);
                        if (num >= 1 && num <= 90 && !extractedNumbers.includes(num)) {
                            if (!currentMatchId) {
                                dbConnection.query('INSERT INTO partite (data_inizio) VALUES (NOW())', (err, result) => {
                                    if (err) {
                                        console.error('Errore nella creazione di una nuova partita:', err);
                                        return;
                                    }
                                    currentMatchId = result.insertId;
                                    console.log(`Nuova partita iniziata con ID: ${currentMatchId}`);
                                    saveExtraction(currentMatchId, num);
                                });
                            } else {
                                saveExtraction(currentMatchId, num);
                            }
                        }
                    }
                    break;
                case 'resetGame':
                    if (clientInfo && clientInfo.role === 'admin') {
                        if (currentMatchId) {
                            dbConnection.query('UPDATE partite SET data_fine = NOW() WHERE id = ?', [currentMatchId]);
                        }
                        
                        extractedNumbers = [];
                        currentMatchId = null;
                        console.log('Gioco resettato');
                        broadcastUpdate();
                    }
                    break;
            }
        } catch (error) {
            console.error('Errore parsing messaggio:', error);
        }
    })
    ws.on('close', () => {
        clients.delete(ws);
        console.log('Connessione WebSocket chiusa');
    });
});
function saveExtraction(partitaId, numero) {
    extractedNumbers.push(numero);
    const query = 'INSERT INTO estrazioni (partita_id, numero, orario) VALUES (?, ?, NOW())';
    dbConnection.query(query, [partitaId, numero], err => {
        if (err) console.error('Errore nel salvataggio del numero estratto:', err);
        broadcastUpdate();
        console.log(`Numero chiamato: ${numero}`);
    });
}
const HOST = "localhost";
const PORT = process.env.PORT || 3000;
server.listen(PORT,HOST, () => {
    console.log(`Server in esecuzione su porta ${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin`);
    console.log(`Viewer: http://localhost:${PORT}/viewer`);
});