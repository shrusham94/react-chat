require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const createOpenAI = require('openai');
const TranscriptClient = require('youtube-transcript-api').default || require('youtube-transcript-api');
const transcriptClient = new TranscriptClient();
const YTDlpWrap = require('yt-dlp-wrap').default;

const OPENAI_KEY = (process.env.REACT_APP_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '').trim();
const openai = OPENAI_KEY ? createOpenAI({ apiKey: OPENAI_KEY }) : null;

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const URI = process.env.REACT_APP_MONGODB_URI || process.env.MONGODB_URI || process.env.REACT_APP_MONGO_URI;
const DB = 'chatapp';

let db;

async function connect() {
  const client = await MongoClient.connect(URI);
  db = client.db(DB);
  console.log('MongoDB connected');
}

app.get('/', (req, res) => {
  res.send(`
    <html>
      <body style="font-family:sans-serif;padding:2rem;background:#00356b;color:white;min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0">
        <div style="text-align:center">
          <h1>Chat API Server</h1>
          <p>Backend is running. Use the React app at <a href="http://localhost:3000" style="color:#ffd700">localhost:3000</a></p>
          <p><a href="/api/status" style="color:#ffd700">Check DB status</a></p>
        </div>
      </body>
    </html>
  `);
});

app.get('/api/status', async (req, res) => {
  try {
    const usersCount = await db.collection('users').countDocuments();
    const sessionsCount = await db.collection('sessions').countDocuments();
    res.json({ usersCount, sessionsCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Users ────────────────────────────────────────────────────────────────────

app.post('/api/users', async (req, res) => {
  try {
    const { username, password, email, firstName, lastName } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });
    const name = String(username).trim().toLowerCase();
    const existing = await db.collection('users').findOne({ username: name });
    if (existing) return res.status(400).json({ error: 'Username already exists' });
    const hashed = await bcrypt.hash(password, 10);
    await db.collection('users').insertOne({
      username: name,
      password: hashed,
      email: email ? String(email).trim().toLowerCase() : null,
      firstName: firstName ? String(firstName).trim() : null,
      lastName: lastName ? String(lastName).trim() : null,
      createdAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });
    const name = username.trim().toLowerCase();
    const user = await db.collection('users').findOne({ username: name });
    if (!user) return res.status(401).json({ error: 'User not found' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid password' });
    res.json({
      ok: true,
      username: name,
      firstName: user.firstName || '',
      lastName: user.lastName || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sessions ─────────────────────────────────────────────────────────────────

app.get('/api/sessions', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'username required' });
    const sessions = await db
      .collection('sessions')
      .find({ username })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(
      sessions.map((s) => ({
        id: s._id.toString(),
        agent: s.agent || null,
        title: s.title || null,
        createdAt: s.createdAt,
        messageCount: (s.messages || []).length,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { username, agent } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    const { title } = req.body;
    const result = await db.collection('sessions').insertOne({
      username,
      agent: agent || null,
      title: title || null,
      createdAt: new Date().toISOString(),
      messages: [],
    });
    res.json({ id: result.insertedId.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  try {
    await db.collection('sessions').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/sessions/:id/title', async (req, res) => {
  try {
    const { title } = req.body;
    await db.collection('sessions').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { title } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── YouTube Channel Download ───────────────────────────────────────────────────
// Uses yt-dlp (free) when YOUTUBE_API_KEY is not set; otherwise uses YouTube Data API v3.
// Falls back to Invidious if yt-dlp is unavailable.

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || process.env.REACT_APP_YOUTUBE_API_KEY;
const INVIDIOUS_INSTANCES = ['https://inv.nadeko.net', 'https://invidious.nerdvpn.de', 'https://yewtu.be'];
const FETCH_OPTS = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } };

// Check if a YouTube video is still available (not private/deleted/restricted)
async function checkVideoAvailable(videoId) {
  if (!videoId) return false;
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      { ...FETCH_OPTS, method: 'GET' }
    );
    return res.ok;
  } catch (_) {
    return false;
  }
}

// Filter videos to only include those still available on YouTube (batched to avoid rate limits)
async function filterAvailableVideos(videos) {
  if (!videos?.length) return videos;
  const BATCH = 5;
  const result = [];
  for (let i = 0; i < videos.length; i += BATCH) {
    const batch = videos.slice(i, i + BATCH);
    const checks = await Promise.all(
      batch.map((v) => checkVideoAvailable(v.video_id).then((ok) => ({ v, ok })))
    );
    result.push(...checks.filter((c) => c.ok).map((c) => c.v));
  }
  return result;
}

async function ensureYtDlpBinary() {
  const binDir = path.join(__dirname, '../.yt-dlp');
  const binPath = path.join(binDir, os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (fs.existsSync(binPath)) return binPath;
  fs.mkdirSync(binDir, { recursive: true });
  try {
    await YTDlpWrap.downloadFromGithub(binPath, null, os.platform());
  } catch (_) {}
  return fs.existsSync(binPath) ? binPath : (os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

function ensureChannelVideosUrl(channelUrl) {
  const u = String(channelUrl || '').trim().replace(/\/$/, '');
  if (u.includes('/videos') || u.includes('/streams') || u.includes('/shorts')) return u;
  return u + '/videos';
}

function secToIsoDuration(sec) {
  if (sec == null || sec === '') return '';
  const s = parseInt(sec, 10) || 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), secs = s % 60;
  let out = 'PT';
  if (h) out += h + 'H';
  if (m) out += m + 'M';
  out += secs + 'S';
  return out;
}

function uploadDateToIso(ud) {
  if (!ud || typeof ud !== 'string') return '';
  if (ud.length === 8) return `${ud.slice(0, 4)}-${ud.slice(4, 6)}-${ud.slice(6, 8)}T00:00:00.000Z`;
  return ud;
}

function runYtDlp(binPath, args) {
  return new Promise((resolve, reject) => {
    const opts = { stdio: ['ignore', 'pipe', 'pipe'] };
    if (os.platform() === 'win32') opts.windowsHide = true;
    const proc = spawn(binPath, args, opts);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}

async function fetchChannelVideosYtDlp(channelUrl, maxVideos) {
  const binPath = await ensureYtDlpBinary();
  const url = ensureChannelVideosUrl(channelUrl);
  const nodePath = process.execPath;
  const args = nodePath
    ? ['--js-runtimes', `node:${nodePath}`, url, '--dump-json', '--no-download', '--no-warnings', '--playlist-end', String(maxVideos)]
    : [url, '--dump-json', '--no-download', '--no-warnings', '--playlist-end', String(maxVideos)];
  const stdout = await runYtDlp(binPath, args);
  const lines = stdout.trim().split('\n').filter((l) => l.trim());
  const videos = [];
  let channelId = null;
  for (const line of lines) {
    try {
      const v = JSON.parse(line);
      if (!v.id) continue;
      if (!channelId && v.channel_id) channelId = v.channel_id;
      videos.push({
        video_id: v.id,
        title: v.title || '',
        description: v.description || '',
        duration: v.duration ? secToIsoDuration(v.duration) : '',
        published_at: uploadDateToIso(v.upload_date) || (v.timestamp ? new Date(v.timestamp * 1000).toISOString() : ''),
        view_count: parseInt(v.view_count || '0', 10),
        like_count: parseInt(v.like_count || '0', 10),
        comment_count: parseInt(v.comment_count || '0', 10),
        thumbnail_url: v.thumbnail || (v.id ? `https://img.youtube.com/vi/${v.id}/hqdefault.jpg` : ''),
        video_url: `https://www.youtube.com/watch?v=${v.id}`,
        transcript: '',
      });
    } catch (_) {}
  }
  return { videos, channelId };
}

function extractChannelIdFromUrl(url) {
  const u = String(url || '').trim();
  const channelMatch = u.match(/youtube\.com\/channel\/([a-zA-Z0-9_-]+)/);
  if (channelMatch) return channelMatch[1];
  const handleMatch = u.match(/youtube\.com\/@([a-zA-Z0-9_.-]+)/);
  if (handleMatch) return { forHandle: handleMatch[1] };
  const cMatch = u.match(/youtube\.com\/c\/([a-zA-Z0-9_-]+)/);
  if (cMatch) return { forUsername: cMatch[1] };
  return null;
}

async function resolveChannelIdInvidious(channelUrl) {
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const res = await fetch(`${base}/api/v1/resolveurl?url=${encodeURIComponent(channelUrl)}`, FETCH_OPTS);
      const data = await res.json();
      const ucid = data?.ucid || data?.browseId;
      if (ucid) return ucid;
    } catch (_) {}
  }
  return null;
}

async function fetchVideoDetailsInvidious(base, videoId) {
  try {
    const [videoRes, commentsRes] = await Promise.all([
      fetch(`${base}/api/v1/videos/${videoId}`, FETCH_OPTS),
      fetch(`${base}/api/v1/comments/${videoId}`, FETCH_OPTS),
    ]);
    const videoData = videoRes.ok ? await videoRes.json() : null;
    const commentsData = commentsRes.ok ? await commentsRes.json() : null;
    return {
      view_count: videoData?.viewCount != null ? parseInt(videoData.viewCount, 10) : null,
      like_count: videoData?.likeCount != null ? parseInt(videoData.likeCount, 10) : null,
      comment_count: commentsData?.commentCount != null ? parseInt(commentsData.commentCount, 10) : null,
      published_at: videoData?.published ? new Date(videoData.published * 1000).toISOString() : null,
    };
  } catch (_) {
    return { view_count: null, like_count: null, comment_count: null, published_at: null };
  }
}

async function fetchChannelVideosInvidious(channelId, maxVideos) {
  let baseUsed = null;
  const rawVideos = [];
  let continuation = null;
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      while (rawVideos.length < maxVideos) {
        let url = `${base}/api/v1/channels/${channelId}/videos?sort_by=newest`;
        if (continuation) url += `&continuation=${encodeURIComponent(continuation)}`;
        const res = await fetch(url, FETCH_OPTS);
        const data = await res.json();
        const batch = data?.videos || [];
        if (!batch.length) break;
        baseUsed = base;
        for (const v of batch) {
          if (rawVideos.length >= maxVideos) break;
          rawVideos.push(v);
        }
        continuation = data?.continuation || null;
        if (!continuation) break;
      }
      if (rawVideos.length > 0) break;
    } catch (_) {}
  }
  if (!rawVideos.length) return [];

  const detailsPromises = rawVideos.map((v) => fetchVideoDetailsInvidious(baseUsed || INVIDIOUS_INSTANCES[0], v.videoId));
  const detailsList = await Promise.all(detailsPromises);

  return rawVideos.map((v, i) => {
    const d = detailsList[i] || {};
    return {
      video_id: v.videoId,
      title: v.title || '',
      description: v.description || '',
      duration: v.lengthSeconds ? `PT${Math.floor(v.lengthSeconds / 60)}M${v.lengthSeconds % 60}S` : '',
      published_at: d.published_at ?? (v.published ? new Date(v.published * 1000).toISOString() : ''),
      view_count: d.view_count ?? parseInt(v.viewCount || '0', 10),
      like_count: d.like_count ?? parseInt(v.likeCount || '0', 10),
      comment_count: d.comment_count ?? 0,
      thumbnail_url: v.videoThumbnails?.[0]?.url || v.videoThumbnails?.[v.videoThumbnails.length - 1]?.url || '',
      video_url: `https://www.youtube.com/watch?v=${v.videoId}`,
      transcript: '',
    };
  });
}

app.post('/api/youtube/download', async (req, res) => {
  try {
    const { channelUrl, maxVideos = 10 } = req.body;
    const max = Math.min(Math.max(1, parseInt(maxVideos, 10) || 10), 100);
    const parsed = extractChannelIdFromUrl(channelUrl);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid YouTube channel URL. Use format: https://www.youtube.com/@channelname or https://www.youtube.com/channel/UC...' });
    }

    let channelId = typeof parsed === 'string' ? parsed : null;
    let videos = [];
    const useYoutubeApi = !!YOUTUBE_API_KEY;

    if (useYoutubeApi) {
      if (!channelId && parsed.forHandle) {
        const chRes = await fetch(
          `https://www.googleapis.com/youtube/v3/channels?part=id,snippet&forHandle=${parsed.forHandle}&key=${YOUTUBE_API_KEY}`
        );
        const chData = await chRes.json();
        channelId = chData.items?.[0]?.id;
      }
      if (!channelId && parsed.forUsername) {
        const uRes = await fetch(
          `https://www.googleapis.com/youtube/v3/channels?part=id&forUsername=${parsed.forUsername}&key=${YOUTUBE_API_KEY}`
        );
        const uData = await uRes.json();
        channelId = uData.items?.[0]?.id;
      }
      if (!channelId) return res.status(400).json({ error: 'Channel not found' });

      const searchRes = await fetch(
        `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${channelId}&type=video&order=date&maxResults=${max}&key=${YOUTUBE_API_KEY}`
      );
      const searchData = await searchRes.json();
      const videoIds = (searchData.items || []).map((i) => i.id.videoId).filter(Boolean);
      if (!videoIds.length) return res.status(400).json({ error: 'No videos found' });

      const videosRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails,status&id=${videoIds.join(',')}&key=${YOUTUBE_API_KEY}`
      );
      const videosData = await videosRes.json();
      videos = (videosData.items || [])
        .filter((v) => {
          const status = v.status || {};
          const privacy = (status.privacyStatus || '').toLowerCase();
          const uploadStatus = (status.uploadStatus || '').toLowerCase();
          return (privacy === 'public' || privacy === 'unlisted') && uploadStatus !== 'failed' && uploadStatus !== 'rejected';
        })
        .map((v) => ({
        video_id: v.id,
        title: v.snippet?.title || '',
        description: v.snippet?.description || '',
        duration: v.contentDetails?.duration || '',
        published_at: v.snippet?.publishedAt || '',
        view_count: parseInt(v.statistics?.viewCount || '0', 10),
        like_count: parseInt(v.statistics?.likeCount || '0', 10),
        comment_count: parseInt(v.statistics?.commentCount || '0', 10),
        thumbnail_url: v.snippet?.thumbnails?.high?.url || v.snippet?.thumbnails?.default?.url || '',
        video_url: `https://www.youtube.com/watch?v=${v.id}`,
        transcript: '',
      }));

      await transcriptClient.ready;
      for (let i = 0; i < videos.length; i++) {
        try {
          const data = await transcriptClient.getTranscript(videos[i].video_id);
          const track = data?.tracks?.[0];
          videos[i].transcript = (track?.transcript || []).map((t) => t.text || '').join(' ').trim();
        } catch (_) {}
      }
    } else {
      try {
        const ytDlpResult = await fetchChannelVideosYtDlp(channelUrl, max);
        videos = ytDlpResult.videos || [];
        if (videos.length > 0) {
          channelId = channelId || ytDlpResult.channelId || 'yt-dlp';
          await transcriptClient.ready;
          for (let i = 0; i < videos.length; i++) {
            try {
              const data = await transcriptClient.getTranscript(videos[i].video_id);
              const track = data?.tracks?.[0];
              videos[i].transcript = (track?.transcript || []).map((t) => t.text || '').join(' ').trim();
            } catch (_) {}
          }
        }
      } catch (ytDlpErr) {
        console.warn('[YouTube] yt-dlp failed, falling back to Invidious:', ytDlpErr.message);
      }
      if (videos.length === 0) {
        if (!channelId) {
          channelId = await resolveChannelIdInvidious(channelUrl);
          if (!channelId) return res.status(400).json({ error: 'Channel not found. Ensure yt-dlp is available or add YOUTUBE_API_KEY.' });
        }
        videos = await fetchChannelVideosInvidious(channelId, max);
      }
    }

    if (videos.length === 0) {
      return res.status(400).json({
        error: 'No videos could be fetched. Try: (1) Install yt-dlp (pip install yt-dlp or winget install yt-dlp) and restart the server, or (2) Add YOUTUBE_API_KEY to .env for reliable access.',
      });
    }
    // Filter out unavailable videos (private, deleted, restricted)
    videos = await filterAvailableVideos(videos);
    if (videos.length === 0) {
      return res.status(400).json({
        error: 'All fetched videos are unavailable (private, deleted, or restricted). Try a different channel.',
      });
    }
    const output = { channel_id: channelId || 'unknown', channel_url: channelUrl, videos, downloaded_at: new Date().toISOString() };
    const publicDir = path.join(__dirname, '../public');
    const filename = `youtube_channel_${channelId}_${Date.now()}.json`;
    const filepath = path.join(publicDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(output, null, 2), 'utf8');
    res.json({ ok: true, filename, data: output, downloadUrl: `/${filename}` });
  } catch (err) {
    console.error('[YouTube download]', err);
    res.status(500).json({ error: err.message || 'Download failed' });
  }
});

// ── OpenAI Proxy (avoids browser connection errors from firewalls/proxies) ────

app.post('/api/openai/chat', async (req, res) => {
  if (!openai) return res.status(500).json({ error: 'OpenAI API key not configured' });
  try {
    const { messages, stream, tools, tool_choice } = req.body;
    if (!messages || !Array.isArray(messages))
      return res.status(400).json({ error: 'messages array required' });
    const opts = {
      model: 'gpt-4o-mini',
      messages,
      stream: !!stream,
    };
    if (tools?.length) {
      opts.tools = tools;
      opts.tool_choice = tool_choice || 'auto';
    }
    if (stream) {
      const completion = await openai.chat.completions.create(opts);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      for await (const chunk of completion) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) res.write(`data: ${JSON.stringify({ type: 'text', text: delta })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const completion = await openai.chat.completions.create(opts);
      res.json(completion);
    }
  } catch (err) {
    console.error('[OpenAI proxy]', err);
    const is401 = err.status === 401 || err.statusCode === 401 || (err.message && err.message.includes('401'));
    const msg = is401
      ? 'Your OpenAI API key is invalid or expired. Create a new key at https://platform.openai.com/account/api-keys and update REACT_APP_OPENAI_API_KEY in your .env file, then restart the server.'
      : (err.message || 'OpenAI request failed');
    res.status(500).json({ error: msg });
  }
});

app.post('/api/openai/image', async (req, res) => {
  if (!openai) return res.status(500).json({ error: 'OpenAI API key not configured' });
  try {
    const { prompt, anchorImage } = req.body;
    let finalPrompt = prompt || 'A beautiful image';
    if (anchorImage) {
      finalPrompt = `Generate an image inspired by the style and composition of the user's reference image. ${finalPrompt}`;
    }
    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt: finalPrompt,
      n: 1,
      size: '1024x1024',
    });
    const url = response.data?.[0]?.url;
    if (!url) return res.status(500).json({ error: 'Image generation failed' });
    const imgRes = await fetch(url);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const base64 = buf.toString('base64');
    res.json({ _chartType: 'generated_image', imageData: base64, mimeType: 'image/png', prompt });
  } catch (err) {
    console.error('[OpenAI image]', err);
    const is401 = err.status === 401 || err.statusCode === 401 || (err.message && err.message.includes('401'));
    const msg = is401
      ? 'Your OpenAI API key is invalid or expired. Create a new key at https://platform.openai.com/account/api-keys and update REACT_APP_OPENAI_API_KEY in your .env file, then restart the server.'
      : (err.message || 'Image generation failed');
    res.status(500).json({ error: msg });
  }
});

// ── Messages ─────────────────────────────────────────────────────────────────

app.post('/api/messages', async (req, res) => {
  try {
    const { session_id, role, content, imageData, charts, toolCalls, sessionJsonData } = req.body;
    if (!session_id || !role || content === undefined)
      return res.status(400).json({ error: 'session_id, role, content required' });
    const msg = {
      role,
      content,
      timestamp: new Date().toISOString(),
      ...(imageData && {
        imageData: Array.isArray(imageData) ? imageData : [imageData],
      }),
      ...(charts?.length && { charts }),
      ...(toolCalls?.length && { toolCalls }),
    };
    const update = { $push: { messages: msg } };
    if (sessionJsonData && sessionJsonData.videos?.length) {
      update.$set = update.$set || {};
      update.$set.jsonData = sessionJsonData;
      update.$set.jsonDataName = req.body.jsonDataName || 'youtube_channel.json';
    }
    await db.collection('sessions').updateOne(
      { _id: new ObjectId(session_id) },
      update
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages', async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });
    const doc = await db
      .collection('sessions')
      .findOne({ _id: new ObjectId(session_id) });
    const raw = doc?.messages || [];
    const msgs = raw.map((m, i) => {
      const arr = m.imageData
        ? Array.isArray(m.imageData)
          ? m.imageData
          : [m.imageData]
        : [];
      return {
        id: `${doc._id}-${i}`,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        images: arr.length
          ? arr.map((img) => ({ data: img.data, mimeType: img.mimeType }))
          : undefined,
        charts: m.charts?.length ? m.charts : undefined,
        toolCalls: m.toolCalls?.length ? m.toolCalls : undefined,
      };
    });
    const jsonData = doc?.jsonData || null;
    const jsonDataName = doc?.jsonDataName || null;
    res.json({ messages: msgs, jsonData, jsonDataName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

connect()
  .then(() => {
    app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
