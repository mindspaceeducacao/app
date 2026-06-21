/* ==========================================================================
   VIEWER.JS
   Núcleo do visualizador de PDF. Responsável por:
   - Carregar o documento via PDF.js
   - Criar a estrutura virtualizada de páginas (placeholders + canvas)
   - Renderizar/descarregar páginas conforme a posição de rolagem (lazy load)
   - Controlar zoom (Ctrl+scroll, pinça touch, botões), ajuste de
     largura/página e rotação
   - Navegação por teclado (setas, PageUp/Down, Home/End)
   - Indicador flutuante de página atual e botão "voltar ao topo"
   ========================================================================== */

const PDFViewer = {
  container: null,        // .viewer (elemento com scroll)
  pagesContainer: null,   // .viewer__pages
  pageIndicator: null,
  scrollTopBtn: null,

  pages: [],              // [{ pageNum, wrapperEl, canvas, textLayerEl, status, baseWidth, baseHeight }]
  renderQueue: new Set(), // páginas atualmente em processo de renderização
  observer: null,         // IntersectionObserver para virtualização

  scrollRAF: null,
  resizeRAF: null,

  // Constantes de virtualização: quantas páginas "à frente/atrás" mantemos montadas.
  RENDER_MARGIN: "1200px 0px 1200px 0px",
  UNLOAD_MARGIN_PAGES: 4, // páginas fora desta janela são descarregadas

  /** Ponto de entrada: configura PDF.js e inicia o carregamento do documento. */
  async init() {
    this.container = document.getElementById("viewerContainer");
    this.pagesContainer = document.getElementById("pagesContainer");
    this.pageIndicator = document.getElementById("pageIndicator");
    this.scrollTopBtn = document.getElementById("btnScrollTop");

    this.configurePdfJsWorker();
    this.bindEvents();
    this.bindEventBus();

    await this.loadDocument(AppState.pdfUrl);
  },

  /** Define o caminho do worker do PDF.js (arquivo local, sem CDN). */
  configurePdfJsWorker() {
    if (typeof pdfjsLib === "undefined") {
      console.error("[PDFViewer] pdfjsLib não encontrado. Verifique pdfjs/pdf.min.js");
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = "pdfjs/pdf.worker.min.js";
  },

  /* ------------------------------------------------------------------------
     CARREGAMENTO DO DOCUMENTO
     ------------------------------------------------------------------------ */

  async loadDocument(url) {
    const loadingOverlay = document.getElementById("loadingOverlay");
    const loadingText = document.getElementById("loadingText");
    const progressBar = document.getElementById("loadingProgressBar");

    try {
      const loadingTask = pdfjsLib.getDocument({
        url,
        cMapUrl: null,
        enableXfa: true,
      });

      loadingTask.onProgress = (progress) => {
        if (progress.total) {
          const pct = Math.min(100, Math.round((progress.loaded / progress.total) * 100));
          progressBar.style.width = `${pct}%`;
          loadingText.textContent = `Carregando documento... ${pct}%`;
        }
      };

      const pdfDoc = await loadingTask.promise;

      AppState.pdfDoc = pdfDoc;
      AppState.numPages = pdfDoc.numPages;
      AppState.fileName = this.extractFileName(url);
      document.getElementById("docTitle").textContent = AppState.fileName;
      document.getElementById("docTitle").title = AppState.fileName;
      document.title = AppState.fileName + " — PDF Viewer";

      progressBar.style.width = "100%";

      this.restorePersistedState();
      await this.buildPageStructure();

      EventBus.emit("document:loaded");

      // Restaura a última página visitada (se existir e for válida).
      const lastPage = Storage.get("lastPage", 1);
      const targetPage = Math.min(Math.max(1, lastPage), AppState.numPages);
      this.scrollToPage(targetPage, "auto");

      setTimeout(() => loadingOverlay.classList.add("is-hidden"), 280);
      Toast.show(`Documento carregado: ${AppState.numPages} páginas`);
    } catch (err) {
      console.error("[PDFViewer] Erro ao carregar o PDF:", err);
      loadingText.textContent = "Erro ao carregar o documento.";
      Toast.show("Não foi possível carregar o PDF.", 4000);
    }
  },

  extractFileName(url) {
    const clean = url.split("?")[0];
    const parts = clean.split("/");
    return decodeURIComponent(parts[parts.length - 1] || "documento.pdf");
  },

  /** Recupera zoom salvo no localStorage (a página é restaurada após montar a estrutura). */
  restorePersistedState() {
    const savedZoom = Storage.get("zoom", null);
    if (savedZoom && typeof savedZoom === "number") {
      AppState.scale = Math.min(Math.max(savedZoom, AppState.minScale), AppState.maxScale);
    }
    ZoomControl.syncUI(AppState.scale);
  },

  /* ------------------------------------------------------------------------
     CONSTRUÇÃO DA ESTRUTURA VIRTUALIZADA DE PÁGINAS
     ------------------------------------------------------------------------ */

  /**
   * Cria um wrapper <div class="pdf-page"> para cada página do documento,
   * já com as dimensões corretas (para que a rolagem total seja precisa),
   * mas SEM renderizar o conteúdo ainda — isso é feito sob demanda.
   */
  async buildPageStructure() {
    this.pagesContainer.innerHTML = "";
    this.pages = [];

    // Primeira página é usada para obter dimensões base de referência.
    const firstPage = await AppState.pdfDoc.getPage(1);
    const baseViewport = firstPage.getViewport({ scale: 1 });

    for (let pageNum = 1; pageNum <= AppState.numPages; pageNum++) {
      const wrapper = this.createPageWrapper(pageNum, baseViewport);
      this.pages.push({
        pageNum,
        wrapperEl: wrapper,
        canvas: null,
        textLayerEl: null,
        status: "unloaded", // unloaded -> loading -> rendered
        baseWidth: baseViewport.width,
        baseHeight: baseViewport.height,
      });
      this.pagesContainer.appendChild(wrapper);
    }

    this.applyScaleToAllWrappers();
    this.setupVirtualization();
  },

  /** Cria o elemento wrapper de uma página com placeholder de carregamento. */
  createPageWrapper(pageNum, baseViewport) {
    const wrapper = document.createElement("div");
    wrapper.className = "pdf-page";
    wrapper.dataset.pageNumber = String(pageNum);
    wrapper.style.width = `${baseViewport.width}px`;
    wrapper.style.height = `${baseViewport.height}px`;

    const placeholder = document.createElement("div");
    placeholder.className = "pdf-page__placeholder";
    placeholder.innerHTML = '<div class="loading-spinner"></div>';
    wrapper.appendChild(placeholder);

    const badge = document.createElement("span");
    badge.className = "pdf-page__number-badge";
    badge.textContent = `Página ${pageNum}`;
    wrapper.appendChild(badge);

    return wrapper;
  },

  /* ------------------------------------------------------------------------
     VIRTUALIZAÇÃO (lazy load / unload de páginas)
     ------------------------------------------------------------------------ */

  setupVirtualization() {
    if (this.observer) this.observer.disconnect();

    this.observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const pageNum = parseInt(entry.target.dataset.pageNumber, 10);
          if (entry.isIntersecting) {
            this.renderPage(pageNum);
          } else {
            this.scheduleUnload(pageNum);
          }
        });
      },
      {
        root: this.container,
        rootMargin: this.RENDER_MARGIN,
        threshold: 0.01,
      }
    );

    this.pages.forEach((p) => this.observer.observe(p.wrapperEl));
  },

  /**
   * Decide se uma página que saiu da área de observação deve ser
   * efetivamente descarregada (liberar canvas/textLayer da memória).
   * Mantemos uma janela de segurança ao redor da página atual para
   * evitar descarregar/recarregar repetidamente durante rolagem rápida.
   */
  scheduleUnload(pageNum) {
    const distance = Math.abs(pageNum - AppState.currentPage);
    if (distance > this.UNLOAD_MARGIN_PAGES) {
      this.unloadPage(pageNum);
    }
  },

  /** Libera os recursos (canvas, text layer) de uma página, voltando ao placeholder. */
  unloadPage(pageNum) {
    const page = this.pages[pageNum - 1];
    if (!page || page.status === "unloaded") return;

    page.wrapperEl.innerHTML = "";
    const placeholder = document.createElement("div");
    placeholder.className = "pdf-page__placeholder";
    placeholder.innerHTML = '<div class="loading-spinner"></div>';
    page.wrapperEl.appendChild(placeholder);

    const badge = document.createElement("span");
    badge.className = "pdf-page__number-badge";
    badge.textContent = `Página ${pageNum}`;
    page.wrapperEl.appendChild(badge);

    page.canvas = null;
    page.textLayerEl = null;
    page.status = "unloaded";
  },

  /**
   * Renderiza o conteúdo de uma página (canvas + camada de texto) usando
   * PDF.js. Evita renderizações concorrentes duplicadas via renderQueue.
   */
  async renderPage(pageNum) {
    const page = this.pages[pageNum - 1];
    if (!page || page.status === "rendered" || this.renderQueue.has(pageNum)) return;

    this.renderQueue.add(pageNum);
    page.status = "loading";

    try {
      const pdfPage = await AppState.pdfDoc.getPage(pageNum);
      const viewport = pdfPage.getViewport({ scale: AppState.scale, rotation: AppState.rotation });

      // Garante que, se a renderização ficou obsoleta (zoom mudou no meio do processo),
      // a próxima chamada de renderPage cuidará de atualizar corretamente.
      const wrapper = page.wrapperEl;
      wrapper.style.width = `${viewport.width}px`;
      wrapper.style.height = `${viewport.height}px`;
      wrapper.innerHTML = "";

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { alpha: false });
      const outputScale = window.devicePixelRatio || 1;

      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;

      wrapper.appendChild(canvas);

      const renderTask = pdfPage.render({ canvasContext: ctx, viewport, transform });
      await renderTask.promise;

      // Camada de texto (necessária para seleção e busca).
      const textLayerEl = await this.renderTextLayer(pdfPage, viewport, wrapper);

      const badge = document.createElement("span");
      badge.className = "pdf-page__number-badge";
      badge.textContent = `Página ${pageNum}`;
      wrapper.appendChild(badge);

      page.canvas = canvas;
      page.textLayerEl = textLayerEl;
      page.status = "rendered";

      EventBus.emit("page:textLayerRendered", { pageNum });
    } catch (err) {
      console.error(`[PDFViewer] erro ao renderizar página ${pageNum}`, err);
      page.status = "unloaded";
    } finally {
      this.renderQueue.delete(pageNum);
    }
  },

  /** Cria a camada de texto sobreposta ao canvas, usada para seleção e busca. */
  async renderTextLayer(pdfPage, viewport, wrapper) {
    const textContent = await pdfPage.getTextContent();

    const textLayerDiv = document.createElement("div");
    textLayerDiv.className = "pdf-page__text-layer";
    textLayerDiv.style.width = `${viewport.width}px`;
    textLayerDiv.style.height = `${viewport.height}px`;
    wrapper.appendChild(textLayerDiv);

    // API clássica do PDF.js (legacy build) para construir a camada de texto.
    if (pdfjsLib.renderTextLayer) {
      const task = pdfjsLib.renderTextLayer({
        textContent,
        container: textLayerDiv,
        viewport,
        textDivs: [],
      });
      await task.promise;
    } else {
      // Fallback manual simples, caso a API renderTextLayer não esteja disponível.
      this.manualTextLayerFallback(textContent, viewport, textLayerDiv);
    }

    return textLayerDiv;
  },

  /** Fallback manual para posicionar spans de texto, usado apenas se necessário. */
  manualTextLayerFallback(textContent, viewport, container) {
    textContent.items.forEach((item) => {
      const span = document.createElement("span");
      span.textContent = item.str;
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]);
      span.style.left = `${tx[4]}px`;
      span.style.top = `${tx[5] - fontHeight}px`;
      span.style.fontSize = `${fontHeight}px`;
      span.style.fontFamily = item.fontName || "sans-serif";
      container.appendChild(span);
    });
  },

  /* ------------------------------------------------------------------------
     ZOOM E ESCALA
     ------------------------------------------------------------------------ */

  /** Atualiza apenas as dimensões (width/height) dos wrappers sem re-renderizar tudo de uma vez. */
  applyScaleToAllWrappers() {
    const rotated = AppState.rotation % 180 !== 0;
    this.pages.forEach((page) => {
      const w = rotated ? page.baseHeight : page.baseWidth;
      const h = rotated ? page.baseWidth : page.baseHeight;
      page.wrapperEl.style.width = `${w * AppState.scale}px`;
      page.wrapperEl.style.height = `${h * AppState.scale}px`;
    });
  },

  /**
   * Reaplica o zoom atual: ajusta dimensões de todos os wrappers e
   * força a re-renderização das páginas atualmente visíveis/montadas.
   * Páginas fora da viewport apenas têm seu tamanho de placeholder ajustado.
   */
  async rescaleAndRerender(preserveScrollAnchor = true) {
    const anchor = preserveScrollAnchor ? this.getScrollAnchor() : null;

    this.applyScaleToAllWrappers();

    // Marca como "unloaded" todas as páginas renderizadas para forçar re-render
    // com a nova escala — mas apenas as que estão (ou ficarão) visíveis serão
    // de fato redesenhadas pelo IntersectionObserver/renderPage.
    this.pages.forEach((page) => {
      if (page.status === "rendered") {
        page.status = "unloaded";
      }
    });

    // Reobserva (o observer já está ativo; apenas disparamos checagem manual
    // para páginas atualmente dentro da viewport, sem esperar evento de scroll).
    this.pages.forEach((page) => {
      const rect = page.wrapperEl.getBoundingClientRect();
      const containerRect = this.container.getBoundingClientRect();
      const isNear =
        rect.bottom > containerRect.top - 1200 && rect.top < containerRect.bottom + 1200;
      if (isNear) this.renderPage(page.pageNum);
    });

    if (anchor) {
      // Restaura a posição relativa de rolagem após o reflow do novo tamanho.
      requestAnimationFrame(() => this.restoreScrollAnchor(anchor));
    }
  },

  /** Captura um "ponto de ancoragem" da rolagem atual (página + offset relativo). */
  getScrollAnchor() {
    const pageNum = AppState.currentPage;
    const page = this.pages[pageNum - 1];
    if (!page) return null;
    const wrapperRect = page.wrapperEl.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();
    const relativeOffset = containerRect.top - wrapperRect.top;
    const ratio = page.wrapperEl.offsetHeight > 0 ? relativeOffset / page.wrapperEl.offsetHeight : 0;
    return { pageNum, ratio };
  },

  /** Restaura a posição de rolagem com base no ponto de ancoragem salvo. */
  restoreScrollAnchor(anchor) {
    const page = this.pages[anchor.pageNum - 1];
    if (!page) return;
    const offsetTop = page.wrapperEl.offsetTop;
    const targetScroll = offsetTop + anchor.ratio * page.wrapperEl.offsetHeight;
    this.container.scrollTop = targetScroll;
  },

  /** Calcula e aplica o zoom necessário para ajustar a largura da página ao container. */
  fitToWidth() {
    if (this.pages.length === 0) return;
    const referencePage = this.pages[AppState.currentPage - 1] || this.pages[0];
    const rotated = AppState.rotation % 180 !== 0;
    const naturalWidth = rotated ? referencePage.baseHeight : referencePage.baseWidth;
    const availableWidth = this.container.clientWidth - 48; // margem de respiro
    const scale = availableWidth / naturalWidth;
    ZoomControl.setScale(scale, "width");
    this.rescaleAndRerender(false);
  },

  /** Calcula e aplica o zoom necessário para ajustar a página inteira ao container. */
  fitToPage() {
    if (this.pages.length === 0) return;
    const referencePage = this.pages[AppState.currentPage - 1] || this.pages[0];
    const rotated = AppState.rotation % 180 !== 0;
    const naturalWidth = rotated ? referencePage.baseHeight : referencePage.baseWidth;
    const naturalHeight = rotated ? referencePage.baseWidth : referencePage.baseHeight;
    const availableWidth = this.container.clientWidth - 48;
    const availableHeight = this.container.clientHeight - 48;
    const scale = Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight);
    ZoomControl.setScale(scale, "page");
    this.rescaleAndRerender(false);
  },

  /* ------------------------------------------------------------------------
     NAVEGAÇÃO / ROLAGEM
     ------------------------------------------------------------------------ */

  /** Rola suavemente até o início de uma página específica. */
  scrollToPage(pageNum, behavior = "smooth") {
    const clamped = Math.min(Math.max(1, pageNum), AppState.numPages);
    const page = this.pages[clamped - 1];
    if (!page) return;

    this.container.scrollTo({
      top: page.wrapperEl.offsetTop - 16,
      behavior,
    });

    AppState.currentPage = clamped;
    EventBus.emit("page:changed", clamped);
  },

  /**
   * Determina qual página está atualmente mais visível no centro do
   * viewport e atualiza o estado/indicador de página atual.
   */
  detectCurrentPage() {
    const containerRect = this.container.getBoundingClientRect();
    const centerY = containerRect.top + containerRect.height * 0.35;

    let closestPage = AppState.currentPage;
    let closestDistance = Infinity;

    this.pages.forEach((page) => {
      const rect = page.wrapperEl.getBoundingClientRect();
      if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) return;
      const distance = Math.abs(rect.top - centerY);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestPage = page.pageNum;
      }
    });

    if (closestPage !== AppState.currentPage) {
      AppState.currentPage = closestPage;
      EventBus.emit("page:changed", closestPage);
    }
    this.showPageIndicatorBriefly();
  },

  showPageIndicatorBriefly() {
    this.pageIndicator.textContent = `${AppState.currentPage} / ${AppState.numPages}`;
    this.pageIndicator.classList.add("is-visible");
    clearTimeout(this._indicatorTimeout);
    this._indicatorTimeout = setTimeout(() => {
      this.pageIndicator.classList.remove("is-visible");
    }, 1100);
  },

  /* ------------------------------------------------------------------------
     EVENTOS DE SCROLL / RESIZE / ZOOM (GESTOS)
     ------------------------------------------------------------------------ */

  bindEvents() {
    // Rolagem: detecta página atual e controla virtualização via IntersectionObserver,
    // mas usamos rAF aqui apenas para o indicador e botão "voltar ao topo".
    this.container.addEventListener("scroll", () => {
      if (this.scrollRAF) return;
      this.scrollRAF = requestAnimationFrame(() => {
        this.detectCurrentPage();
        this.toggleScrollTopButton();
        this.scrollRAF = null;
      });
    });

    // Ctrl/Cmd + roda do mouse = zoom.
    this.container.addEventListener(
      "wheel",
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const delta = -e.deltaY;
          const factor = delta > 0 ? 1.08 : 0.92;
          this.zoomByFactor(factor, { x: e.clientX, y: e.clientY });
        }
      },
      { passive: false }
    );

    // Pinça (touch) para zoom em dispositivos móveis.
    this.bindPinchZoom();

    // Botão flutuante de voltar ao topo.
    this.scrollTopBtn.addEventListener("click", () => {
      this.scrollToPage(1, "smooth");
    });

    // Navegação por teclado.
    document.addEventListener("keydown", (e) => this.handleKeyboardNav(e));

    // Resize da janela: recalcula fit mode se ativo.
    window.addEventListener("resize", () => {
      if (this.resizeRAF) cancelAnimationFrame(this.resizeRAF);
      this.resizeRAF = requestAnimationFrame(() => {
        if (AppState.fitMode === "width") this.fitToWidth();
        else if (AppState.fitMode === "page") this.fitToPage();
      });
    });
  },

  /** Conecta os eventos emitidos pelos outros módulos (toolbar, etc.) à lógica do viewer. */
  bindEventBus() {
    EventBus.on("nav:goToPage", (pageNum) => this.scrollToPage(pageNum, "smooth"));

    EventBus.on("zoom:apply", ({ scale }) => {
      AppState.scale = scale;
      this.rescaleAndRerender(true);
    });

    EventBus.on("zoom:fitRequest", (mode) => {
      if (mode === "width") this.fitToWidth();
      else if (mode === "page") this.fitToPage();
    });

    EventBus.on("rotation:changed", () => {
      this.rebuildAfterRotation();
    });
  },

  /** Após uma rotação, recalcula dimensões base e força nova renderização. */
  async rebuildAfterRotation() {
    const anchor = this.getScrollAnchor();
    this.applyScaleToAllWrappers();

    this.pages.forEach((page) => {
      page.status = "unloaded";
    });

    this.pages.forEach((page) => {
      const rect = page.wrapperEl.getBoundingClientRect();
      const containerRect = this.container.getBoundingClientRect();
      const isNear = rect.bottom > containerRect.top - 1200 && rect.top < containerRect.bottom + 1200;
      if (isNear) this.renderPage(page.pageNum);
    });

    if (anchor) requestAnimationFrame(() => this.restoreScrollAnchor(anchor));
  },

  /** Aplica um fator multiplicativo ao zoom atual (usado por Ctrl+wheel e pinça). */
  zoomByFactor(factor) {
    const newScale = AppState.scale * factor;
    ZoomControl.setScale(newScale, null);
  },

  /** Configura o gesto de pinça (pinch-to-zoom) via Pointer Events / Touch Events. */
  bindPinchZoom() {
    let initialDistance = null;
    let initialScale = AppState.scale;

    const getDistance = (touches) => {
      const [a, b] = touches;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };

    this.container.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length === 2) {
          initialDistance = getDistance(e.touches);
          initialScale = AppState.scale;
        }
      },
      { passive: true }
    );

    this.container.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length === 2 && initialDistance) {
          e.preventDefault();
          const currentDistance = getDistance(e.touches);
          const ratio = currentDistance / initialDistance;
          const newScale = initialScale * ratio;
          ZoomControl.setScale(newScale, null);
        }
      },
      { passive: false }
    );

    this.container.addEventListener("touchend", (e) => {
      if (e.touches.length < 2) initialDistance = null;
    });
  },

  /** Mostra/oculta o botão flutuante "voltar ao topo" conforme a posição de rolagem. */
  toggleScrollTopButton() {
    const shouldShow = this.container.scrollTop > 600;
    this.scrollTopBtn.classList.toggle("is-visible", shouldShow);
  },

  /**
   * Trata atalhos de teclado globais de navegação. Ignora quando o foco
   * está em um campo de input/textarea para não interferir na digitação.
   */
  handleKeyboardNav(e) {
    const activeTag = document.activeElement.tagName;
    const isTyping = activeTag === "INPUT" || activeTag === "TEXTAREA";
    if (isTyping) return;
    if (SearchManager.isOpen && document.activeElement === SearchManager.input) return;

    switch (e.key) {
      case "ArrowRight":
      case "PageDown":
        e.preventDefault();
        this.scrollToPage(AppState.currentPage + 1, "smooth");
        break;
      case "ArrowLeft":
      case "PageUp":
        e.preventDefault();
        this.scrollToPage(AppState.currentPage - 1, "smooth");
        break;
      case "ArrowDown":
        e.preventDefault();
        this.container.scrollBy({ top: 80, behavior: "smooth" });
        break;
      case "ArrowUp":
        e.preventDefault();
        this.container.scrollBy({ top: -80, behavior: "smooth" });
        break;
      case "Home":
        e.preventDefault();
        this.scrollToPage(1, "smooth");
        break;
      case "End":
        e.preventDefault();
        this.scrollToPage(AppState.numPages, "smooth");
        break;
      case "+":
      case "=":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          ZoomControl.step(1);
        }
        break;
      case "-":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          ZoomControl.step(-1);
        }
        break;
      default:
        break;
    }
  },
};

/* ==========================================================================
   BOOTSTRAP DA APLICAÇÃO
   ========================================================================== */
document.addEventListener("DOMContentLoaded", () => {
  PDFViewer.init();
});
