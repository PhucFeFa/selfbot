# 🚀 Discord 24/7 Rich Presence Selfbot

Treo trạng thái Rich Presence hoạt động 24/7 trên Cloud (Render, Koyeb, Railway, VPS).

---

## 🛠️ Hướng dẫn cài đặt & chạy Local

1. Cài đặt các gói phụ thuộc:
   ```bash
   npm install
   ```

2. Tạo file `.env` và điền Token:
   ```env
   DISCORD_TOKEN=your_token_here
   PORT=3000
   ```

3. Chạy script:
   ```bash
   npm start
   ```

---

## ☁️ Hướng dẫn treo 24/7 trên Render (Miễn phí)

1. Đăng nhập [Render.com](https://render.com/).
2. Chọn **New +** ➜ **Web Service**.
3. Kết nối với GitHub Repository `PhucFeFa/selfbot`.
4. Điền cấu hình:
   * **Runtime**: `Node`
   * **Build Command**: `npm install`
   * **Start Command**: `npm start`
5. Ở mục **Environment Variables**, thêm biến:
   * `DISCORD_TOKEN` = `[Token của bạn]`
6. Bấm **Deploy Web Service**.
