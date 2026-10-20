FROM node:22-trixie-slim

ARG TARGETARCH
ARG LIBREOFFICE_VERSION=26.2.6
ARG LIBREOFFICE_SHA256_AMD64=fd0e8f8f2408dd2e5b90286e60f3f97cf566ba441cd48cfc5bcc68067303e0bc
ARG LIBREOFFICE_SHA256_ARM64=f8e8b1d30abde0d530d727ce1b26909ccbedc3d76bcf75d93b3dd5fcd5b8d278

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl fontconfig \
        libxinerama1 libxext6 libxrender1 libsm6 libice6 libx11-6 libx11-xcb1 libxrandr2 \
        libfontconfig1 libfreetype6 libcairo2 libcups2t64 libdbus-1-3 libdbus-glib-1-2 libnss3 \
        libxslt1.1 libxml2 libglu1-mesa libgl1 libgssapi-krb5-2 \
        fonts-liberation fonts-dejavu-core fonts-noto-core fonts-crosextra-carlito fonts-crosextra-caladea qpdf \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) package_arch=x86-64; download_arch=x86_64; checksum="${LIBREOFFICE_SHA256_AMD64}" ;; \
        arm64) package_arch=aarch64; download_arch=aarch64; checksum="${LIBREOFFICE_SHA256_ARM64}" ;; \
        *) echo "Kiến trúc không hỗ trợ: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    series="${LIBREOFFICE_VERSION%.*}"; \
    archive="LibreOffice_${LIBREOFFICE_VERSION}_Linux_${package_arch}_deb.tar.gz"; \
    curl -fsSL -o "/tmp/${archive}" "https://download.documentfoundation.org/libreoffice/stable/${LIBREOFFICE_VERSION}/deb/${download_arch}/${archive}"; \
    echo "${checksum}  /tmp/${archive}" | sha256sum -c -; \
    mkdir /tmp/libreoffice; \
    tar -xzf "/tmp/${archive}" -C /tmp/libreoffice; \
    cd /tmp/libreoffice/*/DEBS; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ./libreoffice${series}_*.deb ./libreoffice${series}-ure_*.deb \
        ./libobasis${series}-core_*.deb ./libobasis${series}-ooofonts_*.deb ./libobasis${series}-images_*.deb \
        ./libobasis${series}-graphicfilter_*.deb ./libobasis${series}-ooolinguistic_*.deb ./libobasis${series}-xsltfilter_*.deb \
        ./libobasis${series}-writer_*.deb ./libobasis${series}-calc_*.deb ./libobasis${series}-impress_*.deb \
        ./libobasis${series}-draw_*.deb ./libobasis${series}-math_*.deb ./libobasis${series}-en-us_*.deb \
        ./libreoffice${series}-en-us_*.deb ./libreoffice${series}-writer_*.deb ./libreoffice${series}-calc_*.deb \
        ./libreoffice${series}-impress_*.deb ./libreoffice${series}-draw_*.deb ./libreoffice${series}-math_*.deb; \
    cd /; \
    rm -rf /tmp/libreoffice "/tmp/${archive}" /var/lib/apt/lists/*; \
    test -x "/opt/libreoffice${series}/program/soffice"; \
    ln -s "/opt/libreoffice${series}/program/soffice" /usr/local/bin/soffice

WORKDIR /app
COPY package.json server.js fontlibrary.js zipreader.js transfer.js ./
COPY public ./public

RUN useradd -m -u 10001 viewer && mkdir -p /data/cache /data/fonts && chown -R viewer /data
USER viewer

ENV PORT=8080 CACHE_DIR=/data/cache FONT_DIR=/data/fonts HOME=/home/viewer
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
