(() => {
  'use strict';

  const state = {
    period: 'day',
    dim: 'date',
    raw: null, // last successful API payload
  };

  const el = {
    periodSelector: document.getElementById('periodSelector'),
    drilldownSelector: document.getElementById('drilldownSelector'),
    filterPill: document.getElementById('filterPill'),
    refreshBtn: document.getElementById('refreshBtn'),
    retryBtn: document.getElementById('retryBtn'),
    kpiTotal: document.getElementById('kpiTotal'),
    kpiSub: document.getElementById('kpiSub'),
    kpiPeriod: document.getElementById('kpiPeriod'),
    kpiRange: document.getElementById('kpiRange'),
    kpiPeak: document.getElementById('kpiPeak'),
    kpiPeakCount: document.getElementById('kpiPeakCount'),
    chartTitle: document.getElementById('chartTitle'),
    chartSubtitle: document.getElementById('chartSubtitle'),
    loadingState: document.getElementById('loadingState'),
    errorState: document.getElementById('errorState'),
    errorMessage: document.getElementById('errorMessage'),
    emptyState: document.getElementById('emptyState'),
    canvas: document.getElementById('oppChart'),
    chartViewport: document.getElementById('chartViewport'),
    chartCanvasWrap: document.getElementById('chartCanvasWrap'),
    scrollHint: document.getElementById('scrollHint'),
  };

  // Categories beyond this count switch from a vertical column chart to a
  // horizontal bar chart, so every label stays readable instead of being
  // skipped or squeezed.
  const HORIZONTAL_THRESHOLD = 10;
  const HORIZONTAL_ROW_HEIGHT = 34; // px per category row when scrolling
  const HORIZONTAL_MIN_HEIGHT = 360; // matches the default viewport height

  let chart = null;

  const PERIOD_LABEL = { day: 'יום נוכחי', week: 'שבוע נוכחי', month: 'חודש נוכחי', year: 'שנה נוכחית' };
  const DIM_LABEL = { date: 'תאריך', media: 'מדיה', project: 'פרויקט' };
  const MONTH_NAMES = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const MONTH_SHORT = ['ינו','פבר','מרץ','אפר','מאי','יונ','יול','אוג','ספט','אוק','נוב','דצמ'];
  const WEEKDAY_SHORT = ['יום א׳','יום ב׳','יום ג׳','יום ד׳','יום ה׳','יום ו׳','שבת'];
  const WEEKDAY_FULL = ['יום ראשון','יום שני','יום שלישי','יום רביעי','יום חמישי','יום שישי','יום שבת'];

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------

  async function loadData() {
    showLoading();
    try {
      const res = await fetch(`/api/opportunities?period=${encodeURIComponent(state.period)}`, {
        cache: 'no-store',
      });
      const payload = await res.json();

      if (!res.ok) {
        throw new Error(payload.error || `Request failed with status ${res.status}`);
      }

      state.raw = payload;
      el.filterPill.textContent = payload.filter;
      render();
    } catch (err) {
      showError(err.message || 'לא ניתן להתחבר ל-API של ההזדמנויות.');
    }
  }

  // -------------------------------------------------------------------------
  // Aggregation
  // -------------------------------------------------------------------------

  function parseDateOnly(value) {
    if (!value) return null;
    const d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return d;
  }

  function daysInMonth(year, monthIndex) {
    return new Date(year, monthIndex + 1, 0).getDate();
  }

  function aggregateByDate(opportunities, period) {
    const now = new Date();

    if (period === 'day') {
      const label = `${WEEKDAY_SHORT[now.getDay()]}, ${now.getDate()} ב${MONTH_NAMES[now.getMonth()]}`;
      return { labels: [label], counts: [opportunities.length], meta: ['היום'] };
    }

    if (period === 'week') {
      // Week starts on Sunday — same rule the server uses to compute the
      // $filter start date, so the two stay in sync.
      const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
      const counts = new Array(7).fill(0); // all 7 days shown, future days stay 0

      opportunities.forEach((opp) => {
        const d = parseDateOnly(opp.startDate);
        if (!d) return;
        const dayOnly = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const diffDays = Math.round((dayOnly - startOfWeek) / (24 * 60 * 60 * 1000));
        if (diffDays >= 0 && diffDays < 7) {
          counts[diffDays] += 1;
        }
      });

      const labels = WEEKDAY_FULL.slice();
      return { labels, counts, meta: labels };
    }

    if (period === 'month') {
      const y = now.getFullYear();
      const m = now.getMonth();
      const total = daysInMonth(y, m);
      const counts = new Array(total).fill(0);

      opportunities.forEach((opp) => {
        const d = parseDateOnly(opp.startDate);
        if (!d) return;
        if (d.getFullYear() === y && d.getMonth() === m) {
          counts[d.getDate() - 1] += 1;
        }
      });

      const labels = counts.map((_, i) => `${String(i + 1).padStart(2, '0')} ${MONTH_SHORT[m]}`);
      return { labels, counts, meta: labels };
    }

    if (period === 'year') {
      const y = now.getFullYear();
      const counts = new Array(12).fill(0);

      opportunities.forEach((opp) => {
        const d = parseDateOnly(opp.startDate);
        if (!d) return;
        if (d.getFullYear() === y) {
          counts[d.getMonth()] += 1;
        }
      });

      return { labels: MONTH_NAMES.slice(), counts, meta: MONTH_NAMES.slice() };
    }

    return { labels: [], counts: [], meta: [] };
  }

  function aggregateByField(opportunities, field) {
    const map = new Map();

    opportunities.forEach((opp) => {
      const raw = opp && opp.extensions && opp.extensions[field];

      if (Array.isArray(raw)) {
        // e.g. Z_media — an Opportunity can carry multiple values; count it
        // once for every value it contains.
        const values = raw.length ? raw : ['לא צוין'];
        values.forEach((v) => {
          const key = v && String(v).trim() ? String(v).trim() : 'לא צוין';
          map.set(key, (map.get(key) || 0) + 1);
        });
      } else {
        const key = raw && String(raw).trim() ? String(raw).trim() : 'לא צוין';
        map.set(key, (map.get(key) || 0) + 1);
      }
    });

    const entries = Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
    return {
      labels: entries.map((e) => e[0]),
      counts: entries.map((e) => e[1]),
      meta: entries.map((e) => e[0]),
    };
  }

  function buildAggregation() {
    const opportunities = state.raw.opportunities || [];

    if (state.dim === 'date') return aggregateByDate(opportunities, state.period);
    if (state.dim === 'media') return aggregateByField(opportunities, 'Z_media');
    if (state.dim === 'project') return aggregateByField(opportunities, 'Z_project');
    return { labels: [], counts: [], meta: [] };
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function render() {
    const opportunities = state.raw.opportunities || [];

    if (opportunities.length === 0) {
      showEmpty();
      updateKpis(0, null, 0);
      updateHeader();
      return;
    }

    hideOverlays();

    const agg = buildAggregation();
    const total = opportunities.length;

    let peakIdx = 0;
    agg.counts.forEach((c, i) => { if (c > agg.counts[peakIdx]) peakIdx = i; });
    const peakLabel = agg.counts.length ? agg.meta[peakIdx] : '–';
    const peakCount = agg.counts.length ? agg.counts[peakIdx] : 0;

    updateKpis(total, peakLabel, peakCount);
    updateHeader();
    drawChart(agg);
  }

  function updateKpis(total, peakLabel, peakCount) {
    el.kpiTotal.textContent = total.toLocaleString('en-US');
    el.kpiSub.textContent = `פילוח לפי ${DIM_LABEL[state.dim]} · ${PERIOD_LABEL[state.period]}`;
    el.kpiPeriod.textContent = PERIOD_LABEL[state.period];
    el.kpiRange.textContent = state.raw ? `החל מ-${state.raw.startDate}` : '–';
    el.kpiPeak.textContent = peakLabel === null ? '–' : peakLabel;
    el.kpiPeakCount.textContent = peakCount
      ? `${peakCount.toLocaleString('en-US')} הזדמנויות`
      : 'אין נתונים עדיין';
  }

  function updateHeader() {
    const dimText = DIM_LABEL[state.dim];
    const periodText = PERIOD_LABEL[state.period];
    el.chartTitle.textContent = `גרף הזדמנויות לפי ${dimText}`;

    if (state.dim === 'date') {
      const subtitles = {
        day: 'ההזדמנויות של היום',
        week: 'פילוח יומי לשבוע הנוכחי',
        month: 'פילוח יומי לחודש הנוכחי',
        year: 'פילוח חודשי לשנה הנוכחית',
      };
      el.chartSubtitle.textContent = subtitles[state.period];
    } else {
      el.chartSubtitle.textContent = `מפולח לפי ${dimText} · ${periodText}`;
    }
  }

  function drawChart(agg) {
    if (typeof Chart === 'undefined') {
      showError('ספריית הגרפים (Chart.js) לא נטענה. בדוק את החיבור לאינטרנט או שה-CDN אינו חסום, ורענן את הדף.');
      return;
    }

    const categoryCount = agg.labels.length;
    const horizontal = categoryCount > HORIZONTAL_THRESHOLD;

    // Size the scrollable wrapper so every bar gets a readable row when
    // there are too many categories to fit the default viewport height.
    if (horizontal) {
      const neededHeight = Math.max(HORIZONTAL_MIN_HEIGHT, categoryCount * HORIZONTAL_ROW_HEIGHT);
      el.chartCanvasWrap.style.height = `${neededHeight}px`;
      el.chartViewport.classList.add('scrollable');
      el.scrollHint.classList.toggle('hidden', neededHeight <= HORIZONTAL_MIN_HEIGHT);
    } else {
      el.chartCanvasWrap.style.height = '';
      el.chartViewport.classList.remove('scrollable');
      el.scrollHint.classList.add('hidden');
    }

    const ctx = el.canvas.getContext('2d');

    const barColor = state.dim === 'date' ? '#3730A9' : '#0EA5A4';
    const hoverColor = state.dim === 'date' ? '#2A2680' : '#0C8887';

    const data = {
      labels: agg.labels,
      datasets: [{
        label: 'הזדמנויות',
        data: agg.counts,
        backgroundColor: barColor,
        hoverBackgroundColor: hoverColor,
        borderRadius: 6,
        maxBarThickness: horizontal ? 24 : (state.dim === 'date' && state.period !== 'day' ? 28 : 64),
      }],
    };

    // Category ticks must never be skipped — every Media/Project/Date label
    // has to stay visible, however many categories there are.
    const categoryTicks = {
      autoSkip: false,
      font: { family: 'Heebo', size: categoryCount > 25 ? 10 : 11 },
      color: '#6B7280',
    };

    const valueTicks = {
      precision: 0,
      font: { family: 'Heebo', size: 11 },
      color: '#6B7280',
    };

    const categoryTitle = { display: true, text: DIM_LABEL[state.dim], font: { family: 'Heebo', size: 12, weight: '600' }, color: '#4A4F72' };
    const valueTitle = { display: true, text: 'מספר הזדמנויות', font: { family: 'Heebo', size: 12, weight: '600' }, color: '#4A4F72' };

    const scales = horizontal
      ? {
          // Horizontal bars: x is the value axis, y is the category axis.
          x: {
            title: valueTitle,
            beginAtZero: true,
            reverse: true, // bars grow right-to-left, matching RTL reading order
            ticks: valueTicks,
            grid: { color: '#EEF0F7' },
          },
          y: {
            title: categoryTitle,
            position: 'right',
            ticks: categoryTicks,
            grid: { display: false },
          },
        }
      : {
          // Vertical columns: x is the category axis, y is the value axis.
          x: {
            title: categoryTitle,
            grid: { display: false },
            ticks: {
              ...categoryTicks,
              maxRotation: categoryCount > 6 ? 60 : 0,
              minRotation: categoryCount > 6 ? 45 : 0,
            },
          },
          y: {
            title: valueTitle,
            position: 'right',
            beginAtZero: true,
            ticks: valueTicks,
            grid: { color: '#EEF0F7' },
          },
        };

    const options = {
      indexAxis: horizontal ? 'y' : 'x',
      responsive: true,
      maintainAspectRatio: false,
      rtl: true,
      animation: { duration: 450, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          rtl: true,
          textDirection: 'rtl',
          backgroundColor: '#1B1F3B',
          titleFont: { family: 'Heebo', weight: '600' },
          bodyFont: { family: 'Heebo' },
          padding: 10,
          cornerRadius: 8,
          displayColors: false,
          callbacks: {
            label: (item) => `${item.formattedValue} הזדמנויות`,
          },
        },
      },
      scales,
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const idx = elements[0].index;
        console.info('Drill-down click:', agg.meta[idx], '→', agg.counts[idx], 'opportunities');
      },
    };

    const type = 'bar';

    // Chart.js doesn't cleanly hot-swap indexAxis (category vs value axes)
    // on an existing instance, so when the orientation changes we rebuild
    // the chart instead of mutating it in place.
    if (chart && chart.options.indexAxis !== options.indexAxis) {
      chart.destroy();
      chart = null;
    }

    if (chart) {
      chart.data = data;
      chart.options = options;
      chart.update();
    } else {
      chart = new Chart(ctx, { type, data, options });
    }
  }

  // -------------------------------------------------------------------------
  // UI states
  // -------------------------------------------------------------------------

  function hideOverlays() {
    el.loadingState.classList.add('hidden');
    el.errorState.classList.add('hidden');
    el.emptyState.classList.add('hidden');
    el.canvas.style.visibility = 'visible';
    el.refreshBtn.querySelector('svg').classList.remove('spinning');
  }

  function resetChartScroll() {
    el.chartCanvasWrap.style.height = '';
    el.chartViewport.classList.remove('scrollable');
    el.scrollHint.classList.add('hidden');
  }

  function showLoading() {
    el.loadingState.classList.remove('hidden');
    el.errorState.classList.add('hidden');
    el.emptyState.classList.add('hidden');
    el.canvas.style.visibility = 'hidden';
    el.refreshBtn.querySelector('svg').classList.add('spinning');
    resetChartScroll();
  }

  function showError(message) {
    el.loadingState.classList.add('hidden');
    el.emptyState.classList.add('hidden');
    el.errorState.classList.remove('hidden');
    el.errorMessage.textContent = message;
    el.canvas.style.visibility = 'hidden';
    el.refreshBtn.querySelector('svg').classList.remove('spinning');
    el.kpiTotal.textContent = '–';
    el.kpiSub.textContent = 'הטעינה נכשלה';
    resetChartScroll();
  }

  function showEmpty() {
    el.loadingState.classList.add('hidden');
    el.errorState.classList.add('hidden');
    el.emptyState.classList.remove('hidden');
    el.canvas.style.visibility = 'hidden';
    el.refreshBtn.querySelector('svg').classList.remove('spinning');
    resetChartScroll();
  }

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------

  el.periodSelector.addEventListener('click', (e) => {
    const btn = e.target.closest('.segmented-btn');
    if (!btn || btn.classList.contains('active')) return;
    setActive(el.periodSelector, btn);
    state.period = btn.dataset.period;
    loadData();
  });

  el.drilldownSelector.addEventListener('click', (e) => {
    const btn = e.target.closest('.segmented-btn');
    if (!btn || btn.classList.contains('active')) return;
    setActive(el.drilldownSelector, btn);
    state.dim = btn.dataset.dim;
    if (state.raw) render();
  });

  el.refreshBtn.addEventListener('click', loadData);
  el.retryBtn.addEventListener('click', loadData);

  function setActive(container, btn) {
    container.querySelectorAll('.segmented-btn').forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  loadData();
})();
