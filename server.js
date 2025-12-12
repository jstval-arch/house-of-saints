const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// Store active polling intervals so we can stop them later
const activePolls = new Map();

// ========================================
// 1. CLAUDE LYRICS
// ========================================
app.post('/api/generate-lyrics-claude', async (req, res) => {
  const { prompt, genre, anthropicApiKey } = req.body;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 1500,
        messages: [{ role: 'user', content: `Write ${genre} song lyrics: ${prompt}. Format as verse/chorus.` }]
      })
    });
    const data = await response.json();
    res.json({ success: true, lyrics: data.content?.[0]?.text || "Error generating lyrics" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================
// 2. OPENAI LYRICS
// ========================================
app.post('/api/generate-lyrics-openai', async (req, res) => {
  const { prompt, genre, openaiApiKey } = req.body;
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4', max_tokens: 1500,
        messages: [{ role: 'user', content: `Write ${genre} song lyrics: ${prompt}. Format as verse/chorus.` }]
      })
    });
    const data = await response.json();
    res.json({ success: true, lyrics: data.choices?.[0]?.message?.content || "Error generating lyrics" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================
// 3. MUSIC GENERATION (CORRECTED POLLING)
// ========================================
app.post('/api/generate-music', async (req, res) => {
  const { prompt, music_style, lyrics, make_instrumental, musicGptApiKey, taskId } = req.body;

  try {
    console.log(`🚀 Sending request to MusicGPT...`);

    const response = await fetch('https://api.musicgpt.com/api/public/v1/MusicAI', {
      method: 'POST',
      headers: { 
        'Authorization': musicGptApiKey, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({
        prompt, 
        music_style, 
        lyrics,
        make_instrumental: make_instrumental || false
      })
    });

    const data = await response.json();

    if (data.success) {
      console.log(`✅ IDs Received: ${data.conversion_id_1}, ${data.conversion_id_2}`);
      
      // Start polling BOTH IDs independently
      if (data.conversion_id_1) {
        startPolling(data.conversion_id_1, taskId, `${req.body.title || 'Song'} (V1)`, music_style, musicGptApiKey);
      }
      if (data.conversion_id_2) {
        startPolling(data.conversion_id_2, taskId, `${req.body.title || 'Song'} (V2)`, music_style, musicGptApiKey);
      }
      
      res.json({ success: true, ...data });
    } else {
      res.status(400).json({ success: false, error: data.message });
    }
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================
// 4. THE POLLING ENGINE (Debug Version)
// ========================================
function startPolling(conversionId, clientTaskId, title, genre, apiKey) {
  console.log(`⏳ Polling started for ID: ${conversionId}`);
  
  const intervalId = setInterval(async () => {
    try {
      const url = `https://api.musicgpt.com/api/public/v1/byId?conversionType=audio_generation&conversion_id=${conversionId}`;
      
      const response = await fetch(url, {
        headers: { 'Authorization': apiKey }
      });

      const data = await response.json();

      // DEBUG LOG: See exactly what MusicGPT says every time
      const currentStatus = data.conversion ? data.conversion.status : "UNKNOWN";
      console.log(`🔎 Checking ${conversionId.substring(0,6)}... Status: ${currentStatus}`);

      // 1. SUCCESS CASE
      if (data.success && data.conversion && data.conversion.status === 'COMPLETED') {
        console.log(`✅ SONG READY: ${title}`);
        
        const track = {
          id: conversionId,
          title: title,
          genre: genre,
          audio_url: data.conversion.audio_url,
          duration: 200,
          album_art: `https://source.unsplash.com/400x400/?music,${genre.toLowerCase()}`
        };

        io.emit('music-ready', { clientTaskId, tracks: [track] });
        clearInterval(intervalId);
        activePolls.delete(conversionId);
      }
      // 2. FAILURE CASE (Fixed to check inner status)
      else if (data.success === false || (data.conversion && data.conversion.status === 'FAILED')) {
         console.log(`❌ Generation Failed for ${conversionId}: ${data.message || "Unknown error"}`);
         clearInterval(intervalId);
         activePolls.delete(conversionId);
      }

    } catch (err) {
      console.error(`Polling error for ${conversionId}:`, err.message);
    }
  }, 10000); // Check every 10 seconds

  activePolls.set(conversionId, intervalId);
  setTimeout(() => {
    if (activePolls.has(conversionId)) {
      clearInterval(activePolls.get(conversionId));
      activePolls.delete(conversionId);
      console.log(`⚠️ Timeout stopping poll for ${conversionId}`);
    }
  }, 600000); // 10 minute timeout
}

// ========================================
// 5. SERVER SETUP
// ========================================
io.on('connection', (socket) => {
  console.log('✅ Client connected:', socket.id);
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', active_polls: activePolls.size }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});