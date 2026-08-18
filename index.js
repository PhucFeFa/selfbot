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
let lastTrackId = '';
let lastMusicUpdate = 0;
let lastRenderedLyric = '';
const lyricsCache = new Map();

// Chuyển đổi định dạng ảnh phù hợp cho Discord
function formatDiscordImage(track) {
    if (!track) return null;
    
    // 1. Nếu là YouTube: dùng chuẩn native youtube:VIDEO_ID (Discord tự render ảnh bìa HD không bao giờ lỗi)
    if (track.videoId) {
        return `youtube:${track.videoId}`;
    }
    if (track.url) {
        const ytMatch = track.url.match(/[?&]v=([^&]+)/) || track.url.match(/youtu\.be\/([^?&]+)/);
        if (ytMatch) return `youtube:${ytMatch[1]}`;
    }

    // 2. Nếu là Spotify: dùng chuẩn native spotify:IMAGE_ID
    if (track.artwork && track.artwork.includes('scdn.co/image/')) {
        const spotId = track.artwork.split('scdn.co/image/')[1];
        if (spotId) return `spotify:${spotId}`;
    }

    // 3. Fallback cho các link ảnh khác
    if (track.artwork) {
        if (track.artwork.startsWith('mp:') || track.artwork.startsWith('youtube:') || track.artwork.startsWith('spotify:')) {
            return track.artwork;
        }
        return `mp:${track.artwork}`;
    }

    return null;
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

// Lấy lời bài hát từ LRCLIB
async function fetchLyrics(title, artist) {
    const cleanedTitle = cleanTitle(title);
    const cacheKey = `${cleanedTitle} - ${artist}`.toLowerCase();

    if (lyricsCache.has(cacheKey)) {
        return lyricsCache.get(cacheKey);
    }

    console.log(`🔍 Đang tìm lời bài hát: "${cleanedTitle}" - ${artist || 'Unknown'}`);

    try {
        let res = await axios.get('https://lrclib.net/api/get', {
            params: {
                track_name: cleanedTitle,
                artist_name: (artist && !artist.toLowerCase().includes('topic')) ? artist : undefined
            },
            timeout: 5000
        });

        if (res.data && res.data.syncedLyrics) {
            const parsed = parseLRC(res.data.syncedLyrics);
            lyricsCache.set(cacheKey, parsed);
            console.log(`✨ Đã tìm thấy lời bài hát khớp thời gian (${parsed.length} câu)`);
            return parsed;
        }

        res = await axios.get('https://lrclib.net/api/search', {
            params: {
                q: `${cleanedTitle} ${artist || ''}`.trim()
            },
            timeout: 5000
        });

        if (res.data && res.data.length > 0) {
            for (const item of res.data) {
                if (item.syncedLyrics) {
                    const parsed = parseLRC(item.syncedLyrics);
                    lyricsCache.set(cacheKey, parsed);
                    console.log(`✨ Đã tìm thấy lời bài hát từ kết quả tìm kiếm: "${item.trackName}"`);
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
async function updatePresence() {
    if (!client.user) return;

    const isMusicActive = currentTrack && !currentTrack.paused && (Date.now() - lastMusicUpdate < 20000);

    try {
        if (isMusicActive) {
            // --- CHẾ ĐỘ PHÁT NHẠC ---
            const track = currentTrack;
            
            // Tính toán thời gian thực tế khớp chuẩn từng mili-giây
            const elapsedSincePing = (Date.now() - lastMusicUpdate) / 1000;
            const liveCurrentTime = Math.min(track.duration || 9999, (track.currentTime || 0) + elapsedSincePing);
            const duration = track.duration || 0;

            let currentLyricLine = '';
            if (currentLyrics && currentLyrics.length > 0) {
                // Lọc câu hát gần nhất với liveCurrentTime
                let activeLine = null;
                for (let i = 0; i < currentLyrics.length; i++) {
                    if (currentLyrics[i].timeSec <= liveCurrentTime) {
                        activeLine = currentLyrics[i];
                    } else {
                        break;
                    }
                }

                if (activeLine) {
                    currentLyricLine = activeLine.text;
                } else {
                    currentLyricLine = '🎵 [Nhạc dạo đầu...]';
                }
            }

            const platform = track.platform || 'Music';
            const songName = track.title || 'Unknown Song';
            const artistName = track.artist || 'Unknown Artist';

            const presence = new RichPresence(client)
                .setApplicationId(CLIENT_ID)
                .setType('PLAYING')
                .setName('PhucLam')
                .setDetails(`🎵 ${songName}`.substring(0, 127))
                .setState(currentLyricLine ? `🎤 ${currentLyricLine}`.substring(0, 127) : `👤 ${artistName}`.substring(0, 127));

            const imageKey = formatDiscordImage(track);
            if (imageKey) {
                presence.setAssetsLargeImage(imageKey);
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

            if (currentLyricLine && currentLyricLine !== lastRenderedLyric) {
                lastRenderedLyric = currentLyricLine;
                console.log(`[${Math.floor(liveCurrentTime)}s] 🎤 ${currentLyricLine}`);
            }

        } else {
            // --- CHẾ ĐỘ MẶC ĐỊNH (Không nghe nhạc) ---
            lastRenderedLyric = '';
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

// Router nhận dữ liệu nhạc từ trình duyệt
app.get('/', (req, res) => {
    res.send('✅ Discord 24/7 Music & Synced Lyrics Selfbot is RUNNING!');
});

app.post('/track', async (req, res) => {
    const data = req.body;
    if (!data || !data.title) {
        return res.json({ ok: false });
    }

    lastMusicUpdate = Date.now();
    currentTrack = data;

    const trackId = `${data.title} - ${data.artist}`;
    if (trackId !== lastTrackId) {
        lastTrackId = trackId;
        lastRenderedLyric = '';
        console.log(`\n🎵 BÀI HÁT MỚI: "${data.title}" (${data.artist || 'Unknown'}) trên ${data.platform || 'Web'}`);
        currentLyrics = await fetchLyrics(data.title, data.artist);
    }

    updatePresence();
    res.json({ ok: true });
});

app.post('/stop', (req, res) => {
    currentTrack = null;
    lastTrackId = '';
    currentLyrics = [];
    updatePresence();
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

    updatePresence();

    // Đồng bộ mỗi 1.0 giây để bám sát lời bài hát từng tích tắc
    setInterval(() => {
        updatePresence();
    }, 1000);
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
    console.error('❌ LỖI: Chưa cấu hình DISCORD_TOKEN trong file .env');
    process.exit(1);
}

client.login(token).catch((err) => {
    console.error('❌ Lỗi khi đăng nhập Discord:', err.message);
});
