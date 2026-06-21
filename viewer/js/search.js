/* ==========================================================================
   SEARCH.JS
   Responsável por:
   - Extrair o texto de cada página via PDF.js (getTextContent)
   - Buscar um termo em todas as páginas do documento
   - Exibir contagem total de ocorrências e navegar entre elas
   - Destacar visualmente as ocorrências na camada de texto renderizada
   ========================================================================== */

const SearchManager = {
  panel: null,
  input: null,
  countEl: null,

  query: "",
  matches: [],        // [{ pageNum, matchIndexInPage }]
  currentMatchIndex: -1,
  isOpen: false,
  debounceTimer: null,
  pageTextCache: new Map(), // pageNum -> string de texto completo da página

  init() {
    this.panel = document.getElementById("searchPanel");
    this.input = document.getElementById("searchInput");
    this.countEl = document.getElementById("searchCount");

    document.getElementById("btnSearch").addEventListener("click", () => this.open());
    document.getElementById("btnSearchClose").addEventListener("click", () => this.close());
    document.getElementById("btnSearchNext").addEventListener("click", () => this.goToMatch(1));
    document.getElementById("btnSearchPrev").addEventListener("click", () => this.goToMatch(-1));

    this.input.addEventListener("input", () => this.onInputChange());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.goToMatch(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        this.close();
      }
    });

    // Atalho global Ctrl+F / Cmd+F abre a busca interna (em vez da do navegador)
    document.addEventListener("keydown", (e) => {
      const isFindShortcut = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f";
      if (isFindShortcut) {
        e.preventDefault();
        this.open();
      }
    });

    EventBus.on("document:loaded", () => this.reset());
    EventBus.on("page:textLayerRendered", ({ pageNum }) => this.applyHighlightsToPage(pageNum));
  },

  reset() {
    this.query = "";
    this.matches = [];
    this.currentMatchIndex = -1;
    this.pageTextCache.clear();
    this.input.value = "";
    this.updateCountUI();
  },

  open() {
    this.isOpen = true;
    this.panel.classList.add("is-open");
    this.panel.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => this.input.focus());
  },

  close() {
    this.isOpen = false;
    this.panel.classList.remove("is-open");
    this.panel.setAttribute("aria-hidden", "true");
    this.clearAllHighlights();
    this.matches = [];
    this.currentMatchIndex = -1;
    this.updateCountUI();
  },

  onInputChange() {
    clearTimeout(this.debounceTimer);
    const value = this.input.value;
    this.debounceTimer = setTimeout(() => this.runSearch(value), 220);
  },

  /**
   * Executa a busca textual em todas as páginas do documento.
   * O texto de cada página é extraído via getTextContent e cacheado
   * para evitar reprocessamento em buscas subsequentes.
   */
  async runSearch(query) {
    this.query = query.trim();
    this.clearAllHighlights();
    this.matches = [];
    this.currentMatchIndex = -1;

    if (!this.query || !AppState.pdfDoc) {
      this.updateCountUI();
      return;
    }

    this.countEl.textContent = "Buscando...";

    const lowerQuery = this.query.toLowerCase();
    const totalPages = AppState.numPages;

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const text = await this.getPageText(pageNum);
      const occurrences = this.countOccurrences(text.toLowerCase(), lowerQuery);
      for (let i = 0; i < occurrences; i++) {
        this.matches.push({ pageNum, matchIndexInPage: i });
      }
    }

    this.updateCountUI();

    if (this.matches.length > 0) {
      this.currentMatchIndex = 0;
      this.highlightAndNavigate();
    }
  },

  /** Retorna (e cacheia) o texto completo de uma página. */
  async getPageText(pageNum) {
    if (this.pageTextCache.has(pageNum)) {
      return this.pageTextCache.get(pageNum);
    }
    const page = await AppState.pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const text = textContent.items.map((item) => item.str).join(" ");
    this.pageTextCache.set(pageNum, text);
    return text;
  },

  /** Conta quantas vezes `needle` aparece em `haystack` (sem overlap). */
  countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let count = 0;
    let pos = 0;
    while (true) {
      const idx = haystack.indexOf(needle, pos);
      if (idx === -1) break;
      count++;
      pos = idx + needle.length;
    }
    return count;
  },

  /** Navega para a ocorrência seguinte (+1) ou anterior (-1). */
  goToMatch(direction) {
    if (this.matches.length === 0) return;
    this.currentMatchIndex = (this.currentMatchIndex + direction + this.matches.length) % this.matches.length;
    this.highlightAndNavigate();
  },

  /** Move o viewer até a página da ocorrência atual e atualiza destaques. */
  highlightAndNavigate() {
    const match = this.matches[this.currentMatchIndex];
    if (!match) return;
    this.updateCountUI();

    EventBus.emit("nav:goToPage", match.pageNum);
    // O destaque efetivo do span ocorre quando a text layer da página estiver pronta
    // (ver applyHighlightsToPage, chamado pelo evento "page:textLayerRendered").
    // Caso a página já esteja renderizada, aplicamos imediatamente também:
    this.applyHighlightsToPage(match.pageNum);
  },

  /**
   * Aplica classes de destaque (.search-highlight / .is-current) nos spans
   * da camada de texto de uma página específica, com base no termo buscado.
   */
  applyHighlightsToPage(pageNum) {
    if (!this.query) return;

    const pageEl = document.querySelector(`.pdf-page[data-page-number="${pageNum}"]`);
    if (!pageEl) return;
    const textLayer = pageEl.querySelector(".pdf-page__text-layer");
    if (!textLayer) return;

    const spans = Array.from(textLayer.querySelectorAll("span"));
    const lowerQuery = this.query.toLowerCase();

    // Limpa destaques antigos desta página antes de reaplicar.
    spans.forEach((span) => span.classList.remove("search-highlight", "is-current"));

    const currentMatch = this.matches[this.currentMatchIndex];
    let matchCounter = 0;

    spans.forEach((span) => {
      const text = span.textContent.toLowerCase();
      if (text.includes(lowerQuery) && lowerQuery.length > 0) {
        span.classList.add("search-highlight");

        // Verifica se esta ocorrência específica é a "atual" selecionada.
        if (
          currentMatch &&
          currentMatch.pageNum === pageNum &&
          matchCounter === currentMatch.matchIndexInPage
        ) {
          span.classList.add("is-current");
          this.scrollSpanIntoView(span);
        }
        matchCounter++;
      }
    });
  },

  /** Garante que o span ativo fique visível dentro da área de rolagem do viewer. */
  scrollSpanIntoView(span) {
    requestAnimationFrame(() => {
      span.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    });
  },

  /** Remove todos os destaques de busca de todas as páginas renderizadas. */
  clearAllHighlights() {
    document.querySelectorAll(".pdf-page__text-layer span.search-highlight").forEach((span) => {
      span.classList.remove("search-highlight", "is-current");
    });
  },

  /** Atualiza o contador "x / y" exibido no painel de busca. */
  updateCountUI() {
    if (!this.query) {
      this.countEl.textContent = "0 / 0";
      return;
    }
    const total = this.matches.length;
    const current = total > 0 ? this.currentMatchIndex + 1 : 0;
    this.countEl.textContent = `${current} / ${total}`;
  },
};

document.addEventListener("DOMContentLoaded", () => {
  SearchManager.init();
});
