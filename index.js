require('dotenv').config();
const { Client, RichPresence } = require('discord.js-selfbot-v13');
const express = require('express');

// Web server để giữ online 24/7 trên Render / Koyeb / UptimeRobot
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('✅ Discord 24/7 Rich Presence is ACTIVE!');
});

app.listen(PORT, () => {
    console.log(`🌐 Web server đang lắng nghe tại port ${PORT}`);
});

const client = new Client();

client.on('ready', async () => {
    console.log('\n======================================================');
    console.log(`🎉 ĐÃ ĐĂNG NHẬP THÀNH CÔNG: ${client.user.tag}`);
    console.log('🤖 Đang kích hoạt trạng thái Rich Presence 24/7...');
    console.log('======================================================\n');

    try {
        const presence = new RichPresence(client)
            .setApplicationId('1538974355193593856')
            .setType('PLAYING')
            .setName('PhucLam')
            .setDetails('Gender: Male')
            .setStartTimestamp(Date.now())
            .addButton('PhucFeFa', 'https://github.com/PhucFeFa')
            .addButton('snvv', 'https://www.instagram.com/lhphucclh?igsh=dHc4dmlqd2tseGE1&igsi=dHc4dmlqd2tseGE1&utm_source=qr');

        client.user.setActivity(presence);
        console.log('✅ Đã thiết lập Rich Presence thành công!');
    } catch (err) {
        console.error('❌ Lỗi khi thiết lập Rich Presence:', err);
    }
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
    console.error('❌ LỖI: Chưa cấu hình DISCORD_TOKEN trong file .env');
    process.exit(1);
}

client.login(token).catch((err) => {
    console.error('❌ Lỗi khi đăng nhập Discord:', err.message);
});
