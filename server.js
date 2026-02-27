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
You are interacting with the user via voice. The user can only speak mandarin. Keep your responses conversational and follow the flowchart exactly.
Crucially: The system needs to log the collected information in the terminal. When you collect new information (NAME, MEDICATION_NAME, FREQUENCY, TIME, START_DATE, METHOD, DETAILS, PHONE_NUMBER, CAREGIVER_INFO), you MUST use the log_medication_data tool.
If you don't hear a response or it doesn't make sense, repeat the question. Ask them to spell things out if you don't know the spelling.
`;

const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;

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
                },
                tools: [{
                    functionDeclarations: [{
                        name: "log_medication_data",
                        description: "Logs collected medication and user information to the system. Call this whenever you gather new data like the user's name, medication name, frequency, time, or caregiver info.",
                        parameters: {
                            type: "OBJECT",
                            properties: {
                                name: { type: "STRING", description: "The name of the user" },
                                medication_name: { type: "STRING", description: "The name of the medication" },
                                frequency: { type: "STRING", description: "How often the medication is taken" },
                                time: { type: "STRING", description: "The time the medication is taken" },
                                caregiver_info: { type: "STRING", description: "Contact info for the caregiver" }
                            }
                        }
                    }]
                }]
            }
        };
        geminiWs.send(JSON.stringify(setupMessage));
    });

    geminiWs.on('message', (data) => {
        const response = JSON.parse(data.toString());

        if (response.setupComplete) {
            console.log('Setup complete. Sending initial trigger to Gemini.');
            const initialGreeting = {
                clientContent: {
                    turns: [{
                        role: "user",
                        parts: [{ text: "Hello" }]
                    }],
                    turnComplete: true
                }
            };
            geminiWs.send(JSON.stringify(initialGreeting));
        }

        if (response.toolCall) {
            const functionCalls = response.toolCall.functionCalls;
            const toolResponses = [];

            for (const call of functionCalls) {
                if (call.name === "log_medication_data") {
                    console.log(`\n\x1b[32m=== COLLECTED INFORMATION (via Tool Call) ===\x1b[0m`);
                    let logStr = "";
                    for (const [key, value] of Object.entries(call.args)) {
                        console.log(`\x1b[32m${key.toUpperCase()}: ${value}\x1b[0m`);
                        logStr += `${key.toUpperCase()}: ${value}\n`;
                    }
                    console.log(`\x1b[32m==============================================\x1b[0m\n`);

                    ws.send(JSON.stringify({ type: 'log', data: logStr.trim() }));

                    toolResponses.push({
                        id: call.id,
                        name: call.name,
                        response: { result: "success" }
                    });
                }
            }

            // Send tool response back to Gemini
            const toolResponseMessage = {
                toolResponse: {
                    functionResponses: toolResponses
                }
            };
            geminiWs.send(JSON.stringify(toolResponseMessage));
            return; // Don't forward this JSON to the frontend
        }

        // Forward to frontend
        ws.send(data.toString());

        // Parse text for terminal logging (e.g. debugging the model's monologue)
        if (response.serverContent && response.serverContent.modelTurn) {
            const parts = response.serverContent.modelTurn.parts;
            for (const part of parts) {
                if (part.text) {
                    process.stdout.write(part.text);
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
