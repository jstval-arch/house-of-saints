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

// Store active music generation tasks
const activeTasks = new Map();

// Serve static files
app.use(express.static('public'));

// ========================================
// CLAUDE LYRIC GENERATION (Server-side, no CORS!)
// ========================================
app.post('/api/generate-lyrics-claude', async (req, res) => {
  const { prompt, genre, anthropicApiKey } = req.body;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `Write ${genre} song lyrics based on this theme: ${prompt}

Format with clear verse/chorus structure. Make it authentic to the ${genre} genre.
Keep it to about 3-4 verses with choruses. Make it singable and emotionally resonant.`
        }]
      })
    });

    const data = await response.json();
    const lyrics = data.content[0].text;

    res.json({ success: true, lyrics });
  } catch (error) {
    console.error('Claude API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================
// OPENAI LYRIC GENERATION (Server-side, no CORS!)
// ========================================
app.post('/api/generate-lyrics-openai', async (req, res) => {
  const { prompt, genre, openaiApiKey } = req.body;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `Write ${genre} song lyrics based on this theme: ${prompt}

Format with clear verse/chorus structure. Make it authentic to the ${genre} genre.
Keep it to about 3-4 verses with choruses. Make it singable and emotionally resonant.`
        }]
      })
    });

    const data = await response.json();
    const lyrics = data.choices[0].message.content;

    res.json({ success: true, lyrics });
  } catch (error) {
    console.error('OpenAI API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================
// MUSICGPT GENERATION WITH WEBHOOK
// ========================================
app.post('/api/generate-music', async (req, res) => {
  const { prompt, music_style, lyrics, make_instrumental, musicGptApiKey, taskId } = req.body;

  try {
    // Get the server's public URL for webhook
    const webhookUrl = 'https://house-of-saints.onrender.com/api/webhook/musicgpt';

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
        make_instrumental: make_instrumental || false,
        webhook_url: webhookUrl  // ← This is the magic!
      })
    });

    const data = await response.json();

    if (data.success) {
      // Store task info for webhook lookup
      activeTasks.set(data.task_id, {
        clientTaskId: taskId,
        timestamp: Date.now(),
        genre: music_style,
        title: req.body.title || `${music_style} Song`
      });

      res.json({ success: true, ...data });
    } else {
      res.status(400).json({ success: false, error: data.message });
    }
  } catch (error) {
    console.error('MusicGPT API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================
// WEBHOOK ENDPOINT - MusicGPT calls this when done!
// ========================================
app.post('/api/webhook/musicgpt', async (req, res) => {
  console.log('🎵 Webhook received from MusicGPT!', req.body);

  const { task_id, conversion_id_1, conversion_id_2, status } = req.body;

  // Acknowledge receipt immediately
  res.sendStatus(200);

  if (status === 'completed') {
    const taskInfo = activeTasks.get(task_id);

    if (taskInfo) {
      // Fetch the actual audio URLs
      try {
        const musicGptApiKey = req.headers.authorization; // You'll need to store this

        const [resp1, resp2] = await Promise.all([
          fetch(`https://api.musicgpt.com/api/public/v1/byId?conversionType=audio_generation&conversion_id=${conversion_id_1}`, {
            headers: { 'Authorization': musicGptApiKey }
          }),
          fetch(`https://api.musicgpt.com/api/public/v1/byId?conversionType=audio_generation&conversion_id=${conversion_id_2}`, {
            headers: { 'Authorization': musicGptApiKey }
          })
        ]);

        const [data1, data2] = await Promise.all([resp1.json(), resp2.json()]);

        if (data1.success && data2.success) {
          const tracks = [
            {
              id: Date.now() + '-v1',
              title: `${taskInfo.title} (Version 1)`,
              genre: taskInfo.genre,
              audio_url: data1.conversion.conversion_path,
              duration: data1.conversion.conversion_duration,
              album_art: `https://source.unsplash.com/400x400/?music,${taskInfo.genre.toLowerCase()}`
            },
            {
              id: Date.now() + '-v2',
              title: `${taskInfo.title} (Version 2)`,
              genre: taskInfo.genre,
              audio_url: data2.conversion.conversion_path,
              duration: data2.conversion.conversion_duration,
              album_art: `https://source.unsplash.com/400x400/?music,${taskInfo.genre.toLowerCase()},2`
            }
          ];

          // Send to all connected clients via WebSocket
          io.emit('music-ready', {
            clientTaskId: taskInfo.clientTaskId,
            tracks
          });

          console.log('✅ Music sent to clients!', tracks);

          // Clean up
          activeTasks.delete(task_id);
        }
      } catch (error) {
        console.error('Error fetching music:', error);
      }
    }
  }
});

// ========================================
// WEBSOCKET CONNECTION
// ========================================
io.on('connection', (socket) => {
  console.log('✅ Client connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('❌ Client disconnected:', socket.id);
  });
});

// ========================================
// HEALTH CHECK
// ========================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', activeTasks: activeTasks.size });
});

// ========================================
// START SERVER
// ========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
🎵 House of Saints Music Server
================================
Server running on port ${PORT}
WebSocket ready for connections
Webhook endpoint: /api/webhook/musicgpt

Ready to generate music! 🚀
  `);
});
