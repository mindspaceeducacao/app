/* ==========================================================================
   TOOLBAR.JS
   Responsável por:
   - Estado global compartilhado da aplicação (AppState)
   - Persistência em localStorage (tema, zoom, última página)
   - Controles da barra superior: navegação, zoom, rotação, tema,
     fullscreen, download, impressão
   - Sistema de notificações (toast)
   ========================================================================== */

/**
 * Estado global da aplicação, compartilhado entre todos os módulos.
 * Cada módulo (viewer, thumbnails, search) lê e atualiza este objeto.
 */
/**
 * Resolve qual PDF deve ser carregado.
 * Ordem de prioridade:
 * 1. window.__PDF_OVERRIDE_URL__ / __PDF_OVERRIDE_NAME__
 *    -> definidos pelo 404.html quando a página é acessada via URL "limpa"
 *       (ex: .../estante-de-conteudos/Livro-Portugues)
 * 2. parâmetro ?file= na própria URL (útil para testar o viewer/index.html direto)
 * 3. valor padrão fixo (fallback de desenvolvimento)
 */
function resolvePdfSource() {
  if (window.__PDF_OVERRIDE_URL__) {
    return {
      url: window.__PDF_OVERRIDE_URL__,
      name: window.__PDF_OVERRIDE_NAME__ || window.__PDF_OVERRIDE_URL__.split("/").pop(),
    };
  }
  const fileParam = new URLSearchParams(window.location.search).get("file");
  if (fileParam) {
    const decoded = decodeURIComponent(fileParam);
    return {
      url: decoded.endsWith(".pdf") ? `pdf/${decoded}` : `pdf/${decoded}.pdf`,
      name: decoded.endsWith(".pdf") ? decoded : `${decoded}.pdf`,
    };
  }
  return {
    url: "pdf/Livro Didático | 1º Ano.pdf",
    name: "Livro Didático | 1º Ano.pdf",
  };
}

const _pdfSource = resolvePdfSource();

const AppState = {
  pdfDoc: null,             // Instância do documento carregado pelo PDF.js
  pdfUrl: _pdfSource.url,
  fileName: _pdfSource.name,
  numPages: 0,
  currentPage: 1,
  scale: 1.0,               // Fator de zoom (1.0 = 100%)
  minScale: 0.25,
  maxScale: 5.0,
  rotation: 0,              // 0, 90, 180, 270
  fitMode: null,            // 'width' | 'page' | null (zoom manual)
  theme: "light",
  sidebarCollapsed: false,
  isFullscreen: false,
  storageKeyPrefix: "pdfviewer:",
};

/**
 * Pequeno barramento de eventos (pub/sub) para comunicação entre módulos
 * sem dependências externas e sem acoplamento direto entre arquivos.
 */
const EventBus = {
  listeners: {},

  /** Inscreve uma função callback para um evento nomeado. */
  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  },

  /** Remove uma inscrição previamente registrada. */
  off(event, callback) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter((cb) => cb !== callback);
  },

  /** Dispara um evento, notificando todos os ouvintes inscritos. */
  emit(event, payload) {
    if (!this.listeners[event]) return;
    this.listeners[event].forEach((cb) => {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[EventBus] erro ao executar callback de "${event}"`, err);
      }
    });
  },
};

/* ==========================================================================
   PERSISTÊNCIA (localStorage)
   ========================================================================== */
const Storage = {
  /** Lê um valor salvo, retornando fallback se não existir ou der erro. */
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(AppState.storageKeyPrefix + key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  },

  /** Salva um valor serializado em JSON. */
  set(key, value) {
    try {
      localStorage.setItem(AppState.storageKeyPrefix + key, JSON.stringify(value));
    } catch (err) {
      console.warn("[Storage] não foi possível salvar:", key, err);
    }
  },
};

/* ==========================================================================
   TOAST NOTIFICATIONS
   ========================================================================== */
const Toast = {
  container: null,

  init() {
    this.container = document.getElementById("toastContainer");
  },

  /**
   * Exibe uma notificação temporária na parte inferior da tela.
   * @param {string} message - Texto a exibir.
   * @param {number} duration - Tempo em ms antes de desaparecer.
   */
  show(message, duration = 2400) {
    if (!this.container) return;
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    this.container.appendChild(el);

    setTimeout(() => {
      el.classList.add("is-leaving");
      setTimeout(() => el.remove(), 200);
    }, duration);
  },
};

/* ==========================================================================
   GERENCIAMENTO DE TEMA (claro/escuro)
   ========================================================================== */
const ThemeManager = {
  init() {
    const saved = Storage.get("theme", null);
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = saved || (prefersDark ? "dark" : "light");
    this.apply(theme, false);

    const btn = document.getElementById("btnTheme");
    btn.addEventListener("click", () => this.toggle());
  },

  apply(theme, notify = true) {
    AppState.theme = theme;
    document.body.setAttribute("data-theme", theme);
    Storage.set("theme", theme);
    if (notify) Toast.show(theme === "dark" ? "Tema escuro ativado" : "Tema claro ativado");
    EventBus.emit("theme:changed", theme);
  },

  toggle() {
    this.apply(AppState.theme === "dark" ? "light" : "dark");
  },
};

/* ==========================================================================
   GERENCIAMENTO DE FULLSCREEN
   ========================================================================== */
const FullscreenManager = {
  init() {
    const btn = document.getElementById("btnFullscreen");
    btn.addEventListener("click", () => this.toggle());

    document.addEventListener("fullscreenchange", () => this.syncState());
    document.addEventListener("webkitfullscreenchange", () => this.syncState());
  },

  toggle() {
    const isFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (!isFs) {
      const el = document.documentElement;
      const request = el.requestFullscreen || el.webkitRequestFullscreen;
      if (request) request.call(el);
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
    }
  },

  syncState() {
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    AppState.isFullscreen = isFs;
    document.body.classList.toggle("is-fullscreen", isFs);
  },
};

/* ==========================================================================
   NAVEGAÇÃO DE PÁGINAS
   ========================================================================== */
const PageNav = {
  pageInput: null,
  pageTotal: null,

  init() {
    this.pageInput = document.getElementById("pageInput");
    this.pageTotal = document.getElementById("pageTotal");

    document.getElementById("btnPrevPage").addEventListener("click", () => this.goTo(AppState.currentPage - 1));
    document.getElementById("btnNextPage").addEventListener("click", () => this.goTo(AppState.currentPage + 1));

    this.pageInput.addEventListener("change", () => {
      const value = parseInt(this.pageInput.value, 10);
      if (!isNaN(value)) this.goTo(value);
    });

    this.pageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.pageInput.blur();
      }
    });

    EventBus.on("page:changed", (pageNum) => this.syncUI(pageNum));
    EventBus.on("document:loaded", () => this.onDocumentLoaded());
  },

  onDocumentLoaded() {
    this.pageTotal.textContent = AppState.numPages;
    this.pageInput.max = AppState.numPages;
    this.syncUI(AppState.currentPage);
  },

  /** Solicita a navegação para uma página específica, validando limites. */
  goTo(pageNum) {
    const clamped = Math.min(Math.max(1, pageNum), AppState.numPages || 1);
    EventBus.emit("nav:goToPage", clamped);
  },

  /** Atualiza apenas a UI (input e botões), sem disparar nova navegação. */
  syncUI(pageNum) {
    AppState.currentPage = pageNum;
    if (document.activeElement !== this.pageInput) {
      this.pageInput.value = pageNum;
    }
    document.getElementById("btnPrevPage").disabled = pageNum <= 1;
    document.getElementById("btnNextPage").disabled = pageNum >= AppState.numPages;
    Storage.set("lastPage", pageNum);
  },
};

/* ==========================================================================
   CONTROLE DE ZOOM
   ========================================================================== */
const ZoomControl = {
  zoomInput: null,
  ZOOM_STEP: 0.1,

  init() {
    this.zoomInput = document.getElementById("zoomInput");

    document.getElementById("btnZoomIn").addEventListener("click", () => this.step(1));
    document.getElementById("btnZoomOut").addEventListener("click", () => this.step(-1));

    this.zoomInput.addEventListener("change", () => this.applyFromInput());
    this.zoomInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.zoomInput.blur();
      }
    });

    document.getElementById("btnFitWidth").addEventListener("click", () => this.setFitMode("width"));
    document.getElementById("btnFitPage").addEventListener("click", () => this.setFitMode("page"));

    EventBus.on("zoom:changed", (scale) => this.syncUI(scale));
  },

  /** Incrementa ou decrementa o zoom em um passo fixo. */
  step(direction) {
    const newScale = AppState.scale + direction * this.ZOOM_STEP;
    this.setScale(newScale, null);
  },

  /** Lê o valor digitado no campo de zoom (%) e aplica. */
  applyFromInput() {
    const raw = this.zoomInput.value.replace("%", "").trim();
    const value = parseFloat(raw);
    if (!isNaN(value) && value > 0) {
      this.setScale(value / 100, null);
    } else {
      this.syncUI(AppState.scale);
    }
  },

  /**
   * Define um novo nível de zoom, respeitando os limites min/max.
   * @param {number} scale - Novo fator de escala (1.0 = 100%).
   * @param {string|null} fitMode - 'width' | 'page' | null
   */
  setScale(scale, fitMode = null) {
    const clamped = Math.min(Math.max(scale, AppState.minScale), AppState.maxScale);
    AppState.scale = clamped;
    AppState.fitMode = fitMode;
    Storage.set("zoom", clamped);
    this.syncUI(clamped);
    EventBus.emit("zoom:apply", { scale: clamped, fitMode });
  },

  /** Ativa um modo de ajuste automático (largura ou página completa). */
  setFitMode(mode) {
    AppState.fitMode = mode;
    EventBus.emit("zoom:fitRequest", mode);
    this.toggleFitButtons(mode);
  },

  toggleFitButtons(mode) {
    document.getElementById("btnFitWidth").classList.toggle("is-active", mode === "width");
    document.getElementById("btnFitPage").classList.toggle("is-active", mode === "page");
  },

  /** Atualiza o campo de texto com a porcentagem atual. */
  syncUI(scale) {
    this.zoomInput.value = `${Math.round(scale * 100)}%`;
    document.getElementById("btnZoomOut").disabled = scale <= AppState.minScale + 0.001;
    document.getElementById("btnZoomIn").disabled = scale >= AppState.maxScale - 0.001;
    if (AppState.fitMode === null) {
      this.toggleFitButtons(null);
    }
  },
};

/* ==========================================================================
   ROTAÇÃO
   ========================================================================== */
const RotationControl = {
  init() {
    document.getElementById("btnRotate").addEventListener("click", () => this.rotate());
  },

  rotate() {
    AppState.rotation = (AppState.rotation + 90) % 360;
    EventBus.emit("rotation:changed", AppState.rotation);
    Toast.show(`Página girada para ${AppState.rotation}°`);
  },
};

/* ==========================================================================
   SIDEBAR TOGGLE
   ========================================================================== */
const SidebarToggle = {
  init() {
    const btn = document.getElementById("btnToggleSidebar");
    const sidebar = document.getElementById("sidebar");
    const appBody = document.querySelector(".app-body");

    // Em telas grandes, a sidebar inicia aberta; em mobile, inicia fechada.
    const startsCollapsed = window.innerWidth <= 768;
    AppState.sidebarCollapsed = startsCollapsed;
    sidebar.classList.toggle("is-collapsed", startsCollapsed);
    btn.setAttribute("aria-pressed", String(!startsCollapsed));

    btn.addEventListener("click", () => {
      AppState.sidebarCollapsed = !AppState.sidebarCollapsed;
      sidebar.classList.toggle("is-collapsed", AppState.sidebarCollapsed);
      btn.setAttribute("aria-pressed", String(!AppState.sidebarCollapsed));
      appBody.classList.toggle("sidebar-open", !AppState.sidebarCollapsed && window.innerWidth <= 768);
    });

    // Fecha a sidebar (modo drawer) ao clicar fora, em telas pequenas.
    appBody.addEventListener("click", (e) => {
      if (window.innerWidth > 768) return;
      if (AppState.sidebarCollapsed) return;
      if (sidebar.contains(e.target) || btn.contains(e.target)) return;
      AppState.sidebarCollapsed = true;
      sidebar.classList.add("is-collapsed");
      appBody.classList.remove("sidebar-open");
      btn.setAttribute("aria-pressed", "false");
    });
  },
};

/* ==========================================================================
   DOWNLOAD E IMPRESSÃO
   ========================================================================== */
const FileActions = {
  init() {
    document.getElementById("btnDownload").addEventListener("click", () => this.download());
    document.getElementById("btnPrint").addEventListener("click", () => this.print());
  },

  download() {
    const link = document.createElement("a");
    link.href = AppState.pdfUrl;
    link.download = AppState.fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    Toast.show("Iniciando download...");
  },

  print() {
    Toast.show("Preparando impressão...");
    // Pequeno atraso para garantir que o toast seja percebido antes do diálogo nativo.
    setTimeout(() => window.print(), 150);
  },
};

/* ==========================================================================
   INICIALIZAÇÃO DO MÓDULO
   ========================================================================== */
document.addEventListener("DOMContentLoaded", () => {
  Toast.init();
  ThemeManager.init();
  FullscreenManager.init();
  PageNav.init();
  ZoomControl.init();
  RotationControl.init();
  SidebarToggle.init();
  FileActions.init();
});
