/**
 * ==========================================
 * 1. STATE & CONSTANTS (資料與常態層)
 * ==========================================
 */
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const AppState = {
  pageItems: [],
  totalBytes: 0,
  nextUniqueId: 1,
  sortableInstance: null,
  addCardElement: null,
  currentEditingItem: null,
  pdfDocCache: new Map(),
};

const QUALITY_NOTES = {
  standard: "轉檔最快，檔案最小，適合一般螢幕閱讀。",
  high: "平衡速度與銳利度，適合絕大多數公文與報告。",
  ultra: "細節最精緻，適合精細圖表或高解析列印需求。",
};

const QUALITY_CONFIGS = {
  standard: { scale: 1.0, quality: 0.82, maxDim: 1400 },
  high: { scale: 1.5, quality: 0.88, maxDim: 2000 },
  ultra: { scale: 2.0, quality: 0.92, maxDim: 2800 },
};

/**
 * ==========================================
 * 2. UI SERVICE LAYER (通知與遮罩服務)
 * ==========================================
 */
const UIService = {
  showToast(message, type = "info") {
    const container = document.getElementById("toastContainer");
    const toast = document.createElement("div");
    toast.className = `toast-card ${type}`;

    let icon = "";
    if (type === "success") {
      icon = `<svg class="toast-icon" style="color: #3fb950;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else if (type === "error") {
      icon = `<svg class="toast-icon" style="color: var(--danger);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line></svg>`;
    } else {
      icon = `<svg class="toast-icon" style="color: var(--accent);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line></svg>`;
    }

    toast.innerHTML = `${icon}<span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(100%)";
      toast.style.transition = "all 0.2s ease";
      setTimeout(() => toast.remove(), 200);
    }, 3000);
  },

  showLoading(msg) {
    document.getElementById("loadingText").textContent = msg;
    document.getElementById("loadingOverlay").style.display = "flex";
  },

  hideLoading() {
    document.getElementById("loadingOverlay").style.display = "none";
  },

  showConfirmDialog({
    title,
    text,
    confirmText = "確認",
    cancelText = "取消",
  }) {
    return new Promise((resolve) => {
      const overlay = document.getElementById("confirmOverlay");
      document.getElementById("modalTitle").textContent = title;
      document.getElementById("modalText").textContent = text;
      const btnConfirm = document.getElementById("btnModalConfirm");
      const btnCancel = document.getElementById("btnModalCancel");
      btnConfirm.textContent = confirmText;
      btnCancel.textContent = cancelText;

      overlay.style.display = "flex";

      const cleanup = (result) => {
        overlay.style.display = "none";
        btnConfirm.removeEventListener("click", onConfirm);
        btnCancel.removeEventListener("click", onCancel);
        resolve(result);
      };

      const onConfirm = () => cleanup(true);
      const onCancel = () => cleanup(false);

      btnConfirm.addEventListener("click", onConfirm);
      btnCancel.addEventListener("click", onCancel);
    });
  },

  formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  },
};

/**
 * ==========================================
 * 3. PDF PROCESSING SERVICE (核心轉檔與處理)
 * ==========================================
 */
const PDFService = {
  async getCachedPdfDoc(buffer) {
    if (!AppState.pdfDocCache.has(buffer)) {
      const doc = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
      AppState.pdfDocCache.set(buffer, doc);
    }
    return AppState.pdfDocCache.get(buffer);
  },

  async renderPagePreview(item) {
    try {
      const doc = await PDFService.getCachedPdfDoc(item.sourceBuffer);
      const page = await doc.getPage(item.pageIndex + 1);
      const unscaled = page.getViewport({
        scale: 1.0,
        rotation: item.initialRotation,
      });
      const scale = Math.min(1.0, 340 / unscaled.height);
      const viewport = page.getViewport({
        scale,
        rotation: item.initialRotation,
      });

      item.canvasElement.width = viewport.width;
      item.canvasElement.height = viewport.height;
      const ctx = item.canvasElement.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;

      if (item.editSnapshot) {
        const img = new Image();
        img.src = item.editSnapshot;
        await new Promise((r) => (img.onload = r));
        ctx.drawImage(img, 0, 0, viewport.width, viewport.height);
      }
    } catch (e) {
      console.error("預覽繪製失敗", e);
    }
  },

  getTargetFilename(ext) {
    let name = document.getElementById("outputFilename").value.trim();
    if (!name) {
      const d = new Date();
      const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
      name = `merged_${ts}`;
    }
    return name.endsWith("." + ext) ? name : `${name}.${ext}`;
  },

  triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
};

/**
 * ==========================================
 * 4. COMPONENT & UI DOM BUILDER (視圖元件層)
 * ==========================================
 */
const UIComponent = {
  getOrCreateAddCard() {
    if (!AppState.addCardElement) {
      AppState.addCardElement = document.createElement("div");
      AppState.addCardElement.className = "add-card-placeholder";
      AppState.addCardElement.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        <span>加入更多頁面</span>
      `;
      AppState.addCardElement.onclick = () =>
        document.getElementById("fileInput").click();
    }
    return AppState.addCardElement;
  },

  createCardElement(item) {
    const card = document.createElement("div");
    card.className = "page-card";
    card.dataset.id = item.id;

    const topbar = document.createElement("div");
    topbar.className = "card-topbar";

    const badgeInput = document.createElement("input");
    badgeInput.type = "number";
    badgeInput.className = "card-index-input";
    badgeInput.title = "點擊直接輸入目標序號跳轉位置";
    badgeInput.addEventListener("click", (e) => e.stopPropagation());
    badgeInput.addEventListener("focus", (e) => e.target.select());
    badgeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.target.blur();
    });
    badgeInput.addEventListener("change", (e) =>
      Controller.jumpItemToPosition(item, e.target),
    );
    topbar.appendChild(badgeInput);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn-delete-x";
    deleteBtn.title = "刪除頁面";
    deleteBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
    deleteBtn.onclick = () => Controller.deleteItem(item);
    topbar.appendChild(deleteBtn);
    card.appendChild(topbar);

    const previewBox = document.createElement("div");
    previewBox.className = "preview-box";
    previewBox.title = "點擊進入單頁大面檢視與編輯";
    previewBox.onclick = () => SingleEditorController.open(item);

    const canvas = document.createElement("canvas");
    canvas.className = "preview-canvas";
    previewBox.appendChild(canvas);
    card.appendChild(previewBox);
    item.canvasElement = canvas;

    const metaBox = document.createElement("div");
    metaBox.className = "meta-box";
    metaBox.innerHTML = `
      <div class="meta-file" title="${item.fileName}">${item.fileName}</div>
      <div class="meta-page">第 ${item.pageIndex + 1} 頁 ${item.edits && item.edits.length > 0 ? '<span style="color:var(--accent);">(已編輯)</span>' : ""}</div>
    `;
    card.appendChild(metaBox);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    actions.innerHTML = `
      <button type="button" class="btn-action-col btn-rotate" title="旋轉 90 度">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
        <span>旋轉</span>
      </button>
      <button type="button" class="btn-action-col btn-move-left" title="往前移">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
        <span>左移</span>
      </button>
      <button type="button" class="btn-action-col btn-move-right" title="往後移">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
        <span>右移</span>
      </button>
    `;

    actions.querySelector(".btn-rotate").onclick = () =>
      Controller.rotateItem(item);
    actions.querySelector(".btn-move-left").onclick = () =>
      Controller.moveItemByStep(item, -1);
    actions.querySelector(".btn-move-right").onclick = () =>
      Controller.moveItemByStep(item, 1);
    card.appendChild(actions);

    return card;
  },

  updateFloatingBarPosition() {
    const wrap = document.querySelector(".floating-bar-sticky-wrap");
    const editorSec = document.querySelector(".editor-section");
    const workspace = document.getElementById("workspace");
    if (!editorSec || !wrap || workspace.style.display === "none") return;
    const rect = editorSec.getBoundingClientRect();
    wrap.style.left = `${rect.left}px`;
    wrap.style.width = `${rect.width}px`;
  },

  syncStateAndBadges() {
    const emptyWrap = document.getElementById("emptyHeroWrap");
    const workspace = document.getElementById("workspace");
    const pageGrid = document.getElementById("pageGrid");

    if (AppState.pageItems.length === 0) {
      emptyWrap.style.display = "flex";
      workspace.classList.remove("active");
      AppState.totalBytes = 0;
      return;
    }

    emptyWrap.style.display = "none";
    workspace.classList.add("active");
    UIComponent.updateFloatingBarPosition();

    document.getElementById("pageCountText").textContent =
      `${AppState.pageItems.length} 頁`;
    document.getElementById("fileSizeText").textContent =
      `來源大小 ${UIService.formatBytes(AppState.totalBytes)}`;

    const addCard = UIComponent.getOrCreateAddCard();
    if (!pageGrid.contains(addCard)) pageGrid.appendChild(addCard);

    AppState.pageItems.forEach((item, idx) => {
      const badgeInput = item.cardElement.querySelector(".card-index-input");
      if (badgeInput && document.activeElement !== badgeInput) {
        badgeInput.value = idx + 1;
        badgeInput.min = 1;
        badgeInput.max = AppState.pageItems.length;
      }

      const metaPage = item.cardElement.querySelector(".meta-page");
      if (metaPage) {
        metaPage.innerHTML = `第 ${item.pageIndex + 1} 頁 ${item.edits && item.edits.length > 0 ? '<span style="color:var(--accent);">(已編輯)</span>' : ""}`;
      }

      const leftBtn = item.cardElement.querySelector(".btn-move-left");
      const rightBtn = item.cardElement.querySelector(".btn-move-right");
      if (leftBtn) {
        leftBtn.disabled = idx === 0;
        leftBtn.style.opacity = idx === 0 ? "0.2" : "1";
      }
      if (rightBtn) {
        rightBtn.disabled = idx === AppState.pageItems.length - 1;
        rightBtn.style.opacity =
          idx === AppState.pageItems.length - 1 ? "0.2" : "1";
      }
    });
  },
};

/**
 * ==========================================
 * 5. SINGLE PAGE EDITOR (單頁編輯與獨立簽名板控制器)
 * ==========================================
 */
const COMMON_COLORS = [
  "#000000",
  "#ffffff",
  "#ffeb3b",
  "#4caf50",
  "#1976d2",
  "#d32f2f",
  "#ff9800",
  "#e91e63",
  "#9c27b0",
  "#3f51b5",
];

const SingleEditorController = {
  canvas: null,
  ctx: null,
  bgCanvas: null,
  currentMode: "sign", // 'sign' or 'text'
  nativeViewport: null,
  baseScale: 1.5,
  currentZoom: 1.0,
  tempEdits: [],
  selectedEditIndex: null,
  activeHandle: null,
  isDraggingObject: false,
  isResizingObject: false,
  dragOffsetX: 0,
  dragOffsetY: 0,
  initialResizeState: null,
  popstateHandler: null,

  // 獨立簽名板內部變數
  sigCanvas: null,
  sigCtx: null,
  isSigDrawing: false,
  sigLastX: 0,
  sigLastY: 0,

  async open(item) {
    AppState.currentEditingItem = item;
    const overlay = document.getElementById("singleEditorOverlay");
    overlay.style.display = "flex";
    document.body.classList.add("modal-open");
    document.getElementById("singleEditorTitle").textContent =
      `編輯頁面：${item.fileName} (第 ${item.pageIndex + 1} 頁)`;

    // 【問題三修正】：加入 History API 狀態，讓手機返回鍵／上一頁手勢能精準只關閉彈窗
    history.pushState({ modalOpen: true }, "");
    if (this.popstateHandler)
      window.removeEventListener("popstate", this.popstateHandler);
    this.popstateHandler = (e) => {
      if (overlay.style.display === "flex") {
        this.close(false); // 不重複呼叫 history.back
      }
    };
    window.addEventListener("popstate", this.popstateHandler);

    this.canvas = document.getElementById("singleEditCanvas");
    this.ctx = this.canvas.getContext("2d");
    this.tempEdits = item.edits ? JSON.parse(JSON.stringify(item.edits)) : [];
    this.selectedEditIndex = null;
    this.currentZoom = 1.0;
    document.getElementById("zoomLevelText").textContent = "100%";

    await this.preloadImages();

    UIService.showLoading("快速載入中...");
    try {
      const doc = await PDFService.getCachedPdfDoc(item.sourceBuffer);
      const page = await doc.getPage(item.pageIndex + 1);
      const totalRotation = (item.initialRotation + item.userRotation) % 360;

      const viewport = page.getViewport({
        scale: this.baseScale,
        rotation: totalRotation,
      });
      this.nativeViewport = viewport;

      this.canvas.width = viewport.width;
      this.canvas.height = viewport.height;
      this.canvas.style.width = viewport.width + "px";
      this.canvas.style.height = viewport.height + "px";

      this.bgCanvas = document.createElement("canvas");
      this.bgCanvas.width = viewport.width;
      this.bgCanvas.height = viewport.height;
      const bgCtx = this.bgCanvas.getContext("2d");
      await page.render({ canvasContext: bgCtx, viewport }).promise;

      this.redrawCanvas();
    } catch (err) {
      UIService.showToast("無法載入單頁檢視：" + err.message, "error");
      this.close(false);
    } finally {
      UIService.hideLoading();
    }
  },

  async preloadImages() {
    for (const edit of this.tempEdits) {
      if (edit.type === "sign" && edit.dataUrl && !edit.imgObj) {
        const img = new Image();
        img.src = edit.dataUrl;
        await new Promise((r) => (img.onload = r));
        edit.imgObj = img;
      }
    }
  },

  setZoom(newZoom) {
    this.currentZoom = Math.max(0.5, Math.min(3.0, newZoom));
    document.getElementById("zoomLevelText").textContent =
      `${Math.round(this.currentZoom * 100)}%`;
    if (!this.nativeViewport) return;

    const targetW = this.nativeViewport.width * this.currentZoom;
    const targetH = this.nativeViewport.height * this.currentZoom;
    this.canvas.style.width = targetW + "px";
    this.canvas.style.height = targetH + "px";
  },

  redrawCanvas() {
    if (!this.nativeViewport || !this.bgCanvas) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(this.bgCanvas, 0, 0);

    this.tempEdits.forEach((edit, idx) => {
      if (edit.type === "sign" && edit.imgObj) {
        this.ctx.drawImage(
          edit.imgObj,
          edit.x,
          edit.y,
          edit.width,
          edit.height,
        );
      } else if (edit.type === "text") {
        this.ctx.font = `${edit.size || 16}px sans-serif`;
        this.ctx.fillStyle = edit.color || "#1f6feb";
        this.ctx.fillText(edit.text, edit.x, edit.y);
      }

      if (idx === this.selectedEditIndex) {
        const box = this.getObjectBoundingBox(edit);
        this.ctx.strokeStyle = "#2f81f7";
        this.ctx.lineWidth = 1.5;
        this.ctx.setLineDash([4, 4]);
        this.ctx.strokeRect(box.x, box.y, box.w, box.h);
        this.ctx.setLineDash([]);

        const handles = this.getHandles(box);
        this.ctx.fillStyle = "#ffffff";
        this.ctx.strokeStyle = "#2f81f7";
        this.ctx.lineWidth = 2;
        Object.entries(handles).forEach(([name, h]) => {
          if (name === "x") {
            this.ctx.fillStyle = "#f85149";
            this.ctx.fillRect(h.x - 12, h.y - 12, 24, 24);
            this.ctx.strokeStyle = "#ffffff";
            this.ctx.lineWidth = 2;
            this.ctx.strokeRect(h.x - 12, h.y - 12, 24, 24);
            this.ctx.beginPath();
            this.ctx.moveTo(h.x - 5, h.y - 5);
            this.ctx.lineTo(h.x + 5, h.y + 5);
            this.ctx.moveTo(h.x + 5, h.y - 5);
            this.ctx.lineTo(h.x - 5, h.y + 5);
            this.ctx.stroke();
          } else {
            this.ctx.fillStyle = "#ffffff";
            this.ctx.fillRect(h.x - 6, h.y - 6, 12, 12);
            this.ctx.strokeRect(h.x - 6, h.y - 6, 12, 12);
          }
        });
      }
    });
  },

  getObjectBoundingBox(edit) {
    if (edit.type === "sign") {
      return { x: edit.x, y: edit.y, w: edit.width, h: edit.height };
    } else {
      const fontSize = edit.size || 16;
      return {
        x: edit.x,
        y: edit.y - fontSize,
        w: edit.width || 100,
        h: fontSize + 6,
      };
    }
  },

  getHandles(box) {
    return {
      nw: { x: box.x, y: box.y },
      ne: { x: box.x + box.w, y: box.y },
      se: { x: box.x + box.w, y: box.y + box.h },
      sw: { x: box.x, y: box.y + box.h },
      n: { x: box.x + box.w / 2, y: box.y },
      e: { x: box.x + box.w, y: box.y + box.h / 2 },
      s: { x: box.x + box.w / 2, y: box.y + box.h },
      w: { x: box.x, y: box.y + box.h / 2 },
      x: { x: box.x + box.w + 16, y: box.y - 16 },
    };
  },

  close(shouldPop = true) {
    document.getElementById("singleEditorOverlay").style.display = "none";
    document.body.classList.remove("modal-open");
    AppState.currentEditingItem = null;
    this.tempEdits = [];
    this.bgCanvas = null;
    if (this.popstateHandler) {
      window.removeEventListener("popstate", this.popstateHandler);
      this.popstateHandler = null;
    }
    if (shouldPop) {
      try {
        history.back();
      } catch (e) {}
    }
  },

  initColorPicker(gridId, colorInputId, hiddenPickerId) {
    const grid = document.getElementById(gridId);
    const colorInput = document.getElementById(colorInputId);
    const hiddenPicker = document.getElementById(hiddenPickerId);

    grid.innerHTML = "";
    COMMON_COLORS.forEach((hex) => {
      const cell = document.createElement("div");
      cell.className = "palette-color-cell";
      cell.style.backgroundColor = hex;
      if (hex === hiddenPicker.value) {
        cell.classList.add("active-color");
      }
      cell.onclick = () => {
        grid
          .querySelectorAll(".palette-color-cell")
          .forEach((c) => c.classList.remove("active-color"));
        cell.classList.add("active-color");
        colorInput.value = hex;
        hiddenPicker.value = hex;
      };
      grid.appendChild(cell);
    });

    colorInput.oninput = (e) => {
      const hex = e.target.value;
      hiddenPicker.value = hex;
      grid
        .querySelectorAll(".palette-color-cell")
        .forEach((c) => c.classList.remove("active-color"));
    };
  },

  initSignatureModal() {
    this.sigCanvas = document.getElementById("sigModalCanvas");
    this.sigCtx = this.sigCanvas.getContext("2d");

    const clearSig = () => {
      this.sigCtx.clearRect(0, 0, this.sigCanvas.width, this.sigCanvas.height);
      this.sigCtx.fillStyle = "#ffffff";
      this.sigCtx.fillRect(0, 0, this.sigCanvas.width, this.sigCanvas.height);
    };

    document.getElementById("btnOpenSignPad").onclick = () => {
      document.getElementById("signatureModal").style.display = "flex";
      clearSig();
    };

    document.getElementById("btnSigClear").onclick = clearSig;
    document.getElementById("btnSigCancel").onclick = () => {
      document.getElementById("signatureModal").style.display = "none";
    };

    const getSigPos = (e) => {
      const rect = this.sigCanvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return {
        x: (clientX - rect.left) * (this.sigCanvas.width / rect.width),
        y: (clientY - rect.top) * (this.sigCanvas.height / rect.height),
      };
    };

    const startSig = (e) => {
      this.isSigDrawing = true;
      const pos = getSigPos(e);
      this.sigLastX = pos.x;
      this.sigLastY = pos.y;
      e.preventDefault();
    };

    const moveSig = (e) => {
      if (!this.isSigDrawing) return;
      const pos = getSigPos(e);
      const activeColor =
        document.getElementById("signColorPicker")?.value || "#000000";

      this.sigCtx.strokeStyle = activeColor;
      this.sigCtx.lineWidth = 4;
      this.sigCtx.lineCap = "round";
      this.sigCtx.lineJoin = "round";
      this.sigCtx.beginPath();
      this.sigCtx.moveTo(this.sigLastX, this.sigLastY);
      this.sigCtx.lineTo(pos.x, pos.y);
      this.sigCtx.stroke();

      this.sigLastX = pos.x;
      this.sigLastY = pos.y;
      e.preventDefault();
    };

    const endSig = () => {
      this.isSigDrawing = false;
    };

    this.sigCanvas.onmousedown = startSig;
    window.addEventListener("mousemove", moveSig);
    window.addEventListener("mouseup", endSig);

    this.sigCanvas.ontouchstart = startSig;
    window.addEventListener("touchmove", moveSig, { passive: false });
    window.addEventListener("touchend", endSig);

    document.getElementById("btnSigConfirm").onclick = () => {
      const dataUrl = this.sigCanvas.toDataURL("image/png");
      const imgObj = new Image();
      imgObj.src = dataUrl;
      imgObj.onload = () => {
        // 預設將簽名放置在畫布中心偏上位置
        const boxW = Math.min(220, this.canvas.width * 0.4);
        const boxH = boxW * (this.sigCanvas.height / this.sigCanvas.width);
        const boxX = (this.canvas.width - boxW) / 2;
        const boxY = (this.canvas.height - boxH) / 2;

        this.tempEdits.push({
          type: "sign",
          dataUrl,
          imgObj,
          x: boxX,
          y: boxY,
          width: boxW,
          height: boxH,
        });
        this.selectedEditIndex = this.tempEdits.length - 1;
        this.redrawCanvas();
        UIService.showToast("簽章已加入，可自由縮放與移動", "success");
        document.getElementById("signatureModal").style.display = "none";
      };
    };
  },

  initEvents() {
    document.getElementById("btnCloseSingleEditor").onclick = () =>
      this.close(true);
    document.getElementById("btnCancelSingle").onclick = () => this.close(true);

    this.initColorPicker(
      "signPaletteGrid",
      "signColorInput",
      "signColorPicker",
    );
    this.initColorPicker(
      "textPaletteGrid",
      "textColorInput",
      "textColorPicker",
    );
    this.initSignatureModal();

    document.getElementById("btnZoomIn").onclick = () =>
      this.setZoom(this.currentZoom + 0.25);
    document.getElementById("btnZoomOut").onclick = () =>
      this.setZoom(this.currentZoom - 0.25);
    document.getElementById("btnZoomReset").onclick = () => this.setZoom(1.0);

    document.querySelectorAll(".tool-mode-btn").forEach((btn) => {
      btn.onclick = (e) => {
        document
          .querySelectorAll(".tool-mode-btn")
          .forEach((b) => b.classList.remove("active"));
        e.target.classList.add("active");
        this.currentMode = e.target.dataset.mode;
        document.getElementById("signToolOptions").style.display =
          this.currentMode === "sign" ? "flex" : "none";
        document.getElementById("textToolOptions").style.display =
          this.currentMode === "text" ? "flex" : "none";
      };
    });

    document.getElementById("btnClearPad").onclick = () => {
      this.tempEdits = this.tempEdits.filter((e) => e.type !== "sign");
      this.selectedEditIndex = null;
      this.redrawCanvas();
      UIService.showToast("已清除所有簽名", "info");
    };

    this.canvas = document.getElementById("singleEditCanvas");

    // 【問題二修正】：將互動與移動邏輯提升至 window 全域監聽，確保在手機邊緣調整大小或拖曳不會中斷
    const handleStart = (clientX, clientY) => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      const x = (clientX - rect.left) * scaleX;
      const y = (clientY - rect.top) * scaleY;

      if (this.selectedEditIndex !== null) {
        const box = this.getObjectBoundingBox(
          this.tempEdits[this.selectedEditIndex],
        );
        const handles = this.getHandles(box);
        for (const [hName, hCoord] of Object.entries(handles)) {
          const hitRadius = hName === "x" ? 24 : 16; // 放大手機觸控容錯範圍
          if (
            Math.abs(x - hCoord.x) <= hitRadius &&
            Math.abs(y - hCoord.y) <= hitRadius
          ) {
            if (hName === "x") {
              this.tempEdits.splice(this.selectedEditIndex, 1);
              this.selectedEditIndex = null;
              this.redrawCanvas();
              UIService.showToast("已刪除該物件", "info");
              return true;
            }
            this.isResizingObject = true;
            this.activeHandle = hName;
            this.initialResizeState = {
              x: box.x,
              y: box.y,
              w: box.w,
              h: box.h,
              mouseX: x,
              mouseY: y,
              edit: this.tempEdits[this.selectedEditIndex],
            };
            return true;
          }
        }
      }

      let clickedIdx = -1;
      for (let i = this.tempEdits.length - 1; i >= 0; i--) {
        const box = this.getObjectBoundingBox(this.tempEdits[i]);
        if (
          x >= box.x &&
          x <= box.x + box.w &&
          y >= box.y &&
          y <= box.y + box.h
        ) {
          clickedIdx = i;
          break;
        }
      }

      if (clickedIdx !== -1) {
        this.selectedEditIndex = clickedIdx;
        this.isDraggingObject = true;
        const obj = this.tempEdits[clickedIdx];
        this.dragOffsetX = x - obj.x;
        this.dragOffsetY = y - obj.y;
        this.redrawCanvas();
        return true;
      }

      if (this.selectedEditIndex !== null) {
        this.selectedEditIndex = null;
        this.redrawCanvas();
        return true;
      }

      // 文字模式：點擊空白處直接加入文字
      if (this.currentMode === "text") {
        const textInput = document.getElementById("customTextInput");
        const textVal = textInput.value.trim();
        if (!textVal) {
          UIService.showToast("請先在上方輸入框填入要加入的文字", "error");
          textInput.focus();
          return true;
        }
        const fontSize = 18;
        const textColor =
          document.getElementById("textColorPicker")?.value || "#1f6feb";

        this.ctx.font = `${fontSize}px sans-serif`;
        const metrics = this.ctx.measureText(textVal);

        this.tempEdits.push({
          type: "text",
          text: textVal,
          size: fontSize,
          color: textColor,
          x,
          y,
          width: metrics.width,
        });
        this.selectedEditIndex = this.tempEdits.length - 1;
        this.redrawCanvas();
        UIService.showToast("已加入文字，可拖曳或縮放", "success");
      }
      this.redrawCanvas();
      return true;
    };

    const handleMove = (clientX, clientY) => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      const x = (clientX - rect.left) * scaleX;
      const y = (clientY - rect.top) * scaleY;

      if (this.isResizingObject && this.initialResizeState) {
        const st = this.initialResizeState;
        const dx = x - st.mouseX;
        const dy = y - st.mouseY;
        let newW = st.w,
          newH = st.h,
          newX = st.x,
          newY = st.y;

        if (this.activeHandle.includes("e")) newW = Math.max(20, st.w + dx);
        if (this.activeHandle.includes("s")) newH = Math.max(20, st.h + dy);
        if (this.activeHandle.includes("w")) {
          const possibleW = st.w - dx;
          if (possibleW > 20) {
            newW = possibleW;
            newX = st.x + dx;
          }
        }
        if (this.activeHandle.includes("n")) {
          const possibleH = st.h - dy;
          if (possibleH > 20) {
            newH = possibleH;
            newY = st.y + dy;
          }
        }

        const ratio = st.w / st.h;
        if (this.activeHandle.length === 2 && ratio) {
          newH = newW / ratio;
        }

        if (st.edit.type === "sign") {
          st.edit.x = newX;
          st.edit.y = newY;
          st.edit.width = newW;
          st.edit.height = newH;
        } else if (st.edit.type === "text") {
          st.edit.x = newX;
          st.edit.y = newY + newH * 0.75;
          st.edit.size = Math.max(10, Math.round(newH * 0.8));
          st.edit.width = newW;
        }
        this.redrawCanvas();
        return;
      }

      if (this.isDraggingObject && this.selectedEditIndex !== null) {
        const obj = this.tempEdits[this.selectedEditIndex];
        obj.x = x - this.dragOffsetX;
        obj.y = y - this.dragOffsetY;
        this.redrawCanvas();
        return;
      }
    };

    const handleEnd = () => {
      if (this.isResizingObject) {
        this.isResizingObject = false;
        this.initialResizeState = null;
        return;
      }
      if (this.isDraggingObject) {
        this.isDraggingObject = false;
        return;
      }
    };

    this.canvas.addEventListener("mousedown", (e) =>
      handleStart(e.clientX, e.clientY),
    );
    window.addEventListener("mousemove", (e) =>
      handleMove(e.clientX, e.clientY),
    );
    window.addEventListener("mouseup", () => handleEnd());

    this.canvas.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length === 1) {
          const touch = e.touches[0];
          handleStart(touch.clientX, touch.clientY);
          e.preventDefault();
        }
      },
      { passive: false },
    );

    window.addEventListener(
      "touchmove",
      (e) => {
        if (
          e.touches.length === 1 &&
          (this.isResizingObject || this.isDraggingObject)
        ) {
          const touch = e.touches[0];
          handleMove(touch.clientX, touch.clientY);
          e.preventDefault();
        }
      },
      { passive: false },
    );

    window.addEventListener("touchend", () => handleEnd());

    document.getElementById("btnSaveSingle").onclick = () => {
      if (!AppState.currentEditingItem) return;
      AppState.currentEditingItem.edits = this.tempEdits.map((e) => ({
        type: e.type,
        dataUrl: e.dataUrl,
        text: e.text,
        size: e.size,
        color: e.color,
        x: e.x,
        y: e.y,
        width: e.width,
        height: e.height,
      }));

      this.selectedEditIndex = null;
      this.redrawCanvas();

      AppState.currentEditingItem.editSnapshot =
        this.canvas.toDataURL("image/png");
      PDFService.renderPagePreview(AppState.currentEditingItem);
      UIComponent.syncStateAndBadges();
      UIService.showToast("已儲存該頁編輯內容", "success");
      this.close(true);
    };
  },
};

/**
 * ==========================================
 * 6. CONTROLLER & EVENT LAYER (控制與事件層)
 * ==========================================
 */
const Controller = {
  initSortable() {
    if (AppState.sortableInstance) return;
    AppState.sortableInstance = new Sortable(
      document.getElementById("pageGrid"),
      {
        draggable: ".page-card",
        filter:
          ".card-index-input, .btn-delete-x, .card-actions, button, input",
        preventOnFilter: false,
        animation: 180,
        // 【問題四修正】：增加手機長按延遲，讓使用者在手機上可以順暢上下滾動頁面
        delay: 200,
        delayOnTouchOnly: true,
        touchStartThreshold: 5,
        ghostClass: "sortable-ghost",
        chosenClass: "sortable-chosen",
        scroll: true,
        scrollSensitivity: 100,
        scrollSpeed: 20,
        bubbleScroll: true,
        onEnd: function (evt) {
          if (evt.oldIndex === evt.newIndex) return;
          if (evt.newIndex >= AppState.pageItems.length)
            evt.newIndex = AppState.pageItems.length - 1;
          const [moved] = AppState.pageItems.splice(evt.oldIndex, 1);
          AppState.pageItems.splice(evt.newIndex, 0, moved);
          UIComponent.syncStateAndBadges();
        },
      },
    );
  },

  animateReorder(actionFn) {
    const firstPositions = new Map();
    AppState.pageItems.forEach((item) => {
      if (item.cardElement)
        firstPositions.set(item.id, item.cardElement.getBoundingClientRect());
    });

    actionFn();

    AppState.pageItems.forEach((item) => {
      const card = item.cardElement;
      if (!card) return;
      const first = firstPositions.get(item.id);
      const last = card.getBoundingClientRect();
      if (first) {
        const deltaX = first.left - last.left;
        const deltaY = first.top - last.top;
        if (deltaX !== 0 || deltaY !== 0) {
          card.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
          card.style.transition = "none";
          card.offsetHeight;
          requestAnimationFrame(() => {
            card.style.transition = "transform 0.25s ease-out";
            card.style.transform = "";
          });
          setTimeout(() => {
            card.style.transition = "";
          }, 250);
        }
      }
    });
  },

  rotateItem(item) {
    item.userRotation = (item.userRotation + 90) % 360;
    PDFService.renderPagePreview(item);
  },

  moveItemByStep(item, step) {
    const idx = AppState.pageItems.indexOf(item);
    const targetIdx = idx + step;
    if (targetIdx < 0 || targetIdx >= AppState.pageItems.length) return;

    Controller.animateReorder(() => {
      AppState.pageItems.splice(idx, 1);
      AppState.pageItems.splice(targetIdx, 0, item);

      const addCard = UIComponent.getOrCreateAddCard();
      const nextRef = AppState.pageItems[targetIdx + 1]?.cardElement || addCard;
      document
        .getElementById("pageGrid")
        .insertBefore(item.cardElement, nextRef);
      UIComponent.syncStateAndBadges();
    });
  },

  getElementDocumentTop(el) {
    let top = 0,
      curr = el;
    while (curr) {
      top += curr.offsetTop;
      curr = curr.offsetParent;
    }
    return top;
  },

  jumpItemToPosition(item, inputEl) {
    const currentIdx = AppState.pageItems.indexOf(item);
    let targetNum = parseInt(inputEl.value, 10);

    if (
      isNaN(targetNum) ||
      targetNum < 1 ||
      targetNum > AppState.pageItems.length ||
      targetNum - 1 === currentIdx
    ) {
      inputEl.value = currentIdx + 1;
      return;
    }

    const targetIdx = targetNum - 1;
    Controller.animateReorder(() => {
      AppState.pageItems.splice(currentIdx, 1);
      AppState.pageItems.splice(targetIdx, 0, item);

      const addCard = UIComponent.getOrCreateAddCard();
      const nextRef = AppState.pageItems[targetIdx + 1]?.cardElement || addCard;
      document
        .getElementById("pageGrid")
        .insertBefore(item.cardElement, nextRef);
      UIComponent.syncStateAndBadges();
    });

    requestAnimationFrame(() => {
      const restingTop = Controller.getElementDocumentTop(item.cardElement);
      const cardHeight = item.cardElement.offsetHeight || 380;
      window.scrollTo({
        top: Math.max(0, restingTop - (window.innerHeight - cardHeight) / 2),
        behavior: "smooth",
      });
    });

    UIService.showToast(`已將該頁移至第 ${targetNum} 位`, "info");
  },

  deleteItem(item) {
    const idx = AppState.pageItems.indexOf(item);
    if (idx !== -1) {
      Controller.animateReorder(() => {
        AppState.pageItems.splice(idx, 1);
        item.cardElement.remove();
        UIComponent.syncStateAndBadges();
      });
      UIService.showToast("已刪除該頁", "info");
    }
  },

  async handleFiles(files) {
    UIService.showLoading("載入頁面中...");
    const fileArray = Array.from(files);
    const newItems = [];
    let loadedCount = 0;

    // 【問題一修正】：使用標準 for...of 非同步迴圈支援手機與電腦批次多檔上傳
    for (const file of fileArray) {
      if (!file.name.toLowerCase().endsWith(".pdf")) continue;
      try {
        AppState.totalBytes += file.size;
        const buffer = await file.arrayBuffer();
        const doc = await pdfjsLib.getDocument({ data: buffer.slice(0) })
          .promise;

        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const item = {
            id: AppState.nextUniqueId++,
            sourceBuffer: buffer,
            fileName: file.name,
            pageIndex: i - 1,
            userRotation: 0,
            initialRotation: page.rotate || 0,
            cardElement: null,
            canvasElement: null,
            edits: [],
            editSnapshot: null,
          };
          newItems.push(item);
          AppState.pageItems.push(item);
          loadedCount++;
        }
      } catch (err) {
        UIService.showToast(
          `無法開啟 ${file.name}，請檢查檔案格式或是否加密。`,
          "error",
        );
      }
    }

    const pageGrid = document.getElementById("pageGrid");
    const addCard = UIComponent.getOrCreateAddCard();
    if (!pageGrid.contains(addCard)) pageGrid.appendChild(addCard);

    for (const item of newItems) {
      const card = UIComponent.createCardElement(item);
      item.cardElement = card;
      pageGrid.insertBefore(card, addCard);
      PDFService.renderPagePreview(item);
    }

    UIService.hideLoading();
    if (loadedCount > 0) {
      UIService.showToast(`已成功載入 ${loadedCount} 頁`, "success");
    } else {
      UIService.showToast("未能成功載入任何 PDF 檔案", "error");
    }
    UIComponent.syncStateAndBadges();
    Controller.initSortable();
  },

  async exportPdf() {
    if (!AppState.pageItems.length) return;
    UIService.showLoading("正在合併 PDF 與套用編輯/簽章...");
    try {
      const outDoc = await PDFLib.PDFDocument.create();
      const cache = new Map();

      for (const item of AppState.pageItems) {
        let src = cache.get(item.sourceBuffer);
        if (!src) {
          src = await PDFLib.PDFDocument.load(item.sourceBuffer);
          cache.set(item.sourceBuffer, src);
        }
        const [copied] = await outDoc.copyPages(src, [item.pageIndex]);
        if (item.userRotation !== 0) {
          const cur = copied.getRotation().angle;
          copied.setRotation(PDFLib.degrees((cur + item.userRotation) % 360));
        }

        if (item.edits && item.edits.length > 0) {
          const { width, height } = copied.getSize();
          for (const edit of item.edits) {
            const scaleFactorX =
              width /
              (SingleEditorController.nativeViewport?.width || width * 1.5);
            const scaleFactorY =
              height /
              (SingleEditorController.nativeViewport?.height || height * 1.5);

            if (edit.type === "sign") {
              const pngImage = await outDoc.embedPng(edit.dataUrl);
              copied.drawImage(pngImage, {
                x: edit.x * scaleFactorX,
                y: height - (edit.y + edit.height) * scaleFactorY,
                width: edit.width * scaleFactorX,
                height: edit.height * scaleFactorY,
              });
            } else if (edit.type === "text") {
              let r = 0.12,
                g = 0.43,
                b = 0.98;
              if (
                edit.color &&
                edit.color.startsWith("#") &&
                edit.color.length === 7
              ) {
                r = parseInt(edit.color.substr(1, 2), 16) / 255;
                g = parseInt(edit.color.substr(3, 2), 16) / 255;
                b = parseInt(edit.color.substr(5, 2), 16) / 255;
              }
              copied.drawText(edit.text, {
                x: edit.x * scaleFactorX,
                y: height - edit.y * scaleFactorY,
                size: (edit.size || 16) * scaleFactorX,
                color: PDFLib.rgb(r, g, b),
              });
            }
          }
        }

        outDoc.addPage(copied);
      }

      const bytes = await outDoc.save();
      PDFService.triggerDownload(
        new Blob([bytes], { type: "application/pdf" }),
        PDFService.getTargetFilename("pdf"),
      );
      UIService.showToast("PDF 匯出成功", "success");
    } catch (err) {
      UIService.showToast("PDF 匯出失敗：" + err.message, "error");
      console.error(err);
    } finally {
      UIService.hideLoading();
    }
  },

  async exportJpg() {
    if (!AppState.pageItems.length) return;
    const quality = document.getElementById("jpgQualityMode").value;
    const total = AppState.pageItems.length;
    UIService.showLoading(`準備轉檔中 (0 / ${total})...`);

    const cfg = QUALITY_CONFIGS[quality] || QUALITY_CONFIGS.standard;

    try {
      const zip = new JSZip();
      const docCache = new Map();

      const getDoc = async (buffer) => {
        if (!docCache.has(buffer)) {
          docCache.set(
            buffer,
            await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise,
          );
        }
        return docCache.get(buffer);
      };

      for (let i = 0; i < total; i++) {
        const item = AppState.pageItems[i];
        const pageNumber = i + 1;
        const doc = await getDoc(item.sourceBuffer);
        const page = await doc.getPage(item.pageIndex + 1);
        const totalRotation = (item.initialRotation + item.userRotation) % 360;

        const unscaled = page.getViewport({
          scale: 1.0,
          rotation: totalRotation,
        });
        const appliedScale = Math.min(
          cfg.scale,
          cfg.maxDim / Math.max(unscaled.width, unscaled.height),
        );
        const viewport = page.getViewport({
          scale: appliedScale,
          rotation: totalRotation,
        });

        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d", { alpha: false });

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;

        if (item.editSnapshot) {
          const img = new Image();
          img.src = item.editSnapshot;
          await new Promise((r) => (img.onload = r));
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        }

        const blob = await new Promise((res) =>
          canvas.toBlob(res, "image/jpeg", cfg.quality),
        );
        zip.file(`page_${String(pageNumber).padStart(3, "0")}.jpg`, blob);
        canvas.width = 0;
        canvas.height = 0;
      }

      UIService.showLoading("正在打包 ZIP...");
      const zipContent = await zip.generateAsync(
        { type: "blob", compression: "STORE" },
        (meta) => {
          UIService.showLoading(`打包進度：${Math.floor(meta.percent)}%`);
        },
      );

      PDFService.triggerDownload(
        zipContent,
        PDFService.getTargetFilename("zip"),
      );
      UIService.showToast("JPG 打包下載完成", "success");
    } catch (err) {
      UIService.showToast("轉檔失敗：" + err.message, "error");
    } finally {
      UIService.hideLoading();
    }
  },
};

/**
 * ==========================================
 * 7. INITIALIZATION & EVENT BINDINGS (初始化與綁定)
 * ==========================================
 */
document.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("fileInput");
  document
    .getElementById("emptyHero")
    .addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => {
    if (e.target.files?.length) Controller.handleFiles(e.target.files);
    fileInput.value = "";
  });

  let dragCounter = 0;
  const globalDropOverlay = document.getElementById("globalDropOverlay");
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragCounter++;
    if (e.dataTransfer.types.includes("Files"))
      globalDropOverlay.style.display = "flex";
  });
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      globalDropOverlay.style.display = "none";
      dragCounter = 0;
    }
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragCounter = 0;
    globalDropOverlay.style.display = "none";
    if (e.dataTransfer.files?.length)
      Controller.handleFiles(e.dataTransfer.files);
  });

  window.addEventListener("resize", UIComponent.updateFloatingBarPosition);
  const editorSectionEl = document.querySelector(".editor-section");
  if (window.ResizeObserver && editorSectionEl) {
    new ResizeObserver(UIComponent.updateFloatingBarPosition).observe(
      editorSectionEl,
    );
  }

  document
    .getElementById("btnScrollTop")
    .addEventListener("click", () =>
      window.scrollTo({ top: 0, behavior: "smooth" }),
    );
  document.getElementById("btnScrollBottom").addEventListener("click", () => {
    const addCard = UIComponent.getOrCreateAddCard();
    if (addCard && addCard.parentElement)
      addCard.scrollIntoView({ behavior: "smooth", block: "center" });
    else
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  });

  const qualityModeSelect = document.getElementById("jpgQualityMode");
  qualityModeSelect.addEventListener("change", (e) => {
    document.getElementById("jpgQualityNote").textContent =
      QUALITY_NOTES[e.target.value] || "";
  });

  document.getElementById("btnClearAll").addEventListener("click", async () => {
    if (!AppState.pageItems.length) return;
    const confirmed = await UIService.showConfirmDialog({
      title: "確定清空所有頁面？",
      text: `將清除目前已加入的 ${AppState.pageItems.length} 個頁面。`,
      confirmText: "確認清空",
      cancelText: "取消",
    });
    if (confirmed) {
      AppState.pageItems.forEach((item) => item.cardElement?.remove());
      AppState.pageItems = [];
      AppState.totalBytes = 0;
      UIComponent.syncStateAndBadges();
      UIService.showToast("已清空頁面", "info");
    }
  });

  document
    .getElementById("btnExportPdf")
    .addEventListener("click", Controller.exportPdf);
  document
    .getElementById("btnExportJpg")
    .addEventListener("click", Controller.exportJpg);

  SingleEditorController.initEvents();
});
