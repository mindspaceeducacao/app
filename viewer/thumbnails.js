/* ==========================================================================
   THUMBNAILS.JS
   Responsável por:
   - Criar a lista de miniaturas (uma por página) na sidebar
   - Renderizar cada miniatura sob demanda usando PDF.js (sem imagens prontas)
   - Sincronizar a miniatura ativa com a página atual do viewer
   - Navegar até a página correspondente ao clicar em uma miniatura
   ========================================================================== */

const ThumbnailManager = {
  listEl: null,
  items: [],          // [{ pageNum, container, canvasWrap, rendered, observer }]
  observer: null,      // IntersectionObserver para lazy rendering das miniaturas
  THUMB_WIDTH: 160,    // Largura base (px) usada para renderizar a miniatura

  init() {
    this.listEl = document.getElementById("thumbnailList");
    EventBus.on("document:loaded", () => this.build());
    EventBus.on("page:changed", (pageNum) => this.setActive(pageNum));
  },

  /** Constrói a estrutura DOM de todas as miniaturas (placeholders) de uma vez. */
  build() {
    this.listEl.innerHTML = "";
    this.items = [];

    document.getElementById("sidebarPageCount").textContent = AppState.numPages;

    for (let pageNum = 1; pageNum <= AppState.numPages; pageNum++) {
      const item = this.createThumbItem(pageNum);
      this.items.push(item);
      this.listEl.appendChild(item.container);
    }

    this.setupLazyRendering();
    this.setActive(AppState.currentPage);
  },

  /** Cria o elemento DOM de uma miniatura, ainda sem renderizar o canvas. */
  createThumbItem(pageNum) {
    const container = document.createElement("div");
    container.className = "thumb-item";
    container.dataset.page = String(pageNum);
    container.style.animationDelay = `${Math.min(pageNum * 18, 280)}ms`;
    container.setAttribute("role", "button");
    container.setAttribute("tabindex", "0");
    container.setAttribute("aria-label", `Ir para a página ${pageNum}`);

    const canvasWrap = document.createElement("div");
    canvasWrap.className = "thumb-item__canvas-wrap";

    const skeleton = document.createElement("div");
    skeleton.className = "thumb-item__skeleton";
    canvasWrap.appendChild(skeleton);

    const label = document.createElement("span");
    label.className = "thumb-item__label";
    label.textContent = String(pageNum);

    container.appendChild(canvasWrap);
    container.appendChild(label);

    const onActivate = () => EventBus.emit("nav:goToPage", pageNum);
    container.addEventListener("click", onActivate);
    container.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    });

    return { pageNum, container, canvasWrap, rendered: false };
  },

  /**
   * Usa IntersectionObserver para renderizar apenas miniaturas visíveis
   * (ou próximas da área visível) na sidebar, economizando memória/CPU
   * em documentos com centenas de páginas.
   */
  setupLazyRendering() {
    if (this.observer) this.observer.disconnect();

    this.observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const pageNum = parseInt(entry.target.dataset.page, 10);
            this.renderThumb(pageNum);
          }
        });
      },
      {
        root: this.listEl,
        rootMargin: "400px 0px 400px 0px",
        threshold: 0.01,
      }
    );

    this.items.forEach((item) => this.observer.observe(item.container));
  },

  /** Renderiza (uma única vez) a miniatura de uma página usando PDF.js. */
  async renderThumb(pageNum) {
    const item = this.items[pageNum - 1];
    if (!item || item.rendered) return;
    item.rendered = true; // marca antes para evitar renderizações duplicadas concorrentes

    try {
      const page = await AppState.pdfDoc.getPage(pageNum);
      const baseViewport = page.getViewport({ scale: 1, rotation: AppState.rotation });
      const scale = this.THUMB_WIDTH / baseViewport.width;
      const viewport = page.getViewport({ scale, rotation: AppState.rotation });

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { alpha: false });
      const outputScale = window.devicePixelRatio || 1;

      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = "100%";
      canvas.style.height = "auto";

      const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;

      await page.render({ canvasContext: ctx, viewport, transform }).promise;

      // Substitui o skeleton pelo canvas renderizado com uma transição suave.
      item.canvasWrap.innerHTML = "";
      canvas.style.opacity = "0";
      canvas.style.transition = "opacity 220ms ease";
      item.canvasWrap.appendChild(canvas);
      requestAnimationFrame(() => (canvas.style.opacity = "1"));
    } catch (err) {
      console.error(`[ThumbnailManager] erro ao renderizar miniatura da página ${pageNum}`, err);
      item.rendered = false;
    }
  },

  /** Re-renderiza todas as miniaturas já exibidas (usado após rotação). */
  refreshAll() {
    this.items.forEach((item) => {
      item.rendered = false;
      item.canvasWrap.innerHTML = '<div class="thumb-item__skeleton"></div>';
    });
    // Força nova checagem de interseção para o que está visível agora.
    this.items.forEach((item) => {
      const rect = item.container.getBoundingClientRect();
      const listRect = this.listEl.getBoundingClientRect();
      if (rect.bottom > listRect.top - 400 && rect.top < listRect.bottom + 400) {
        this.renderThumb(item.pageNum);
      }
    });
  },

  /** Marca visualmente a miniatura correspondente como ativa e centraliza na view. */
  setActive(pageNum) {
    this.items.forEach((item) => {
      const isActive = item.pageNum === pageNum;
      item.container.classList.toggle("is-active", isActive);
      if (isActive) {
        this.scrollIntoViewIfNeeded(item.container);
      }
    });
  },

  /** Rola a sidebar suavemente apenas se a miniatura ativa não estiver visível. */
  scrollIntoViewIfNeeded(el) {
    const listRect = this.listEl.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const isVisible = elRect.top >= listRect.top && elRect.bottom <= listRect.bottom;
    if (!isVisible) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  },
};

EventBus.on("rotation:changed", () => ThumbnailManager.refreshAll());

document.addEventListener("DOMContentLoaded", () => {
  ThumbnailManager.init();
});
