require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const xml2js  = require('xml2js');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL    = parseInt(process.env.CACHE_TTL || '300000');  // 5 min  (X)
const IG_CACHE_TTL = 30 * 60 * 1000;                               // 30 min (Instagram — saves Apify credits)

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Cache (supports per-entry TTL) ──────────────────────────────────────────
const cache = new Map();
const getCached = key => {
  const e = cache.get(key);
  if (!e) return null;
  return (Date.now() - e.ts < (e.ttl || CACHE_TTL)) ? e.data : null;
};
const setCache        = (key, data)      => cache.set(key, { data, ts: Date.now() });
const setCacheWithTTL = (key, data, ttl) => cache.set(key, { data, ts: Date.now(), ttl });

// ─── Account metadata ─────────────────────────────────────────────────────────
const ACCOUNT_META = {
  modgovae:         { name: 'UAE Ministry of Defence'          },
  moiuae:           { name: 'UAE Ministry of Interior'        },
  uaemediaoffice:   { name: 'UAE Media Office'                },
  uaegov:           { name: 'UAE Government'                  },
  wamnews:          { name: 'WAM News Agency'                 },
  mofauae:          { name: 'Ministry of Foreign Affairs'     },
  dubaimediaoffice: { name: 'Dubai Media Office'              },
  dxbmediaoffice:   { name: 'Dubai Media Office'              },
  admediaoffice:    { name: 'Abu Dhabi Media Office'          },
  ncemauae:         { name: 'National Crisis & Emergency Mgmt'},
  uaenma:           { name: 'UAE National Media'              },
};

const X_ACCOUNTS  = ['modgovae','moiuae','uaemediaoffice','wamnews','mofauae','dxbmediaoffice','admediaoffice','ncemauae','uaenma'];
const IG_ACCOUNTS = ['modgovae','moiuae','uaegov','wamnews','mofauae','dubaimediaoffice','admediaoffice','ncemauae','uaenma'];

// ─── RSS utilities ────────────────────────────────────────────────────────────
async function parseRSS(xml) {
  const result = await xml2js.parseStringPromise(xml, { explicitArray: false, trim: true });
  const channel = result?.rss?.channel;
  if (!channel) return [];
  const raw = channel.item;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

// Strip HTML tags and decode entities, removing attachment/image blocks
function cleanText(html = '') {
  return html
    .replace(/<div[^>]*class="[^"]*attachment[^"]*"[\s\S]*?<\/div>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<a[^>]+href="https?:\/\/t\.co\/[^"]*"[^>]*>[^<]*<\/a>/gi, '') // strip t.co shortlinks
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Nitter RSS — live X/Twitter data without API keys ───────────────────────
// Ordered by reliability. First success wins.
const NITTER_INSTANCES = [
  'https://nitter.net',           // primary — official, usually up
  'https://nitter.poast.org',
  'https://nitter.privacydev.net',
  'https://nitter.nl',
  'https://nitter.kavin.rocks',
];

async function fetchViaNitter(username) {
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  for (const instance of NITTER_INSTANCES) {
    try {
      const res = await axios.get(`${instance}/${username}/rss`, {
        timeout: 9000,
        headers: { 'User-Agent': UA, Accept: 'application/rss+xml, text/xml, */*' },
      });

      const items = await parseRSS(res.data);

      // Drop retweets (Nitter title starts with "R " for retweets)
      const own = items.filter(item => {
        const t = String(item.title || '');
        return !t.startsWith('R ') && !t.startsWith('RT ');
      }).slice(0, 3);

      if (own.length === 0) continue;

      return own.map(item => {
        const desc = String(item.description || '');
        const text = cleanText(desc) || cleanText(String(item.title || ''));

        // guid is the raw tweet ID on nitter.net
        const tweetId = String(item.guid || '').replace(/[^0-9]/g, '');
        const twitterUrl = tweetId
          ? `https://twitter.com/${username}/status/${tweetId}`
          : String(item.link || '').replace(/https?:\/\/[^/]+\//, 'https://twitter.com/').replace(/#m$/, '');

        // Convert Nitter image proxy → Twitter CDN
        // e.g. https://nitter.net/pic/media%2FABCxyz.jpg → https://pbs.twimg.com/media/ABCxyz.jpg
        let image = null;
        const imgMatch = desc.match(/src="([^"]*\/pic\/[^"]+)"/i);
        if (imgMatch) {
          const picPath = decodeURIComponent(imgMatch[1].replace(/^.*\/pic\//, ''));
          image = `https://pbs.twimg.com/${picPath}`;
        }

        return {
          id:         tweetId || twitterUrl,
          text,
          image,
          created_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
          url:        twitterUrl,
          metrics:    null,  // RSS doesn't carry engagement counts
          isLive:     true,
          via:        'nitter',
        };
      });
    } catch {
      // try next instance
    }
  }
  return null;
}

// ─── X / Twitter ─────────────────────────────────────────────────────────────
async function fetchXAccount(username) {
  const key = `x_${username}`;
  const cached = getCached(key);
  if (cached) return cached;

  const meta = ACCOUNT_META[username] || { name: username };

  // 1. Official X API v2 (highest quality — real metrics, real images)
  if (process.env.X_BEARER_TOKEN) {
    try {
      const headers = { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` };

      const userRes = await axios.get(
        `https://api.twitter.com/2/users/by/username/${username}`,
        { headers, params: { 'user.fields': 'profile_image_url,name,verified' }, timeout: 10000 }
      );
      const user = userRes.data.data;

      const tweetsRes = await axios.get(
        `https://api.twitter.com/2/users/${user.id}/tweets`,
        {
          headers,
          params: {
            max_results:    10,
            'tweet.fields': 'created_at,public_metrics,attachments',
            expansions:     'attachments.media_keys',
            'media.fields': 'url,type,preview_image_url',
            exclude:        'retweets,replies',
          },
          timeout: 10000,
        }
      );

      const tweets   = tweetsRes.data.data || [];
      const mediaMap = Object.fromEntries(
        (tweetsRes.data.includes?.media || []).map(m => [m.media_key, m])
      );

      const posts = tweets.slice(0, 3).map(t => {
        const mk    = t.attachments?.media_keys?.[0];
        const media = mk ? mediaMap[mk] : null;
        return {
          id:         t.id,
          text:       t.text,
          image:      media?.url || media?.preview_image_url || null,
          created_at: t.created_at,
          url:        `https://twitter.com/${username}/status/${t.id}`,
          metrics:    t.public_metrics,
          isLive:     true,
          via:        'api',
        };
      });

      const result = {
        account: {
          username,
          name:     user.name,
          avatar:   user.profile_image_url?.replace('_normal', '_400x400'),
          verified: user.verified,
        },
        posts,
        source: 'api',
      };
      setCache(key, result);
      return result;
    } catch (err) {
      console.error(`[X API] @${username}:`, err.response?.data?.detail || err.message);
    }
  }

  // 2. Nitter RSS — real tweets, no API key needed
  const nitterPosts = await fetchViaNitter(username);
  if (nitterPosts && nitterPosts.length > 0) {
    const result = {
      account: {
        username,
        name:     meta.name,
        avatar:   `https://unavatar.io/twitter/${username}`,
        verified: true,
      },
      posts:  nitterPosts,
      source: 'rss',
    };
    setCache(key, result);
    return result;
  }

  // 3. All sources failed
  return {
    account: { username, name: meta.name, avatar: `https://unavatar.io/twitter/${username}` },
    posts:   [],
    source:  'unavailable',
    error:   'Could not connect to X. Try adding X_BEARER_TOKEN to .env.',
  };
}

// ─── Instagram — Apify batch scraper ─────────────────────────────────────────
// All 9 accounts fetched in ONE Apify call to minimise credit usage.
// Results cached for 30 minutes.

let _apifyInFlight = null; // prevent concurrent duplicate calls

async function fetchAllIGViaApify() {
  const BATCH_KEY = 'ig_apify_batch';
  const cached = getCached(BATCH_KEY);
  if (cached) return cached;

  if (_apifyInFlight) return _apifyInFlight; // deduplicate

  _apifyInFlight = (async () => {
    try {
      const res = await axios.post(
        'https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items',
        {
          directUrls:   IG_ACCOUNTS.map(u => `https://www.instagram.com/${u}/`),
          resultsType:  'posts',
          resultsLimit: 3,
        },
        {
          params:  { token: process.env.APIFY_TOKEN, memory: 256, timeout: 60 },
          timeout: 120_000,
          headers: { 'Content-Type': 'application/json' },
        }
      );

      // Group posts by ownerUsername
      const byUser = {};
      for (const item of (res.data || [])) {
        const uname = item.ownerUsername?.toLowerCase();
        if (!uname) continue;
        if (!byUser[uname]) byUser[uname] = [];
        if (byUser[uname].length < 3) {
          byUser[uname].push({
            id:         item.shortCode,
            text:       item.caption || '',
            image:      item.displayUrl ? `/api/imgproxy?url=${encodeURIComponent(item.displayUrl)}` : null,
            created_at: item.timestamp || null,
            url:        item.url || `https://www.instagram.com/p/${item.shortCode}/`,
            metrics:    { like_count: item.likesCount || 0, comments_count: item.commentsCount || 0 },
            isLive:     true,
            via:        'apify',
          });
        }
      }

      setCacheWithTTL(BATCH_KEY, byUser, IG_CACHE_TTL);
      return byUser;
    } catch (err) {
      const status = err.response?.status;
      // 402 = credits exhausted, 429 = rate limit
      if (status === 402 || status === 429) {
        console.warn('[Apify] Credits exhausted or rate limited');
        return { _creditsExhausted: true };
      }
      console.error('[Apify]', err.response?.data?.error?.message || err.message);
      return null;
    }
  })().finally(() => { _apifyInFlight = null; });

  return _apifyInFlight;
}

// ─── Instagram ────────────────────────────────────────────────────────────────
async function fetchIGAccount(username) {
  const key = `ig_${username}`;
  const cached = getCached(key);
  if (cached) return cached;

  const meta = ACCOUNT_META[username] || { name: username };
  const avatar = `https://unavatar.io/instagram/${username}`;

  const unavailable = (msg = 'Unable to fetch data') => ({
    account: { username, name: meta.name, avatar },
    posts:   [],
    source:  'unavailable',
    error:   msg,
  });

  // 1. Official Instagram Graph API (if credentials are set)
  if (process.env.IG_ACCESS_TOKEN && process.env.IG_USER_IDS) {
    try {
      const userIds = JSON.parse(process.env.IG_USER_IDS);
      const userId  = userIds[username];

      if (userId) {
        const res = await axios.get(
          `https://graph.facebook.com/v18.0/${userId}/media`,
          {
            params: {
              fields:       'id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count,permalink',
              limit:        3,
              access_token: process.env.IG_ACCESS_TOKEN,
            },
            timeout: 10000,
          }
        );

        const posts = (res.data.data || []).slice(0, 3).map(p => ({
          id:         p.id,
          text:       p.caption || '',
          image:      p.media_type === 'VIDEO' ? p.thumbnail_url : p.media_url,
          created_at: p.timestamp,
          url:        p.permalink,
          metrics:    { like_count: p.like_count || 0, comments_count: p.comments_count || 0 },
          isLive:     true,
          via:        'api',
        }));

        const result = { account: { username, name: meta.name, avatar }, posts, source: 'api' };
        setCache(key, result);
        return result;
      }
    } catch (err) {
      console.error(`[IG API] @${username}:`, err.message);
    }
  }

  // 2. Apify Instagram scraper
  if (process.env.APIFY_TOKEN) {
    const batch = await fetchAllIGViaApify();

    if (!batch || batch._creditsExhausted) return unavailable();

    // Try exact match first, then partial match (handles slight username differences)
    const key2 = username.toLowerCase();
    let posts = batch[username] || batch[key2];
    if (!posts) {
      const closeKey = Object.keys(batch).find(k => k.includes(key2) || key2.includes(k));
      if (closeKey) posts = batch[closeKey];
    }
    if (posts && posts.length > 0) {
      const result = { account: { username, name: meta.name, avatar }, posts, source: 'apify' };
      setCacheWithTTL(key, result, IG_CACHE_TTL);
      return result;
    }

    return unavailable();
  }

  // 3. Nothing configured
  return unavailable('Add APIFY_TOKEN to your environment to enable Instagram.');
}

// ─── Image proxy — avoids Cross-Origin-Resource-Policy blocks on Instagram CDN ─
const IG_CDN_HOSTS = ['cdninstagram.com', 'fbcdn.net'];

app.get('/api/imgproxy', async (req, res) => {
  const url = req.query.url;
  try {
    if (!url) return res.status(400).send('Missing url');
    const parsed = new URL(url);
    if (!IG_CDN_HOSTS.some(h => parsed.hostname.endsWith(h)))
      return res.status(400).send('Disallowed host');

    const upstream = await axios.get(url, {
      responseType: 'stream',
      timeout: 10000,
      headers: {
        'Referer':    'https://www.instagram.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    });

    res.setHeader('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    upstream.data.pipe(res);
  } catch {
    res.status(502).send('Image unavailable');
  }
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/api/x', async (req, res) => {
  try {
    const data = await Promise.all(X_ACCOUNTS.map(fetchXAccount));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/instagram', async (req, res) => {
  try {
    const data = await Promise.all(IG_ACCOUNTS.map(fetchIGAccount));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/cache/:platform/:username', (req, res) => {
  cache.delete(`${req.params.platform}_${req.params.username}`);
  res.json({ success: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🇦🇪  UAE Gov Social Hub  →  http://localhost:${PORT}\n`);
  console.log(`   X source        : ${process.env.X_BEARER_TOKEN  ? '✅ X API v2'         : '📡 Nitter RSS (live, no key needed)'}`);
  console.log(`   Instagram source: ${process.env.IG_ACCESS_TOKEN ? '✅ Instagram API'    : process.env.APIFY_TOKEN ? '✅ Apify scraper' : '⚠️  no key — Instagram unavailable'}`);
  console.log(`   Cache TTL       : X=${CACHE_TTL/1000}s  Instagram=${IG_CACHE_TTL/1000}s\n`);
});
