/* ═══════════════════════════════════════════════════════════════════════════
   UAE Gov Social Hub — Frontend
   ═══════════════════════════════════════════════════════════════════════════ */

class SocialHub {
  constructor() {
    this.platform = 'news';
    this.cache    = {};
    this.loading  = false;

    this.$grid       = document.getElementById('feedGrid');
    this.$sourceBadge= document.getElementById('sourceBadge');
    this.$updateTime = document.getElementById('updateTime');
    this.$refreshBtn = document.getElementById('refreshAllBtn');

    this._bindEvents();
    this._load('news');
  }

  // ── Events ────────────────────────────────────────────────────────────────
  _bindEvents() {
    document.querySelectorAll('.platform-btn').forEach(btn => {
      btn.addEventListener('click', () => this._switchPlatform(btn.dataset.platform));
    });
    this.$refreshBtn.addEventListener('click', () => {
      delete this.cache[this.platform];
      this._load(this.platform);
    });
  }

  _switchPlatform(platform) {
    if (platform === this.platform && this.cache[platform]) return;
    this.platform = platform;

    document.querySelectorAll('.platform-btn').forEach(btn => {
      const on = btn.dataset.platform === platform;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on);
    });

    this.$grid.className = `feed-grid platform-${platform}`;

    if (this.cache[platform]) {
      this._render(this.cache[platform]);
    } else {
      this._load(platform);
    }
  }

  // ── Data ──────────────────────────────────────────────────────────────────
  async _load(platform) {
    if (this.loading) return;
    this.loading = true;
    this._setSpinning(true);
    this._renderSkeletons(platform === 'news' ? 14 : 9, platform === 'news' ? 2 : 3);

    try {
      const endpoint = platform === 'x' ? '/api/x' : platform === 'instagram' ? '/api/instagram' : '/api/news';
      const res  = await fetch(endpoint);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Server error');

      this.cache[platform] = json.data;
      this._render(json.data);
      this._updateMeta(json.data);
    } catch (err) {
      this._renderError(err.message);
    } finally {
      this.loading = false;
      this._setSpinning(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  _render(accounts) {
    this.$grid.innerHTML = '';
    accounts.forEach((data, i) => {
      const card = data.source === 'unavailable'
        ? this._buildUnavailableCard(data)
        : this._buildCard(data);
      card.style.animationDelay = `${i * 50}ms`;
      this.$grid.appendChild(card);
    });
  }

  _buildCard({ account, posts, source }) {
    const card = document.createElement('article');
    card.className = 'account-card';

    const profileUrl = this.platform === 'instagram'
      ? `https://instagram.com/${account.username}`
      : `https://twitter.com/${account.username}`;

    const avatarFallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(account.name)}&background=003087&color=fff&size=96&bold=true`;

    const sourceLabel = source === 'rss'
      ? '<span class="source-tag rss-tag">RSS</span>'
      : '';

    card.innerHTML = `
      <div class="account-header">
        <div class="account-avatar-wrap">
          <img class="account-avatar"
               src="${account.avatar || avatarFallback}"
               alt="${this._esc(account.name)}"
               loading="lazy"
               onerror="this.onerror=null;this.src='${avatarFallback}'" />
          ${account.verified ? '<span class="verified-badge" aria-label="Verified">✓</span>' : ''}
        </div>
        <div class="account-info">
          <div class="account-name">${this._esc(account.name)} ${sourceLabel}</div>
          <div class="account-username">@${this._esc(account.username)}</div>
        </div>
        <a class="account-link" href="${profileUrl}" target="_blank" rel="noopener noreferrer" aria-label="View profile">
          ${this._extLinkSvg(14)}
        </a>
      </div>
      <div class="posts-list">
        ${posts.map((p, i) => this._buildPost(p, i)).join('')}
      </div>`;

    return card;
  }

  _buildUnavailableCard({ account, error }) {
    const card = document.createElement('article');
    card.className = 'account-card unavailable-card';

    const profileUrl = this.platform === 'instagram'
      ? `https://instagram.com/${account.username}`
      : `https://twitter.com/${account.username}`;

    const avatarFallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(account.name)}&background=003087&color=fff&size=96&bold=true`;

    card.innerHTML = `
      <div class="account-header">
        <div class="account-avatar-wrap">
          <img class="account-avatar"
               src="${account.avatar || avatarFallback}"
               alt="${this._esc(account.name)}"
               loading="lazy"
               onerror="this.onerror=null;this.src='${avatarFallback}'" />
        </div>
        <div class="account-info">
          <div class="account-name">${this._esc(account.name)}</div>
          <div class="account-username">@${this._esc(account.username)}</div>
        </div>
        <a class="account-link" href="${profileUrl}" target="_blank" rel="noopener noreferrer">
          ${this._extLinkSvg(14)}
        </a>
      </div>
      <div class="unavailable-body">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="unavailable-icon">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <p class="unavailable-msg">${this._esc(error || 'Posts unavailable')}</p>
      </div>`;

    return card;
  }

  _buildPost(post, idx) {
    const time    = this._timeAgo(post.created_at);
    const absTime = post.created_at ? this._absTime(post.created_at) : '';
    const text    = this._truncate(post.text, 200);
    const metrics = post.metrics ? this._metricsHtml(post.metrics) : '';

    const imageHtml = post.image ? `
      <div class="post-image-wrap">
        <img class="post-image" src="${this._esc(post.image)}" alt="" loading="lazy"
             onerror="this.closest('.post-image-wrap').remove()" />
      </div>` : '';

    return `
      <div class="post-item">
        ${imageHtml}
        <div class="post-row-top">
          <span class="post-num">${idx + 1}</span>
          <p class="post-text">${this._fmtText(text)}</p>
        </div>
        <div class="post-footer">
          <div class="post-metrics">${metrics}</div>
          <div class="post-meta">
            <span class="post-time" title="${absTime}">${time}</span>
            <a class="post-link" href="${this._esc(post.url)}" target="_blank" rel="noopener noreferrer" aria-label="Open post">
              ${this._extLinkSvg(12)}
            </a>
          </div>
        </div>
      </div>`;
  }

  // ── Skeletons ─────────────────────────────────────────────────────────────
  _renderSkeletons(count = 9, postsPerCard = 3) {
    this.$grid.innerHTML = Array.from({ length: count }, () => `
      <article class="account-card skeleton-card" aria-hidden="true">
        <div class="account-header">
          <div class="skeleton skeleton-avatar"></div>
          <div class="account-info" style="flex:1">
            <div class="skeleton skeleton-text" style="width:65%;margin-bottom:6px"></div>
            <div class="skeleton skeleton-text" style="width:40%"></div>
          </div>
        </div>
        <div class="posts-list">
          ${Array.from({ length: postsPerCard }, () => `
            <div class="post-item">
              <div class="post-row-top">
                <div class="skeleton skeleton-num"></div>
                <div style="flex:1">
                  <div class="skeleton skeleton-text"></div>
                  <div class="skeleton skeleton-text" style="width:80%"></div>
                  <div class="skeleton skeleton-text" style="width:55%"></div>
                </div>
              </div>
            </div>`).join('')}
        </div>
      </article>`).join('');
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  _renderError(message) {
    this.$grid.innerHTML = `
      <div class="error-state">
        <div class="error-icon">⚠️</div>
        <h3>Failed to load</h3>
        <p>${this._esc(message)}</p>
        <button onclick="hub._load(hub.platform)">Try again</button>
      </div>`;
  }

  // ── Meta bar ──────────────────────────────────────────────────────────────
  _updateMeta(accounts) {
    const time = new Date().toLocaleTimeString('en-AE', { hour: '2-digit', minute: '2-digit' });
    this.$updateTime.textContent = `Updated ${time}`;

    // Show badge only when Instagram has no keys
    const allUnavailable = accounts.every(a => a.source === 'unavailable');
    const someRSS        = accounts.some(a => a.source === 'rss');

    let badgeText = '';
    let badgeClass = '';
    if (allUnavailable) {
      badgeText = 'API keys required';
      badgeClass = 'badge-warn';
    } else if (someRSS) {
      badgeText = 'Via Nitter RSS';
      badgeClass = 'badge-rss';
    }

    if (badgeText) {
      this.$sourceBadge.textContent = badgeText;
      this.$sourceBadge.className   = `source-badge ${badgeClass} visible`;
    } else {
      this.$sourceBadge.className = 'source-badge';
    }
  }

  // ── Formatters ────────────────────────────────────────────────────────────
  _metricsHtml(m) {
    if (!m) return '';
    const fmt = n => {
      if (!n || n < 0) return null;
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
      if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
      return String(n);
    };

    const parts = [];
    if (m.retweet_count !== undefined) {
      const l = fmt(m.like_count);
      const r = fmt(m.retweet_count);
      const c = fmt(m.reply_count);
      if (l) parts.push(`<span class="metric"><span class="metric-icon">♥</span>${l}</span>`);
      if (r) parts.push(`<span class="metric"><span class="metric-icon">↺</span>${r}</span>`);
      if (c) parts.push(`<span class="metric"><span class="metric-icon">💬</span>${c}</span>`);
    } else {
      const l = fmt(m.like_count);
      const c = fmt(m.comments_count);
      if (l) parts.push(`<span class="metric"><span class="metric-icon">♥</span>${l}</span>`);
      if (c) parts.push(`<span class="metric"><span class="metric-icon">💬</span>${c}</span>`);
    }
    return parts.join('');
  }

  // "2h ago", "just now", "Mar 1" …
  _timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    if (isNaN(diff) || diff < 0) return this._absTime(dateStr);
    if (diff < 60_000)       return 'just now';
    if (diff < 3_600_000)    return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000)   return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 604_800_000)  return `${Math.floor(diff / 86_400_000)}d ago`;
    return this._absTime(dateStr);
  }

  // Absolute "Mar 1, 10:30 AM"
  _absTime(dateStr) {
    if (!dateStr) return '';
    try {
      return new Date(dateStr).toLocaleString('en-AE', {
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
      });
    } catch { return ''; }
  }

  _truncate(str, max) {
    if (!str) return '';
    const s = str.replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max).trimEnd() + '…' : s;
  }

  _esc(str = '') {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  _fmtText(str = '') {
    return this._esc(str)
      .replace(/@(\w+)/g, '<span class="mention">@$1</span>')
      .replace(/#(\w+)/g, '<span class="hashtag">#$1</span>');
  }

  _extLinkSvg(size = 14) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
      <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
    </svg>`;
  }

  _setSpinning(on) {
    this.$refreshBtn.classList.toggle('spinning', on);
  }
}

const hub = new SocialHub();
