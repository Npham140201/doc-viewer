(function () {
  'use strict';

  var root = document.getElementById('viewer');
  var source = root.dataset.src;
  var proxySource = root.dataset.proxy;
  var downloadSource = root.dataset.download;
  var name = root.dataset.name;
  var speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  var skipSeconds = 10;
  var toastTimer = null;
  var idleTimer = null;
  var viaProxy = proxySource === source;

  function create(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  var toolbar = create('div', 'toolbar');
  var area = create('div', 'video-area');
  var video = create('video');
  var toast = create('div', 'toast');
  var fail = create('div', 'fail');
  var failBox = create('div', '', 'Không phát được video này (định dạng hoặc bộ giải mã chưa được hỗ trợ). Bạn có thể bấm Tải về để xem bằng ứng dụng khác.');
  fail.appendChild(failBox);
  video.controls = true;
  video.preload = 'metadata';
  video.playsInline = true;
  area.appendChild(video);
  root.appendChild(toolbar);
  root.appendChild(area);
  root.appendChild(toast);
  root.appendChild(fail);

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 2200);
  }

  function addButton(label, handler) {
    var button = create('button', '', label);
    button.type = 'button';
    button.addEventListener('click', function () { handler(); button.blur(); });
    toolbar.appendChild(button);
    return button;
  }

  function seekBy(seconds) {
    var duration = isFinite(video.duration) ? video.duration : Infinity;
    video.currentTime = Math.min(Math.max(video.currentTime + seconds, 0), duration);
    showToast((seconds > 0 ? '+' : '−') + Math.abs(seconds) + ' giây');
  }

  function togglePlay() {
    if (video.paused) video.play().catch(function () {});
    else video.pause();
  }

  var speedSelect = create('select');
  speedSelect.setAttribute('aria-label', 'Tốc độ phát');
  speeds.forEach(function (speed) {
    var option = create('option', '', speed + '×');
    option.value = String(speed);
    if (speed === 1) option.selected = true;
    speedSelect.appendChild(option);
  });
  speedSelect.addEventListener('change', function () {
    video.playbackRate = Number(speedSelect.value);
    speedSelect.blur();
  });

  function stepSpeed(direction) {
    var index = speeds.indexOf(video.playbackRate);
    if (index < 0) index = speeds.indexOf(1);
    var next = Math.min(Math.max(index + direction, 0), speeds.length - 1);
    video.playbackRate = speeds[next];
    showToast('Tốc độ ' + speeds[next] + '×');
  }

  video.addEventListener('ratechange', function () {
    var matching = String(video.playbackRate);
    for (var index = 0; index < speedSelect.options.length; index++) {
      if (speedSelect.options[index].value === matching) speedSelect.selectedIndex = index;
    }
  });

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
      return;
    }
    if (!root.requestFullscreen) {
      showToast('Trình duyệt này không hỗ trợ toàn màn hình.');
      return;
    }
    root.requestFullscreen().catch(function () { showToast('Không bật được toàn màn hình.'); });
  }

  function togglePictureInPicture() {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(function () {});
      return;
    }
    video.requestPictureInPicture().catch(function () { showToast('Không bật được hình trong hình.'); });
  }

  function baseFileName() {
    return (name || 'video').replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[\\/:*?"<>|]+/g, '_');
  }

  function saveBlob(blob, fileName) {
    var link = document.createElement('a');
    var url = URL.createObjectURL(blob);
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function drawAndSave() {
    var canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    var total = Math.floor(video.currentTime);
    var stamp = String(Math.floor(total / 60)).padStart(2, '0') + '-' + String(total % 60).padStart(2, '0');
    canvas.toBlob(function (blob) {
      if (!blob) {
        showToast('Không chụp được khung hình.');
        return;
      }
      saveBlob(blob, baseFileName() + '_' + stamp + '.png');
      showToast('Đã lưu khung hình');
    }, 'image/png');
  }

  function switchToProxy() {
    return new Promise(function (resolve, reject) {
      if (viaProxy) {
        resolve();
        return;
      }
      var resumeAt = video.currentTime;
      var rate = video.playbackRate;
      var wasPaused = video.paused;
      var timer = setTimeout(function () { reject(new Error('timeout')); }, 20000);
      showToast('Đang chuẩn bị chụp khung hình...');
      video.pause();
      video.addEventListener('loadedmetadata', function onLoaded() {
        video.removeEventListener('loadedmetadata', onLoaded);
        video.addEventListener('seeked', function onSeeked() {
          video.removeEventListener('seeked', onSeeked);
          clearTimeout(timer);
          video.playbackRate = rate;
          if (!wasPaused) video.play().catch(function () {});
          viaProxy = true;
          resolve();
        });
        video.currentTime = resumeAt;
      });
      video.src = proxySource;
      video.load();
    });
  }

  function capture() {
    if (!video.videoWidth) {
      showToast('Video chưa sẵn sàng.');
      return;
    }
    try {
      drawAndSave();
    } catch (error) {
      if (error && error.name !== 'SecurityError') {
        showToast('Không chụp được khung hình.');
        return;
      }
      switchToProxy().then(function () {
        try { drawAndSave(); } catch (second) { showToast('Không chụp được khung hình.'); }
      }).catch(function () { showToast('Không chụp được khung hình.'); });
    }
  }

  function download() {
    var link = document.createElement('a');
    link.href = downloadSource;
    link.download = name || 'video';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  addButton('Lùi ' + skipSeconds + ' giây', function () { seekBy(-skipSeconds); });
  addButton('Tới ' + skipSeconds + ' giây', function () { seekBy(skipSeconds); });
  toolbar.appendChild(create('span', 'label', 'Tốc độ'));
  toolbar.appendChild(speedSelect);
  var fullscreenButton = addButton('Toàn màn hình', toggleFullscreen);
  if (document.pictureInPictureEnabled) addButton('Hình trong hình', togglePictureInPicture);
  addButton('Chụp khung hình', capture);
  addButton('Tải về', download);

  document.addEventListener('keydown', function (event) {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.target && (event.target.tagName === 'SELECT' || event.target.tagName === 'INPUT')) return;
    var handled = true;
    switch (event.key) {
      case ' ': case 'k': case 'K': togglePlay(); break;
      case 'ArrowLeft': case 'j': case 'J': seekBy(-skipSeconds); break;
      case 'ArrowRight': case 'l': case 'L': seekBy(skipSeconds); break;
      case 'ArrowUp': video.volume = Math.min(video.volume + 0.05, 1); showToast('Âm lượng ' + Math.round(video.volume * 100) + '%'); break;
      case 'ArrowDown': video.volume = Math.max(video.volume - 0.05, 0); showToast('Âm lượng ' + Math.round(video.volume * 100) + '%'); break;
      case 'm': case 'M': video.muted = !video.muted; showToast(video.muted ? 'Tắt tiếng' : 'Bật tiếng'); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 'p': case 'P': if (document.pictureInPictureEnabled) togglePictureInPicture(); break;
      case 'c': case 'C': capture(); break;
      case ',': case '<': stepSpeed(-1); break;
      case '.': case '>': stepSpeed(1); break;
      default: handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  document.addEventListener('fullscreenchange', function () {
    fullscreenButton.textContent = document.fullscreenElement ? 'Thoát toàn màn hình' : 'Toàn màn hình';
  });

  function wake() {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (document.fullscreenElement === root && !video.paused) root.classList.add('idle');
    }, 3000);
  }
  document.addEventListener('mousemove', wake);
  document.addEventListener('pointerdown', wake);
  video.addEventListener('pause', wake);

  video.addEventListener('error', function () {
    fail.classList.add('show');
  });
  video.src = source;

  window.__videoViewer = { video: video, capture: capture, seekBy: seekBy, stepSpeed: stepSpeed };
})();
