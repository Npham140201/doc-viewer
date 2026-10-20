(function () {
  'use strict';

  var root = document.getElementById('viewer');
  var source = root.dataset.src;
  var speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  var skipSeconds = 10;
  var toastTimer = null;
  var idleTimer = null;

  function create(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  var area = create('div', 'video-area');
  var video = create('video');
  var toast = create('div', 'toast');
  var fail = create('div', 'fail');
  fail.appendChild(create('div', '', 'Không phát được video này (định dạng hoặc bộ giải mã chưa được hỗ trợ).'));
  video.controls = true;
  video.preload = 'metadata';
  video.playsInline = true;
  area.appendChild(video);
  root.appendChild(area);
  root.appendChild(toast);
  root.appendChild(fail);

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 2200);
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

  function stepSpeed(direction) {
    var index = speeds.indexOf(video.playbackRate);
    if (index < 0) index = speeds.indexOf(1);
    var next = Math.min(Math.max(index + direction, 0), speeds.length - 1);
    video.playbackRate = speeds[next];
    showToast('Tốc độ ' + speeds[next] + '×');
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
      return;
    }
    if (!root.requestFullscreen) return;
    root.requestFullscreen().catch(function () {});
  }

  document.addEventListener('keydown', function (event) {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    var handled = true;
    switch (event.key) {
      case ' ': case 'k': case 'K': togglePlay(); break;
      case 'ArrowLeft': case 'j': case 'J': seekBy(-skipSeconds); break;
      case 'ArrowRight': case 'l': case 'L': seekBy(skipSeconds); break;
      case 'ArrowUp': video.volume = Math.min(video.volume + 0.05, 1); showToast('Âm lượng ' + Math.round(video.volume * 100) + '%'); break;
      case 'ArrowDown': video.volume = Math.max(video.volume - 0.05, 0); showToast('Âm lượng ' + Math.round(video.volume * 100) + '%'); break;
      case 'm': case 'M': video.muted = !video.muted; showToast(video.muted ? 'Tắt tiếng' : 'Bật tiếng'); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case ',': case '<': stepSpeed(-1); break;
      case '.': case '>': stepSpeed(1); break;
      default: handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

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
})();
