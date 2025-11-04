// index.js — 최종본
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 5000;
app.use(cors());
app.use(express.json({ limit: '2mb' }));




/* ================================
 * 0) MySQL 연결
 * ================================ */
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME || 'facegpt',
  waitForConnections: true,
  connectionLimit: 10,
});


/* ================================
 * 📘 calibration-temp.json 로드
 * ================================ */
let calibration = null;
try {
  const caliPath = path.join(__dirname, 'calibration-temp.json');
  if (fs.existsSync(caliPath)) {
    calibration = JSON.parse(fs.readFileSync(caliPath, 'utf8'));
    console.log('✅ calibration-temp.json 로드 완료');
  } else {
    console.warn('⚠️ calibration-temp.json 파일이 없습니다. 기본값 사용');
  }
} catch (err) {
  console.error('❌ calibration-temp.json 로드 실패:', err.message);
  calibration = null;
}

/* ================================
 * 📘 보정 관련 함수
 * ================================ */
// ① 성향 × 성별별 온도(τ) 가져오기
function getTau(trait, gender) {
  if (!calibration) return 1.0;
  const t = trait?.toLowerCase() || 'neutral';
  const g = gender?.toLowerCase() || 'male';
  return calibration?.[t]?.[g] ?? 1.0;
}

// ② 온도 보정 softmax 적용
function applyCalibration(faceDist, tau = 1.0) {
  if (!faceDist || tau === 1.0) return faceDist;
  const exp = {};
  let sum = 0;
  for (const k of Object.keys(faceDist)) {
    // τ가 작을수록 감정 확신을 강화, 클수록 평준화됨
    exp[k] = Math.pow(faceDist[k], 1 / tau); 
    //τ(온도)가 작을수록(내향형일수록) 1/τ는 커지므로 큰 값이 더 커지고 작은 값은 더 작아짐 → 확신 강화 (Sharper distribution)
    //τ가 클수록(외향형일수록) 1/τ는 작아져서 전체가 평평해짐 → 감정 완화 (Softer distribution)
    sum += exp[k];
  }
  const norm = {};
  for (const k of Object.keys(exp)) norm[k] = exp[k] / sum; //각 값의 비율을 구해서 저장 -> 합은 1이됨 이 과정에서 큰값은 더 커지고 작은값은 작아지거나 or 전체가 평평해짐
  return norm;
}

/* ================================
 * 1) OpenAI (GPT)
 * ================================ */
const OpenAI = require('openai');
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/* ================================
 * 2) Spotify API
 * ================================ */
let spotifyToken = null;
let spotifyTokenExpireAt = 0;

async function getSpotifyAccessToken() {
  const now = Date.now();
  if (spotifyToken && now < spotifyTokenExpireAt) return spotifyToken;

  const tokenUrl = 'https://accounts.spotify.com/api/token';
  const authHeader = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64');

  const res = await axios.post(
    tokenUrl,
    new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${authHeader}`,
      },
    }
  );

  spotifyToken = res.data.access_token;
  spotifyTokenExpireAt = now + (res.data.expires_in - 60) * 1000;
  return spotifyToken;
}

// 한국 K-POP 위주 후보
async function getKoreaTopTracks(limit = 30) {
  const token = await getSpotifyAccessToken();
  const url = `https://api.spotify.com/v1/search?q=genre:k-pop&type=track&market=KR&limit=${Math.min(
    limit,
    50
  )}`;
  const r = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // ISRC KR 필터(한국 음원 선호)
  const items = (r.data.tracks?.items || []).filter((t) =>
    t?.external_ids?.isrc?.startsWith('KR')
  );

  return items.map((t) => ({
    id: t.id,
    title: t.name,
    artist: t.artists.map((a) => a.name).join(', '),
    spotifyUrl: t.external_urls?.spotify || '',
  }));
}

// 10대 추억 윈도우
function teenageWindow(age) {
  const now = new Date().getFullYear();
  if (!age || age < 13 || age > 100) return null;
  const start = now - (age - 13);
  const end = now - (age - 19);
  return [Math.min(start, end), Math.max(start, end)];
}

async function getNostalgiaTracks(age, limit = 30) {
  const win = teenageWindow(age);
  if (!win) return [];
  const [start, end] = win;
  const token = await getSpotifyAccessToken();
  const url = `https://api.spotify.com/v1/search?q=genre:k-pop year:${start}-${end}&type=track&market=KR&limit=${Math.min(
    limit,
    50
  )}`;
  const r = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (r.data.tracks?.items || []).map((t) => ({
    id: t.id,
    title: t.name,
    artist: t.artists.map((a) => a.name).join(', '),
    spotifyUrl: t.external_urls?.spotify || '',
  }));
}

async function getAudioFeatures(ids) {
  try {
    if (!ids?.length) return {};
    const token = await getSpotifyAccessToken();
    const url = `https://api.spotify.com/v1/audio-features?ids=${ids.join(',')}`;
    const res = await axios.get(url, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      validateStatus: (s) => s < 500,
    });

    if (res.status === 403) {
      // 토큰 재발급 유도
      spotifyToken = null;
      await getSpotifyAccessToken();
      return {};
    }

    const feats = {};
    (res.data?.audio_features || []).forEach((f) => {
      if (f && f.id)
        feats[f.id] = {
          valence: f.valence,
          energy: f.energy,
          tempo: f.tempo,
          acousticness: f.acousticness,
          danceability: f.danceability,
        };
    });
    return feats;
  } catch (e) {
    console.error('[getAudioFeatures 실패]', e.response?.status || e.message);
    return {};
  }
}

/* ================================
 * 3) 유틸
 * ================================ */
const EMOTIONS = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'fearful',
  'disgusted',
  'surprised',
];
const EMOTION_ALIAS = {
  neutral: 'neutral',
  happy: 'happy',
  sad: 'sad',
  angry: 'angry',
  fearful: 'fearful',
  disgusted: 'disgusted',
  surprised: 'surprised',
};

function normalizeDist(raw) {
  if (!raw) return null;
  const dist = {};
  let sum = 0;
  for (const e of EMOTIONS) {
    const v = Number(raw?.[e] ?? 0);
    dist[e] = isNaN(v) ? 0 : v;
    sum += dist[e];
  }
  if (sum <= 0) {
    const u = 1 / EMOTIONS.length;
    EMOTIONS.forEach((e) => (dist[e] = u));
    return dist;
  }
  EMOTIONS.forEach((e) => (dist[e] = dist[e] / sum));
  return dist;
}
function argmaxLabel(dist) {
  if (!dist) return 'neutral';
  return Object.entries(dist).sort((a, b) => b[1] - a[1])[0][0];
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ================================
 * 4) 가사 가져오기 (선택)
 *    - GENIUS/MUSIXMATCH 키가 없으면 '' 반환
 * ================================ */
const USE_GENIUS = !!process.env.GENIUS_API_TOKEN;
const USE_MXM = !!process.env.MUSIXMATCH_API_KEY;

async function getLyricsForTrack(title, artist) {
  try {
    if (USE_MXM) {
      // Musixmatch 검색 → track.lyrics.get
      const q = `${title} ${artist}`;
      const search = await axios.get(
        'https://api.musixmatch.com/ws/1.1/track.search',
        {
          params: {
            q_track: title,
            q_artist: artist,
            s_track_rating: 'desc',
            apikey: process.env.MUSIXMATCH_API_KEY,
            page_size: 1,
          },
        }
      );
      const trackId =
        search.data?.message?.body?.track_list?.[0]?.track?.track_id;
      if (trackId) {
        const lyr = await axios.get(
          'https://api.musixmatch.com/ws/1.1/track.lyrics.get',
          { params: { track_id: trackId, apikey: process.env.MUSIXMATCH_API_KEY } }
        );
        const text = lyr.data?.message?.body?.lyrics?.lyrics_body || '';
        return text.replace(/[*].*$/s, '').trim(); // 광고 꼬리 제거
      }
    }

    if (USE_GENIUS) {
      // Genius 검색 후 첫 결과 URL의 가사 스니펫 (API에서 본문은 직접 제공X → 요약만 확보)
      const r = await axios.get('https://api.genius.com/search', {
        headers: { Authorization: `Bearer ${process.env.GENIUS_API_TOKEN}` },
        params: { q: `${title} ${artist}` },
      });
      const hit = r.data?.response?.hits?.[0]?.result;
      if (hit) {
        // 상세 API로 일부 메타를 받아 간단 개요 문장 구성
        const snippet = [
          hit.title_with_featured || hit.full_title || `${title} — ${artist}`,
          hit.primary_artist?.name ? `(artist: ${hit.primary_artist.name})` : '',
        ]
          .filter(Boolean)
          .join(' ');
        return snippet; // 실제 전체 가사는 사이트 스크래핑 필요 → 여기선 스니펫
      }
    }
  } catch (e) {
    console.warn('[Lyrics] 가져오기 실패:', e.response?.data || e.message);
  }
  return '';
}

/* ================================
 * 5) EmotionSpec (GPT)
 * ================================ */
async function createEmotionSpec({ emotion, gender, age }) {
  if (!openai) {
    // GPT가 없으면 기본 스펙
    return {
      mode: 'mixed',
      weights: { empathy: 0.6, relief: 0.4 },
      seedGenres: ['k-pop', 'indie'],
      audioTargets: { valence: [0.4, 0.7], energy: [0.3, 0.6] },
      keywords: [],
      banKeywords: [],
    };
  }

  const prompt = `
당신은 음악 심리 전문가입니다.
감정: ${emotion}, 성별: ${gender}, 나이: ${age}
사용자의 감정 특성(EmotionSpec)을 JSON으로 만드세요.

형식:
{
 "mode": "mixed",
 "weights": {"empathy":0.6,"relief":0.4},
 "seedGenres":["k-pop","indie"],
 "audioTargets":{"valence":[0.4,0.7],"energy":[0.3,0.6]},
 "keywords":["위로","편안","공감"],
 "banKeywords":["분노","공격적"]
}
JSON만 출력하세요.
`;

  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [{ role: 'user', content: prompt }],
  });
  const txt = r.choices[0].message.content.trim();
  const json = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  return json;
}

/* ================================
 * 6) 곡별 감정 적합도 (GPT)
 *    - category: 공감/해소
 *    - reason: 3~4문장
 * ================================ */
async function scoreTrackWithGPT(spec, track, lyrics = '') {
  if (!openai) {
    // GPT 없으면 간단 규칙으로 대체
    const empathyBias = lyrics.includes('슬픔') || lyrics.includes('외로움');
    const category = empathyBias ? '공감' : '해소';
    return {
      scores: { empathy: empathyBias ? 0.8 : 0.3, relief: empathyBias ? 0.3 : 0.8, overall: 0.65 },
      category,
      reason:
        category === '공감'
          ? `${track.title} - ${track.artist} 은/는 가사와 분위기가 현재 감정을 함께 느끼게 해주는 곡입니다.`
          : `${track.title} - ${track.artist} 은/는 경쾌한 흐름으로 감정을 환기시켜주는 해소형 곡입니다.`,
    };
  }

  const prompt = `
당신은 음악 심리학자이자 음악 큐레이터입니다.
아래 EmotionSpec, 곡 정보, 가사를 분석하여
이 곡이 사용자의 감정에 '공감'하거나 '해소'할 수 있는지를 평가하세요.

EmotionSpec: ${JSON.stringify(spec, null, 2)}

곡 정보:
제목: ${track.title}
가수: ${track.artist}
가사: ${lyrics || '(가사 없음)'}

아래 형식의 JSON으로만 출력하세요.
{
 "scores": { "empathy": 0.7, "relief": 0.4, "overall": 0.68 },
 "category": "공감" 또는 "해소",
 "reason": "3~4문장으로, 곡의 분위기·가사·음향적 특징을 감정적으로 따뜻하게 설명 (곡 제목/가수 그대로 언급)"
}
`;
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.7,
    messages: [{ role: 'user', content: prompt }],
  });

  const txt = r.choices[0].message.content.trim();
  const json = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  return json;
}

/* ================================
 * 7) 감정별 오디오 피처 필터 (공감/해소 분기)
 * ================================ */
function filterByEmotionAndType(tracks, feats, emotion, type) {
  const out = [];
  for (const t of tracks) {
    const f = feats[t.id];
    if (!f) continue;

    let ok = true;
    switch (emotion) {
      case 'neutral':
        ok =
          type === 'empathy'
            ? f.energy >= 0.4 && f.energy <= 0.6 && f.valence >= 0.4 && f.valence <= 0.6
            : f.valence > 0.7 && f.energy > 0.6;
        break;
      case 'happy':
        ok = type === 'empathy' ? f.valence > 0.7 && f.energy > 0.6 : f.energy < 0.5 && f.valence > 0.5;
        break;
      case 'sad':
        ok = type === 'empathy' ? f.valence < 0.35 && f.energy < 0.6 : f.valence > 0.6 && f.energy > 0.5;
        break;
      case 'angry':
        ok = type === 'empathy' ? f.energy > 0.7 && f.valence < 0.4 : f.energy < 0.5 && f.valence > 0.6;
        break;
      case 'fearful':
        ok = type === 'empathy' ? f.acousticness > 0.6 && f.energy < 0.5 : f.valence > 0.6 && f.danceability > 0.5;
        break;
      case 'disgusted':
        ok = type === 'empathy' ? f.valence < 0.4 && f.energy < 0.6 : f.valence > 0.7 && f.energy > 0.5;
        break;
      case 'surprised':
        ok = type === 'empathy' ? f.valence > 0.6 && f.energy > 0.6 && f.danceability > 0.5 : f.valence > 0.6 && f.energy < 0.5;
        break;
      default:
        ok = true;
    }
    if (ok) out.push(t);
  }
  return out.length >= 2 ? out : tracks; // 과도 필터 방지
}

/* ================================
 * 8) /recommend
 *    - 공감 2곡 + 해소 1곡
 * ================================ */
app.post('/recommend', async (req, res) => {
  try {
    const {
      age,
      gender,
      emotion,
      faceDist,
      userEmotion,
      nostalgia = 0,
      trait = null,
      quality = null,
    } = req.body || {};

    // 최종 감정 결정 (얼굴 우선)
    let fused = null;
    if (faceDist) {
      fused = normalizeDist(faceDist);
      const tau = getTau(trait, gender);
      fused = applyCalibration(fused, tau);
    }
    const finalEmotion = fused ? argmaxLabel(fused) : EMOTION_ALIAS[emotion] || 'neutral';

    // GPT EmotionSpec
    const spec = await createEmotionSpec({
      emotion: finalEmotion,
      gender,
      age,
    });

    // 후보 검색 (노스탤지어/일반)
    let candidates = nostalgia ? await getNostalgiaTracks(age, 30) : await getKoreaTopTracks(30);
    shuffle(candidates);

    // 오디오 피처
    const feats = await getAudioFeatures(candidates.map((t) => t.id));

    // 공감/해소 후보 분리 (오디오 피처 기반 1차 필터)
    let empathyCand = filterByEmotionAndType(candidates, feats, finalEmotion, 'empathy');
    let reliefCand = filterByEmotionAndType(candidates, feats, finalEmotion, 'relief');

    // 2차: GPT 의미 평가 (병렬 처리)
    // 속도 대비 품질 균형을 위해 앞쪽 8개만 스코어링
    empathyCand = empathyCand.slice(0, 8);
    reliefCand = reliefCand.slice(0, 8);

    const toScore = [
      ...empathyCand.map((t) => ({ ...t, _cat: '공감' })),
      ...reliefCand.map((t) => ({ ...t, _cat: '해소' })),
    ];

    // 가사+스코어 파이프라인 (적당한 동시성)
    const CHUNK = 4;
    const scored = [];
    for (let i = 0; i < toScore.length; i += CHUNK) {
      const chunk = toScore.slice(i, i + CHUNK);
      const part = await Promise.all(
        chunk.map(async (t) => {
          const lyrics = await getLyricsForTrack(t.title, t.artist);
          const s = await scoreTrackWithGPT(spec, t, lyrics);
          const cat = s?.category || t._cat || '공감';
          return {
            ...t,
            category: cat,
            reason: s?.reason || '',
            scores: s?.scores || { overall: 0.5, empathy: 0.5, relief: 0.5 },
          };
        })
      );
      scored.push(...part);
    }

    // 정렬 & 상위 선택
    scored.sort((a, b) => (b.scores?.overall || 0) - (a.scores?.overall || 0));

    let empathyList = scored.filter((t) => t.category === '공감').slice(0, 2);
    let reliefList = scored.filter((t) => t.category === '해소').slice(0, 1);

    if (reliefList.length < 1) {
      const backup =
        scored.find((t) => !empathyList.includes(t)) ||
        empathyList.slice(-1).map((t) => ({ ...t, category: '해소' }))[0];
      if (backup) reliefList = [backup.category === '해소' ? backup : { ...backup, category: '해소' }];
    }

    const combined = [...empathyList, ...reliefList];

    // ✅ YouTube 링크 자동 생성
    if (process.env.YOUTUBE_API_KEY) {
      console.log('🎥 YouTube 링크 추가 중...');
      for (const t of combined) {
        try {
          const q = `${t.title} ${t.artist}`;
          const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(
            q
          )}&type=video&maxResults=1&key=${process.env.YOUTUBE_API_KEY}`;
          const r = await axios.get(url);
          const vid = r.data?.items?.[0]?.id?.videoId;
          t.youtubeUrl = vid ? `https://www.youtube.com/watch?v=${vid}` : '';
        } catch (err) {
          console.warn('[YouTube 검색 실패]', t.title, err.message);
          t.youtubeUrl = '';
        }
      }
    } else {
      // 🔸 API 키가 없을 때는 검색 링크라도 넣어줌
      for (const t of combined) {
        t.youtubeUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(
          t.title + ' ' + t.artist
        )}`;
      }
    }
    // 최종 응답
    res.json({
      emotion: finalEmotion,
      nostalgia: !!nostalgia,
      spec,
      recommendations: combined.map((t) => ({
        title: t.title,
        artist: t.artist,
        spotifyUrl: t.spotifyUrl,
        youtubeUrl: t.youtubeUrl, // ✅ 추가
        category: t.category,
        reason: t.reason || '',
        // 프런트 저장용 보조 필드
        spotifyId: t.id,
      })),
    });
  } catch (e) {
    console.error('[recommend 실패]', e);
    res.status(500).json({ error: 'recommend failed' });
  }
});

/* ================================
 * 9) /recsets (추천 세트 저장)
 * ================================ */
app.post('/recsets', async (req, res) => {
  try {
    const { age = null, gender = null, emotion = null, items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'items(추천 목록)이 필요합니다' });
    }
    const [r] = await pool.execute(
      `INSERT INTO rec_sets (emotion, age, gender, items) VALUES (?,?,?,?)`,
      [emotion || null, age || null, gender || null, JSON.stringify(items)]
    );
    res.json({ ok: true, id: r.insertId });
  } catch (e) {
    console.error('[recsets insert error]', e);
    res.status(500).json({ ok: false, error: 'server error' });
  }
});

/* ================================
 * 10) /history/recsets (페이지네이션 + 마지막 전송 로그)
 *     - MySQL only_full_group_by 호환
 * ================================ */
app.get('/history/recsets', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '20', 10), 1), 50);
    const offset = (page - 1) * pageSize;

    console.log('[history] 요청 도착:', { page, pageSize, offset });

    const [[{ cnt }]] = await pool.query(`SELECT COUNT(*) AS cnt FROM rec_sets`);

    // 마지막 push_logs 1건만 조인 (MySQL 5/8 모두 호환)
    const sql = `
      SELECT 
        rs.id, rs.emotion, rs.age, rs.gender, rs.items, rs.created_at AS createdAt,
        pl.id AS pushId, pl.message, pl.selected_idx AS selectedIdx, pl.created_at AS pushedAt
      FROM rec_sets rs
      LEFT JOIN (
        SELECT pl1.*
        FROM push_logs pl1
        JOIN (
          SELECT rec_set_id, MAX(id) AS max_id
          FROM push_logs
          GROUP BY rec_set_id
        ) last ON last.rec_set_id = pl1.rec_set_id AND last.max_id = pl1.id
      ) pl ON pl.rec_set_id = rs.id
      ORDER BY rs.id DESC
      LIMIT ? OFFSET ?
    `;
    const [rows] = await pool.query(sql, [pageSize, offset]);

    const normalized = rows.map((r) => {
      let itemsArr = [];
      try {
        const raw = r.items;
        if (raw == null) itemsArr = [];
        else if (typeof raw === 'string') itemsArr = JSON.parse(raw);
        else if (Buffer.isBuffer(raw)) itemsArr = JSON.parse(raw.toString('utf8'));
        else if (Array.isArray(raw)) itemsArr = raw;
        else if (typeof raw === 'object') itemsArr = raw;
      } catch (e) {
        console.error('[history items parse fail]', r.id, e);
        itemsArr = [];
      }
      return {
        id: r.id,
        emotion: r.emotion,
        age: r.age,
        gender: r.gender,
        items: itemsArr,
        createdAt: r.createdAt,
        push: r.pushId
          ? { id: r.pushId, message: r.message, selectedIdx: r.selectedIdx, pushedAt: r.pushedAt }
          : null,
      };
    });

    res.json({ ok: true, page, pageSize, total: cnt, items: normalized });
  } catch (e) {
    console.error('[history/recsets ERROR]', e);
    res.status(500).json({ ok: false, error: 'server error' });
  }
});

/* ================================
 * 11) WebSocket 스트리밍 (/ws) + /push
 *      - meta(감정/성별/나이/세트/선택곡) 포함
 * ================================ */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const channels = new Map();
function getChannel(name = 'default') {
  if (!channels.has(name)) channels.set(name, new Set());
  return channels.get(name);
}
wss.on('connection', (ws) => {
  let joined = null;
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'hello' && msg.role === 'stream') {
        const ch = msg.channel || 'default';
        getChannel(ch).add(ws);
        joined = ch;
        ws.send(JSON.stringify({ type: 'ack', channel: ch }));
      }
    } catch { }
  });
  ws.on('close', () => {
    if (joined) getChannel(joined).delete(ws);
  });
});

app.post('/push', async (req, res) => {
  try {
    const {
      channel = 'default',
      song,
      message = '',
      recSetId = null,
      selectedIdx = null,
    } = req.body || {};
    if (!song || !song.title || !song.artist) {
      return res.status(400).json({ ok: false, error: 'song(title,artist) required' });
    }

    const clientIp =
      (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) ||
      req.socket.remoteAddress ||
      '';
    const userAgent = req.headers['user-agent'] || '';

    const [r] = await pool.execute(
      `INSERT INTO push_logs
        (channel, title, artist, youtube_url, spotify_id, message,
         client_ip, user_agent, rec_set_id, selected_idx)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        channel,
        song.title,
        song.artist,
        song.youtubeUrl || null,
        song.spotifyId || null,
        message || null,
        clientIp,
        userAgent,
        recSetId,
        selectedIdx,
      ]
    );
    const insertedId = r.insertId;

    // meta 채우기 (감정/나이/성별)
    let meta = null;
    if (recSetId) {
      const [rows] = await pool.execute(
        `SELECT emotion, age, gender FROM rec_sets WHERE id = ?`,
        [recSetId]
      );
      if (rows && rows[0]) {
        meta = {
          emotion: rows[0].emotion || null,
          age: rows[0].age ?? null,
          gender: rows[0].gender || null,
          recSetId,
          selectedIdx,
        };
      }
    }

    // WS broadcast
    const payload = JSON.stringify({ type: 'play', song, message, logId: insertedId, meta });
    const set = getChannel(channel);
    let delivered = 0;
    set.forEach((ws) => {
      if (ws.readyState === 1) {
        delivered++;
        ws.send(payload);
      }
    });

    res.json({ ok: true, delivered, id: insertedId });
  } catch (e) {
    console.error('[push error]', e);
    res.status(500).json({ ok: false, error: 'server error' });
  }
});

/* ================================
 * 12) YouTube 링크 (선택) — 프런트에서 호출할 수도 있음
 * ================================ */
const USE_YOUTUBE = !!process.env.YOUTUBE_API_KEY;
app.get('/yt', async (req, res) => {
  try {
    if (!USE_YOUTUBE) return res.json({ url: '' });
    const q = `${req.query.title || ''} ${req.query.artist || ''}`.trim();
    if (!q) return res.json({ url: '' });
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(
      q
    )}&type=video&maxResults=1&key=${process.env.YOUTUBE_API_KEY}`;
    const r = await axios.get(url);
    const vid = r.data?.items?.[0]?.id?.videoId;
    res.json({ url: vid ? `https://www.youtube.com/watch?v=${vid}` : '' });
  } catch (e) {
    console.error('[YouTube 검색 실패]', e.response?.data || e.message);
    res.json({ url: '' });
  }
});

/* ================================
 * 13) 정적 리소스 / 헬스체크
 * ================================ */
app.use('/stream', express.static(path.join(__dirname, 'streaming-client')));
app.get('/health', (_, res) => res.json({ ok: true }));

server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
