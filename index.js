require('dotenv').config();
const { Client, RichPresence } = require('discord.js-selfbot-v13');
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CLIENT_ID = '1538974355193593856';

// Trạng thái bài hát hiện tại
let currentTrack = null;
let currentLyrics = [];
let currentImageKey = null;
let lastTrackId = '';
let lastMusicUpdate = 0;
let lastPresenceKey = '';
let lastSetActivityTime = 0;

const lyricsCache = new Map();

// Làm sạch tên ca sĩ (loại bỏ - Topic, VEVO, Official...)
function cleanArtist(artist) {
    if (!artist) return '';
    return artist
        .replace(/\s*-\s*Topic\s*/gi, '')
        .replace(/\s*-\s*Chủ đề\s*/gi, '')
        .replace(/VEVO$/gi, '')
        .replace(/Official$/gi, '')
        .trim();
}

// Lấy ca sĩ chính
function getPrimaryArtist(artist) {
    if (!artist) return '';
    const cleaned = cleanArtist(artist);
    return cleaned.split(/,| và | ft\. | feat\. | x | & /i)[0].trim();
}

// Làm sạch tên bài hát
function cleanTitle(title) {
    if (!title) return '';
    return title
        .replace(/\(Official.*?\)/gi, '')
        .replace(/\[Official.*?\]/gi, '')
        .replace(/\(Audio.*?\)/gi, '')
        .replace(/\[Audio.*?\]/gi, '')
        .replace(/\(Lyric.*?\)/gi, '')
        .replace(/\[Lyric.*?\]/gi, '')
        .replace(/\(MV.*?\)/gi, '')
        .replace(/\[MV.*?\]/gi, '')
        .replace(/\|.*$/g, '')
        .replace(/-.*MV$/gi, '')
        .replace(/\s*-\s*Topic\s*/gi, '')
        .trim();
}

// LẤY CHÍNH XÁC ẢNH BÌA TỪ NGUỒN PHÁT (TUYỆT ĐỐI KHÔNG TÌM KIẾM BỪA TRÊN YOUTUBE ĐỂ TRÁNH LẤY NHẦM ẢNH)
function getExactArtworkKey(track) {
    if (!track) return null;

    // 1. YouTube & YouTube Music: Dùng chính xác Video ID đang phát trong tab
    if (track.videoId && typeof track.videoId === 'string' && track.videoId.length >= 5) {
        return `youtube:${track.videoId}`;
    }
    if (track.url) {
        const ytMatch = track.url.match(/[?&]v=([^&#]+)/) || track.url.match(/youtu\.be\/([^&#]+)/);
        if (ytMatch) return `youtube:${ytMatch[1]}`;
    }
    if (track.artwork && track.artwork.includes('/vi/')) {
        const viMatch = track.artwork.match(/\/vi\/([^\/]+)\//);
        if (viMatch) return `youtube:${viMatch[1]}`;
    }

    // 2. Spotify: Dùng chính xác Image ID từ Spotify CDN
    if (track.artwork && track.artwork.includes('scdn.co/image/')) {
        const spotId = track.artwork.split('scdn.co/image/')[1].split('?')[0];
        if (spotId) return `spotify:${spotId}`;
    }

    return null;
}

// Phân tích cú pháp LRC [mm:ss.xx]
function parseLRC(lrcText) {
    if (!lrcText) return [];
    const lines = lrcText.split('\n');
    const result = [];
    const timeRegex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/g;

    for (const line of lines) {
        let match;
        const matches = [];
        while ((match = timeRegex.exec(line)) !== null) {
            const min = parseInt(match[1], 10);
            const sec = parseInt(match[2], 10);
            const ms = match[3] ? parseInt(match[3].padEnd(3, '0').slice(0, 3), 10) : 0;
            matches.push(min * 60 + sec + ms / 1000);
        }

        const text = line.replace(timeRegex, '').trim();
        if (text) {
            for (const timeSec of matches) {
                result.push({ timeSec, text });
            }
        }
    }

    result.sort((a, b) => a.timeSec - b.timeSec);
    return result;
}

// Lấy lời bài hát từ LRCLIB
async function fetchLyrics(title, artist) {
    const cleanedTitle = cleanTitle(title);
    const primaryArtist = getPrimaryArtist(artist);
    const cacheKey = `${cleanedTitle} - ${primaryArtist}`.toLowerCase();

    if (lyricsCache.has(cacheKey)) {
        return lyricsCache.get(cacheKey);
    }

    try {
        let res = await axios.get('https://lrclib.net/api/get', {
            params: {
                track_name: cleanedTitle,
                artist_name: primaryArtist || undefined
            },
            timeout: 3000
        });

        if (res.data && res.data.syncedLyrics) {
            const parsed = parseLRC(res.data.syncedLyrics);
            lyricsCache.set(cacheKey, parsed);
            return parsed;
        }
    } catch (e) {}

    try {
        let res = await axios.get('https://lrclib.net/api/search', {
            params: {
                q: `${cleanedTitle} ${primaryArtist}`.trim()
            },
            timeout: 3000
        });

        if (res.data && res.data.length > 0) {
            for (const item of res.data) {
                if (item.syncedLyrics) {
                    const parsed = parseLRC(item.syncedLyrics);
                    lyricsCache.set(cacheKey, parsed);
                    return parsed;
                }
            }
        }
    } catch (e) {}

    lyricsCache.set(cacheKey, []);
    return [];
}

const client = new Client({ checkUpdate: false });
const startTime = Date.now();

// Cập nhật trạng thái Rich Presence lên Discord
async function updatePresence(force = false) {
    if (!client.user) return;

    // Nếu quá 7 giây không nhận được tín hiệu -> quay về mặc định
    const isMusicActive = currentTrack && !currentTrack.paused && (Date.now() - lastMusicUpdate < 7000);

    if (!isMusicActive && currentTrack) {
        currentTrack = null;
        lastTrackId = '';
        currentLyrics = [];
        currentImageKey = null;
    }

    try {
        if (isMusicActive) {
            // --- CHẾ ĐỘ PHÁT NHẠC (Đang nghe...) ---
            const track = currentTrack;
            
            const elapsedSincePing = (Date.now() - lastMusicUpdate) / 1000;
            const liveCurrentTime = Math.min(track.duration || 9999, (track.currentTime || 0) + elapsedSincePing);
            const effectiveTime = liveCurrentTime + 0.35;
            const duration = track.duration || 0;

            let activeLyric = '';
            if (currentLyrics && currentLyrics.length > 0) {
                for (let i = 0; i < currentLyrics.length; i++) {
                    const line = currentLyrics[i];
                    const nextLine = currentLyrics[i + 1];
                    const lineEndTime = nextLine ? nextLine.timeSec : line.timeSec + 6;

                    if (effectiveTime >= line.timeSec && effectiveTime < lineEndTime) {
                        if (effectiveTime - line.timeSec <= 5.5) {
                            activeLyric = line.text;
                        }
                        break;
                    }
                }
            }

            const platform = track.platform || 'Music';
            const songName = cleanTitle(track.title) || 'Unknown Song';
            const artistName = cleanArtist(track.artist) || 'Artist';

            // 📌 DÒNG 1: Tên bài hát
            const detailsText = `🎵 ${songName}`.substring(0, 127);
            
            // 📌 DÒNG 2: Tên ca sĩ
            const stateText = `🎧 ${artistName}`.substring(0, 127);

            // 📌 DÒNG 3: Lời bài hát chạy theo từng giây (hoặc platform nếu đang dạo nhạc)
            const largeImageText = activeLyric ? `🎤 ${activeLyric}` : `✨ ${platform}`;

            const presenceKey = `MUSIC|${songName}|${stateText}|${currentImageKey}|${largeImageText}`;
            if (!force && presenceKey === lastPresenceKey && (Date.now() - lastSetActivityTime < 12000)) {
                return;
            }
            lastPresenceKey = presenceKey;
            lastSetActivityTime = Date.now();

            const presence = new RichPresence(client)
                .setApplicationId(CLIENT_ID)
                .setType('LISTENING') // 🎧 Đang nghe
                .setName('PhucLam')
                .setDetails(detailsText)
                .setState(stateText);

            if (currentImageKey) {
                presence.setAssetsLargeImage(currentImageKey);
                presence.setAssetsLargeText(largeImageText.substring(0, 127));
            }

            if (duration > 0 && liveCurrentTime >= 0) {
                presence.setStartTimestamp(Math.floor(Date.now() - liveCurrentTime * 1000));
                presence.setEndTimestamp(Math.floor(Date.now() + (duration - liveCurrentTime) * 1000));
            }

            if (track.url && (track.url.startsWith('http://') || track.url.startsWith('https://'))) {
                presence.addButton(`▶️ Nghe trên ${platform}`, track.url);
            }
            presence.addButton('PhucFeFa', 'https://github.com/PhucFeFa');

            await client.user.setActivity(presence);

        } else {
            // --- CHẾ ĐỘ MẶC ĐỊNH (Đang nghe PhucLam - Gender: Male) ---
            const presenceKey = 'DEFAULT_LISTENING';
            if (!force && presenceKey === lastPresenceKey && (Date.now() - lastSetActivityTime < 20000)) {
                return;
            }
            lastPresenceKey = presenceKey;
            lastSetActivityTime = Date.now();

            const presence = new RichPresence(client)
                .setApplicationId(CLIENT_ID)
                .setType('LISTENING')
                .setName('PhucLam')
                .setDetails('Gender: Male')
                .setStartTimestamp(startTime)
                .addButton('PhucFeFa', 'https://github.com/PhucFeFa')
                .addButton('snvv', 'https://www.instagram.com/lhphucclh?igsh=dHc4dmlqd2tseGE1&igsi=dHc4dmlqd2tseGE1&utm_source=qr');

            await client.user.setActivity(presence);
        }
    } catch (err) {
        console.error('❌ Lỗi updatePresence:', err.message);
    }
}

async function handleTrackData(data) {
    if (!data || !data.title || data.paused) {
        currentTrack = null;
        updatePresence(true);
        return { ok: true, reset: true };
    }

    lastMusicUpdate = Date.now();
    currentTrack = data;

    const trackId = `${cleanTitle(data.title)} - ${cleanArtist(data.artist)}`;
    if (trackId !== lastTrackId) {
        lastTrackId = trackId;
        lastPresenceKey = '';
        console.log(`\n🎵 BÀI HÁT: "${data.title}" (${cleanArtist(data.artist)}) trên ${data.platform || 'Web'}`);

        // 1. Lấy CHÍNH XÁC ảnh bìa từ nguồn phát (Không đoán mò trên YouTube)
        currentImageKey = getExactArtworkKey(data);

        // 2. Cập nhật trạng thái ngay lập tức
        updatePresence(true);

        // 3. Tra cứu lời bài hát ngầm
        fetchLyrics(data.title, data.artist).then(lyrics => {
            currentLyrics = lyrics;
            updatePresence(true);
        });

    } else {
        updatePresence(false);
    }

    return { ok: true };
}

// Router nhận dữ liệu nhạc từ trình duyệt (Hỗ trợ cả POST và GET)
app.get('/', (req, res) => {
    res.send('✅ Discord 24/7 Music & Synced Lyrics Selfbot is RUNNING!');
});

app.post('/track', async (req, res) => {
    const result = await handleTrackData(req.body);
    res.json(result);
});

app.get('/track', async (req, res) => {
    const data = { ...req.query };
    data.currentTime = parseFloat(data.currentTime) || 0;
    data.duration = parseFloat(data.duration) || 0;
    data.paused = data.paused === 'true';
    const result = await handleTrackData(data);
    res.json(result);
});

app.post('/stop', (req, res) => {
    currentTrack = null;
    lastTrackId = '';
    currentLyrics = [];
    currentImageKey = null;
    updatePresence(true);
    res.json({ ok: true });
});

app.get('/stop', (req, res) => {
    currentTrack = null;
    lastTrackId = '';
    currentLyrics = [];
    currentImageKey = null;
    updatePresence(true);
    res.json({ ok: true });
});

app.listen(PORT, () => {
    console.log(`🌐 Web server đang lắng nghe tại port ${PORT}`);
});

client.on('ready', async () => {
    console.log('\n======================================================');
    console.log(`🎉 ĐÃ ĐĂNG NHẬP THÀNH CÔNG: ${client.user.tag}`);
    console.log('🤖 Đang kích hoạt chế độ Rich Presence 24/7 (LISTENING)...');
    console.log('======================================================\n');

    updatePresence(true);

    setInterval(() => {
        updatePresence(false);
    }, 500);
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
    console.error('❌ LỖI: Chưa cấu hình DISCORD_TOKEN trong file .env');
    process.exit(1);
}

client.login(token).catch((err) => {
    console.error('❌ Lỗi khi đăng nhập Discord:', err.message);
});
