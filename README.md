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
