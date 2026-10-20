# doc-viewer

Dịch vụ xem tài liệu từ link tệp của Hub: ảnh và video (có thanh tiện ích), PDF, Word/Excel/PowerPoint (LibreOffice chuyển sang PDF). Node.js không phụ thuộc thư viện ngoài.

Chạy và triển khai trên cụm k3s: xem `docs/doc-viewer-setup.md` trong repo `ci-cd-platform` (manifest nằm ở `apps/doc-viewer/`).

```
GET /view?k=<khóa>&src=<link Hub mã hóa URL>&type=<đuôi>&name=<tên tệp>
GET /media?k=&src=&name=&download=1     chuyển tiếp có Range (chụp khung hình, tải về)
GET /healthz
```

Biến môi trường chính: `ALLOWED_HOSTS` (bắt buộc), `VIEWER_KEY`, `CACHE_DIR`, `MAX_DOWNLOAD_MB`, `CONVERT_TIMEOUT_SECONDS`, `SOFFICE_PATH`.

Chạy thử cục bộ (chưa có LibreOffice thì chỉ ảnh/video/PDF hoạt động):

```
ALLOWED_HOSTS=localhost:9000 VIEWER_KEY=abc node server.js
```

Repo này Public (Actions miễn phí) nên KHÔNG đặt khóa, chuỗi kết nối hay địa chỉ nội bộ vào đây.

## Thư viện font tự lớn dần

Khi chuyển PPTX, dịch vụ tự trích các font nhúng (`ppt/fonts/*.fntdata`, EOT) vào `FONT_DIR/library/` (loại trùng theo SHA-256, bỏ qua font cấm nhúng `fsType = 2`), rồi cho LibreOffice dùng qua một `fonts.conf` riêng. Font bỏ tay vào `FONT_DIR/manual/` cũng được dùng. `GET /fonts?k=<khóa>` liệt kê thư viện và các font tài liệu dùng nhưng chưa có. Giữ `FONT_DIR` trên ổ đĩa bền.

## Chạy thử

```
node --test "test/*.test.js"          # thư viện font, đọc zip
node test/make-font-pptx.js font.ttf mau.pptx Tên    # tạo PPTX mẫu nhúng một font
```

Image build bằng LibreOffice chính thức của The Document Foundation (cài từ gói `.deb`, kiểm SHA-256), nền Node 22 trên Debian trixie. Workflow `build` chạy thử thật trong container trước khi đẩy image.
