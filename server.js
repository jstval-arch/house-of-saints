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

// Store active polling intervals
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
// 3. MUSIC GENERATION (POLLING)
// ========================================
app.post('/api/generate-music', async (req, res) => {
  const { prompt, music_style, lyrics, make_instrumental, musicGptApiKey, taskId } = req.body;

  try {
    console.log(`🚀 Sending request to MusicGPT...`);
    const response = await fetch('https://api.musicgpt.com/api/public/v1/MusicAI', {
      method: 'POST',
      headers: { 'Authorization': musicGptApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, music_style, lyrics, make_instrumental: make_instrumental || false })
    });

    const data = await response.json();

    if (data.success) {
      console.log(`✅ IDs Received: ${data.conversion_id_1}, ${data.conversion_id_2}`);
      if (data.conversion_id_1) startPolling(data.conversion_id_1, taskId, `${req.body.title || 'Song'} (V