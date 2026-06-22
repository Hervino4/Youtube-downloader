const express = require('express');
const { Innertube, Platform } = require('youtubei.js');
const vm = require('vm');
const { Readable } = require('stream');
const path = require('path');

// youtubei.js needs an evaluator to run YouTube's obfuscated player script,
// which is required to decipher streaming URLs (signature + "n" params).
// The library ships no default evaluator on purpose; we provide one using Node's vm module.
Platform.shim.eval = async (data) => {
  // data.output may contain a top-level `return`, which is only valid inside a
  // function body — so we wrap it in one, matching the pattern from youtubei.js's
  // own docs (which use `new Function(data.output)()`), but via vm for Node.
  const wrapped = `(function() {\n${data.output}\n})()`;
  return vm.runInNewContext(wrapped);
};

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Innertube client is created lazily on first request and cached.
let innertubeInstance = null;
async function getInnertube() {
  if (!innertubeInstance) {
    innertubeInstance = await Innertube.create();
  }
  return innertubeInstance;
}

function sanitizeFilename(name) {
  return (name || 'video').replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);
}

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') {
      return u.pathname.slice(1);
    }
    if (u.searchParams.has('v')) {
      return u.searchParams.get('v');
    }
    // handles /shorts/<id> and /embed/<id>
    const match = u.pathname.match(/\/(shorts|embed)\/([^/?]+)/);
    if (match) return match[2];
  } catch {
    return null;
  }
  return null;
}

// GET /api/info?url=...  -> title, author, duration, thumbnail for preview
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  const videoId = extractVideoId(url || '');

  if (!videoId) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  }

  try {
    const yt = await getInnertube();
    const info = await yt.getInfo(videoId);
    const details = info.basic_info;

    const thumbnails = details.thumbnail || [];
    const thumbnail = thumbnails.length ? thumbnails[thumbnails.length - 1].url : null;

    res.json({
      title: details.title,
      author: details.author || 'Unknown',
      lengthSeconds: details.duration,
      thumbnail,
    });
  } catch (err) {
    console.error('Info error:', err);
    res.status(500).json({ error: 'Could not fetch video info. The URL may be invalid or the video unavailable.' });
  }
});

// GET /api/download?url=...  -> streams an mp4 (video+audio) to the browser as a file download
app.get('/api/download', async (req, res) => {
  const { url } = req.query;
  const videoId = extractVideoId(url || '');

  if (!videoId) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  }

  try {
    const yt = await getInnertube();
    const info = await yt.getInfo(videoId);
    const title = sanitizeFilename(info.basic_info.title);

    // 'best' combines video+audio when a progressive format exists; otherwise
    // youtubei.js muxes separate video/audio streams together on the fly.
    const stream = await yt.download(videoId, {
      type: 'video+audio',
      quality: 'best',
      format: 'mp4',
    });

    res.setHeader('Content-Disposition', `attachment; filename="${title}.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');

    // youtubei.js returns a WHATWG ReadableStream (web stream); convert to a Node stream to pipe.
    const nodeStream = Readable.fromWeb(stream);

    nodeStream.on('error', (err) => {
      console.error('Stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed while streaming: ' + err.message });
      } else {
        res.end();
      }
    });

    nodeStream.pipe(res);
  } catch (err) {
    console.error('Download error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Could not download this video. ' + err.message });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
