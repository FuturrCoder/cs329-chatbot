const startBtn = document.getElementById('startBtn');
const endBtn = document.getElementById('endBtn');
const statusText = document.getElementById('statusText');
const micIcon = document.getElementById('micIcon');
const pulseRing = document.getElementById('pulseRing');
const transcriptBox = document.getElementById('transcriptBox');

let ws = null;
let audioContext = null;
let mediaStream = null;
let processor = null;
let source = null;

// Audio playback scheduling
let nextPlayTime = 0;

// AudioContext for playback
let playContext = null;

startBtn.addEventListener('click', async () => {
    try {
        startBtn.classList.add('hidden');
        endBtn.classList.remove('hidden');
        statusText.textContent = 'Connecting...';

        ws = new WebSocket(`ws://${window.location.host}`);

        ws.onopen = async () => {
            statusText.textContent = 'Connected. Speak now!';
            micIcon.classList.add('active');
            pulseRing.classList.add('active');

            // Initialize AudioContext
            audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 16000
            });
            playContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 24000 // Gemini output is usually 24kHz
            });

            // Get microphone access
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            source = audioContext.createMediaStreamSource(mediaStream);

            // Use ScriptProcessorNode as a simple alternative for the prototype
            processor = audioContext.createScriptProcessor(4096, 1, 1);

            source.connect(processor);
            processor.connect(audioContext.destination);

            processor.onaudioprocess = (e) => {
                // Mute mic if bot is talking
                if (playContext && playContext.currentTime < nextPlayTime) {
                    return;
                }

                const inputData = e.inputBuffer.getChannelData(0);

                // Convert float32 to int16
                const pcm16 = new Int16Array(inputData.length);
                for (let i = 0; i < inputData.length; i++) {
                    const s = Math.max(-1, Math.min(1, inputData[i]));
                    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }

                // Convert to base64 safely
                const buffer = new ArrayBuffer(pcm16.length * 2);
                const view = new DataView(buffer);
                for (let i = 0; i < pcm16.length; i++) {
                    view.setInt16(i * 2, pcm16[i], true); // little-endian
                }

                let binary = '';
                const bytes = new Uint8Array(buffer);
                for (let i = 0; i < bytes.byteLength; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }
                const base64Data = btoa(binary);

                // Send to server
                if (ws && ws.readyState === WebSocket.OPEN) {
                    const message = {
                        realtimeInput: {
                            mediaChunks: [{
                                mimeType: "audio/pcm;rate=16000",
                                data: base64Data
                            }]
                        }
                    };
                    ws.send(JSON.stringify(message));
                }
            };
        };

        ws.onmessage = (event) => {
            const response = JSON.parse(event.data);

            if (response.type === 'log') {
                addTranscript(response.data, 'model');
            }

            if (response.serverContent && response.serverContent.modelTurn) {
                const parts = response.serverContent.modelTurn.parts;
                for (const part of parts) {
                    if (part.inlineData) {
                        playAudioBase64(part.inlineData.data);
                    }
                }
            }
        };

        ws.onclose = () => {
            stopCall();
        };

        ws.onerror = (e) => {
            console.error(e);
            stopCall();
            statusText.textContent = 'Connection Error';
        };

    } catch (err) {
        console.error('Error starting call', err);
        statusText.textContent = 'Microphone Error';
        stopCall();
    }
});

endBtn.addEventListener('click', stopCall);

function stopCall() {
    startBtn.classList.remove('hidden');
    endBtn.classList.add('hidden');
    statusText.textContent = 'Call Ended. Ready to start.';
    micIcon.classList.remove('active');
    pulseRing.classList.remove('active');

    if (processor) {
        processor.disconnect();
        processor = null;
    }
    if (source) {
        source.disconnect();
        source = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    if (ws) {
        ws.close();
        ws = null;
    }

    nextPlayTime = 0;
}

function playAudioBase64(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    // Gemini returns 24kHz PCM16, so convert to Float32
    const int16Array = new Int16Array(bytes.buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 0x8000;
    }

    if (!playContext) return;
    if (playContext.state === 'suspended') playContext.resume();

    const audioBuffer = playContext.createBuffer(1, float32Array.length, 24000);
    audioBuffer.copyToChannel(float32Array, 0);

    const source = playContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(playContext.destination);

    // Schedule playback sequentially
    if (nextPlayTime < playContext.currentTime) {
        nextPlayTime = playContext.currentTime + 0.05; // small buffer
    }

    source.start(nextPlayTime);
    nextPlayTime += audioBuffer.duration;
}

function addTranscript(text, role) {
    const p = document.createElement('div');
    p.className = `turn-${role}`;
    p.textContent = (role === 'model' ? 'Assistant: ' : 'You: ') + text;
    transcriptBox.appendChild(p);
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
}
