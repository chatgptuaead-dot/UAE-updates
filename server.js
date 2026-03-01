require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const xml2js  = require('xml2js');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '300000'); // 5 min

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Cache ────────────────────────────────────────────────────────────────────
const cache = new Map();
const getCached = key => {
  const e = cache.get(key);
  return (e && Date.now() - e.ts < CACHE_TTL) ? e.data : null;
};
const setCache = (key, data) => cache.set(key, { data, ts: Date.now() });

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

// ─── Instagram ────────────────────────────────────────────────────────────────
async function fetchIGAccount(username) {
  const key = `ig_${username}`;
  const cached = getCached(key);
  if (cached) return cached;

  const meta = ACCOUNT_META[username] || { name: username };

  // Official Instagram Graph API
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

        const result = {
          account: { username, name: meta.name, avatar: `https://unavatar.io/instagram/${username}` },
          posts,
          source: 'api',
        };
        setCache(key, result);
        return result;
      }
    } catch (err) {
      console.error(`[IG API] @${username}:`, err.message);
    }
  }

  // No Instagram credentials — tell the user clearly
  return {
    account: { username, name: meta.name, avatar: `https://unavatar.io/instagram/${username}` },
    posts:   [],
    source:  'unavailable',
    error:   'Instagram requires API credentials. See .env.example for setup.',
  };
}

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
  console.log(`   X source        : ${process.env.X_BEARER_TOKEN  ? '✅ X API v2'        : '📡 Nitter RSS (live, no key needed)'}`);
  console.log(`   Instagram source: ${process.env.IG_ACCESS_TOKEN ? '✅ Instagram API'   : '⚠️  no key — Instagram unavailable'}`);
  console.log(`   Cache TTL       : ${CACHE_TTL / 1000}s\n`);
});
