(function () {
  'use strict';

  var root = document.getElementById('viewer');
  var source = root.dataset.src;
  var name = root.dataset.name;
  var minimumScale = 0.05;
  var maximumScale = 20;
  var state = { scale: 1, x: 0, y: 0, rotation: 0, autoFit: true };
  var pointers = new Map();
  var lastPinch = null;
  var toastTimer = null;

  function create(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  var stage = create('div', 'stage');
  var image = create('img', 'photo');
  var toolbar = create('div', 'toolbar');
  var readout = create('span', 'readout', '100%');
  var toast = create('div', 'toast');
  var fail = create('div', 'fail');
  var failBox = create('div', '', 'Không tải được ảnh.');
  fail.appendChild(failBox);
  image.alt = name;
  image.draggable = false;
  stage.appendChild(image);
  root.appendChild(stage);
  root.appendChild(toolbar);
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

  function stageCenter() {
    var rect = stage.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function apply() {
    image.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px) rotate(' + state.rotation + 'deg) scale(' + state.scale + ')';
    readout.textContent = Math.round(state.scale * 100) + '%';
  }

  function fitScale() {
    var sideways = Math.abs(state.rotation) % 180 === 90;
    var width = sideways ? image.naturalHeight : image.naturalWidth;
    var height = sideways ? image.naturalWidth : image.naturalHeight;
    if (!width || !height) return 1;
    var availableWidth = Math.max(stage.clientWidth - 24, 50);
    var availableHeight = Math.max(stage.clientHeight - 24, 50);
    if (document.fullscreenElement === root) availableHeight = stage.clientHeight;
    return Math.min(availableWidth / width, availableHeight / height, 1);
  }

  function fit() {
    state.scale = fitScale();
    state.x = 0;
    state.y = 0;
    state.autoFit = true;
    apply();
  }

  function actualSize() {
    state.scale = 1;
    state.x = 0;
    state.y = 0;
    state.autoFit = false;
    apply();
  }

  function zoomAt(factor, clientX, clientY) {
    var center = stageCenter();
    var pointX = clientX - center.x;
    var pointY = clientY - center.y;
    var nextScale = Math.min(Math.max(state.scale * factor, minimumScale), maximumScale);
    var ratio = nextScale / state.scale;
    state.x = pointX - (pointX - state.x) * ratio;
    state.y = pointY - (pointY - state.y) * ratio;
    state.scale = nextScale;
    state.autoFit = false;
    apply();
  }

  function zoomFromCenter(factor) {
    var center = stageCenter();
    zoomAt(factor, center.x, center.y);
  }

  function rotate(degrees) {
    state.rotation = (state.rotation + degrees) % 360;
    fit();
  }

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

  addButton('Thu nhỏ', function () { zoomFromCenter(1 / 1.25); });
  toolbar.appendChild(readout);
  addButton('Phóng to', function () { zoomFromCenter(1.25); });
  addButton('Vừa khung', fit);
  addButton('100%', actualSize);
  addButton('Xoay trái', function () { rotate(-90); });
  addButton('Xoay phải', function () { rotate(90); });
  var fullscreenButton = addButton('Toàn màn hình', toggleFullscreen);

  stage.addEventListener('wheel', function (event) {
    event.preventDefault();
    zoomAt(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)), event.clientX, event.clientY);
  }, { passive: false });

  stage.addEventListener('pointerdown', function (event) {
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    stage.classList.add('dragging');
    lastPinch = null;
  });

  stage.addEventListener('pointermove', function (event) {
    var previous = pointers.get(event.pointerId);
    if (!previous) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      state.x += event.clientX - previous.x;
      state.y += event.clientY - previous.y;
      state.autoFit = false;
      apply();
    } else if (pointers.size === 2) {
      var points = Array.from(pointers.values());
      var distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      var middleX = (points[0].x + points[1].x) / 2;
      var middleY = (points[0].y + points[1].y) / 2;
      if (lastPinch && lastPinch.distance > 0) {
        state.x += middleX - lastPinch.middleX;
        state.y += middleY - lastPinch.middleY;
        zoomAt(distance / lastPinch.distance, middleX, middleY);
      }
      lastPinch = { distance: distance, middleX: middleX, middleY: middleY };
    }
  });

  function releasePointer(event) {
    pointers.delete(event.pointerId);
    lastPinch = null;
    if (pointers.size === 0) stage.classList.remove('dragging');
  }
  stage.addEventListener('pointerup', releasePointer);
  stage.addEventListener('pointercancel', releasePointer);

  stage.addEventListener('dblclick', function (event) {
    var atFit = state.autoFit || Math.abs(state.scale - fitScale()) < 0.01;
    if (!atFit) {
      fit();
      return;
    }
    var target = fitScale() < 0.99 ? 1 : 2;
    zoomAt(target / state.scale, event.clientX, event.clientY);
  });

  document.addEventListener('keydown', function (event) {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    var handled = true;
    switch (event.key) {
      case '+': case '=': zoomFromCenter(1.25); break;
      case '-': case '_': zoomFromCenter(1 / 1.25); break;
      case '0': fit(); break;
      case '1': actualSize(); break;
      case 'r': rotate(90); break;
      case 'R': rotate(-90); break;
      case 'f': case 'F': toggleFullscreen(); break;
      default: handled = false;
    }
    if (handled) event.preventDefault();
  });

  document.addEventListener('fullscreenchange', function () {
    fullscreenButton.textContent = document.fullscreenElement ? 'Thoát toàn màn hình' : 'Toàn màn hình';
    if (state.autoFit) fit();
  });

  window.addEventListener('resize', function () {
    if (state.autoFit) fit();
  });

  var idleTimer = null;
  function wake() {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (document.fullscreenElement === root) root.classList.add('idle');
    }, 3000);
  }
  document.addEventListener('mousemove', wake);
  document.addEventListener('pointerdown', wake);

  image.addEventListener('load', function () {
    image.style.width = image.naturalWidth + 'px';
    image.style.height = image.naturalHeight + 'px';
    image.style.left = '50%';
    image.style.top = '50%';
    image.style.marginLeft = (-image.naturalWidth / 2) + 'px';
    image.style.marginTop = (-image.naturalHeight / 2) + 'px';
    fit();
  });
  image.addEventListener('error', function () {
    fail.classList.add('show');
  });
  image.src = source;

  window.__imageViewer = { state: state, fit: fit, actualSize: actualSize, rotate: rotate, zoomFromCenter: zoomFromCenter, zoomAt: zoomAt };
})();
