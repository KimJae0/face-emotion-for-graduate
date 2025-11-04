// player.js 전체 교체 (혹은 아래 변경 반영)
const wsStat = document.getElementById('wsStat');
const content = document.getElementById('content');

function toYouTubeEmbed(url='') {
  if (!url) return '';
  if (url.includes('watch?v=')) return url.replace('watch?v=', 'embed/');
  if (url.includes('/embed/')) return url;
  return '';
}

// ✅ meta(감정/성별/나이/세트/선택곡)까지 렌더
function render(song, message, meta) {
  content.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = `${song.title} — ${song.artist}`;
  content.appendChild(title);

  // 감정/성별/나이 칩
  if (meta && (meta.emotion || meta.gender || meta.age != null || meta.recSetId || meta.selectedIdx != null)) {
    const metaBox = document.createElement('div');
    metaBox.className = 'box';
    const chips = document.createElement('div');
    chips.className = 'chips';

    if (meta.emotion) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = `감정: ${meta.emotion}`;
      chips.appendChild(c);
    }
    if (meta.gender) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = `성별: ${meta.gender}`;
      chips.appendChild(c);
    }
    if (meta.age != null) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = `나이: ${meta.age}`;
      chips.appendChild(c);
    }
    if (meta.recSetId) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = `세트 #${meta.recSetId}`;
      chips.appendChild(c);
    }
    if (meta.selectedIdx != null) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = `선택: ${meta.selectedIdx + 1}번`;
      chips.appendChild(c);
    }

    metaBox.appendChild(chips);
    content.appendChild(metaBox);
  }

  // YouTube 우선 재생
  const yt = toYouTubeEmbed(song.youtubeUrl || '');
  if (yt) {
    const frame = document.createElement('iframe');
    frame.width = '100%';
    frame.height = '540';
    frame.allow =
      'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    frame.allowFullscreen = true;
    frame.src = yt;
    content.appendChild(frame);
  } else {
    const noSrc = document.createElement('div');
    noSrc.className = 'box';
    noSrc.textContent = '재생 소스가 없습니다(YouTube 링크 없음)';
    content.appendChild(noSrc);
  }

  const msgBox = document.createElement('div');
  msgBox.className = 'box';
  msgBox.textContent = message ? `📢 ${message}` : '메시지가 도착하면 여기 표시됩니다';
  content.appendChild(msgBox);
}

(function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    wsStat.textContent = 'WS connected';
    ws.send(JSON.stringify({ type: 'hello', role: 'stream', channel: 'default' }));
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'play') render(msg.song || {}, msg.message || '', msg.meta || null);
    } catch {}
  };

  ws.onclose = () => (wsStat.textContent = 'WS disconnected');
})();
