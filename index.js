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
const lyricsCache = new Map();

function formatDiscordImage(url) {
    if (!url) return null;
    if (url.startsWith('mp:') || url.startsWith('youtube:') || url.startsWith('spotify:')) return url;
    return `mp:${url}`;
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
                artist_name: artist || undefined
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
            const currentTime = track.currentTime || 0;
            const duration = track.duration || 0;

            let currentLyricLine = '';
            if (currentLyrics && currentLyrics.length > 0) {
                const activeLine = currentLyrics.filter(l => l.timeSec <= currentTime).pop();
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

            if (track.artwork && (track.artwork.startsWith('http://') || track.artwork.startsWith('https://') || track.artwork.startsWith('mp:'))) {
                presence.setAssetsLargeImage(formatDiscordImage(track.artwork));
                presence.setAssetsLargeText(`${songName} - ${artistName}`.substring(0, 127));
            }

            if (duration > 0 && currentTime >= 0) {
                presence.setStartTimestamp(Math.floor(Date.now() - currentTime * 1000));
                presence.setEndTimestamp(Math.floor(Date.now() + (duration - currentTime) * 1000));
            }

            if (track.url && (track.url.startsWith('http://') || track.url.startsWith('https://'))) {
                presence.addButton(`▶️ Nghe trên ${platform}`, track.url);
            }
            presence.addButton('PhucFeFa', 'https://github.com/PhucFeFa');

            await client.user.setActivity(presence);

        } else {
            // --- CHẾ ĐỘ MẶC ĐỊNH (Không nghe nhạc) ---
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

    // Duy trì kiểm tra cập nhật mỗi 1.5 giây để lời bài hát nhảy theo từng giây
    setInterval(() => {
        updatePresence();
    }, 1500);
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
    console.error('❌ LỖI: Chưa cấu hình DISCORD_TOKEN trong file .env');
    process.exit(1);
}

client.login(token).catch((err) => {
    console.error('❌ Lỗi khi đăng nhập Discord:', err.message);
});
