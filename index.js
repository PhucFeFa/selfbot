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
let currentArtworkKey = null;
let lastTrackId = '';
let lastMusicUpdate = 0;
let lastPresenceKey = '';
let lastSetActivityTime = 0;

const lyricsCache = new Map();
const artworkCache = new Map();

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

// Lấy ca sĩ chính (loại bỏ các ca sĩ phụ / ft / và)
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

// Tìm ảnh bìa Album HD vuông 1:1 chuẩn quốc tế (không bao giờ bị viền đen)
async function fetchHighResArtwork(title, artist, fallbackTrack) {
    const cleanedTitle = cleanTitle(title);
    const primaryArtist = getPrimaryArtist(artist);
    const cacheKey = `${cleanedTitle} - ${primaryArtist}`.toLowerCase();

    if (artworkCache.has(cacheKey)) {
        return artworkCache.get(cacheKey);
    }

    // 1. Tìm ảnh bìa HD 600x600 từ iTunes
    try {
        const res = await axios.get('https://itunes.apple.com/search', {
            params: {
                term: `${cleanedTitle} ${primaryArtist}`.trim(),
                entity: 'song',
                limit: 1
            },
            timeout: 4000
        });

        if (res.data && res.data.results && res.data.results.length > 0) {
            const rawUrl = res.data.results[0].artworkUrl100;
            if (rawUrl) {
                const highResUrl = rawUrl.replace('100x100bb', '600x600bb');
                const discordImg = `mp:${highResUrl}`;
                artworkCache.set(cacheKey, discordImg);
                console.log(`🖼️ Đã tìm thấy ảnh bìa Album vuông HD từ iTunes cho "${cleanedTitle}"`);
                return discordImg;
            }
        }
    } catch (e) {}

    // 2. Định dạng Spotify Native
    if (fallbackTrack && fallbackTrack.artwork && fallbackTrack.artwork.includes('scdn.co/image/')) {
        const spotId = fallbackTrack.artwork.split('scdn.co/image/')[1].split('?')[0];
        if (spotId) {
            const discordImg = `spotify:${spotId}`;
            artworkCache.set(cacheKey, discordImg);
            return discordImg;
        }
    }

    // 3. Định dạng YouTube Native
    if (fallbackTrack) {
        if (fallbackTrack.videoId) {
            const discordImg = `youtube:${fallbackTrack.videoId}`;
            artworkCache.set(cacheKey, discordImg);
            return discordImg;
        }
        if (fallbackTrack.url) {
            const ytMatch = fallbackTrack.url.match(/[?&]v=([^&#]+)/) || fallbackTrack.url.match(/youtu\.be\/([^&#]+)/);
            if (ytMatch) {
                const discordImg = `youtube:${ytMatch[1]}`;
                artworkCache.set(cacheKey, discordImg);
                return discordImg;
            }
        }
        if (fallbackTrack.artwork && fallbackTrack.artwork.includes('/vi/')) {
            const viMatch = fallbackTrack.artwork.match(/\/vi\/([^\/]+)\//);
            if (viMatch) {
                const discordImg = `youtube:${viMatch[1]}`;
                artworkCache.set(cacheKey, discordImg);
                return discordImg;
            }
        }
    }

    return null;
}

// Lấy lời bài hát từ LRCLIB (Tìm kiếm đa tầng thông minh)
async function fetchLyrics(title, artist) {
    const cleanedTitle = cleanTitle(title);
    const primaryArtist = getPrimaryArtist(artist);
    const cacheKey = `${cleanedTitle} - ${primaryArtist}`.toLowerCase();

    if (lyricsCache.has(cacheKey)) {
        return lyricsCache.get(cacheKey);
    }

    console.log(`🔍 Đang tìm lời: "${cleanedTitle}" (Ca sĩ: "${primaryArtist || 'Unknown'}")`);

    // 1. Tìm chính xác với ca sĩ chính
    try {
        let res = await axios.get('https://lrclib.net/api/get', {
            params: {
                track_name: cleanedTitle,
                artist_name: primaryArtist || undefined
            },
            timeout: 4000
        });

        if (res.data && res.data.syncedLyrics) {
            const parsed = parseLRC(res.data.syncedLyrics);
            lyricsCache.set(cacheKey, parsed);
            console.log(`✨ Đã tìm thấy lời bài hát khớp thời gian (${parsed.length} câu)`);
            return parsed;
        }
    } catch (e) {}

    // 2. Tìm kiếm theo cụm từ "Tên bài + Ca sĩ chính"
    try {
        let res = await axios.get('https://lrclib.net/api/search', {
            params: {
                q: `${cleanedTitle} ${primaryArtist}`.trim()
            },
            timeout: 4000
        });

        if (res.data && res.data.length > 0) {
            for (const item of res.data) {
                if (item.syncedLyrics) {
                    const parsed = parseLRC(item.syncedLyrics);
                    lyricsCache.set(cacheKey, parsed);
                    console.log(`✨ Đã tìm thấy lời bài hát từ kết quả: "${item.trackName}" - ${item.artistName}`);
                    return parsed;
                }
            }
        }
    } catch (e) {}

    // 3. Tìm kiếm theo tên bài hát
    try {
        let res = await axios.get('https://lrclib.net/api/search', {
            params: {
                q: cleanedTitle
            },
            timeout: 4000
        });

        if (res.data && res.data.length > 0) {
            for (const item of res.data) {
                if (item.syncedLyrics) {
                    const parsed = parseLRC(item.syncedLyrics);
                    lyricsCache.set(cacheKey, parsed);
                    console.log(`✨ Đã tìm thấy lời bài hát theo tên bài: "${item.trackName}"`);
                    return parsed;
                }
            }
        }
    } catch (e) {}

    lyricsCache.set(cacheKey, []);
    console.log('ℹ️ Không có lời bài hát khớp thời gian cho bài này.');
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
        currentArtworkKey = null;
    }

    try {
        if (isMusicActive) {
            // --- CHẾ ĐỘ PHÁT NHẠC ---
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

            const detailsText = `🎵 ${songName}`.substring(0, 127);
            const stateText = activeLyric ? `🎤 ${activeLyric}`.substring(0, 127) : `🎧 ${artistName}`.substring(0, 127);

            const presenceKey = `MUSIC|${songName}|${stateText}|${currentArtworkKey}`;
            if (!force && presenceKey === lastPresenceKey && (Date.now() - lastSetActivityTime < 12000)) {
                return;
            }
            lastPresenceKey = presenceKey;
            lastSetActivityTime = Date.now();

            const presence = new RichPresence(client)
                .setApplicationId(CLIENT_ID)
                .setType('PLAYING')
                .setName('PhucLam')
                .setDetails(detailsText)
                .setState(stateText);

            if (currentArtworkKey) {
                presence.setAssetsLargeImage(currentArtworkKey);
                presence.setAssetsLargeText(`${songName} - ${artistName}`.substring(0, 127));
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
            // --- CHẾ ĐỘ MẶC ĐỊNH (Khi dừng/tắt nhạc) ---
            const presenceKey = 'DEFAULT';
            if (!force && presenceKey === lastPresenceKey && (Date.now() - lastSetActivityTime < 20000)) {
                return;
            }
            lastPresenceKey = presenceKey;
            lastSetActivityTime = Date.now();

            const presence = new RichPresence(client)
                .setApplicationId(CLIENT_ID)
                .setType('PLAYING')
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
        console.log(`\n🎵 BÀI HÁT MỚI: "${data.title}" (${cleanArtist(data.artist)}) trên ${data.platform || 'Web'}`);
        
        // Tìm song song Lời bài hát & Ảnh bìa HD
        const [lyrics, artwork] = await Promise.all([
            fetchLyrics(data.title, data.artist),
            fetchHighResArtwork(data.title, data.artist, data)
        ]);

        currentLyrics = lyrics;
        currentArtworkKey = artwork;
        updatePresence(true);
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
    currentArtworkKey = null;
    updatePresence(true);
    res.json({ ok: true });
});

app.get('/stop', (req, res) => {
    currentTrack = null;
    lastTrackId = '';
    currentLyrics = [];
    currentArtworkKey = null;
    updatePresence(true);
    res.json({ ok: true });
});

app.listen(PORT, () => {
    console.log(`🌐 Web server đang lắng nghe tại port ${PORT}`);
});

client.on('ready', async () => {
    console.log('\n======================================================');
    console.log(`🎉 ĐÃ ĐĂNG NHẬP THÀNH CÔNG: ${client.user.tag}`);
    console.log('🤖 Đang kích hoạt chế độ Rich Presence 24/7 + Music & Lyrics...');
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
