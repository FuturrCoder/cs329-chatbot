const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Read the mermaid flowchart
const flowchartPath = path.join(__dirname, 'task1.mmd');
const flowchart = fs.readFileSync(flowchartPath, 'utf8');

const systemInstructionText = `
You are Cheesecake, a medication reminder assistant.
You must strictly follow the flow described in this mermaid flowchart:

${flowchart}

INSTRUCTIONS:
You are interacting with the user via voice. Keep your responses conversational and follow the flowchart exactly.
Crucially: The system needs to log the collected information in the terminal. In your text responses, whenever you collect new information (like NAME, MNAME, FREQUENCY, TIME, CAREGIVER INFO), please include a data block in your response like this:
[LOG_DATA: MNAME=Tylenol, FREQUENCY=daily, TIME=8am]
You will speak the response, but this logged text will be captured by the backend terminal.
If you don't hear a response or it doesn't make sense, repeat the question. Ask them to spell things out if you don't know the spelling.
`;

const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;

// Helper to log extracted data
function extractAndLogData(text) {
    const logMatch = text.match(/\[LOG_DATA:\s*(.*?)\]/);
    if (logMatch) {
        console.log(`\n\x1b[32m=== COLLECTED INFORMATION ===\x1b[0m`);
        console.log(`\x1b[32m${logMatch[1]}\x1b[0m`);
        console.log(`\x1b[32m===============================\x1b[0m\n`);
    } else {
        // Just log the text as well for debugging
        process.stdout.write(text);
    }
}

wss.on('connection', (ws) => {
    console.log('Frontend connected.');

    // Connect to Gemini Live API
    if (!process.env.GEMINI_API_KEY) {
        console.error('Missing GEMINI_API_KEY');
        ws.close();
        return;
    }

    const geminiWs = new WebSocket(GEMINI_WS_URL);

    geminiWs.on('open', () => {
        console.log('Connected to Gemini Live API.');

        // Send initial setup message
        const setupMessage = {
            setup: {
                model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
                generationConfig: {
                    responseModalities: ["AUDIO"]
                },
                systemInstruction: {
                    parts: [{ text: systemInstructionText }]
                }
            }
        };
        geminiWs.send(JSON.stringify(setupMessage));
    });

    geminiWs.on('message', (data) => {
        const response = JSON.parse(data.toString());

        // Forward to frontend
        ws.send(data.toString());

        // Parse text for terminal logging
        if (response.serverContent && response.serverContent.modelTurn) {
            const parts = response.serverContent.modelTurn.parts;
            for (const part of parts) {
                if (part.text) {
                    extractAndLogData(part.text);
                }
            }
        }
    });

    geminiWs.on('close', (code, reason) => {
        console.log(`Disconnected from Gemini Live API. Code: ${code}, Reason: ${reason}`);
        ws.close();
    });

    geminiWs.on('error', (error) => {
        console.error('Gemini API Error:', error);
    });

    ws.on('message', (message) => {
        // Just forward whatever the frontend sends (realtimeInput) directly to Gemini
        if (geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.send(message.toString());
        }
    });

    ws.on('close', () => {
        console.log('Frontend disconnected.');
        if (geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.close();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
