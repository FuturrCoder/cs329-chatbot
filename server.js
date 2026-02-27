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

function getSystemInstructionText(taskId) {
    let flowchartPath;
    let extraInstructions = "";

    const now = new Date();
    const centralTime = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        dateStyle: 'full',
        timeStyle: 'long'
    }).format(now);

    const timeContext = `The current date and time is ${centralTime}. All times should be in Central Time.`;

    if (taskId === 2) {
        flowchartPath = path.join(__dirname, 'task2.mmd');
        extraInstructions = "Crucially: The system needs to log the collected information in the terminal. When you collect new information (whether they have taken their medication, and the reminder time if they want one), you MUST use the log_task2_data tool. Make sure to log the reminder time strictly in Central Time (e.g., '3:00 PM CT').";
    } else if (taskId === 3) {
        flowchartPath = path.join(__dirname, 'task3.mmd');

        const preSetupState = `
You are already set up for this user. The user's current profile is:
- Caretaker Info: John Doe, 123-456-7890
- Medication 1: A cholesterol pill once every two weeks at 6pm, starting tomorrow. Additional details: 10mg.
- Medication 2: A Metoprolol pill once every day at 8am, starting tomorrow. Additional details: take before breakfast.

Start the conversation acknowledging they are already set up and ask what they would like to do, according to the flowchart.
`;
        extraInstructions = `${preSetupState}\nCrucially: You are interacting with the user to collect data. The flowchart has grey boxes indicating data that you must extract. Whenever you hit a step in the conversation corresponding to one of these fields (ACTION, MEDICATION_NAME, FREQUENCY, TIME, START_DATE, METHOD, DETAILS, PHONE_NUMBER, CARETAKER_INFO), you MUST use the \`log_medication_data\` tool and log the fields you have collected so far. Do not wait until the very end, log them as you confirm them. Make sure to map the fields you've extracted into the tool properties.`;
    } else {
        flowchartPath = path.join(__dirname, 'task1.mmd');
        extraInstructions = "Crucially: The system needs to log the collected information in the terminal. When you collect new information (NAME, MEDICATION_NAME, FREQUENCY, TIME, START_DATE, METHOD, DETAILS, PHONE_NUMBER, CARETAKER_INFO), you MUST use the log_medication_data tool.";
    }

    const flowchart = fs.readFileSync(flowchartPath, 'utf8');

    return `
You are Cheesecake, a medication reminder assistant.
${timeContext}

You must strictly follow the flow described in this mermaid flowchart:

${flowchart}

INSTRUCTIONS:
You are interacting with the user via voice. Keep your responses conversational and follow the flowchart exactly.
${extraInstructions}
If you don't hear a response or it doesn't make sense, repeat the question. Ask them to spell things out if you don't know the spelling.
`;
}

const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;

wss.on('connection', (ws, req) => {
    console.log('Frontend connected.');

    // Parse the task ID from the URL string
    const urlParams = new URLSearchParams(req.url.replace('/?', ''));
    const taskIdString = urlParams.get('task');
    const taskId = taskIdString ? parseInt(taskIdString, 10) : 1;
    console.log(`Task ID Selected: ${taskId}`);

    // Connect to Gemini Live API
    if (!process.env.GEMINI_API_KEY) {
        console.error('Missing GEMINI_API_KEY');
        ws.close();
        return;
    }

    const geminiWs = new WebSocket(GEMINI_WS_URL);

    geminiWs.on('open', () => {
        console.log('Connected to Gemini Live API.');

        // Set up tools based on task ID
        let tools = [];
        if (taskId === 2) {
            tools = [{
                functionDeclarations: [{
                    name: "log_task2_data",
                    description: "Logs the user's daily check-in responses. Call this when you find out if they've taken their medication, and when they specify a reminder time.",
                    parameters: {
                        type: "OBJECT",
                        properties: {
                            status: { type: "STRING", description: "Whether the user took their medication. Values: 'TAKEN' or 'NOT_TAKEN'" },
                            reminder_time: { type: "STRING", description: "The time the user wants to be reminded later, if applicable" }
                        }
                    }
                }]
            }];
        } else {
            tools = [{
                functionDeclarations: [{
                    name: "log_medication_data",
                    description: "Logs collected medication and user information to the system. Call this whenever you gather new data like the user's name, medication name, frequency, time, or caretaker info.",
                    parameters: {
                        type: "OBJECT",
                        properties: {
                            action_taken: { type: "STRING", description: "The action the user is taking right now, if applicable. Must be one of: ADD_MEDICATION, CHANGE_MEDICATION, REMOVE_MEDICATION, ADD_CARETAKER, EDIT_CARETAKER, REMOVE_CARETAKER" },
                            name: { type: "STRING", description: "The name of the user" },
                            medication_name: { type: "STRING", description: "The name of the medication" },
                            frequency: { type: "STRING", description: "How often the medication is taken" },
                            time: { type: "STRING", description: "The time the medication is taken" },
                            start_date: { type: "STRING", description: "When the reminders start" },
                            method: { type: "STRING", description: "Message or Call reminder method" },
                            details: { type: "STRING", description: "Additional instructions or dosage" },
                            phone_number: { type: "STRING", description: "The caller's phone number" },
                            caretaker_info: { type: "STRING", description: "Contact info for the caretaker" }
                        }
                    }
                }]
            }];
        }

        // Send initial setup message
        const setupMessage = {
            setup: {
                model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
                generationConfig: {
                    responseModalities: ["AUDIO"]
                },
                systemInstruction: {
                    parts: [{ text: getSystemInstructionText(taskId) }]
                },
                tools: tools
            }
        };
        geminiWs.send(JSON.stringify(setupMessage));
    });

    geminiWs.on('message', (data) => {
        const response = JSON.parse(data.toString());

        if (response.setupComplete) {
            console.log('Setup complete. Sending initial trigger to Gemini.');

            let triggerText = "Hello";
            if (taskId === 3) {
                triggerText = "Start the conversation by saying exactly this verbatim: 'Welcome. Press 1 for medication settings, or press 2 for caretaker settings.'";
            }

            const initialGreeting = {
                clientContent: {
                    turns: [{
                        role: "user",
                        parts: [{ text: triggerText }]
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
                if (call.name === "log_medication_data" || call.name === "log_task2_data") {
                    console.log(`\n\x1b[32m=== COLLECTED INFORMATION (via Tool Call: ${call.name}) ===\x1b[0m`);
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
