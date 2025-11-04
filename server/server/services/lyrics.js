// ✅ 최종 정리된 lyrics.js (Genius 버전 예시)
const axios = require('axios');
const GENIUS_API = 'https://api.genius.com';

async function getLyricsForTrack(title, artist) {
  const token = process.env.GENIUS_API_KEY;
  if (!token) return '';

  try {
    const query = `${title} ${artist}`;
    const res = await axios.get(`${GENIUS_API}/search?q=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const hit = res.data?.response?.hits?.[0]?.result;
    if (!hit?.url) return '';

    const html = (await axios.get(hit.url)).data;
    const blocks = [...html.matchAll(/<div class="Lyrics__Container[^>]*>([\s\S]*?)<\/div>/g)];
    let raw = blocks.map(b => b[1]).join('\n');
    if (!raw) {
      const alt = html.match(/<div class="lyrics">([\s\S]*?)<\/div>/);
      raw = alt ? alt[1] : '';
    }

    const text = raw
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();

    return text.slice(0, 4000);
  } catch (e) {
    console.warn('[Genius lyrics fail]', e.message);
    return '';
  }
}

module.exports = { getLyricsForTrack };
