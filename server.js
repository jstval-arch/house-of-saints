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

// Serve static files (Your frontend)
app.use(express.static('public'));

// ========================================
// 1. CLAUDE LYRIC GENERATION
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
        model: 'claude-sonnet-4-20250514', // Or current model
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `Write ${genre} song lyrics based on this theme: ${prompt}. Format with clear verse/chorus structure.`
        }]
      })
    });

    const data = await response.json();
    // Handle potential API errors gracefully
    if (data.error) throw new Error(data.error.message);
    
    const lyrics = data.content[0].text;
    res.json({ success: true, lyrics });
  } catch (error) {
    console.error('Claude API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================
// 2. OPENAI LYRIC GENERATION
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
          content: `Write ${genre} song lyrics based on this theme: ${prompt}. Format with clear verse/chorus structure.`
        }]
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const lyrics = data.choices[0].message.content;
    res.json({ success: true, lyrics });
  } catch (error) {
    console.error('OpenAI API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================
// 3. MUSICGPT GENERATION (UPDATED)
// ========================================
app.post('/api/generate-music', async (req, res) => {
  const { prompt, music_style, lyrics, make_instrumental, musicGptApiKey, taskId } = req.body;

  try {
    // FIX 1: Force HTTPS URL so Render doesn't block it
    const webhookUrl = 'https://house-of-saints.onrender.com/api/webhook/musicgpt';

    console.log(`🚀 Submitting to MusicGPT with webhook: ${webhookUrl}`);

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
        webhook_url: webhookUrl 
      })
    });

    const data = await response.json();

    if (data.success) {
      // Store task info for when the webhook comes back
      activeTasks.set(data.task_id, {
        clientTaskId: taskId,
        timestamp: Date.now(),
        genre: music_style,
        title: req.body.title || `${music_style} Song`,
        musicGptApiKey: musicGptApiKey // Store key to use in webhook
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
// 4. WEBHOOK RECEIVER (FIXED & IMPROVED)
// ========================================
app.post('/api/webhook/musicgpt', async (req, res) => {
  // Acknowledge receipt immediately (important for webhooks!)
  res.sendStatus(200);

  try {
    const { task_id, conversion_id, status, conversion_type } = req.body;
    console.log(`🎵 Webhook Hit! Task: ${task_id}, Status: ${status}`);

    // We only care about COMPLETED AUDIO tasks
    if (status === 'completed' && conversion_type === 'audio_generation') {
      const taskInfo = activeTasks.get(task_id);

      if (!taskInfo) {
        console.log(`⚠️ Warning: Task ID ${task_id} not found in memory (Server may have restarted).`);
        return;
      }

      // Fetch the actual audio URL
      const response = await fetch(`https://api.musicgpt.com/api/public/v1/byId?conversionType=audio_generation&conversion_id=${conversion_id}`, {
        headers: { 'Authorization': taskInfo.musicGptApiKey }
      });

      const data = await response.json();

      if (data.success) {
        const track = {
          id: conversion_id,
          title: `${taskInfo.title}`,
          genre: taskInfo.genre,
          audio_url: data.conversion.conversion_path,
          duration: data.conversion.conversion_duration,
          album_art: `https://source.unsplash.com/400x400/?music,${taskInfo.genre.toLowerCase()}`,
          timestamp: Date.now()
        };

        // FIX 2: Send track IMMEDIATELY to frontend
        io.emit('music-ready', {
          clientTaskId: taskInfo.clientTaskId,
          tracks: [track]
        });

        console.log(`✅ Success! Sent track to client: ${track.title}`);
      }
    }
  } catch (error) {
    console.error('Webhook processing error:', error);
  }
});

// ========================================
// 5. WEBSOCKET CONNECTION
// ========================================
io.on('connection', (socket) => {
  console.log('✅ Client connected:', socket.id);
  socket.on('disconnect', () => console.log('❌ Client disconnected:', socket.id));
});

// Health Check (Keeps server awake)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', activeTasks: activeTasks.size });
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
  🎵 HOUSE OF SAINTS SERVER RUNNING!
  ==================================
  URL: https://house-of-saints.onrender.com
  PORT: ${PORT}
  WEBHOOK: https://house-of-saints.onrender.com/api/webhook/musicgpt
  `);
});