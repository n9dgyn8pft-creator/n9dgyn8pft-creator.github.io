
(function () {
  "use strict";
  if (!document.getElementById("tab-strength")) return;
  // ---------- constants ----------
  const CURVES = { // equivalent age at +20 °C (days) -> % of R28
    pc:   [[0,0],[1,30],[2,42],[3,50],[5,60],[7,68],[10,76],[14,84],[21,93],[28,100],[45,106],[60,109],[90,113]],
    fast: [[0,0],[1,40],[2,55],[3,63],[5,72],[7,78],[10,84],[14,90],[21,96],[28,100],[45,104],[60,106],[90,108]],
    slag: [[0,0],[1,15],[2,27],[3,35],[5,47],[7,56],[10,65],[14,74],[21,88],[28,100],[45,109],[60,113],[90,118]]
  };
  const CEMENT_NAME = { pc: "портландцемент", fast: "быстротвердеющий портландцемент", slag: "шлакопортландцемент" };
  const MILESTONES = [[50, "снятие боковой опалубки"], [70, "снятие несущей опалубки (пролёт до 6 м)"], [100, "проектная прочность"]];
  const WD = ["Вс","Пн","Вт","Ср","Чт","Пт","Сб"];
  const DEFAULT_PLACE = { name: "Москва", admin1: "", country: "Россия", latitude: 55.7558, longitude: 37.6173 };

  const $ = id => document.getElementById(id);
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem("beton:" + k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem("beton:" + k, JSON.stringify(v)); } catch (e) {} }
  };

  // ---------- dates (local, day precision) ----------
  const pad = n => String(n).padStart(2, "0");
  const iso = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const parseIso = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
  const diffDays = (a, b) => Math.round((parseIso(iso(b)) - parseIso(iso(a))) / 864e5);
  const ru = d => pad(d.getDate()) + "." + pad(d.getMonth() + 1);
  const ruFull = d => pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear();
  const fmt = (x, n = 1) => x.toFixed(n).replace(".", ",").replace("-", "−");


  // ---------- state ----------
  let place = store.get("place") || DEFAULT_PLACE;
  let mode = store.get("mode") || "auto";
  const today = parseIso(iso(new Date()));

  // ---------- init inputs ----------
  const placeLabel = p => p.name + (p.admin1 ? ", " + p.admin1 : "") + (p.country ? ", " + p.country : "");
  $("place").value = placeLabel(place);
  $("place-hint").textContent = "Координаты: " + fmt(place.latitude, 2) + ", " + fmt(place.longitude, 2);
  const saved = store.get("form") || {};
  $("pour").value = saved.pour || iso(addDays(today, -7));
  $("pour").max = iso(addDays(today, 15));
  ["cls", "cement", "horizon", "offset", "mconst", "mlist"].forEach(id => { if (saved[id] != null) $(id).value = saved[id]; });
  if (saved.antifreeze) $("antifreeze").checked = true;

  function setMode(m) {
    mode = m; store.set("mode", m);
    $("mode-auto").classList.toggle("on", m === "auto");
    $("mode-manual").classList.toggle("on", m === "manual");
    $("manual").classList.toggle("show", m === "manual");
    $("place-field").style.opacity = m === "manual" ? .55 : 1;
  }
  $("mode-auto").onclick = () => setMode("auto");
  $("mode-manual").onclick = () => setMode("manual");
  setMode(mode);

  // ---------- geocoding ----------
  let geoTimer = null, geoCtl = null;
  const sug = $("suggest");
  $("place").addEventListener("input", () => {
    clearTimeout(geoTimer);
    const q = $("place").value.trim();
    if (q.length < 2) { sug.classList.remove("show"); return; }
    geoTimer = setTimeout(async () => {
      try {
        if (geoCtl) geoCtl.abort();
        geoCtl = new AbortController();
        const r = await fetch("https://geocoding-api.open-meteo.com/v1/search?count=7&language=ru&format=json&name=" + encodeURIComponent(q), { signal: geoCtl.signal });
        const j = await r.json();
        const list = j.results || [];
        sug.innerHTML = "";
        if (!list.length) { sug.innerHTML = '<button type="button" disabled>Ничего не найдено</button>'; }
        list.forEach(p => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = p.name;
          const s = document.createElement("small");
          s.textContent = [p.admin1, p.country].filter(Boolean).join(", ");
          b.appendChild(s);
          b.onclick = () => {
            place = { name: p.name, admin1: p.admin1 || "", country: p.country || "", latitude: p.latitude, longitude: p.longitude };
            store.set("place", place);
            $("place").value = placeLabel(place);
            $("place-hint").textContent = "Координаты: " + fmt(place.latitude, 2) + ", " + fmt(place.longitude, 2);
            sug.classList.remove("show");
          };
          sug.appendChild(b);
        });
        sug.classList.add("show");
      } catch (e) {
        if (e.name !== "AbortError") { sug.innerHTML = '<button type="button" disabled>Поиск недоступен — используйте ручной ввод</button>'; sug.classList.add("show"); }
      }
    }, 300);
  });
  document.addEventListener("click", e => { if (!$("place-field").contains(e.target)) sug.classList.remove("show"); });

  // ---------- weather ----------
  async function getJson(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  async function fetchWeather(lat, lon, start, end) {
    const out = {}; // iso -> {t, src}
    const put = (j, src, override) => {
      const d = j && j.daily; if (!d) return;
      d.time.forEach((s, i) => {
        let t = d.temperature_2m_mean ? d.temperature_2m_mean[i] : null;
        if (t == null && d.temperature_2m_max && d.temperature_2m_min && d.temperature_2m_max[i] != null && d.temperature_2m_min[i] != null)
          t = (d.temperature_2m_max[i] + d.temperature_2m_min[i]) / 2;
        if (t == null) return;
        if (override || !out[s]) out[s] = { t, src };
      });
    };
    const base = "latitude=" + lat + "&longitude=" + lon + "&daily=temperature_2m_mean,temperature_2m_max,temperature_2m_min&timezone=auto";
    const tasks = [];
    // archive (reanalysis) for days older than ~6 days
    const archEnd = addDays(today, -6);
    if (start <= archEnd) {
      const e = end < archEnd ? end : archEnd;
      tasks.push(getJson("https://archive-api.open-meteo.com/v1/archive?" + base + "&start_date=" + iso(start) + "&end_date=" + iso(e)).then(j => ({ j, src: "archive" })).catch(() => null));
    }
    // forecast endpoint covers recent past (up to 92 days) + 16 days ahead
    const past = Math.max(0, Math.min(92, diffDays(start, today)));
    if (end >= addDays(today, -92)) {
      tasks.push(getJson("https://api.open-meteo.com/v1/forecast?" + base + "&past_days=" + past + "&forecast_days=16").then(j => ({ j, src: "forecast" })));
    }
    const res = await Promise.all(tasks);
    const arch = res.find(r => r && r.src === "archive");
    const fc = res.find(r => r && r.src === "forecast");
    if (arch) put(arch.j, "archive", true);
    if (fc) put(fc.j, "forecast", false);
    if (!arch && !fc) throw new Error("no data");
    return out;
  }

  // ---------- math ----------
  function curvePct(curve, age) {
    if (age <= 0) return 0;
    for (let i = 1; i < curve.length; i++) {
      if (age <= curve[i][0]) {
        const [a0, p0] = curve[i - 1], [a1, p1] = curve[i];
        return p0 + (p1 - p0) * (age - a0) / (a1 - a0);
      }
    }
    return curve[curve.length - 1][1];
  }
  function kFactor(tc, antifreeze) {
    if (tc < 0 && !antifreeze) return 0;
    return Math.max(0, (tc + 10) / 30);
  }

  function compute(series, opts) {
    const curve = CURVES[opts.cement];
    let cum = 0;
    return series.map(d => {
      const tc = d.t + opts.offset;
      const k = kFactor(tc, opts.antifreeze);
      cum += k;
      const pct = curvePct(curve, cum);
      return Object.assign({}, d, { tc, k, cum, pct, mpa: pct / 100 * opts.cls });
    });
  }

  // ---------- run ----------
  $("form").addEventListener("submit", async e => {
    e.preventDefault();
    const pourStr = $("pour").value;
    if (!pourStr) { showBanner("Укажите дату заливки.", true); return; }
    const opts = {
      pour: parseIso(pourStr),
      cls: parseFloat($("cls").value),
      cement: $("cement").value,
      horizon: Math.max(7, Math.min(90, parseInt($("horizon").value, 10) || 28)),
      offset: parseFloat(String($("offset").value).replace(",", ".")) || 0,
      antifreeze: $("antifreeze").checked
    };
    store.set("form", { pour: pourStr, cls: $("cls").value, cement: opts.cement, horizon: opts.horizon, offset: opts.offset,
      antifreeze: opts.antifreeze, mconst: $("mconst").value, mlist: $("mlist").value });

    const dates = Array.from({ length: opts.horizon }, (_, i) => addDays(opts.pour, i));
    const end = dates[dates.length - 1];
    let series, note = "";
    showBanner("");

    if (mode === "auto") {
      $("go").disabled = true; $("status").textContent = "Загружаю погоду…";
      try {
        const w = await fetchWeather(place.latitude, place.longitude, opts.pour, end);
        series = dates.map(d => {
          const s = iso(d), rec = w[s];
          if (rec) return { date: d, t: rec.t, kind: d < today ? "fact" : "fc" };
          return { date: d, t: null, kind: "none" };
        });
        note = "Погода: Open-Meteo, " + placeLabel(place) + ".";
      } catch (err) {
        $("go").disabled = false; $("status").textContent = "";
        setMode("manual");
        showBanner("Не удалось загрузить погоду (нет доступа к сервису Open-Meteo с этой страницы или нет интернета). Переключил на ручной ввод — укажите среднюю температуру или значения по дням и нажмите «Рассчитать» ещё раз.", true);
        return;
      }
      $("go").disabled = false; $("status").textContent = "";
    } else {
      const c = parseFloat(String($("mconst").value).replace(",", "."));
      const list = $("mlist").value.split(/[\s;]+/).map(x => x.replace(",", ".").replace("−", "-")).filter(Boolean).map(Number).filter(x => !isNaN(x));
      if (isNaN(c) && !list.length) { showBanner("Укажите среднюю температуру.", true); return; }
      series = dates.map((d, i) => i < list.length ? { date: d, t: list[i], kind: "fact" } : (isNaN(c) ? { date: d, t: null, kind: "none" } : { date: d, t: c, kind: "manual" }));
      note = "Температура введена вручную.";
    }

    // fill gaps: average of last 7 known days before the gap (or the first known values)
    const known = series.filter(d => d.t != null);
    if (!known.length) { showBanner("Нет данных о температуре для выбранного периода.", true); return; }
    let extrap = 0;
    series.forEach((d, i) => {
      if (d.t != null) return;
      const prev = series.slice(0, i).filter(x => x.t != null && x.kind !== "assume").slice(-7);
      const pool = prev.length ? prev : known.slice(0, 7);
      d.t = pool.reduce((s, x) => s + x.t, 0) / pool.length;
      d.kind = "assume"; extrap++;
    });

    const rows = compute(series, opts);
    render(rows, opts, note, extrap);
  });

  function showBanner(msg, err) {
    const b = $("banner"); b.textContent = msg; b.classList.toggle("err", !!err);
  }

  // ---------- render ----------
  const svgns = "http://www.w3.org/2000/svg";
  const el = (tag, a, txt) => { const e = document.createElementNS(svgns, tag); for (const k in a) e.setAttribute(k, a[k]); if (txt != null) e.textContent = txt; return e; };
  const kindName = { fact: "факт", fc: "прогноз", assume: "допущение (нет прогноза)", manual: "задано вручную" };

  function render(rows, opts, note, extrap) {
    $("results").hidden = false;
    const n = rows.length;
    const daysSince = diffDays(opts.pour, today);
    const idxToday = Math.min(n - 1, Math.max(-1, daysSince - 1)); // last completed day
    $("st-days").textContent = daysSince >= 0 ? daysSince : "—";
    $("st-days-sub").textContent = daysSince >= 0 ? "заливка " + ruFull(opts.pour) : "заливка через " + (-daysSince) + " сут";

    if (idxToday >= 0 && mode === "auto") {
      const r = rows[idxToday];
      $("st-now-l").textContent = "Прочность на конец " + ru(r.date);
      $("st-now").innerHTML = Math.round(r.pct) + '<span class="unit">% R28</span>';
      $("st-now-sub").textContent = "≈ " + fmt(r.mpa) + " МПа из " + fmt(opts.cls, opts.cls % 1 ? 1 : 0);
    } else {
      $("st-now-l").textContent = "Прочность сейчас";
      $("st-now").textContent = "—";
      $("st-now-sub").textContent = mode === "manual" ? "в ручном режиме см. график" : "бетон ещё не залит";
    }
    const last = rows[n - 1];
    $("st-end-l").textContent = "На " + ru(last.date) + " (" + n + " сут)";
    $("st-end").innerHTML = Math.round(last.pct) + '<span class="unit">% R28</span>';
    $("st-end-sub").textContent = "≈ " + fmt(last.mpa) + " МПа";
    const avg = rows.reduce((s, r) => s + r.t, 0) / n;
    $("st-t").innerHTML = fmt(avg) + '<span class="unit"> °C</span>';
    const minT = Math.min(...rows.map(r => r.t));
    $("st-t-sub").textContent = "мин. " + fmt(minT) + " °C" + (opts.offset ? " · бетон +" + fmt(opts.offset) + " °C" : "");

    // milestones
    const ms = $("milestones"); ms.innerHTML = "";
    MILESTONES.forEach(([p, what]) => {
      const i = rows.findIndex(r => r.pct >= p);
      const box = document.createElement("div"); box.className = "ms";
      let d, w;
      if (i >= 0) {
        const r = rows[i];
        d = ruFull(r.date) + " · " + (i + 1) + "-е сут";
        w = what + (r.kind === "fc" ? " · по прогнозу" : r.kind === "assume" ? " · по допущению" : "");
      } else { d = "позже " + ru(last.date); w = what + " · увеличьте период расчёта"; }
      box.innerHTML = '<div class="p">' + p + '% R28</div><div class="d"></div><div class="w"></div>';
      box.querySelector(".d").textContent = d; box.querySelector(".w").textContent = w;
      ms.appendChild(box);
    });

    // warnings
    const msgs = [];
    if (note) msgs.push(note);
    if (extrap) msgs.push("Для " + extrap + " сут прогноза нет — температура принята по среднему за последние известные дни.");
    const frozeEarly = rows.find(r => r.tc < 0 && r.pct < 50);
    if (frozeEarly && !opts.antifreeze) {
      showBanner("Внимание: " + ru(frozeEarly.date) + " среднесуточная температура бетона ниже 0 °C, а прочность ещё около " + Math.round(frozeEarly.pct) + "% R28. Без утепления, прогрева или противоморозных добавок есть риск замораживания до набора критической прочности. " + msgs.join(" "), true);
    } else showBanner(msgs.join(" "));

    // table
    $("tbl-cap").textContent = "k = (T + 10) / 30 · кривая твердения: " + CEMENT_NAME[opts.cement] + " · класс B" + fmt(opts.cls, opts.cls % 1 ? 1 : 0).replace(",0", "");
    const tb = $("tbody"); tb.innerHTML = "";
    rows.forEach(r => {
      const tr = document.createElement("tr");
      if (r.tc < 0 && !opts.antifreeze) tr.className = "cold";
      const tag = r.kind === "fc" ? '<span class="tag f">прогноз</span>' : r.kind === "assume" ? '<span class="tag x">допущ.</span>' : "";
      tr.innerHTML = "<td>" + ru(r.date) + " " + WD[r.date.getDay()] + tag + "</td><td>" + fmt(r.t) + "</td><td>" + fmt(r.tc) + "</td><td>" + r.k.toFixed(2) +
        "</td><td>" + r.cum.toFixed(1) + "</td><td>" + Math.round(r.pct) + "%</td><td>" + fmt(r.mpa) + "</td>";
      tb.appendChild(tr);
    });

    drawStrength(rows, opts, idxToday);
    drawTemp(rows, idxToday);
  }

  function tip(svgEl, tt, html, e) {
    const wrap = svgEl.closest(".chart-wrap").getBoundingClientRect();
    tt.innerHTML = html;
    tt.style.left = Math.min(Math.max(e.clientX - wrap.left, 80), wrap.width - 80) + "px";
    tt.style.top = (e.clientY - wrap.top - 12) + "px";
    tt.classList.add("show");
  }
  const labelStep = n => n <= 16 ? 1 : n <= 32 ? 2 : n <= 60 ? 4 : 7;

  function drawStrength(rows, opts, idxToday) {
    const svg = $("ch-str"); svg.innerHTML = "";
    const W = 880, H = 290, pL = 38, pR = 14, pT = 16, pB = 34;
    const pw = W - pL - pR, ph = H - pT - pB, n = rows.length;
    const maxP = Math.max(100, Math.ceil(Math.max(...rows.map(r => r.pct)) / 10) * 10);
    const x = i => pL + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
    const y = v => pT + ph - (v / maxP) * ph;
    for (let v = 0; v <= maxP; v += 25) {
      svg.appendChild(el("line", { class: "grid", x1: pL, x2: W - pR, y1: y(v), y2: y(v) }));
      svg.appendChild(el("text", { class: "axis", x: pL - 8, y: y(v) + 3, "text-anchor": "end" }, v));
    }
    MILESTONES.forEach(([v, t]) => {
      svg.appendChild(el("line", { class: "thr", x1: pL, x2: W - pR, y1: y(v), y2: y(v) }));
      svg.appendChild(el("text", { class: "thr-t", x: pL + 6, y: y(v) - 4 }, "≈" + v + "% — " + t));
    });
    let area = "M " + x(0) + " " + y(0) + " ";
    rows.forEach((r, i) => area += "L " + x(i) + " " + y(r.pct) + " ");
    area += "L " + x(n - 1) + " " + y(0) + " Z";
    svg.appendChild(el("path", { d: area, fill: "var(--str-soft)", opacity: .5 }));
    // solid for fact/manual, dotted for forecast/assume
    const solid = r => r.kind === "fact" || r.kind === "manual";
    for (let i = 1; i < n; i++) {
      const dashed = !solid(rows[i]);
      svg.appendChild(el("line", { x1: x(i - 1), y1: y(rows[i - 1].pct), x2: x(i), y2: y(rows[i].pct), stroke: "var(--str)", "stroke-width": 2.5,
        "stroke-linecap": "round", "stroke-dasharray": dashed ? "1 6" : "" }));
    }
    const st = labelStep(n), tt = $("tt-str");
    rows.forEach((r, i) => {
      if (n <= 45) svg.appendChild(el("circle", { cx: x(i), cy: y(r.pct), r: 3.5, fill: "var(--surface)", stroke: "var(--str)", "stroke-width": 1.8 }));
      if (i % st === 0) svg.appendChild(el("text", { class: "axis", x: x(i), y: H - 12, "text-anchor": "middle" }, ru(r.date)));
      const hit = el("rect", { x: x(i) - pw / n / 2, y: pT, width: Math.max(pw / n, 4), height: ph, fill: "transparent" });
      hit.addEventListener("mousemove", e => tip(svg, tt, "<b>" + ru(r.date) + " " + WD[r.date.getDay()] + "</b> · " + kindName[r.kind] + "<br><b>" + Math.round(r.pct) + "%</b> R28 ≈ " + fmt(r.mpa) + " МПа<br>T бетона " + fmt(r.tc) + " °C, экв. возраст " + r.cum.toFixed(1) + " сут", e));
      hit.addEventListener("mouseleave", () => tt.classList.remove("show"));
      svg.appendChild(hit);
    });
    if (idxToday >= 0 && idxToday < n - 1 && mode === "auto") {
      const xt = (x(idxToday) + x(idxToday + 1)) / 2;
      svg.appendChild(el("line", { class: "today", x1: xt, x2: xt, y1: pT, y2: pT + ph }));
      svg.appendChild(el("text", { class: "today-t", x: xt + 4, y: pT + ph - 6 }, "сегодня"));
    }
    const lr = rows[n - 1];
    svg.appendChild(el("text", { x: x(n - 1) - 4, y: y(lr.pct) - 10, "text-anchor": "end", class: "axis", style: "font-weight:600;fill:var(--str);font-size:12px" }, Math.round(lr.pct) + "%"));
  }

  function drawTemp(rows, idxToday) {
    const svg = $("ch-t"); svg.innerHTML = "";
    const W = 880, H = 250, pL = 38, pR = 14, pT = 24, pB = 34;
    const pw = W - pL - pR, ph = H - pT - pB, n = rows.length;
    const ts = rows.map(r => r.t);
    let lo = Math.min(0, Math.floor(Math.min(...ts) / 5) * 5), hi = Math.max(10, Math.ceil(Math.max(...ts) / 5) * 5);
    const y = v => pT + ph - ((v - lo) / (hi - lo)) * ph;
    const stepV = (hi - lo) > 30 ? 10 : 5;
    for (let v = lo; v <= hi; v += stepV) {
      svg.appendChild(el("line", { class: v === 0 ? "zero" : "grid", x1: pL, x2: W - pR, y1: y(v), y2: y(v) }));
      svg.appendChild(el("text", { class: "axis", x: pL - 8, y: y(v) + 3, "text-anchor": "end" }, String(v).replace("-", "−")));
    }
    const slot = pw / n, gap = Math.min(8, slot * 0.25), bw = slot - gap;
    const st = labelStep(n), tt = $("tt-t");
    rows.forEach((r, i) => {
      const x0 = pL + i * slot + gap / 2;
      const top = Math.min(y(r.t), y(0)), h = Math.max(Math.abs(y(r.t) - y(0)), 2);
      const fill = r.kind === "assume" ? "var(--nodata)" : "var(--temp)";
      const rect = el("rect", { x: x0, y: top, width: bw, height: h, rx: Math.min(3, bw / 3), fill, opacity: r.kind === "fc" ? .45 : 1 });
      rect.addEventListener("mousemove", e => tip(svg, tt, "<b>" + ru(r.date) + " " + WD[r.date.getDay()] + "</b><br>" + kindName[r.kind] + ": " + fmt(r.t) + " °C", e));
      rect.addEventListener("mouseleave", () => tt.classList.remove("show"));
      svg.appendChild(rect);
      if (n <= 21) svg.appendChild(el("text", { class: "axis", x: x0 + bw / 2, y: r.t >= 0 ? top - 5 : top + h + 12, "text-anchor": "middle" }, fmt(r.t)));
      if (i % st === 0) svg.appendChild(el("text", { class: "axis", x: x0 + bw / 2, y: H - 12, "text-anchor": "middle" }, ru(r.date)));
    });
    if (idxToday >= 0 && idxToday < n - 1 && mode === "auto") {
      const xt = pL + (idxToday + 1) * slot;
      svg.appendChild(el("line", { class: "today", x1: xt, x2: xt, y1: pT - 8, y2: pT + ph }));
      svg.appendChild(el("text", { class: "today-t", x: xt, y: 12, "text-anchor": "middle" }, "сегодня"));
    }
  }
})();


(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const num = v => { const x = parseFloat(String(v == null ? "" : v).replace(",", ".").replace("−", "-")); return isNaN(x) ? 0 : x; };
  const nf = (x, d = 2) => x.toLocaleString("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d }).replace("-", "−");
  const nint = x => Math.round(x).toLocaleString("ru-RU");
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem("beton:" + k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem("beton:" + k, JSON.stringify(v)); } catch (e) {} }
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const showTab = t => { if (window.App) window.App.open(t); };
  window.__legacy = window.__legacy || {};
  const legacySet = (id, items) => { window.__legacy[id] = items; if (window.__legacyChanged) window.__legacyChanged(); };

  // ================= persisted plain inputs =================
  function persist(ids, key, onChange) {
    const saved = store.get(key) || {};
    ids.forEach(id => { if (saved[id] != null) $(id).value = saved[id]; });
    const save = () => { const o = {}; ids.forEach(id => o[id] = $(id).value); store.set(key, o); onChange(); };
    ids.forEach(id => { $(id).addEventListener("input", save); $(id).addEventListener("change", save); });
  }

  // ================= generic rows editor =================
  function rowsEditor({ el, addBtn, key, types, defaults, onChange }) {
    let rows = store.get(key) || defaults.map(r => JSON.parse(JSON.stringify(r)));
    const save = () => store.set(key, rows);
    const valueOf = r => { const t = types[r.type]; return t ? t.calc(r.v) * Math.max(0, num(r.qty)) : 0; };

    function rowEl(r, i) {
      const t = types[r.type];
      const div = document.createElement("div");
      div.className = "row";
      let h = '<label class="mini mtype"><span>Тип</span><select data-k="__type">' +
        Object.entries(types).map(([k, v]) => '<option value="' + k + '"' + (k === r.type ? " selected" : "") + ">" + v.name + "</option>").join("") +
        "</select></label>";
      t.fields.forEach(f => {
        if (r.v[f.k] == null) r.v[f.k] = f.def;
        if (f.options) {
          h += '<label class="mini"><span>' + f.label + '</span><select data-k="' + f.k + '">' +
            f.options.map(o => '<option value="' + o[0] + '"' + (String(o[0]) === String(r.v[f.k]) ? " selected" : "") + ">" + o[1] + "</option>").join("") + "</select></label>";
        } else {
          h += '<label class="mini"><span>' + f.label + '</span><input type="text" inputmode="decimal" data-k="' + f.k + '" value="' + esc(r.v[f.k]) + '"></label>';
        }
      });
      if (!t.noQty) h += '<label class="mini qty"><span>Кол-во</span><input type="text" inputmode="numeric" data-k="__qty" value="' + esc(r.qty) + '"></label>';
      h += '<div class="rres"></div><button type="button" class="rdel" aria-label="Удалить">×</button>';
      div.innerHTML = h;
      div.querySelectorAll("[data-k]").forEach(inp => {
        const ev = inp.tagName === "SELECT" ? "change" : "input";
        inp.addEventListener(ev, () => {
          const k = inp.dataset.k;
          if (k === "__type") { r.type = inp.value; r.v = {}; if (types[r.type].noQty) r.qty = 1; save(); render(); return; }
          if (k === "__qty") r.qty = inp.value; else r.v[k] = inp.value;
          save(); update();
        });
      });
      div.querySelector(".rdel").onclick = () => { rows.splice(i, 1); save(); render(); };
      return div;
    }
    function update() {
      el.querySelectorAll(".row").forEach((d, i) => { const r = rows[i]; d.querySelector(".rres").textContent = types[r.type].fmt(valueOf(r)); });
      onChange(rows, valueOf);
    }
    function render() { el.innerHTML = ""; rows.forEach((r, i) => el.appendChild(rowEl(r, i))); update(); }
    addBtn.onclick = () => { const last = rows[rows.length - 1]; rows.push(last ? { type: last.type, v: {}, qty: 1 } : JSON.parse(JSON.stringify(defaults[0]))); save(); render(); };
    render();
    return { refresh: update };
  }

  const m3 = x => nf(x, 2) + " м³";
  if ($("tab-volume")) {
  // ================= VOLUME =================
  const VOL_TYPES = {
    strip: { name: "Лента / ростверк / балка", fields: [{ k: "L", label: "Длина, м", def: "30" }, { k: "b", label: "Ширина, м", def: "0,4" }, { k: "h", label: "Высота, м", def: "0,6" }],
      calc: v => num(v.L) * num(v.b) * num(v.h), fmt: m3 },
    slab: { name: "Плита / перекрытие", fields: [{ k: "L", label: "Длина, м", def: "10" }, { k: "W", label: "Ширина, м", def: "8" }, { k: "t", label: "Толщина, м", def: "0,25" }, { k: "o", label: "Проёмы, м²", def: "0" }],
      calc: v => Math.max(0, num(v.L) * num(v.W) - num(v.o)) * num(v.t), fmt: m3 },
    rect: { name: "Столб прямоугольный", fields: [{ k: "a", label: "Сторона a, м", def: "0,4" }, { k: "b", label: "Сторона b, м", def: "0,4" }, { k: "h", label: "Высота, м", def: "2" }],
      calc: v => num(v.a) * num(v.b) * num(v.h), fmt: m3 },
    round: { name: "Свая / столб круглый", fields: [{ k: "d", label: "Диаметр, м", def: "0,3" }, { k: "h", label: "Глубина, м", def: "2" }],
      calc: v => Math.PI * num(v.d) * num(v.d) / 4 * num(v.h), fmt: m3 },
    ready: { name: "Готовый объём", fields: [{ k: "V", label: "Объём, м³", def: "1" }], calc: v => num(v.V), fmt: m3 }
  };
  let volTotal = 0;
  const volEd = rowsEditor({
    el: $("vol-rows"), addBtn: $("vol-add"), key: "volRows", types: VOL_TYPES,
    defaults: [{ type: "strip", v: {}, qty: 1 }],
    onChange: (rows, val) => {
      const net = rows.reduce((s, r) => s + val(r), 0);
      const res = num($("vol-reserve").value), cap = num($("vol-mixer").value), dens = num($("vol-density").value);
      volTotal = net * (1 + res / 100);
      const order = Math.ceil(volTotal * 4) / 4; // миксер обычно заказывают с шагом 0,25–0,5 м³
      $("vol-net").textContent = m3(net);
      $("vol-total").innerHTML = nf(volTotal, 2) + '<span class="unit"> м³</span>';
      $("vol-total-sub").textContent = net ? "округлённо к заказу " + nf(order, 2) + " м³" : "";
      if (volTotal > 0 && cap > 0) {
        const n = Math.ceil(volTotal / cap - 1e-9), lastLoad = volTotal - (n - 1) * cap;
        $("vol-trucks").textContent = n;
        $("vol-trucks-sub").textContent = n > 1 ? (n - 1) + " × " + nf(cap, 0) + " м³ + " + nf(lastLoad, 2) + " м³" : nf(volTotal, 2) + " м³ из " + nf(cap, 0);
      } else { $("vol-trucks").textContent = "—"; $("vol-trucks-sub").textContent = ""; }
      $("vol-mass").innerHTML = nf(volTotal * dens, 1) + '<span class="unit"> т</span>';
      $("vol-to-mix").disabled = !(volTotal > 0);
      legacySet("volume", volTotal > 0 ? [["Бетон товарный", Math.ceil(volTotal * 4) / 4, "м³"]] : []);
    }
  });
  persist(["vol-reserve", "vol-mixer", "vol-density"], "volOpts", () => volEd.refresh());
  volEd.refresh();
  $("vol-to-mix").onclick = () => { const mo = store.get("mixOpts") || {}; mo["mix-vol"] = volTotal.toFixed(2); store.set("mixOpts", mo); if ($("mix-vol")) { $("mix-vol").value = volTotal.toFixed(2); $("mix-vol").dispatchEvent(new Event("input")); } showTab("mix"); window.scrollTo({ top: 0, behavior: "smooth" }); };

  }
  if ($("tab-mix")) {
  // ================= MIX =================
  // массовые пропорции Ц : П : Щ для ПЦ М500, щебень 5–20
  const MIX = { "B7.5": [4.6, 7.0], "B10": [3.5, 5.7], "B12.5": [3.3, 5.4], "B15": [2.8, 4.8], "B20": [2.1, 3.9], "B22.5": [1.9, 3.7], "B25": [1.5, 3.1], "B30": [1.2, 2.7], "B35": [1.1, 2.5] };
  const DRY = 2215, WATER = 185, RHO = { c: 1300, s: 1500, g: 1400 };
  function calcMix() {
    const [ps, pg] = MIX[$("mix-cls").value];
    let c = DRY / (1 + ps + pg), s = c * ps, g = c * pg;
    if ($("mix-cem").value === "400") { const c2 = c * 1.15, k = (DRY - c2) / (DRY - c); s *= k; g *= k; c = c2; }
    const V = Math.max(0, num($("mix-vol").value)), bag = num($("mix-bag").value);
    const tb = $("mix-body");
    const row = (name, per, tot, extra) => "<tr><td>" + name + "</td><td>" + per + "</td><td>" + tot + "</td><td>" + extra + "</td></tr>";
    tb.innerHTML =
      row("Цемент", nint(c) + " кг", nint(c * V) + " кг", nf(Math.ceil(c * V / bag * 10) / 10, 1) + " меш. по " + bag + " кг · " + nint(Math.ceil(c * V / bag)) + " к покупке") +
      row("Песок", nint(s) + " кг", nint(s * V) + " кг", nf(s * V / RHO.s, 2) + " м³") +
      row("Щебень 5–20", nint(g) + " кг", nint(g * V) + " кг", nf(g * V / RHO.g, 2) + " м³") +
      row("Вода", nint(WATER) + " л", nint(WATER * V) + " л", "В/Ц ≈ " + nf(WATER / c, 2));
    $("mix-title").textContent = "Расход материалов на " + nf(V, 2) + " м³";
    // пропорции по объёму (вёдрам)
    const vc = c / RHO.c, vs = s / RHO.s / vc, vg = g / RHO.g / vc, wPerBucket = WATER / (c / RHO.c * 1000) * 10;
    let html = "<b>На глаз, в вёдрах (по объёму):</b> Ц : П : Щ = 1 : " + nf(vs, 1) + " : " + nf(vg, 1) + ", воды ≈ " + nf(wPerBucket, 1) + " л на ведро цемента (10 л)." +
      "<br><b>По массе:</b> 1 : " + nf(s / c, 2) + " : " + nf(g / c, 2) + ".";
    const batch = num($("mix-batch").value);
    if (batch > 0) {
      const out = batch * 0.65 / 1000; // м³ бетона
      html += "<br><b>На замес " + nint(batch) + " л</b> (≈" + nf(out * 1000, 0) + " л бетона): цемент " + nf(c * out, 1) + " кг, песок " + nf(s * out, 1) + " кг, щебень " + nf(g * out, 1) + " кг, вода " + nf(WATER * out, 1) + " л" +
        (V > 0 ? " · замесов на весь объём: " + nint(Math.ceil(V / out)) : "") + ".";
    }
    $("mix-prop").innerHTML = html;
    legacySet("mix", V > 0 ? [["Цемент, мешок " + bag + " кг", Math.ceil(c * V / bag), "меш."], ["Песок", Math.round(s * V / RHO.s * 100) / 100, "м³"], ["Щебень 5–20", Math.round(g * V / RHO.g * 100) / 100, "м³"]] : []);
  }
  persist(["mix-cls", "mix-cem", "mix-vol", "mix-bag", "mix-batch"], "mixOpts", calcMix);
  calcMix();

  }
  if ($("tab-rebar")) {
  // ================= REBAR =================
  const DIAMS = [6, 8, 10, 12, 14, 16, 18, 20, 22, 25];
  const kgm = d => 0.00617 * d * d;
  [["rb-sD", 12], ["rb-tD", 12], ["rb-tDs", 8]].forEach(([id, def]) => {
    $(id).innerHTML = DIAMS.map(d => '<option value="' + d + '"' + (d === def ? " selected" : "") + ">Ø" + d + " (" + nf(kgm(d), 3) + " кг/м)</option>").join("");
  });
  let rbMode = store.get("rbMode") || "slab";
  function setRb(m) {
    rbMode = m; store.set("rbMode", m);
    document.querySelectorAll("[data-rb]").forEach(b => b.classList.toggle("on", b.dataset.rb === m));
    $("rb-slab").hidden = m !== "slab"; $("rb-strip").hidden = m !== "strip";
    calcRebar();
  }
  document.querySelectorAll("[data-rb]").forEach(b => b.onclick = () => setRb(b.dataset.rb));
  const STOCK = 11.7;
  // длина стержня с учётом стыков внахлёст
  const withLaps = (len, d, lapD) => { const joints = Math.max(0, Math.ceil(len / STOCK - 1e-9) - 1); return len + joints * lapD * d / 1000; };
  function calcRebar() {
    const cover = num($("rb-cover").value) / 1000, lapD = num($("rb-lap").value), res = num($("rb-res").value) / 100;
    const items = []; let knots = 0;
    if (rbMode === "slab") {
      const L = num($("rb-sL").value), W = num($("rb-sW").value), T = num($("rb-sT").value) / 1000, d = num($("rb-sD").value),
        st = num($("rb-sS").value) / 1000, nm = num($("rb-sN").value);
      if (L > 2 * cover && W > 2 * cover && st > 0) {
        const nAlongL = Math.floor((W - 2 * cover) / st + 1e-9) + 1, nAlongW = Math.floor((L - 2 * cover) / st + 1e-9) + 1;
        items.push({ name: "Стержни вдоль длины" + (nm > 1 ? " (2 сетки)" : ""), d, n: nAlongL * nm, len: withLaps(L - 2 * cover, d, lapD) });
        items.push({ name: "Стержни вдоль ширины" + (nm > 1 ? " (2 сетки)" : ""), d, n: nAlongW * nm, len: withLaps(W - 2 * cover, d, lapD) });
        knots = nAlongL * nAlongW * nm;
        if (nm > 1) {
          const n = Math.ceil(L * W), h = Math.max(0, T - 2 * cover);
          items.push({ name: "Поддерживающие «лягушки» (1 шт/м²)", d: Math.min(d, 12), n, len: h + 0.4 });
          knots += n * 2;
        }
      }
    } else {
      const L = num($("rb-tL").value), B = num($("rb-tB").value) / 1000, H = num($("rb-tH").value) / 1000, n = Math.round(num($("rb-tN").value)),
        d = num($("rb-tD").value), ss = num($("rb-tSs").value) / 1000, ds = num($("rb-tDs").value);
      if (L > 0 && ss > 0 && B > 2 * cover && H > 2 * cover) {
        items.push({ name: "Продольная арматура", d, n, len: withLaps(L, d, lapD) });
        const ns = Math.floor(L / ss + 1e-9) + 1, sl = 2 * ((B - 2 * cover) + (H - 2 * cover)) + 0.15;
        items.push({ name: "Хомуты (замкнутые)", d: ds, n: ns, len: sl });
        knots = ns * n;
      }
    }
    let totalLen = 0, totalMass = 0, stockMass = 0;
    const tb = $("rb-body"); tb.innerHTML = "";
    const byD = {};
    items.forEach(it => {
      const tl = it.n * it.len * (1 + res), mass = tl * kgm(it.d);
      const per = it.len <= STOCK ? Math.floor(STOCK / it.len + 1e-9) : 0; // сколько заготовок выходит из одного хлыста
      const stocks = per ? Math.ceil(it.n * (1 + res) / per - 1e-9) : Math.ceil(tl / STOCK - 1e-9);
      totalLen += tl; totalMass += mass; stockMass += stocks * STOCK * kgm(it.d);
      byD[it.d] = byD[it.d] || { len: 0, mass: 0, st: 0 }; byD[it.d].len += tl; byD[it.d].mass += mass; byD[it.d].st += stocks;
      const tr = document.createElement("tr");
      tr.innerHTML = "<td>" + it.name + "</td><td>" + it.d + "</td><td>" + nint(it.n) + "</td><td>" + nf(it.len, 2) + "</td><td>" + nf(tl, 1) + "</td><td>" + nint(stocks) + "</td><td>" + nf(mass, 1) + "</td>";
      tb.appendChild(tr);
    });
    Object.keys(byD).sort((a, b) => a - b).forEach(d => {
      const tr = document.createElement("tr"); tr.className = "sum";
      tr.innerHTML = "<td>Итого Ø" + d + "</td><td>" + d + "</td><td></td><td></td><td>" + nf(byD[d].len, 1) + "</td><td>" + nint(byD[d].st) + "</td><td>" + nf(byD[d].mass, 1) + "</td>";
      tb.appendChild(tr);
    });
    $("rb-mass").innerHTML = totalMass >= 1000 ? nf(totalMass / 1000, 2) + '<span class="unit"> т</span>' : nint(totalMass) + '<span class="unit"> кг</span>';
    $("rb-mass-sub").textContent = (res ? "с запасом " + nint(res * 100) + "% · " : "") + "целыми хлыстами " + (stockMass >= 1000 ? nf(stockMass / 1000, 2) + " т" : nint(stockMass) + " кг");
    $("rb-len").innerHTML = nint(totalLen) + '<span class="unit"> м</span>';
    $("rb-knots").textContent = nint(knots);
    $("rb-wire").innerHTML = nf(knots * 0.3 * 0.0089, 1) + '<span class="unit"> кг</span>';
    legacySet("rebar", Object.keys(byD).sort((a, b) => a - b).map(d => ["Арматура Ø" + d + " (хлыст 11,7 м)", byD[d].st, "шт."]).concat(knots ? [["Проволока вязальная Ø1,2", Math.round(knots * 0.3 * 0.0089 * 10) / 10, "кг"]] : []));
  }
  persist(["rb-sL", "rb-sW", "rb-sT", "rb-sD", "rb-sS", "rb-sN", "rb-tL", "rb-tB", "rb-tH", "rb-tN", "rb-tD", "rb-tSs", "rb-tDs", "rb-cover", "rb-lap", "rb-res"], "rbOpts", calcRebar);
  setRb(rbMode);

  }
  if ($("tab-brick")) {
  // ================= BRICK =================
  const THICK = [["0.12", "½ кирпича (120)"], ["0.25", "1 кирпич (250)"], ["0.38", "1½ (380)"], ["0.51", "2 кирпича (510)"], ["0.64", "2½ (640)"]];
  const BR_TYPES = {
    wall: { name: "Стена", fields: [{ k: "L", label: "Длина, м", def: "10" }, { k: "H", label: "Высота, м", def: "3" }, { k: "t", label: "Толщина", def: "0.38", options: THICK }, { k: "o", label: "Проёмы, м²", def: "0" }],
      calc: v => Math.max(0, num(v.L) * num(v.H) - num(v.o)) * num(v.t), fmt: m3 },
    pillar: { name: "Столб", fields: [{ k: "a", label: "a, мм", def: "380" }, { k: "b", label: "b, мм", def: "380" }, { k: "H", label: "Высота, м", def: "3,3" }],
      calc: v => num(v.a) * num(v.b) / 1e6 * num(v.H), fmt: m3 },
    ready: { name: "Готовый объём", fields: [{ k: "V", label: "Объём, м³", def: "1" }], calc: v => num(v.V), fmt: m3 }
  };
  const PALLET = { 65: 380, 88: 280, 138: 200 };
  const MORTAR_RATIO = { 50: 7, 75: 5.5, 100: 4.5, 150: 3.5 }; // Ц:П по объёму на ПЦ М500
  let brRows = [], brVal = () => 0;
  function calcBrick() {
    const hb = num($("br-type").value) / 1000, j = num($("br-joint").value) / 1000;
    const perM3 = 1 / ((0.25 + j) * (0.12 + j) * (hb + j));
    const mortarPerM3 = Math.max(0, 1 - perM3 * 0.25 * 0.12 * hb);
    const V = brRows.reduce((s, r) => s + brVal(r), 0);
    const res = num($("br-res").value) / 100, pal = Math.max(1, num($("br-pallet").value));
    const n = Math.ceil(V * perM3 * (1 + res));
    $("br-vol").innerHTML = nf(V, 2) + '<span class="unit"> м³</span>';
    $("br-vol-sub").textContent = nint(perM3) + " шт. и " + nf(mortarPerM3, 3) + " м³ раствора на 1 м³";
    $("br-n").innerHTML = nint(n) + '<span class="unit"> шт.</span>';
    $("br-n-sub").textContent = "без запаса " + nint(V * perM3);
    $("br-pal").innerHTML = nint(Math.ceil(n / pal - 1e-9)) + '<span class="unit"> шт.</span>';
    const mort = V * mortarPerM3 * 1.05; // +5% на потери раствора
    const ratio = MORTAR_RATIO[$("br-mortar").value], sand = mort * 1.1, cem = sand / ratio * 1300, bag = num($("br-bag").value);
    $("br-mort").innerHTML = nf(mort, 2) + '<span class="unit"> м³</span>';
    legacySet("brick", n > 0 ? [["Кирпич " + $("br-type").selectedOptions[0].textContent, n, "шт."], ["Цемент для раствора, мешок " + bag + " кг", Math.ceil(cem / bag), "меш."], ["Песок для раствора", Math.round(sand * 10) / 10, "м³"]] : []);
    $("br-mort-sub").textContent = mort > 0 ? "цемент ≈ " + nint(cem) + " кг (" + nint(Math.ceil(cem / bag)) + " меш.), песок ≈ " + nf(sand, 1) + " м³" : "";
  }
  const brEd = rowsEditor({
    el: $("br-rows"), addBtn: $("br-add"), key: "brRows", types: BR_TYPES,
    defaults: [{ type: "wall", v: {}, qty: 1 }],
    onChange: (rows, val) => { brRows = rows; brVal = val; calcBrick(); }
  });
  $("br-type").addEventListener("change", () => { $("br-pallet").value = PALLET[$("br-type").value]; $("br-pallet").dispatchEvent(new Event("input")); });
  persist(["br-type", "br-joint", "br-pallet", "br-res", "br-mortar", "br-bag"], "brOpts", calcBrick);
  brEd.refresh();
  }
})();


(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const num = v => { if (typeof v === "number") return v; const x = parseFloat(String(v == null ? "" : v).replace(/\s/g, "").replace(",", ".").replace("−", "-")); return isNaN(x) ? 0 : x; };
  const nf = (x, d = 2) => (isFinite(x) ? x : 0).toLocaleString("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d }).replace("-", "−");
  const nint = x => Math.round(isFinite(x) ? x : 0).toLocaleString("ru-RU");
  const ceil = x => Math.ceil(x - 1e-9);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem("beton:" + k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem("beton:" + k, JSON.stringify(v)); } catch (e) {} }
  };
  const norm = s => String(s).toLowerCase().replace(/ё/g, "е");
  // ---------- theme ----------
  function applyTheme(t) {
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
    document.querySelectorAll(".theme button").forEach(b => b.classList.toggle("on", b.dataset.t === t));
    store.set("theme", t);
  }
  document.querySelectorAll(".theme button").forEach(b => b.onclick = () => applyTheme(b.dataset.t));
  applyTheme(store.get("theme") || "auto");

  const S = (label, value, unit, sub, accent) => ({ label, value, unit, sub, accent });
  const deg = r => r * 180 / Math.PI, rad = d => d * Math.PI / 180;

  // ====================================================================
  //  CALCULATORS
  // ====================================================================
  const CATS = [["found", "Участок и фундамент"], ["struct", "Конструктив"], ["finish", "Отделка"], ["glass", "Остекление"], ["land", "Благоустройство и сети"], ["green", "Озеленение"], ["tech", "Технические расчёты"], ["learn", "Обучение"]];
  const CALCS = [];
  const add = c => CALCS.push(c);

  // ---------- legacy (already on the page) ----------
  add({ id: "strength", cat: "struct", legacy: true, mark: "по погоде", name: "Набор прочности бетона", kw: "прочность твердение распалубка опалубка погода температура зима мороз r28 созревание", desc: "Когда бетон наберёт 50, 70 и 100% — по реальной погоде в вашем городе" });
  add({ id: "volume", cat: "struct", legacy: true, name: "Объём бетона и миксеры", kw: "куб кубатура фундамент лента плита ростверк сваи столбы миксер бетон заказ", desc: "Кубы с запасом по элементам, сколько миксеров заказать" });
  add({ id: "mix", cat: "struct", legacy: true, name: "Состав бетона", kw: "пропорции цемент песок щебень вода замес бетономешалка ведра марка класс", desc: "Цемент, песок, щебень, вода по классу; в вёдрах и на замес" });
  add({ id: "rebar", cat: "struct", legacy: true, name: "Арматура плиты и ленты", kw: "арматура каркас сетка хомуты вязка проволока хлысты металл", desc: "Метры, хлысты и тонны по диаметрам, вязальная проволока" });
  add({ id: "brick", cat: "struct", legacy: true, name: "Кирпич и раствор", kw: "кирпич кладка стена раствор поддон силикатный керамический полуторный столб", desc: "Кирпич, поддоны, раствор, цемент и песок для кладки" });

  // ---------- Газобетон ----------
  add({
    id: "block", cat: "struct", name: "Газобетон и блоки", kw: "газобетон газоблок пеноблок блоки клей кладка армирование стена d500 d400 керамзитоблок",
    desc: "Блоки в штуках и кубах, поддоны, клей и армирование рядов",
    inputs: [
      { k: "L", label: "Длина стен, м", def: 40, hint: "Сумма всех стен по оси" },
      { k: "H", label: "Высота стен, м", def: 3 },
      { k: "o", label: "Проёмы, м²", def: 12, hint: "Окна + двери" },
      { k: "bl", label: "Длина блока, мм", def: 600 },
      { k: "bh", label: "Высота блока, мм", def: 250 },
      { k: "t", label: "Толщина стены, мм", type: "sel", def: "300", opts: [["100", "100"], ["150", "150"], ["200", "200"], ["250", "250"], ["300", "300"], ["375", "375"], ["400", "400"], ["500", "500"]] },
      { k: "pal", label: "Объём поддона, м³", def: 1.8, hint: "Уточните у поставщика" },
      { k: "glue", label: "Расход клея, кг/м³", def: 25, hint: "Шов 2–3 мм: 20–30 кг на м³" },
      { k: "every", label: "Армировать каждый N-й ряд", def: 4 },
      { k: "res", label: "Запас, %", def: 5 }
    ],
    run(v) {
      const area = Math.max(0, v.L * v.H - v.o), V = area * v.t / 1000, r = 1 + v.res / 100;
      const blockFace = (v.bl / 1000) * (v.bh / 1000);
      const n = blockFace > 0 ? ceil(area / blockFace * r) : 0;
      const Vr = V * r, pal = v.pal > 0 ? ceil(Vr / v.pal) : 0;
      const glue = V * v.glue, bags = ceil(glue / 25);
      const rows = v.bh > 0 ? Math.floor(v.H * 1000 / v.bh) : 0;
      const armRows = v.every > 0 && rows > 0 ? Math.floor((rows - 1) / v.every) + 1 : 0;
      const rebar = armRows * v.L * 2 * 1.05;
      return {
        stats: [S("Площадь кладки", nf(area, 1), "м²"), S("Блоков с запасом", nint(n), "шт.", nf(Vr, 2) + " м³", true), S("Поддонов", nint(pal), "шт."), S("Клей", nint(bags), "меш. 25 кг", "≈ " + nint(glue) + " кг")],
        table: { head: ["Позиция", "Значение"], rows: [["Рядов кладки", nint(rows)], ["Армируемых рядов (первый + каждый " + v.every + "-й)", nint(armRows)], ["Арматура Ø8 в штробы (2 прутка)", nf(rebar, 0) + " м · " + nf(rebar * 0.395, 0) + " кг"]] },
        items: [["Блок " + v.bl + "×" + v.bh + "×" + v.t, n, "шт."], ["Клей для блоков, мешок 25 кг", bags, "меш."], ["Арматура Ø8 А500", Math.round(rebar), "м"]]
      };
    },
    info: "Первый ряд кладётся на цементно-песчаный раствор — его клей не учитывает. Армопояс и перемычки считайте отдельно в «Объёме бетона» и «Арматуре»."
  });

  // ---------- Кровля ----------
  add({
    id: "roof", cat: "struct", name: "Двускатная кровля и стропила", kw: "кровля крыша стропила конек скат угол обрешетка металлочерепица профнастил мягкая черепица площадь",
    desc: "Высота конька, длина стропил, площадь кровли, обрешётка и покрытие",
    inputs: [
      { k: "B", label: "Ширина дома (пролёт), м", def: 8 },
      { k: "L", label: "Длина дома, м", def: 10 },
      { k: "mode", label: "Задать", type: "sel", def: "a", opts: [["a", "угол ската"], ["h", "высоту конька"]] },
      { k: "a", label: "Угол ската, °", def: 30, show: v => v.mode === "a" },
      { k: "h", label: "Высота конька над стенами, м", def: 2.3, show: v => v.mode === "h" },
      { k: "ov", label: "Свес по карнизу, м", def: 0.5, hint: "По горизонтали" },
      { k: "go", label: "Свес по фронтону, м", def: 0.3 },
      { k: "step", label: "Шаг стропил, мм", def: 600 },
      { k: "sb", label: "Сечение стропил: ширина, мм", def: 50 },
      { k: "sh", label: "Сечение стропил: высота, мм", def: 200 },
      { k: "bs", label: "Шаг обрешётки, мм", def: 350 },
      { k: "mat", label: "Покрытие", type: "sel", def: "mt", opts: [["mt", "Металлочерепица (+10%)"], ["pn", "Профнастил (+10%)"], ["soft", "Гибкая черепица (+15%, уп. 3 м²)"], ["falc", "Фальц (+7%)"]] }
    ],
    run(v) {
      const half = v.B / 2;
      let a = v.mode === "a" ? v.a : deg(Math.atan2(v.h, half));
      a = Math.min(Math.max(a, 1), 75);
      const h = half * Math.tan(rad(a));
      const slopeMain = half / Math.cos(rad(a));
      const slope = (half + v.ov) / Math.cos(rad(a));
      const roofL = v.L + 2 * v.go;
      const area = 2 * slope * roofL;
      const pairs = v.step > 0 ? ceil(v.L / (v.step / 1000)) + 1 : 0;
      const raf = pairs * 2, rafV = raf * slope * v.sb / 1000 * v.sh / 1000;
      const bRows = v.bs > 0 ? ceil(slope / (v.bs / 1000)) + 1 : 0, batten = bRows * 2 * roofL * 1.05;
      const kMat = { mt: 1.1, pn: 1.1, soft: 1.15, falc: 1.07 }[v.mat];
      const buy = area * kMat;
      const warn = [];
      if (v.mat === "mt" && a < 14) warn.push("Металлочерепицу обычно кладут при уклоне от 14°.");
      if (v.mat === "soft" && a < 12) warn.push("Гибкую черепицу обычно кладут при уклоне от 12° (с ковром — по инструкции производителя).");
      if (v.mat === "pn" && a < 8) warn.push("Профнастил при уклоне менее 8° требует герметизации нахлёстов.");
      const items = [["Стропила " + v.sb + "×" + v.sh + ", длина " + nf(slope, 2) + " м", raf, "шт."], ["Обрешётка", Math.round(batten), "м"]];
      if (v.mat === "soft") items.push(["Гибкая черепица, упаковка 3 м²", ceil(buy / 3), "уп."]); else items.push([{ mt: "Металлочерепица", pn: "Профнастил кровельный", falc: "Фальцевая кровля" }[v.mat], Math.round(buy * 10) / 10, "м²"]);
      items.push(["Коньковый элемент", Math.round(roofL * 1.05 * 10) / 10, "м"]);
      return {
        stats: [S("Угол / высота конька", nf(a, 1) + "° · " + nf(h, 2), "м"), S("Длина стропила со свесом", nf(slope, 2), "м", "без свеса " + nf(slopeMain, 2) + " м"), S("Площадь кровли", nf(area, 1), "м²", "к покупке ≈ " + nf(buy, 1) + " м²", true), S("Стропил", nint(raf), "шт.", nf(rafV, 2) + " м³ доски")],
        table: { head: ["Позиция", "Значение"], rows: [["Уклон", nf(Math.tan(rad(a)) * 100, 0) + "%"], ["Пар стропил", nint(pairs)], ["Рядов обрешётки на скат", nint(bRows)], ["Обрешётка (с запасом 5%)", nf(batten, 0) + " м"], ["Длина конька", nf(roofL, 2) + " м"], ["Карнизные свесы (2 стороны)", nf(roofL * 2, 1) + " м"], ["Фронтонные свесы (4 шт.)", nf(slope * 4, 1) + " м"]] },
        warn: warn.join(" "), items
      };
    },
    info: "Сечение стропил здесь не подбирается по прочности — его определяет снеговой район, пролёт и шаг. Для проверки воспользуйтесь калькулятором «Деревянная балка»."
  });

  // ---------- Лестница ----------
  add({
    id: "stairs", cat: "struct", mark: "проём + разметка", name: "Лестница прямая", kw: "лестница ступени подступенок проступь косоур тетива блондель проем перекрытие угол марш",
    desc: "Ступени по формуле удобства, угол, косоур, размер проёма и разметка",
    inputs: [
      { k: "H", label: "Высота от пола до пола, мм", def: 2900, hint: "Чистовой пол 1-го до чистового пола 2-го этажа" },
      { k: "hr", label: "Желаемая высота ступени, мм", def: 175, hint: "Удобно 150–190" },
      { k: "run", label: "Длина в плане, мм (0 — подобрать)", def: 0, hint: "Если место ограничено" },
      { k: "t", label: "Толщина перекрытия, мм", def: 250 },
      { k: "head", label: "Высота прохода, мм", def: 2000 },
      { k: "w", label: "Ширина марша, мм", def: 900 }
    ],
    run(v) {
      const n = Math.max(2, Math.round(v.H / Math.max(100, v.hr)));
      const h = v.H / n, treads = n - 1;
      const b = v.run > 0 ? v.run / treads : Math.min(320, Math.max(220, 630 - 2 * h));
      const run = b * treads, ang = deg(Math.atan2(h, b)), blond = 2 * h + b;
      const str = Math.hypot(run, v.H - h); // косоур от пола до верхней проступи
      const x0 = (v.H - v.t - v.head) * b / h; // где начинается проём
      const open = Math.max(0, run - x0);
      const warn = [];
      if (blond < 600 || blond > 650) warn.push("2h + b = " + nint(blond) + " мм — вне удобного диапазона 600–650 мм.");
      if (ang > 45) warn.push("Угол " + nf(ang, 0) + "° — крутая лестница, удобно 30–40°.");
      if (b < 250) warn.push("Проступь меньше 250 мм — стопа помещается не полностью.");
      const rows = [];
      for (let i = 1; i <= n; i++) rows.push([String(i), nint(h * i), i < n ? nint(b * (i - 1)) + "–" + nint(b * i) : "этаж", i < n ? "ступень" : "пол 2-го этажа"]);
      return {
        stats: [S("Подъёмов", nint(n), "шт.", "ступеней (проступей): " + treads), S("Высота ступени h", nf(h, 1), "мм"), S("Проступь b", nint(b), "мм", "2h + b = " + nint(blond) + " мм", true), S("Угол / длина в плане", nf(ang, 1) + "° · " + nf(run / 1000, 2), "м"), S("Проём в перекрытии, длина", "≥ " + nint(open), "мм", "косоур ≈ " + nf(str / 1000, 2) + " м")],
        table: { cap: "Разметка: высота каждой проступи от чистого пола и её положение по горизонтали от первой ступени", head: ["№", "Высота, мм", "По горизонтали, мм", ""], rows },
        extra: [["Длина косоура (по линии ступеней)", nf(str / 1000, 2) + " м"], ["Минимальная длина проёма в перекрытии", nint(open) + " мм"], ["Ширина проёма", "≥ " + nint(v.w + 100) + " мм"]],
        warn: warn.join(" "),
        items: [["Ступени (проступи) " + nint(b + 30) + "×" + nint(v.w), treads, "шт."], ["Косоур / тетива ≈ " + nf(str / 1000, 2) + " м", 2, "шт."]]
      };
    },
    info: "Формула Блонделя: 2h + b = 600–650 мм (шаг человека). Последний подъём выходит на пол второго этажа, поэтому проступей на одну меньше, чем подъёмов. Проём рассчитан так, чтобы над любой ступенью оставалась заданная высота прохода. Проступь к закупке — с нависанием 30 мм."
  });

  // ---------- Пиломатериал ----------
  add({
    id: "lumber", cat: "struct", name: "Пиломатериал: штуки ↔ кубы", kw: "доска брус куб кубометр штук в кубе пиломатериал лес цена вагонка",
    desc: "Сколько досок в кубе, объём партии и цена за штуку",
    inputs: [
      { k: "b", label: "Толщина, мм", def: 50 }, { k: "h", label: "Ширина, мм", def: 150 }, { k: "l", label: "Длина, м", def: 6 },
      { k: "mode", label: "Известно", type: "sel", def: "n", opts: [["n", "количество штук"], ["v", "объём, м³"]] },
      { k: "n", label: "Количество, шт.", def: 40, show: v => v.mode === "n" },
      { k: "v", label: "Объём, м³", def: 2, show: v => v.mode === "v" },
      { k: "price", label: "Цена за м³, ₽", def: 0, hint: "Необязательно" }
    ],
    run(v) {
      const one = v.b / 1000 * v.h / 1000 * v.l, perM3 = one > 0 ? 1 / one : 0;
      const n = v.mode === "n" ? v.n : Math.floor(v.v * perM3 + 1e-9);
      const V = n * one;
      const st = [S("Объём одной", nf(one, 4), "м³"), S("Штук в 1 м³", nf(perM3, 1), "шт."), S(v.mode === "n" ? "Объём партии" : "Штук в " + nf(v.v, 2) + " м³", v.mode === "n" ? nf(V, 3) : nint(n), v.mode === "n" ? "м³" : "шт.", v.mode === "n" ? "" : "= " + nf(V, 3) + " м³", true),
        S("Погонаж / площадь", nint(n * v.l), "м", "покрывает " + nf(n * v.l * v.h / 1000, 1) + " м²")];
      if (v.price > 0) st.push(S("Цена", nint(v.price * one), "₽/шт.", "партия " + nint(v.price * V) + " ₽"));
      return { stats: st, items: [["Пиломатериал " + v.b + "×" + v.h + "×" + nf(v.l, 1) + " м", n, "шт."]] };
    }
  });

  // ---------- Деревянная балка ----------
  add({
    id: "beam", cat: "tech", mark: "прочность + прогиб", name: "Деревянная балка перекрытия", kw: "балка лага перекрытие прогиб пролет сечение доска брус нагрузка несущая способность стропило",
    desc: "Проверка сечения по прочности и прогибу, подбор высоты",
    inputs: [
      { k: "L", label: "Пролёт в свету, м", def: 4.5 },
      { k: "s", label: "Шаг балок, мм", def: 600 },
      { k: "b", label: "Ширина сечения, мм", def: 50 },
      { k: "h", label: "Высота сечения, мм", def: 200 },
      { k: "use", label: "Назначение", type: "sel", def: "1.5", opts: [["1.5", "Жилое помещение (1,5 кПа)"], ["0.7", "Неэксплуатируемый чердак (0,7 кПа)"], ["2", "Терраса, балкон (2,0 кПа)"], ["3", "Офис, мастерская (3,0 кПа)"]] },
      { k: "g", label: "Собственный вес пола и потолка, кПа", def: 1.0, hint: "≈ 1 кПа = 100 кг/м² (утеплитель, полы, подшивка)" },
      { k: "R", label: "Древесина", type: "sel", def: "13", opts: [["14", "Сосна/ель 1 сорт"], ["13", "Сосна/ель 2 сорт"], ["8.5", "Сосна/ель 3 сорт"]] },
      { k: "lim", label: "Допустимый прогиб", type: "sel", def: "250", opts: [["200", "L/200"], ["250", "L/250"], ["300", "L/300 (под плитку)"]] }
    ],
    run(v) {
      const s = v.s / 1000, p = num(v.use), R = num(v.R), E = 10000;
      const qn = (v.g + p) * s, qd = (v.g * 1.1 + p * 1.3) * s; // кН/м
      const check = (b, h) => {
        const W = b * h * h / 6, I = b * h ** 3 / 12; // мм3, мм4
        const M = qd * v.L * v.L / 8 * 1e6; // Н·мм
        const sig = M / W;
        const f = 5 * qn * (v.L * 1000) ** 4 / (384 * E * I); // qn кН/м = Н/мм
        const fl = v.L * 1000 / num(v.lim);
        return { sig, f, fl, ks: sig / R, kf: f / fl };
      };
      const c = check(v.b, v.h);
      let hmin = null;
      for (let h = 100; h <= 400; h += 25) { const t = check(v.b, h); if (t.ks <= 1 && t.kf <= 1) { hmin = h; break; } }
      const ok = c.ks <= 1 && c.kf <= 1;
      return {
        stats: [S("Прочность", nint(c.ks * 100), "%", "σ = " + nf(c.sig, 1) + " из " + nf(R, 1) + " МПа", c.ks <= 1), S("Прогиб", nf(c.f, 1), "мм", "допустимо " + nf(c.fl, 1) + " мм · " + nint(c.kf * 100) + "%", c.kf <= 1), S("Вывод", ok ? "проходит" : "не проходит", ""), S("Мин. высота при b = " + v.b, hmin ? String(hmin) : "> 400", "мм")],
        warn: ok ? "" : "Сечение " + v.b + "×" + v.h + " не проходит" + (c.ks > 1 ? " по прочности" : "") + (c.kf > 1 ? (c.ks > 1 ? " и" : "") + " по прогибу" : "") + ". Увеличьте высоту, уменьшите шаг или поставьте опору.",
        table: { head: ["Параметр", "Значение"], rows: [["Нормативная погонная нагрузка", nf(qn, 2) + " кН/м (" + nint(qn * 100) + " кг/м)"], ["Расчётная погонная нагрузка", nf(qd, 2) + " кН/м"], ["Изгибающий момент", nf(qd * v.L * v.L / 8, 2) + " кН·м"]] }
      };
    },
    info: "Шарнирно опёртая балка, равномерная нагрузка. Коэффициенты надёжности: 1,1 для собственного веса и 1,3 для полезной нагрузки. Модуль упругости древесины 10 000 МПа, расчётное сопротивление изгибу — по сорту (СП 64.13330, без коэффициентов условий работы). Не учитываются сосредоточенные нагрузки (перегородки, ванна, печь), ослабления и влажная древесина. Для ответственных случаев — расчёт конструктора."
  });

  // ---------- Штукатурка ----------
  add({
    id: "plaster", cat: "finish", mark: "по замерам", name: "Штукатурка стен", kw: "штукатурка ротбанд гипсовая цементная маяки слой выравнивание стен смесь мешки",
    desc: "Средний слой по замерам отклонений, мешки смеси и маяки",
    inputs: [
      { k: "A", label: "Площадь стен, м²", def: 40 },
      { k: "H", label: "Высота стен, м", def: 2.7 },
      { k: "mode", label: "Толщина слоя", type: "sel", def: "avg", opts: [["avg", "знаю средний слой"], ["meas", "по замерам отклонений"]] },
      { k: "t", label: "Средний слой, мм", def: 15, show: v => v.mode === "avg" },
      { k: "m", label: "Замеры от шнура/правила до стены, мм", type: "list", def: "20 35 12 28 40 18 25", show: v => v.mode === "meas", hint: "Через пробел. Чем больше точек — тем точнее" },
      { k: "tmin", label: "Минимальный слой над выступом, мм", def: 6, show: v => v.mode === "meas", hint: "С учётом маяка 6 мм" },
      { k: "mix", label: "Смесь", type: "sel", def: "g", opts: [["g", "Гипсовая (≈ 8,5 кг/м²·мм, мешок 30 кг)"], ["c", "Цементная (≈ 17 кг/м²·мм, мешок 25 кг)"], ["ci", "Цементно-известковая (≈ 15 кг/м²·мм, мешок 25 кг)"]] },
      { k: "res", label: "Запас, %", def: 5 }
    ],
    run(v) {
      let t = v.t, extra = [];
      if (v.mode === "meas") {
        const m = v.m;
        if (!m.length) return { warn: "Введите замеры." };
        const mn = Math.min(...m), mx = Math.max(...m), avg = m.reduce((s, x) => s + x, 0) / m.length;
        t = avg - mn + v.tmin;
        extra = [["Замеров", nint(m.length)], ["Перепад стены", nint(mx - mn) + " мм"], ["Слой в самой глубокой точке", nint(mx - mn + v.tmin) + " мм"]];
      }
      const [rate, bag] = { g: [8.5, 30], c: [17, 25], ci: [15, 25] }[v.mix];
      const kg = v.A * t * rate * (1 + v.res / 100), bags = ceil(kg / bag);
      const beac = v.H > 0 ? ceil(v.A / v.H / 1.5) + 1 : 0, beacPcs = beac * ceil(v.H / 3);
      const warn = t > 50 ? "Слой больше 50 мм — нужна армирующая сетка или выравнивание в два захода, либо ГКЛ." : "";
      return {
        stats: [S("Средний слой", nf(t, 1), "мм"), S("Смеси", nint(kg), "кг", "", false), S("Мешков", nint(bags), "шт.", "по " + bag + " кг", true), S("Маяков по 3 м", nint(beacPcs), "шт.", "шаг ≈ 1,5 м")],
        table: extra.length ? { head: ["Параметр", "Значение"], rows: extra } : null, warn,
        items: [[{ g: "Штукатурка гипсовая", c: "Штукатурка цементная", ci: "Штукатурка цементно-известковая" }[v.mix] + ", мешок " + bag + " кг", bags, "меш."], ["Маяк штукатурный 6 мм, 3 м", beacPcs, "шт."]]
      };
    },
    info: "Как мерить: натяните шнур или приложите длинное правило, выставленное по отвесу, и замерьте расстояние до стены в 6–15 точках. Слой в каждой точке = замер − минимальный замер + минимальный слой. Средний слой умножается на площадь и расход смеси на 1 мм."
  });

  // ---------- Стяжка ----------
  add({
    id: "screed", cat: "finish", mark: "по замерам", name: "Стяжка пола", kw: "стяжка пол цпс пескобетон м150 полусухая фибра демпферная лента высыхание уровень нивелир толщина",
    desc: "Толщина по замерам нивелира, смесь, фибра, лента и время высыхания",
    inputs: [
      { k: "A", label: "Площадь пола, м²", def: 20 },
      { k: "P", label: "Периметр помещения, м", def: 18 },
      { k: "mode", label: "Толщина", type: "sel", def: "avg", opts: [["avg", "знаю среднюю толщину"], ["meas", "по замерам нивелира"]] },
      { k: "t", label: "Средняя толщина, мм", def: 50, show: v => v.mode === "avg" },
      { k: "m", label: "Замеры от линии лазера до пола, мм", type: "list", def: "1012 1025 1031 1018 1040 1022", show: v => v.mode === "meas", hint: "Чем больше число — тем ниже пол в этой точке" },
      { k: "tmin", label: "Минимальная толщина, мм", def: 30, show: v => v.mode === "meas", hint: "Над самой высокой точкой" },
      { k: "mix", label: "Материал", type: "sel", def: "dry", opts: [["dry", "Готовая смесь (пескобетон/ЦПС), ≈ 2 кг/м²·мм"], ["self", "Самозамес Ц:П = 1:3 на ПЦ М500"]] },
      { k: "bag", label: "Мешок смеси, кг", def: 40, show: v => v.mix === "dry" },
      { k: "fib", label: "Добавлять фибру", type: "check", def: true }
    ],
    run(v) {
      let t = v.t, extra = [];
      if (v.mode === "meas") {
        const m = v.m;
        if (!m.length) return { warn: "Введите замеры." };
        const mn = Math.min(...m), mx = Math.max(...m), avg = m.reduce((s, x) => s + x, 0) / m.length;
        t = avg - mn + v.tmin;
        extra = [["Перепад пола", nint(mx - mn) + " мм"], ["Толщина в самой низкой точке", nint(mx - mn + v.tmin) + " мм"], ["Отметка чистовой стяжки", "линия лазера − " + nint(mn - v.tmin) + " мм"]];
      }
      const V = v.A * t / 1000;
      const items = [], st = [S("Средняя толщина", nf(t, 0), "мм"), S("Объём раствора", nf(V, 2), "м³")];
      if (v.mix === "dry") {
        const kg = v.A * t * 2 * 1.05, bags = ceil(kg / v.bag);
        st.push(S("Смеси", nint(bags), "меш.", nint(kg) + " кг · по " + v.bag + " кг", true));
        items.push(["Пескобетон / ЦПС М150, мешок " + v.bag + " кг", bags, "меш."]);
      } else {
        const cem = V * 1.05 * 480, sand = V * 1.05 * 1.1;
        st.push(S("Цемент / песок", nint(ceil(cem / 50)) + " меш.", "", "≈ " + nint(cem) + " кг · песок " + nf(sand, 2) + " м³", true));
        items.push(["Цемент ПЦ М500, мешок 50 кг", ceil(cem / 50), "меш."], ["Песок", Math.round(sand * 100) / 100, "м³"]);
      }
      const days = Math.round(7 * Math.min(t, 40) / 10 + 14 * Math.max(0, t - 40) / 10);
      st.push(S("Высыхание до укладки покрытия", "≈ " + days, "сут", "при +20 °C, без сквозняков"));
      items.push(["Демпферная лента", Math.round(v.P * 1.05 * 10) / 10, "м"]);
      if (v.fib) { const f = Math.max(0.1, V * 0.8); items.push(["Фибра полипропиленовая", Math.round(f * 10) / 10, "кг"]); extra.push(["Фибра (0,6–0,9 кг/м³)", nf(f, 1) + " кг"]); }
      extra.push(["Демпферная лента", nf(v.P * 1.05, 1) + " м"]);
      return {
        stats: st, table: { head: ["Параметр", "Значение"], rows: extra },
        warn: t < 30 ? "Стяжка тоньше 30 мм по плёнке или утеплителю трескается — используйте наливной пол или сделайте ≥ 40 мм." : "",
        items
      };
    },
    info: "Высыхание: ориентир — неделя на каждый сантиметр до 4 см и около двух недель на каждый следующий сантиметр. Под паркет и ламинат проверяйте влажность основания (обычно не более 2–4%)."
  });

  // ---------- Плитка ----------
  add({
    id: "tile", cat: "finish", name: "Плитка, клей и затирка", kw: "плитка керамогранит кафель клей затирка шов шпатель раскладка диагональ ванная санузел",
    desc: "Плитка в штуках и коробках, клей по зубу шпателя, затирка по шву",
    inputs: [
      { k: "A", label: "Площадь, м²", def: 12 },
      { k: "a", label: "Плитка: длина, мм", def: 600 }, { k: "b", label: "Плитка: ширина, мм", def: 300 }, { k: "th", label: "Толщина плитки, мм", def: 9 },
      { k: "j", label: "Шов, мм", def: 2 },
      { k: "lay", label: "Раскладка", type: "sel", def: "10", opts: [["7", "Прямая (+7%)"], ["10", "Со смещением / кирпичик (+10%)"], ["15", "Диагональ, ёлочка (+15%)"]] },
      { k: "box", label: "В коробке, м²", def: 1.44 },
      { k: "notch", label: "Зуб шпателя, мм", type: "sel", def: "8", opts: [["6", "6 мм (мелкая плитка)"], ["8", "8 мм (до 30×30)"], ["10", "10 мм (до 60×60)"], ["12", "12 мм (крупный формат)"]] }
    ],
    run(v) {
      const k = 1 + num(v.lay) / 100, tile = v.a * v.b / 1e6;
      const n = tile > 0 ? ceil(v.A * k / tile) : 0, boxes = v.box > 0 ? ceil(v.A * k / v.box) : 0;
      const glueRate = { 6: 2.7, 8: 3.5, 10: 4.2, 12: 5.2 }[v.notch];
      const glue = v.A * glueRate * 1.05, gBags = ceil(glue / 25);
      const groutRate = v.a > 0 && v.b > 0 ? (v.a + v.b) / (v.a * v.b) * v.th * v.j * 1.6 : 0;
      const grout = v.A * groutRate * 1.1;
      return {
        stats: [S("Плиток", nint(n), "шт.", "с запасом " + v.lay + "%"), S("Коробок", nint(boxes), "шт.", nf(boxes * v.box, 2) + " м²", true), S("Клей", nint(gBags), "меш. 25 кг", "≈ " + nf(glueRate, 1) + " кг/м² · " + nint(glue) + " кг"), S("Затирка", nf(grout, 1), "кг", nf(groutRate, 2) + " кг/м²")],
        items: [["Плитка " + v.a + "×" + v.b, boxes, "кор."], ["Плиточный клей, мешок 25 кг", gBags, "меш."], ["Затирка", Math.round(grout * 10) / 10, "кг"]]
      };
    },
    info: "Затирка: (A + B) / (A × B) × толщина × шов × 1,6 кг/м² (+10%). Клей — для цементных клеёв при нанесении на основание; при двойном нанесении (основание + плитка, крупный формат) добавьте 30–50%."
  });

  // ---------- Обои ----------
  add({
    id: "wallpaper", cat: "finish", name: "Обои", kw: "обои рулоны раппорт полосы комната флизелин",
    desc: "Рулоны с учётом раппорта и высоты потолка",
    inputs: [
      { k: "a", label: "Длина комнаты, м", def: 5 }, { k: "b", label: "Ширина комнаты, м", def: 4 }, { k: "H", label: "Высота стен, м", def: 2.7 },
      { k: "doors", label: "Дверей (0,9 м)", def: 1 }, { k: "wins", label: "Окон (1,5 м)", def: 1 },
      { k: "w", label: "Ширина рулона, м", type: "sel", def: "1.06", opts: [["0.53", "0,53 м"], ["0.7", "0,70 м"], ["1.06", "1,06 м"]] },
      { k: "rl", label: "Длина рулона, м", def: 10.05 },
      { k: "rap", label: "Раппорт, см", def: 0, hint: "0 — без подбора рисунка" }
    ],
    run(v) {
      const w = num(v.w), P = 2 * (v.a + v.b);
      const free = Math.max(0, P - v.doors * 0.9 - v.wins * 1.5 * 0.6); // над/под окнами — короткие полосы
      const strips = w > 0 ? ceil(free / w) : 0;
      const r = v.rap / 100;
      const stripLen = r > 0 ? ceil((v.H + 0.05) / r) * r : v.H + 0.1;
      const per = stripLen > 0 ? Math.floor(v.rl / stripLen + 1e-9) : 0;
      const rolls = per > 0 ? ceil(strips / per) : 0;
      return {
        stats: [S("Полос", nint(strips), "шт.", "длиной " + nf(stripLen, 2) + " м"), S("Полос из рулона", nint(per), "шт.", per ? "отход " + nf(v.rl - per * stripLen, 2) + " м с рулона" : "рулон короче полосы"), S("Рулонов", nint(rolls), "шт.", "+1 в запас из той же партии", true), S("Площадь стен", nf(P * v.H, 1), "м²")],
        warn: per === 0 ? "Полоса длиннее рулона — проверьте высоту и длину рулона." : "",
        items: [["Обои " + nf(w, 2) + " × " + nf(v.rl, 2) + " м", rolls + 1, "рул."]]
      };
    },
    info: "Окна учтены частично (над и под ними клеятся короткие полосы), двери вычитаются целиком. Берите рулоны из одной партии — номер партии указан на этикетке."
  });

  // ---------- Краска ----------
  add({
    id: "paint", cat: "finish", mark: "подбор банок", name: "Краска и грунт", kw: "краска покраска грунт грунтовка банки литры расход слои потолок стены",
    desc: "Литры краски и оптимальный набор банок без лишних остатков",
    inputs: [
      { k: "A", label: "Площадь, м²", def: 60 }, { k: "c", label: "Слоёв", def: 2 },
      { k: "cov", label: "Расход: м² с 1 литра за слой", def: 8, hint: "На банке: «8–10 м²/л»" },
      { k: "cans", label: "Объёмы банок, л", def: "9 2,7 0,9", type: "text", hint: "Через пробел" },
      { k: "pr", label: "Считать грунт", type: "check", def: true }
    ],
    run(v) {
      const need = v.cov > 0 ? v.A * v.c / v.cov * 1.05 : 0;
      const sizes = String(v.cans).split(/[\s;]+/).map(num).filter(x => x > 0).sort((a, b) => b - a).slice(0, 4);
      let best = null;
      if (sizes.length) {
        const lim = sizes.map(s => ceil(need / s) + 1);
        const rec = (i, cur, vol, cnt) => {
          if (i === sizes.length) { if (vol >= need - 1e-9 && (!best || vol < best.vol - 1e-9 || (Math.abs(vol - best.vol) < 1e-9 && cnt < best.cnt))) best = { vol, cnt, combo: cur.slice() }; return; }
          for (let k = 0; k <= lim[i]; k++) { cur.push(k); rec(i + 1, cur, vol + k * sizes[i], cnt + k); cur.pop(); if (vol + k * sizes[i] >= need) break; }
        };
        rec(0, [], 0, 0);
      }
      const combo = best ? best.combo.map((k, i) => k ? k + " × " + nf(sizes[i], sizes[i] % 1 ? 1 : 0) + " л" : "").filter(Boolean).join(" + ") : "—";
      const primer = v.pr ? v.A * 0.12 : 0;
      const items = best ? best.combo.map((k, i) => k ? ["Краска, банка " + nf(sizes[i], sizes[i] % 1 ? 1 : 0) + " л", k, "шт."] : null).filter(Boolean) : [];
      if (v.pr) items.push(["Грунтовка", Math.round(primer * 10) / 10, "л"]);
      return {
        stats: [S("Краски нужно", nf(need, 1), "л", "с запасом 5%"), S("Купить", combo, "", best ? "всего " + nf(best.vol, 1) + " л, остаток " + nf(best.vol - need, 1) + " л" : "", true), ...(v.pr ? [S("Грунтовки", nf(primer, 1), "л", "≈ 0,1–0,15 л/м²")] : [])],
        items
      };
    },
    info: "Подбор банок перебирает все сочетания указанных объёмов и выбирает то, где меньше всего остаётся, а при равенстве — меньше банок. Первый слой по пористому основанию расходуется сильнее."
  });

  // ---------- Ламинат ----------
  add({
    id: "floor", cat: "finish", name: "Ламинат, плинтус, подложка", kw: "ламинат паркетная доска кварцвинил spc линолеум плинтус подложка пол упаковки порожек",
    desc: "Упаковки покрытия, плинтус в планках, подложка, порожки",
    inputs: [
      { k: "a", label: "Длина комнаты, м", def: 5 }, { k: "b", label: "Ширина комнаты, м", def: 4 },
      { k: "pack", label: "В упаковке, м²", def: 2.131 },
      { k: "lay", label: "Раскладка", type: "sel", def: "5", opts: [["5", "Прямая (+5%)"], ["10", "Сложная комната (+10%)"], ["15", "Диагональ, ёлочка (+15%)"]] },
      { k: "d", label: "Дверных проёмов", def: 1 }, { k: "dw", label: "Ширина проёма, м", def: 0.8 },
      { k: "pl", label: "Длина планки плинтуса, м", def: 2.5 }, { k: "ur", label: "Подложка в рулоне, м²", def: 10 }
    ],
    run(v) {
      const A = v.a * v.b, k = 1 + num(v.lay) / 100;
      const packs = v.pack > 0 ? ceil(A * k / v.pack) : 0;
      const plinth = Math.max(0, 2 * (v.a + v.b) - v.d * v.dw), pcs = v.pl > 0 ? ceil(plinth * 1.05 / v.pl) : 0;
      const under = v.ur > 0 ? ceil(A * 1.05 / v.ur) : 0;
      return {
        stats: [S("Площадь пола", nf(A, 2), "м²"), S("Упаковок", nint(packs), "шт.", nf(packs * v.pack, 2) + " м²", true), S("Плинтус", nint(pcs), "планок", nf(plinth, 1) + " м · углов ≈ " + 4), S("Подложка", nint(under), "рул.")],
        items: [["Напольное покрытие, упаковка " + nf(v.pack, 3) + " м²", packs, "уп."], ["Плинтус " + nf(v.pl, 1) + " м", pcs, "шт."], ["Подложка, рулон " + nf(v.ur, 0) + " м²", under, "рул."], ["Порожек", v.d, "шт."]]
      };
    },
    info: "Перед укладкой покрытие 48 часов акклиматизируется в помещении. Вдоль стен оставляйте компенсационный зазор 8–10 мм — его закрывает плинтус."
  });

  // ---------- ГКЛ перегородка ----------
  add({
    id: "gkl", cat: "finish", name: "Перегородка из гипсокартона", kw: "гипсокартон гкл перегородка профиль пн пс каркас саморезы серпянка knauf гвл",
    desc: "Листы, профили ПН/ПС, саморезы, дюбели, лента и шпаклёвка",
    inputs: [
      { k: "L", label: "Длина перегородки, м", def: 4 }, { k: "H", label: "Высота, м", def: 2.7 },
      { k: "lay", label: "Слоёв ГКЛ с каждой стороны", type: "sel", def: "1", opts: [["1", "1 слой"], ["2", "2 слоя"]] },
      { k: "sh", label: "Лист", type: "sel", def: "3", opts: [["2.5", "1200 × 2500"], ["2.7", "1200 × 2700"], ["3", "1200 × 3000"]] },
      { k: "st", label: "Шаг стоек, мм", type: "sel", def: "600", opts: [["600", "600"], ["400", "400 (под плитку)"]] },
      { k: "doors", label: "Дверных проёмов", def: 1 },
      { k: "ins", label: "Звукоизоляция минватой", type: "check", def: true }
    ],
    run(v) {
      const A = v.L * v.H, layers = num(v.lay), shA = 1.2 * num(v.sh);
      const sheets = ceil(A * 2 * layers / shA * 1.1);
      const studs = ceil(v.L / (num(v.st) / 1000)) + 1 + v.doors * 2;
      const studLen = studs * v.H, pn = 2 * v.L + v.doors * 1.2;
      const studPcs = ceil(studLen / 3 * (v.H > 3 ? 1.1 : 1)), pnPcs = ceil(pn / 3);
      const screws = ceil(A * 2 * layers * 25), dowels = ceil(pn / 0.5);
      const items = [["ГКЛ 1200×" + Math.round(num(v.sh) * 1000), sheets, "лист."], ["Профиль ПС 50/75/100, 3 м", studPcs, "шт."], ["Профиль ПН 50/75/100, 3 м", pnPcs, "шт."], ["Саморезы TN 25/35", screws, "шт."], ["Дюбель-гвоздь 6×40", dowels, "шт."], ["Лента серпянка", Math.round(A * 2 * 1.2), "м"], ["Шпаклёвка для швов", Math.round(A * 2 * 0.35), "кг"]];
      if (v.ins) items.push(["Минвата акустическая", Math.round(A * 1.05 * 10) / 10, "м²"]);
      return {
        stats: [S("Листов ГКЛ", nint(sheets), "шт.", "+10% на подрезку", true), S("Стоек ПС", nint(studs), "шт.", nint(studPcs) + " профилей по 3 м"), S("Направляющий ПН", nf(pn, 1), "м", nint(pnPcs) + " профилей по 3 м"), S("Саморезов", nint(screws), "шт.")],
        table: { head: ["Позиция", "Количество"], rows: items.map(i => [i[0], nint(i[1]) + " " + i[2]]) },
        items
      };
    },
    info: "Проёмы не вычитаются из листов (обрезки идут на подрезку). У дверей ставятся сдвоенные или усиленные стойки — учтены по 2 на проём. Перемычка над дверью — из ПН."
  });

  // ---------- Утеплитель ----------
  add({
    id: "insul", cat: "finish", name: "Утеплитель и мокрый фасад", kw: "утеплитель минвата пенопласт пеноплэкс эппс фасад мокрый дюбель грибок клей сетка теплоизоляция",
    desc: "Упаковки утеплителя, а для фасада — дюбели, клей и сетка",
    inputs: [
      { k: "A", label: "Площадь, м²", def: 100 },
      { k: "t", label: "Толщина утепления, мм", def: 100 },
      { k: "pt", label: "Толщина плиты в упаковке, мм", def: 50 },
      { k: "pa", label: "Площадь в упаковке, м²", def: 2.88, hint: "При этой толщине плит" },
      { k: "mat", label: "Материал", type: "sel", def: "mw", opts: [["mw", "Минвата"], ["eps", "Пенополистирол / ЭППС"]] },
      { k: "wet", label: "Мокрый фасад (дюбели, клей, сетка)", type: "check", def: false }
    ],
    run(v) {
      const layers = v.pt > 0 ? ceil(v.t / v.pt) : 0;
      const packs = v.pa > 0 ? ceil(v.A * layers / v.pa * 1.05) : 0;
      const V = v.A * v.t / 1000;
      const st = [S("Объём", nf(V, 2), "м³"), S("Слоёв по " + v.pt + " мм", nint(layers), ""), S("Упаковок", nint(packs), "шт.", "+5% на подрезку", true)];
      const items = [[(v.mat === "mw" ? "Минвата " : "ЭППС ") + v.pt + " мм, уп. " + nf(v.pa, 2) + " м²", packs, "уп."]];
      if (v.wet) {
        const dow = ceil(v.A * (v.mat === "mw" ? 6 : 5) * 1.05), glue = v.A * (v.mat === "mw" ? 5 : 4), base = v.A * 5, mesh = v.A * 1.15;
        st.push(S("Дюбелей-грибков", nint(dow), "шт.", "длина ≥ " + nint(v.t + 60) + " мм"));
        items.push(["Дюбель тарельчатый " + nint(v.t + 60) + " мм", dow, "шт."], ["Клей для утеплителя, 25 кг", ceil(glue / 25), "меш."], ["Базовый армирующий состав, 25 кг", ceil(base / 25), "меш."], ["Сетка фасадная 160 г/м²", Math.round(mesh), "м²"]);
      }
      return { stats: st, items, table: v.wet ? { head: ["Позиция", "Количество"], rows: items.map(i => [i[0], nint(i[1]) + " " + i[2]]) } : null };
    },
    info: "Слои ставят с разбежкой швов. Длина дюбеля = толщина утеплителя + клей + заглубление в основание (обычно ≥ 50 мм в кирпич и бетон, ≥ 90 мм в газобетон)."
  });

  // ---------- Уклон ----------
  add({
    id: "slope", cat: "tech", name: "Уклон: градусы, %, мм/м", kw: "уклон градусы проценты промилле перепад канализация отмостка пандус кровля мм на метр 1:n",
    desc: "Перевод уклона между единицами и перепад на длине",
    inputs: [
      { k: "u", label: "Единица", type: "sel", def: "pct", opts: [["pct", "проценты, %"], ["deg", "градусы, °"], ["mm", "мм на метр"], ["n", "1 : n"]] },
      { k: "x", label: "Значение", def: 2 },
      { k: "L", label: "Длина участка, м", def: 6 }
    ],
    run(v) {
      let t; // tan
      if (v.u === "pct") t = v.x / 100; else if (v.u === "deg") t = Math.tan(rad(v.x)); else if (v.u === "mm") t = v.x / 1000; else t = v.x > 0 ? 1 / v.x : 0;
      return {
        stats: [S("Проценты", nf(t * 100, 2), "%"), S("Градусы", nf(deg(Math.atan(t)), 2), "°"), S("На метр", nf(t * 1000, 1), "мм/м"), S("Перепад на " + nf(v.L, 1) + " м", nint(t * v.L * 1000), "мм", "соотношение 1 : " + (t ? nf(1 / t, 1) : "∞"), true)],
        table: { cap: "Частые нормы (проверяйте по проекту)", head: ["Где", "Уклон"], rows: [["Канализация Ø40–50 мм", "0,025–0,03 (25–30 мм/м)"], ["Канализация Ø100–110 мм", "0,02 (20 мм/м)"], ["Наружная канализация Ø110", "не менее 0,02"], ["Отмостка", "1–10% от стены"], ["Пандус для маломобильных", "не более 5% (1:20)"], ["Балкон, терраса", "1–2% от стены"]] }
      };
    }
  });

  // ---------- Металл ----------
  add({
    id: "metal", cat: "tech", name: "Масса металлопроката", kw: "вес металл масса труба профильная лист уголок полоса круг арматура швеллер кг метр погонный",
    desc: "Вес трубы, профтрубы, листа, уголка, полосы и круга",
    inputs: [
      { k: "type", label: "Прокат", type: "sel", def: "prof", opts: [["round", "Круг / арматура"], ["pipe", "Труба круглая"], ["prof", "Труба профильная"], ["angle", "Уголок равнополочный"], ["strip", "Полоса"], ["sheet", "Лист"]] },
      { k: "d", label: "Диаметр, мм", def: 12, show: v => v.type === "round" },
      { k: "D", label: "Наружный диаметр, мм", def: 57, show: v => v.type === "pipe" },
      { k: "a", label: v => v.type === "angle" ? "Полка, мм" : v.type === "strip" ? "Ширина, мм" : "Сторона A, мм", def: 60, show: v => ["prof", "angle", "strip"].includes(v.type) },
      { k: "b", label: "Сторона B, мм", def: 40, show: v => v.type === "prof" },
      { k: "s", label: "Толщина стенки, мм", def: 3, show: v => v.type !== "round" },
      { k: "sw", label: "Лист: ширина, м", def: 1.25, show: v => v.type === "sheet" },
      { k: "sl", label: "Лист: длина, м", def: 2.5, show: v => v.type === "sheet" },
      { k: "L", label: v => v.type === "sheet" ? "Листов, шт." : "Общая длина, м", def: 12 }
    ],
    run(v) {
      const r = 7.85e-3; let kgm = 0, note = "";
      if (v.type === "round") kgm = Math.PI * v.d * v.d / 4 * r;
      if (v.type === "pipe") kgm = Math.PI * (v.D - v.s) * v.s * r;
      if (v.type === "prof") { kgm = (2 * (v.a + v.b) - 4 * v.s) * v.s * r; note = "без учёта скругления углов (≈ −2%)"; }
      if (v.type === "angle") kgm = v.s * (2 * v.a - v.s) * r;
      if (v.type === "strip") kgm = v.a * v.s * r;
      if (v.type === "sheet") { const one = v.sw * v.sl * v.s * 7.85; return { stats: [S("Масса листа", nf(one, 1), "кг", nf(v.s * 7.85, 2) + " кг/м²"), S("Всего", nf(one * v.L, 1), "кг", nf(one * v.L / 1000, 3) + " т", true)] }; }
      return { stats: [S("Масса 1 м", nf(kgm, 3), "кг/м", note), S("Всего", nf(kgm * v.L, 1), "кг", nf(kgm * v.L / 1000, 3) + " т", true), S("Метров в тонне", kgm ? nf(1000 / kgm, 1) : "—", "м")] };
    },
    info: "Плотность стали 7850 кг/м³. Масса по формулам геометрии, ГОСТ-овские значения для уголка и профтрубы немного меньше из-за скруглений."
  });

  // ---------- Земляные работы ----------
  const SOILS = { sand: ["Песок", 1.6, 1.12, [0.5, 1]], sandy: ["Супесь", 1.65, 1.15, [0.25, 0.67]], loam: ["Суглинок", 1.75, 1.24, [0, 0.5]], clay: ["Глина", 1.8, 1.28, [0, 0.25]], fill: ["Насыпной грунт", 1.6, 1.1, [0.67, 1]] };
  add({
    id: "earth", cat: "found", name: "Котлован и траншея", kw: "котлован траншея земляные работы грунт откос разрыхление вывоз камаз самосвал копка объем земли",
    desc: "Объём выемки с откосами, грунт в разрыхлении и рейсы самосвала",
    inputs: [
      { k: "type", label: "Выемка", type: "sel", def: "pit", opts: [["pit", "Котлован"], ["trench", "Траншея"]] },
      { k: "L", label: "Длина по дну, м", def: 12 }, { k: "W", label: "Ширина по дну, м", def: 10 }, { k: "H", label: "Глубина, м", def: 1.8 },
      { k: "soil", label: "Грунт", type: "sel", def: "loam", opts: Object.entries(SOILS).map(([k, s]) => [k, s[0]]) },
      { k: "slope", label: "Откосы", type: "sel", def: "auto", opts: [["auto", "по нормам для грунта"], ["0", "вертикальные стенки (крепление)"]] },
      { k: "truck", label: "Самосвал, м³ кузова", def: 10 }
    ],
    run(v) {
      const s = SOILS[v.soil], m = v.slope === "0" ? 0 : (v.H <= 1.5 ? s[3][0] : s[3][1]);
      let V;
      if (v.type === "trench") V = (v.W + m * v.H) * v.H * v.L;
      else { const A1 = v.L * v.W, A2 = (v.L + 2 * m * v.H) * (v.W + 2 * m * v.H), Am = (v.L + m * v.H) * (v.W + m * v.H); V = v.H / 6 * (A1 + A2 + 4 * Am); }
      const loose = V * s[2], trips = v.truck > 0 ? ceil(loose / v.truck) : 0;
      const warn = (m === 0 && v.H > (v.soil === "sand" || v.soil === "fill" ? 1 : 1.5)) ? "При такой глубине вертикальные стенки без крепления недопустимы (СНиП 12-04): нужны откосы или крепление." : "";
      return {
        stats: [S("Объём в плотном теле", nf(V, 1), "м³"), S("В разрыхлении (вывоз)", nf(loose, 1), "м³", "Kр = " + nf(s[2], 2), true), S("Рейсов самосвала", nint(trips), "шт.", "по " + nf(v.truck, 0) + " м³"), S("Масса грунта", nf(V * s[1], 0), "т")],
        table: { head: ["Параметр", "Значение"], rows: [["Заложение откоса 1 : m", m ? "1 : " + nf(m, 2) : "вертикально"], ["Размер поверху", nf(v.L + 2 * m * v.H, 2) + " × " + nf((v.type === "trench" ? v.W : v.W) + 2 * m * v.H, 2) + " м"]] },
        warn
      };
    },
    info: "Крутизна откосов — по СНиП 12-04-2002 для глубины до 1,5 и до 3 м. Для котлована объём считается как усечённая пирамида. Обратная засыпка уплотняется: оставьте на месте объём пазух × коэффициент остаточного разрыхления."
  });

  // ---------- Сыпучие ----------
  const BULK = { sand: ["Песок карьерный", 1.5], sandw: ["Песок мытый влажный", 1.65], pgs: ["ПГС", 1.65], g520: ["Щебень гранитный 5–20", 1.37], g2040: ["Щебень гранитный 20–40", 1.38], gr: ["Щебень гравийный", 1.43], scr: ["Отсев", 1.5], soil: ["Грунт растительный", 1.2], keram: ["Керамзит", 0.4], cem: ["Цемент", 1.3] };
  add({
    id: "bulk", cat: "tech", name: "Песок, щебень: м³ ↔ тонны", kw: "песок щебень пгс отсев керамзит тонны кубы насыпная плотность самосвал подсыпка уплотнение доставка",
    desc: "Перевод кубов в тонны, подсыпка по площади и слою, рейсы машины",
    inputs: [
      { k: "mat", label: "Материал", type: "sel", def: "g520", opts: Object.entries(BULK).map(([k, b]) => [k, b[0] + " (" + nf(b[1], 2) + " т/м³)"]) },
      { k: "mode", label: "Известно", type: "sel", def: "area", opts: [["area", "площадь и толщина слоя"], ["m3", "объём, м³"], ["t", "масса, т"]] },
      { k: "A", label: "Площадь, м²", def: 60, show: v => v.mode === "area" }, { k: "h", label: "Слой после уплотнения, см", def: 15, show: v => v.mode === "area" },
      { k: "kc", label: "Коэффициент уплотнения", def: 1.25, show: v => v.mode === "area", hint: "Песок 1,15–1,25 · щебень 1,25–1,3" },
      { k: "V", label: "Объём, м³", def: 10, show: v => v.mode === "m3" }, { k: "T", label: "Масса, т", def: 20, show: v => v.mode === "t" },
      { k: "truck", label: "Машина, т", def: 20 }
    ],
    run(v) {
      const rho = BULK[v.mat][1];
      const V = v.mode === "area" ? v.A * v.h / 100 * v.kc : v.mode === "m3" ? v.V : v.T / rho;
      const T = V * rho;
      return { stats: [S("Объём (насыпной)", nf(V, 2), "м³"), S("Масса", nf(T, 2), "т", "", true), S("Рейсов", nint(v.truck > 0 ? ceil(T / v.truck) : 0), "шт.", "по " + nf(v.truck, 0) + " т")], items: [[BULK[v.mat][0], Math.round(T * 10) / 10, "т"]] };
    },
    info: "Насыпная плотность сильно зависит от влажности и фракции: при заказе уточняйте, в чём продаёт поставщик — в тоннах или в кубах."
  });

  // ---------- Справочник бетона ----------
  const CLS = [["B7,5", "М100", 7.5, "Подбетонка, подготовка под фундамент"], ["B10", "М150", 10, "Подготовка, стяжки, дорожки"], ["B12,5", "М150", 12.5, "Стяжки, отмостка, ненагруженные конструкции"], ["B15", "М200", 15, "Ленточные фундаменты лёгких строений, площадки"], ["B20", "М250", 20, "Фундаменты частных домов, перекрытия малых пролётов"], ["B22,5", "М300", 22.5, "Фундаменты, монолитные стены и перекрытия"], ["B25", "М350", 25, "Монолитные перекрытия, колонны, ростверки"], ["B30", "М400", 30, "Ответственные конструкции, бассейны, мосты"], ["B35", "М450", 35, "Гидротехнические, специальные конструкции"], ["B40", "М550", 40, "Специальные конструкции"]];
  add({
    id: "concref", cat: "tech", name: "Классы и марки бетона", kw: "класс марка бетона м200 м300 b25 мпа прочность кгс справочник таблица",
    desc: "Соответствие B и М, прочность в МПа и кгс/см², где применяют",
    inputs: [],
    run() {
      return { table: { cap: "Средняя прочность для класса — при коэффициенте вариации 13,5%: R = B / 0,778", head: ["Класс", "Марка", "B, МПа", "Средняя, МПа", "≈ кгс/см²", "Где применяют"], rows: CLS.map(c => [c[0], c[1], nf(c[2], 1), nf(c[2] / 0.778, 1), nint(c[2] / 0.778 * 10.197), c[3]]) } };
    }
  });

  // ====================================================================
  //  УЧАСТОК И ФУНДАМЕНТ
  // ====================================================================
  const bar = (pct, cls) => '<div class="meter"><span class="' + (cls || "") + '" style="width:' + Math.max(0, Math.min(100, pct)).toFixed(0) + '%"></span></div>';
  const goBtn = (id, label) => '<button type="button" class="chip" data-open="' + id + '">' + esc(label) + " →</button>";

  // ---------- Подбор типа фундамента ----------
  const F_SOILS = [["rock", "Скальный, крупнообломочный"], ["sandC", "Песок гравелистый, крупный, средний"], ["sandF", "Песок мелкий или пылеватый"], ["sandy", "Супесь"], ["loam", "Суглинок"], ["clay", "Глина"], ["peat", "Торф, ил, насыпной (слабый)"]];
  add({
    id: "fselect", cat: "found", mark: "подбор", name: "Какой фундамент выбрать", kw: "фундамент выбор подбор какой тип ушп плита лента мзлф сваи винтовые буронабивные тисэ столбчатый пучение грунт",
    desc: "Опишите участок и дом — получите типы фундамента по убыванию пригодности с причинами",
    inputs: [
      { k: "soil", label: "Грунт под подошвой", type: "sel", def: "loam", opts: F_SOILS, hint: "По геологии; если её нет — по шурфу глубиной 1,5–2 м" },
      { k: "gw", label: "Уровень грунтовых вод весной, м", def: 2.5, hint: "Глубина от поверхности. Смотрите в колодцах и шурфах в апреле" },
      { k: "df", label: "Глубина промерзания, м", def: () => { const f = store.get("lastFrost"); return f ? Math.round(f.dfn * 100) / 100 : 1.4; }, hint: "Посчитайте в калькуляторе «Промерзание» — подставится сама" },
      { k: "relief", label: "Рельеф участка", type: "sel", def: "flat", opts: [["flat", "Ровный (перепад до 0,5 м)"], ["mid", "Небольшой уклон (0,5–1,5 м)"], ["steep", "Сильный уклон (больше 1,5 м)"]] },
      { k: "walls", label: "Стены", type: "sel", def: "aer", opts: [["light", "Каркас, брус, бревно, СИП"], ["aer", "Газобетон, пеноблок, керамоблок"], ["brick", "Кирпич, керамзитоблок"], ["mono", "Монолит, камень"]] },
      { k: "floors", label: "Этажей", type: "sel", def: "2", opts: [["1", "1"], ["2", "2 (или 1 + мансарда)"], ["3", "3"]] },
      { k: "base", label: "Подвал", type: "sel", def: "none", opts: [["none", "Не нужен"], ["tech", "Техподполье / цоколь"], ["basement", "Жилой подвал"]] },
      { k: "live", label: "Проживание", type: "sel", def: "perm", opts: [["perm", "Круглый год, дом отапливается"], ["season", "Сезонно, зимой без отопления"]] },
      { k: "prio", label: "Что важнее", type: "sel", def: "bal", opts: [["cost", "Подешевле и быстрее"], ["bal", "Баланс цены и надёжности"], ["rel", "Максимальная надёжность"]] },
      { k: "wf", label: "Хочу тёплый пол на первом этаже", type: "check", def: true }
    ],
    run(v) {
      const df = v.df > 0 ? v.df : 1.4;
      const heavingSoil = ["sandF", "sandy", "loam", "clay"].includes(v.soil);
      const wet = v.gw <= df + 2;
      const heave = v.soil === "peat" ? "weak" : !heavingSoil ? "none" : (v.soil === "loam" || v.soil === "clay") ? (v.gw <= df + 1 ? "strong" : wet ? "mid" : "low") : (wet ? "mid" : "low");
      const HEAVE_T = { none: "непучинистый", low: "слабопучинистый", mid: "среднепучинистый", strong: "сильнопучинистый", weak: "слабый (сжимаемый)" };
      const heavy = v.walls === "brick" || v.walls === "mono", floors = +v.floors;
      const W = { light: 1, aer: 2, brick: 3, mono: 4 }[v.walls] + (floors - 1) * 0.6;
      const wTxt = W < 1.8 ? "лёгкий" : W < 3 ? "средний" : "тяжёлый";
      const O = [];
      const opt = (id, name, base) => { const o = { id, name, s: base, pros: [], cons: [], excl: null, depth: "", links: [] }; O.push(o); return o; };
      const P = (o, d, t) => { o.s += d; if (t) (d >= 0 ? o.pros : o.cons).push(t); };
      const X = (o, t) => { if (!o.excl) o.excl = t; };

      // УШП
      let o = opt("ushp", "Утеплённая шведская плита (УШП)", 68);
      o.pros.push("Плита, утепление и тёплый пол в одной конструкции", "Мелкое заложение: мало земляных работ, 2–3 недели работ");
      if (v.base !== "none") X(o, "Подвал или техподполье с УШП не сделать");
      if (v.relief === "steep") X(o, "На сильном уклоне нужна огромная подсыпка или подпорные стенки");
      if (v.relief === "mid") P(o, -18, "Уклон: подсыпка и подпорные стенки удорожают");
      if (v.live === "season") P(o, -35, "Без отопления зимой грунт под плитой промерзает — защита от пучения пропадает");
      if (v.walls === "light" || v.walls === "aer") P(o, 14, "Хорошо работает под лёгкий и средний дом");
      if (v.walls === "brick") P(o, floors > 1 ? -22 : -6, "Тяжёлые стены — усиленные рёбра и расчёт");
      if (v.walls === "mono") P(o, -35, "Монолитный дом слишком тяжёл для УШП");
      if (heave === "strong" || heave === "mid") P(o, 10, "Утеплённая «юбка» не даёт грунту промерзать — пучение не страшно");
      if (v.soil === "peat") P(o, -40, "Слабый грунт: только с заменой грунта и расчётом осадок");
      if (v.gw < 1) P(o, 4, "Мелкое заложение не уходит в воду (дренаж всё равно нужен)");
      if (v.wf) P(o, 10, "Тёплый пол уже встроен в плиту");
      if (v.prio === "cost") P(o, 2);
      o.depth = "Заглубление 0,3–0,5 м, песчано-щебёночная подушка 300–500 мм, ЭППС 100–200 мм под плитой и «юбка» по периметру.";
      o.links = [["volume", "Объём бетона"], ["rebar", "Арматура плиты"], ["insul", "Утеплитель"]];

      // Монолитная плита
      o = opt("slab", "Монолитная плита (мелкозаглублённая)", 58);
      o.pros.push("Распределяет вес на всю площадь — прощает неоднородный грунт");
      if (v.base === "basement") P(o, -8, "Под подвал — как днище со стенами в монолите, это уже другой бюджет");
      if (v.base === "tech") P(o, -12, "Техподполье с плитой неудобно — нужен цоколь");
      if (v.relief === "steep") P(o, -30, "На уклоне — подсыпка или ступенчатая конструкция");
      if (v.relief === "mid") P(o, -10);
      if (heavy) P(o, 14, "Хорошо держит тяжёлый каменный дом");
      if (floors === 3) P(o, 8);
      if (v.walls === "light") P(o, -10, "Для лёгкого дома избыточна по деньгам");
      if (heave === "strong") P(o, 10, "Работает на пучинистых грунтах (дом «плавает» вместе с плитой)");
      if (v.soil === "peat") P(o, 4, "Лучше других мелких вариантов на слабом грунте — но нужен расчёт осадок");
      if (v.gw < 1.5) P(o, 10, "Подходит при высоком уровне грунтовых вод");
      if (v.prio === "cost") P(o, -14, "Много бетона и арматуры — один из самых дорогих вариантов");
      if (v.prio === "rel") P(o, 10);
      if (v.live === "season") P(o, -8, "Без отопления — утеплять плиту по периметру");
      o.depth = "Заглубление 0,3–0,6 м, подушка 300–500 мм, плита 200–300 мм с двумя сетками.";
      o.links = [["volume", "Объём бетона"], ["rebar", "Арматура плиты"], ["loads", "Нагрузка на грунт"]];

      // МЗЛФ
      o = opt("mzlf", "Мелкозаглублённая лента (МЗЛФ)", 58);
      o.pros.push("Дешевле заглублённой ленты в 1,5–2 раза");
      if (v.base === "basement") X(o, "Для подвала нужна лента ниже промерзания");
      if (v.soil === "peat") X(o, "На слабом грунте мелкая лента даст неравномерную осадку");
      if (v.base === "tech") P(o, -8, "Только невысокое техподполье");
      if (v.relief === "steep") P(o, -25, "На сильном уклоне — высокий цоколь, лучше сваи");
      if (v.relief === "mid") P(o, -8);
      if (v.walls === "light" || v.walls === "aer") P(o, 10, "Подходит под лёгкий и средний дом");
      if (v.walls === "brick" && floors > 1) P(o, -15, "Двухэтажный кирпич — нагрузка велика для мелкой ленты");
      if (v.walls === "mono") P(o, -30);
      if (heave === "strong") P(o, -25, "Сильное пучение: обязательно утепление, песчаная подушка и дренаж — есть риск трещин");
      if (heave === "mid") P(o, -10, "Пучинистый грунт: утеплённая отмостка, подушка и дренаж обязательны");
      if (heave === "none") P(o, 12, "На непучинистом грунте — надёжный и экономичный вариант");
      if (v.live === "season" && heave !== "none") P(o, -20, "Неотапливаемый дом на пучинистом грунте лента может поднять");
      if (v.gw < 1) P(o, -15, "Высокие воды — подушка будет мокнуть и пучить");
      if (v.prio === "cost") P(o, 14);
      o.depth = "Заглубление 0,5–0,7 м (≈ " + nf(Math.min(0.7, Math.max(0.5, df * 0.4)), 1) + " м), подушка 300–600 мм, утеплённая отмостка 1–1,2 м.";
      o.links = [["volume", "Объём бетона"], ["rebar", "Арматура ленты"], ["loads", "Ширина ленты"]];

      // Заглублённая лента
      o = opt("strip", "Ленточный ниже промерзания (монолит или ФБС)", 55);
      o.pros.push("Классика под каменный дом, позволяет сделать подвал");
      if (v.base === "basement") P(o, 30, "Подвал — самый естественный вариант");
      if (v.base === "tech") P(o, 15, "Удобно сделать техподполье");
      if (v.gw < df + 0.5) P(o, -25, "Подошва попадает в грунтовые воды: водопонижение, гидроизоляция, дренаж");
      else if (v.gw < df + 1) P(o, -8, "Воды близко к подошве — обязателен дренаж");
      if (heavy) P(o, 14, "Хорошо держит тяжёлый каменный дом");
      if (v.walls === "aer") P(o, 5);
      if (v.walls === "light") P(o, -20, "Лёгкий дом не удержит ленту от касательных сил пучения — её может поднять");
      if (heave === "strong" || heave === "mid") P(o, v.walls === "light" ? -10 : -4, "Пучение по боковым стенкам: обратная засыпка песком, утепление");
      if (heave === "none") P(o, 5);
      if (v.relief === "steep") P(o, -8, "Лента ступенями — сложнее, но возможно");
      if (v.soil === "peat") P(o, -40, "Опирать ленту на торф нельзя — менять грунт или сваи");
      if (v.prio === "cost") P(o, df > 1.5 ? -16 : -8, "Глубокая траншея, много бетона и гидроизоляции");
      if (v.prio === "rel") P(o, 6);
      o.depth = "Подошва ниже промерзания: ≥ " + nf(df, 2) + " м (или глубже под подвал), подушка 200–300 мм; монолит или ФБС на ленточных плитах ФЛ.";
      o.links = [["fbs", "Раскладка ФБС"], ["loads", "Ширина подошвы"], ["volume", "Объём бетона"]];

      // Буронабивные / ТИСЭ
      o = opt("bored", "Буронабивные сваи (ТИСЭ) с ростверком", 58);
      o.pros.push("Опираются ниже промерзания — пучение и отопление не важны", "Мало земляных работ");
      if (v.base === "basement") X(o, "С подвалом не сочетается");
      if (v.base === "tech") P(o, -4, "Техподполье — за счёт высокого ростверка");
      if (v.relief === "steep") P(o, 16, "Уклон не проблема — разная высота свай");
      if (v.relief === "mid") P(o, 10);
      if (heave === "strong") P(o, 14, "Один из лучших вариантов на сильнопучинистом грунте");
      if (heave === "mid") P(o, 10);
      if (v.gw < 1) P(o, -15, "Бурение в воде: обсадные трубы, бетон сложно залить качественно");
      if (v.walls === "aer") P(o, 8);
      if (v.walls === "light") P(o, 4);
      if (v.walls === "mono") P(o, -6, "Тяжёлый дом — много свай и мощный ростверк по расчёту");
      if (v.soil === "peat") P(o, 4, "Если сваи пройдут торф до плотного слоя — нужны изыскания");
      if (v.live === "season") P(o, 10, "Не зависит от отопления зимой");
      if (v.soil === "rock") P(o, -20, "Скальный грунт сложно бурить — и сваи не нужны");
      if (v.prio === "cost") P(o, 6);
      if (v.wf) P(o, -3, "Тёплый пол — по перекрытию или по грунту с утеплением");
      o.depth = "Сваи Ø 250–400 мм с уширением, низ ≥ " + nf(df + 0.3, 2) + " м, шаг 1,5–2 м; монолитный ростверк (под каменные стены — висячий, с зазором от грунта).";
      o.links = [["loads", "Количество свай"], ["volume", "Объём бетона"], ["rebar", "Арматура ростверка"]];

      // Винтовые
      o = opt("screw", "Винтовые сваи", 52);
      o.pros.push("Монтаж за 1–2 дня в любое время года, без бетона");
      if (v.soil === "rock") X(o, "В скальный и крупнообломочный грунт сваи не завинтить");
      if (v.base !== "none") X(o, "С подвалом и техподпольем не сочетается");
      if (v.walls === "mono") X(o, "Монолитный или каменный дом на винтовых сваях — нет");
      if (v.walls === "brick") P(o, -40, "Кирпич — только с массивным ж/б ростверком и по расчёту");
      if (v.walls === "light") P(o, 26, "Идеально для каркаса, бруса, бани");
      if (v.walls === "aer") P(o, floors > 1 ? -25 : -12, "Газобетон боится перекосов — нужен жёсткий монолитный ростверк");
      if (v.relief === "steep") P(o, 24, "Лучший вариант на сильном уклоне");
      if (v.relief === "mid") P(o, 14);
      if (v.gw < 1.5) P(o, 10, "Не боятся высоких грунтовых вод");
      if (v.soil === "peat") P(o, 14, "Длинными сваями проходят слабый слой до плотного");
      if (heave !== "none") P(o, 4);
      if (v.live === "season") P(o, 10);
      if (v.prio === "cost") P(o, 14);
      if (v.prio === "rel") P(o, -8, "Ресурс ограничен коррозией: толщина ствола ≥ 4 мм, бетонирование ствола");
      if (v.wf) P(o, -4, "Пол по перекрытию — продумать утепление снизу");
      o.depth = "Лопасть ниже промерзания (≥ " + nf(df + 0.2, 2) + " м) в плотном слое; длину уточняет пробная завинчивка. Ø 108–133 мм, стенка ≥ 4 мм.";
      o.links = [["loads", "Количество свай"], ["metal", "Масса обвязки"]];

      // Столбчатый
      o = opt("column", "Столбчатый", 40);
      o.pros.push("Самый дешёвый вариант для лёгких строений");
      if (v.walls === "brick" || v.walls === "mono") X(o, "Только для лёгких домов, бань и хозпостроек");
      if (v.base !== "none") X(o, "Без подвала");
      if (v.soil === "peat") X(o, "На слабом грунте столбы просядут неравномерно");
      if (v.walls === "aer") P(o, -40, "Газобетон на столбах трескается — нужен жёсткий ростверк");
      if (v.walls === "light") P(o, 20, "Хватит для каркасного дома и бани");
      if (heave === "strong") P(o, -25, "Пучение выталкивает столбы — нужно уширение и засыпка песком");
      if (heave === "mid") P(o, -10);
      if (v.relief === "steep") P(o, 4);
      if (v.prio === "cost") P(o, 18);
      if (v.prio === "rel") P(o, -10);
      o.depth = "Столбы ниже промерзания (" + nf(df, 2) + " м) с уширением подошвы, на непучинистых грунтах — на подушке 0,5–0,8 м.";
      o.links = [["volume", "Объём бетона"]];

      O.forEach(o => o.s = Math.max(3, Math.min(98, Math.round(o.s))));
      O.sort((a, b) => (a.excl ? 1 : 0) - (b.excl ? 1 : 0) || b.s - a.s);
      const verdict = o => o.excl ? ["Не подходит", "bad"] : o.s >= 75 ? ["Рекомендуется", "good"] : o.s >= 60 ? ["Хороший вариант", "good"] : o.s >= 45 ? ["Возможен, с оговорками", "mid"] : ["Не рекомендуется", "bad"];
      const top = O.filter(o => !o.excl).slice(0, 2);
      const cards = O.map((o, i) => {
        const [vt, vc] = verdict(o);
        return '<div class="opt ' + vc + (o.excl ? " off" : "") + '"><div class="opt-h"><span class="opt-n">' + (i + 1) + '</span><div class="opt-t"><b>' + esc(o.name) + '</b><span class="tag-v ' + vc + '">' + vt + "</span></div>" + (o.excl ? "" : '<span class="opt-s">' + o.s + "</span>") + "</div>" +
          (o.excl ? "" : bar(o.s, vc)) +
          (o.excl ? '<p class="opt-x">' + esc(o.excl) + "</p>" :
            '<ul class="pc">' + o.pros.map(t => '<li class="p">' + esc(t) + "</li>").join("") + o.cons.map(t => '<li class="c">' + esc(t) + "</li>").join("") + "</ul>" +
            '<p class="opt-d">' + esc(o.depth) + "</p>" + '<div class="chips">' + o.links.map(l => goBtn(l[0], l[1])).join("") + "</div>") + "</div>";
      }).join("");
      return {
        stats: [S("Грунт", HEAVE_T[heave], "", v.gw <= df + 2 ? "воды близко к зоне промерзания" : "воды глубоко"), S("Дом", wTxt, "", floors + " эт. · " + { light: "лёгкие стены", aer: "блоки", brick: "кирпич", mono: "монолит" }[v.walls]), S("Лучший вариант", top[0] ? top[0].name.replace(/ \(.*\)/, "") : "—", "", top[1] ? "далее: " + top[1].name.replace(/ \(.*\)/, "") : "", true)],
        blocks: [{ title: "Варианты по убыванию пригодности", html: '<div class="opts">' + cards + "</div>" }, { cls: "method", html: "<p><strong>Перед выбором обязательно:</strong> инженерно-геологические изыскания — минимум 3 скважины на глубину 5–6 м под пятном дома. Они покажут слои грунта, его несущую способность и реальный уровень вод. Подбор здесь — экспертная оценка по типовым правилам, а не проект. Окончательное решение — за проектировщиком.</p>" }],
        warn: v.soil === "peat" ? "Торф и насыпной грунт: без изысканий фундамент не выбирать — возможно, слабый слой проще заменить." : ""
      };
    }
  });

  // ---------- Глубина промерзания ----------
  const D0 = { rock: 0.34, sandC: 0.30, sandF: 0.28, sandy: 0.28, loam: 0.23, clay: 0.23 };
  const KH = { slab: [0.9, 0.8, 0.7, 0.6, 0.5], lags: [1.0, 0.9, 0.8, 0.7, 0.6], ins: [1.0, 1.0, 0.9, 0.8, 0.7], base: [0.8, 0.7, 0.6, 0.5, 0.4] };
  const MON = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  async function loadClimate(p) {
    const key = "clim:" + p.latitude.toFixed(2) + "," + p.longitude.toFixed(2);
    const c = store.get(key);
    if (c && c.v === 3) return c;
    const y2 = new Date().getFullYear() - 1, y1 = y2 - 14;
    const r = await fetch("https://archive-api.open-meteo.com/v1/archive?latitude=" + p.latitude + "&longitude=" + p.longitude + "&start_date=" + y1 + "-01-01&end_date=" + y2 + "-12-31&daily=temperature_2m_mean,temperature_2m_min&timezone=auto");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const t = j.daily.time, T = j.daily.temperature_2m_mean, Tn = j.daily.temperature_2m_min || [];
    const ym = {}; // "YYYY-MM" -> [sum, n]
    t.forEach((d, i) => { if (T[i] == null) return; const k = d.slice(0, 7); (ym[k] = ym[k] || [0, 0]); ym[k][0] += T[i]; ym[k][1]++; });
    const sums = Array(12).fill(0), cnt = Array(12).fill(0);
    Object.entries(ym).forEach(([k, [s, n]]) => { const m = +k.slice(5) - 1; sums[m] += s / n; cnt[m]++; });
    const mon = sums.map((s, i) => cnt[i] ? s / cnt[i] : 0);
    // зимы: июль–июнь
    const winters = [];
    for (let y = y1; y < y2; y++) {
      let mt = 0, ok = true;
      for (let m = 7; m <= 18; m++) { const yy = m > 12 ? y + 1 : y, mm = m > 12 ? m - 12 : m; const v = ym[yy + "-" + String(mm).padStart(2, "0")]; if (!v) { ok = false; break; } const avg = v[0] / v[1]; if (avg < 0) mt -= avg; }
      if (ok) winters.push({ y, mt });
    }
    // отопительный период (дни ≤ +8 °C), в среднем за год
    let hd = 0, hs = 0;
    t.forEach((d, i) => { if (T[i] != null && T[i] <= 8) { hd++; hs += T[i]; } });
    const years = y2 - y1 + 1;
    // абсолютный минимум года, последние весенние и первые осенние заморозки (по минимальной температуре воздуха)
    const yr = {};
    t.forEach((d, i) => {
      const x = Tn[i]; if (x == null) return;
      const y = +d.slice(0, 4), doy = Math.round((Date.UTC(y, +d.slice(5, 7) - 1, +d.slice(8, 10)) - Date.UTC(y, 0, 1)) / 864e5) + 1;
      const o = yr[y] = yr[y] || { min: 99, last: 0, first: 400 };
      if (x < o.min) o.min = x;
      if (x <= 0 && doy < 183 && doy > o.last) o.last = doy;
      if (x <= 0 && doy >= 183 && doy < o.first) o.first = doy;
    });
    const ys = Object.values(yr).filter(o => o.min < 99);
    const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
    const tmin = avg(ys.map(o => o.min)), last = avg(ys.filter(o => o.last).map(o => o.last)), first = avg(ys.filter(o => o.first < 400).map(o => o.first));
    const lastMax = ys.length ? Math.max(...ys.map(o => o.last)) : null;
    const res = { v: 3, y1, y2, mon, winters, hsDays: hd / years, hsT: hd ? hs / hd : 0, tmin, last, first, lastMax };
    store.set(key, res);
    return res;
  }
  function monthChart(mon) {
    const W = 600, H = 170, pL = 30, pB = 22, pT = 14, pw = W - pL - 6, ph = H - pT - pB;
    const lo = Math.min(-15, Math.floor(Math.min(...mon) / 5) * 5), hi = Math.max(25, Math.ceil(Math.max(...mon) / 5) * 5);
    const y = v => pT + ph - (v - lo) / (hi - lo) * ph, slot = pw / 12;
    let s = '<svg viewBox="0 0 ' + W + " " + H + '" class="mini-chart" role="img" aria-label="Среднемесячные температуры">';
    for (let v = lo; v <= hi; v += 10) s += '<line x1="' + pL + '" x2="' + (W - 6) + '" y1="' + y(v) + '" y2="' + y(v) + '" class="' + (v === 0 ? "zero" : "grid") + '"/><text x="' + (pL - 6) + '" y="' + (y(v) + 3) + '" class="axis" text-anchor="end">' + v + "</text>";
    if (lo < 0 && hi > 0) s += '<line x1="' + pL + '" x2="' + (W - 6) + '" y1="' + y(0) + '" y2="' + y(0) + '" class="zero"/>';
    mon.forEach((m, i) => {
      const x = pL + i * slot + 4, top = Math.min(y(m), y(0)), h = Math.max(2, Math.abs(y(m) - y(0)));
      s += '<rect x="' + x + '" y="' + top + '" width="' + (slot - 8) + '" height="' + h + '" rx="2" fill="' + (m < 0 ? "var(--str)" : "var(--temp)") + '"><title>' + MON[i] + ": " + nf(m, 1) + ' °C</title></rect>';
      s += '<text x="' + (x + (slot - 8) / 2) + '" y="' + (m < 0 ? top + h + 11 : top - 4) + '" class="axis" text-anchor="middle">' + nf(m, 1) + "</text>";
      s += '<text x="' + (x + (slot - 8) / 2) + '" y="' + (H - 6) + '" class="axis" text-anchor="middle">' + MON[i] + "</text>";
    });
    return s + "</svg>";
  }
  add({
    id: "frost", cat: "found", mark: "по погоде", name: "Промерзание и глубина труб", kw: "глубина промерзания заложения фундамента водопровод канализация трубы сп 22 сп 131 мороз нулевой цикл",
    desc: "Промерзание по реальной погоде за 15 лет, глубина фундамента по СП 22, водопровода и канализации",
    inputs: [
      { k: "place", label: "Населённый пункт", type: "place" },
      { k: "soil", label: "Грунт", type: "sel", def: "loam", opts: F_SOILS.filter(s => s[0] !== "peat") },
      { k: "state", label: "Состояние глинистого грунта", type: "sel", def: "plastic", opts: [["firm", "Твёрдый, тугопластичный (комком не мнётся)"], ["plastic", "Мягкопластичный, влажный"]], show: v => ["sandy", "loam", "clay"].includes(v.soil) },
      { k: "gw", label: "Уровень грунтовых вод, м", def: 2.5 },
      { k: "floor", label: "Пол первого этажа", type: "sel", def: "lags", opts: [["slab", "По грунту (плита, бетонный пол)"], ["lags", "На лагах по грунту"], ["ins", "По утеплённому цокольному перекрытию"], ["base", "Есть подвал или техподполье"], ["cold", "Дом не отапливается"]] },
      { k: "tin", label: "Температура в доме зимой", type: "sel", def: "4", opts: [["0", "0 °C"], ["1", "+5 °C"], ["2", "+10 °C"], ["3", "+15 °C"], ["4", "+20 °C и выше"]], show: v => v.floor !== "cold" },
      { k: "src", label: "Данные о морозах", type: "sel", def: "auto", opts: [["auto", "Погода за 15 лет (автоматически)"], ["manual", "Ввести сумму морозов вручную"]] },
      { k: "mt", label: "Сумма среднемесячных отрицательных температур, °C", def: 25, show: v => v.src === "manual", hint: "Mt по СП 131 для вашего города, без знака минус" },
      { k: "pd", label: "Диаметр канализационной трубы, мм", def: 110 }
    ],
    loadKey: v => v.src === "auto" ? v.place.latitude.toFixed(2) + "," + v.place.longitude.toFixed(2) : "manual",
    load: v => v.src === "auto" ? loadClimate(v.place) : Promise.resolve(null),
    run(v, data, loading) {
      let mt = v.mt, note = "", blocks = [];
      if (v.src === "auto") {
        if (loading) return { note: "Загружаю погоду за 15 лет для " + v.place.name + "…" };
        if (!data || data.error) return { warn: "Не удалось загрузить погоду (на этой странице сетевые запросы закрыты или нет интернета). Выберите «Ввести сумму морозов вручную» — Mt для вашего города есть в СП 131.13330, таблица 5.1." };
        mt = data.mon.filter(m => m < 0).reduce((s, m) => s - m, 0);
        const ws = data.winters.slice().sort((a, b) => b.mt - a.mt);
        note = "Погода " + data.y1 + "–" + data.y2 + " гг., " + placeLabel(v.place) + ".";
        const hard = ws[0];
        blocks.push({ title: "Среднемесячные температуры, °C", html: monthChart(data.mon) + (hard ? '<p class="hint" style="margin-top:8px">Самая холодная зима: ' + hard.y + "/" + String(hard.y + 1).slice(2) + " — Mt = " + nf(hard.mt, 1) + ", промерзание суглинка тогда ≈ " + nf(0.23 * Math.sqrt(hard.mt), 2) + " м. Отопительный период ≈ " + nint(data.hsDays) + " сут при средней " + nf(data.hsT, 1) + " °C (ГСОП ≈ " + nint((20 - data.hsT) * data.hsDays) + ").</p>" : "") });
      }
      const d0 = D0[v.soil], dfn = d0 * Math.sqrt(Math.max(0, mt));
      const kh = v.floor === "cold" ? 1.1 : KH[v.floor][+v.tin];
      const df = kh * dfn;
      // СП 22, табл. 5.3
      let minD, rule;
      const far = v.gw > df + 2;
      if (v.soil === "rock" || v.soil === "sandC") { minD = null; rule = "Грунт непучинистый: глубина заложения не зависит от промерзания"; }
      else if (v.soil === "sandF") { minD = far ? null : df; rule = far ? "Воды глубже df + 2 м — не зависит от промерзания" : "Воды выше df + 2 м — не менее df"; }
      else if (v.state === "plastic") { minD = df; rule = "Пластичный глинистый грунт — не менее df при любом уровне вод"; }
      else if (v.soil === "sandy") { minD = far ? null : df; rule = far ? "Твёрдая супесь, воды глубоко — не зависит от промерзания" : "Воды выше df + 2 м — не менее df"; }
      else { minD = far ? 0.5 * df : df; rule = far ? "Тугопластичный грунт, воды глубоко — не менее 0,5·df" : "Воды выше df + 2 м — не менее df"; }
      const fd = minD == null ? 0.5 : Math.max(0.5, minD);
      const water = dfn + 0.5;
      const sewTop = Math.max(dfn - 0.3, 0.7), sew = sewTop + v.pd / 1000;
      store.set("lastFrost", { dfn, df, place: v.place && v.place.name });
      return {
        note,
        stats: [S("Сумма морозов Mt", nf(mt, 1), "°C·мес"), S("Нормативное промерзание dfn", nf(dfn, 2), "м", "открытая площадка без снега"), S("Расчётное у дома df", nf(df, 2), "м", "kh = " + nf(kh, 1)), S("Минимальная глубина подошвы", nf(fd, 2), "м", minD == null ? "конструктивно, от поверхности" : "по СП 22.13330", true), S("Водопровод (низ трубы)", nf(water, 2), "м", "dfn + 0,5 м по СП 31"), S("Канализация (лоток)", nf(sew, 2), "м", "верх трубы ≥ " + nf(sewTop, 2) + " м по СП 32")],
        blocks,
        table: { head: ["Параметр", "Значение"], rows: [["Коэффициент для грунта d0", nf(d0, 2) + " м"], ["Правило СП 22 (табл. 5.3)", rule], ["Уровень вод относительно df + 2 м", nf(v.gw, 2) + " м " + (far ? ">" : "≤") + " " + nf(df + 2, 2) + " м"]] }
      };
    },
    info: "dfn = d0·√Mt (СП 22.13330, формула 5.3), где Mt — сумма абсолютных значений среднемесячных отрицательных температур, d0 — 0,23 м для суглинков и глин, 0,28 м для супесей и мелких песков, 0,30 м для крупных песков, 0,34 м для крупнообломочных. df = kh·dfn — тепло дома уменьшает промерзание у фундамента (табл. 5.2). Mt считается по фактической погоде последних 15 лет — зимы теплеют, поэтому значение обычно меньше, чем в старых таблицах СП 131. Для ответственных решений сверяйтесь с СП 131 и берите больший результат. Под расчищенным от снега проездом грунт промерзает глубже — там трубы утепляют ЭППС."
  });

  // ---------- Нагрузка на фундамент ----------
  const WALL_M = { aer5: ["Газобетон D500", 600, 300], aer4: ["Газобетон D400", 500, 375], kblock: ["Керамоблок", 900, 380], keramz: ["Керамзитобетонный блок", 1200, 390], brickH: ["Кирпич керамический пустотелый", 1400, 380], brickS: ["Кирпич силикатный", 1900, 380], brickC: ["Кирпич керамический полнотелый", 1800, 380], wood: ["Брус, бревно", 600, 200], frame: ["Каркас с утеплителем", 0, 200], mono: ["Монолит ж/б", 2500, 200] };
  const R_SOIL = { sandC: ["Песок крупный, средний", 450, 0.125], sandF: ["Песок мелкий маловлажный", 300, 0.125], sandFw: ["Песок мелкий влажный", 200, 0.125], silt: ["Песок пылеватый влажный", 150, 0.05], sandy: ["Супесь", 250, 0.05], loamF: ["Суглинок тугопластичный", 220, 0.05], loamS: ["Суглинок мягкопластичный", 150, 0.05], clayF: ["Глина тугопластичная", 300, 0.05], clayS: ["Глина мягкопластичная", 180, 0.05], fill: ["Насыпной, слежавшийся", 100, 0.05] };
  add({
    id: "loads", cat: "found", mark: "вес дома", name: "Нагрузка на фундамент и ширина ленты", kw: "нагрузка вес дома сбор нагрузок ширина подошвы ленты давление на грунт несущая способность сваи количество свай винтовые снеговая",
    desc: "Сколько весит дом, давление на грунт, минимальная ширина подошвы и число свай",
    inputs: [
      { k: "L", label: "Длина дома по осям, м", def: 10 }, { k: "B", label: "Ширина дома по осям, м", def: 9 },
      { k: "fl", label: "Этажей", def: 2 }, { k: "h", label: "Высота этажа, м", def: 3 },
      { k: "wm", label: "Материал стен", type: "sel", def: "aer5", opts: Object.entries(WALL_M).map(([k, w]) => [k, w[0]]) },
      { k: "wt", label: "Толщина наружных стен, мм", def: v => WALL_M[v.wm] ? WALL_M[v.wm][2] : 300, dep: "wm" },
      { k: "clad", label: "Облицовка фасада", type: "sel", def: "40", opts: [["0", "Нет"], ["25", "Сайдинг, вентфасад (25 кг/м²)"], ["40", "Штукатурка (40 кг/м²)"], ["230", "Облицовочный кирпич 120 мм (230 кг/м²)"]] },
      { k: "il", label: "Внутренние несущие стены, м", def: 9, hint: "Длина на этаж, толщина 200–250 мм" },
      { k: "ft", label: "Перекрытия", type: "sel", def: "wood", opts: [["150", "Деревянные балки"], ["420", "Пустотные плиты + стяжка"], ["600", "Монолит 200 мм + стяжка"]] },
      { k: "p1", label: "Пол 1-го этажа", type: "sel", def: "grnd", opts: [["grnd", "По грунту (на ленту не давит)"], ["slab", "Перекрытие, опёртое на фундамент"]] },
      { k: "rf", label: "Кровля", type: "sel", def: "50", opts: [["50", "Металлочерепица, профнастил"], ["70", "Гибкая черепица"], ["120", "Керамическая, цементно-песчаная черепица"]] },
      { k: "snow", label: "Снеговой район", type: "sel", def: "1.5", opts: [["0.5", "I (0,5 кПа)"], ["1", "II (1,0 кПа)"], ["1.5", "III (1,5 кПа) — Москва, Нижний Новгород"], ["2", "IV (2,0 кПа)"], ["2.5", "V (2,5 кПа)"], ["3", "VI (3,0 кПа)"], ["3.5", "VII (3,5 кПа)"], ["4", "VIII (4,0 кПа)"]] },
      { k: "soil", label: "Грунт под подошвой", type: "sel", def: "loamF", opts: Object.entries(R_SOIL).map(([k, s]) => [k, s[0] + " (R0 ≈ " + s[1] + " кПа)"]) },
      { k: "fd", label: "Глубина подошвы от земли, м", def: 1.5 }, { k: "fc", label: "Высота цоколя над землёй, м", def: 0.4 },
      { k: "fb", label: "Ширина подошвы, м", def: 0.4 },
      { k: "pile", label: "Несущая способность одной сваи, т", def: 3, hint: "Винтовая Ø108 ≈ 2–4 т, буронабивная Ø300 ≈ 3–6 т — по грунту" }
    ],
    run(v) {
      const w = WALL_M[v.wm], A = v.L * v.B, P = 2 * (v.L + v.B), Hw = v.fl * v.h;
      const wallArea = P * Hw * 0.85; // 15% проёмы
      const wallKg = w[1] ? wallArea * v.wt / 1000 * w[1] : wallArea * 60;
      const cladKg = wallArea * num(v.clad);
      const intKg = v.il * Hw * (w[1] ? 0.22 * w[1] : 50) * 0.9;
      const nFl = v.fl + (v.p1 === "slab" ? 1 : 0);
      const floorKg = A * nFl * num(v.ft);
      const liveKg = A * ((v.fl - 1 + (v.p1 === "slab" ? 1 : 0)) * (150 + 50) + 70);
      const roofKg = A * 1.3 * num(v.rf), snowKg = A * num(v.snow) * 100;
      const total = (wallKg + cladKg + intKg + floorKg + liveKg + roofKg + snowKg) / 1000; // т
      const Lb = P + v.il, q = Lb > 0 ? total / Lb : 0, qmax = q * 1.25;
      const Hf = v.fd + v.fc, selfq = v.fb * Hf * 2.4;
      const s = R_SOIL[v.soil], d = Math.min(v.fd, 2);
      const R = s[1] * (1 + s[2] * (v.fb - 1)) * (d + 2) / 4;
      const p = v.fb > 0 ? (qmax + selfq) * 9.81 / v.fb : 0;
      const den = R - Hf * 2.4 * 9.81, bmin = den > 0 ? qmax * 9.81 / den : 0;
      const piles = Math.max(v.pile > 0 ? ceil(total * 1.1 / v.pile) : 0, ceil(P / 2.5) + ceil(v.il / 2.5) + 4);
      const ok = p <= R;
      const rows = [["Наружные стены", wallKg], ["Облицовка", cladKg], ["Внутренние стены", intKg], ["Перекрытия (" + nFl + " шт.)", floorKg], ["Полезная нагрузка и перегородки", liveKg], ["Кровля", roofKg], ["Снег", snowKg]].map(r => [r[0], nf(r[1] / 1000, 1) + " т", nint(r[1] / total / 10) + "%"]);
      return {
        stats: [S("Вес дома с нагрузками", nf(total, 0), "т", "без фундамента"), S("На 1 м ленты", nf(q, 2), "т/м", "самая нагруженная ≈ " + nf(qmax, 2) + " т/м"), S("Давление под подошвой", nint(p), "кПа", "допустимо R ≈ " + nint(R) + " кПа", ok), S("Минимальная ширина подошвы", bmin > 0 ? nf(Math.max(bmin, 0.3), 2) : "—", "м", bmin > v.fb ? "сейчас " + nf(v.fb, 2) + " м — мало" : "текущая " + nf(v.fb, 2) + " м — хватает", true), S("Если на сваях", nint(piles), "шт.", "по нагрузке и шагу ≤ 2,5 м")],
        warn: ok ? "" : "Давление " + nint(p) + " кПа больше расчётного сопротивления грунта " + nint(R) + " кПа — расширьте подошву минимум до " + nf(bmin, 2) + " м (ленточная плита ФЛ или уширение).",
        table: { cap: "Из чего складывается вес", head: ["Нагрузка", "Вес", "Доля"], rows },
        extra: [["Фундамент (на 1 м)", nf(selfq, 2) + " т/м"], ["Несущих стен всего", nf(Lb, 1) + " м"], ["Расчётное сопротивление R", nint(R) + " кПа (R0 = " + s[1] + " кПа с поправкой на ширину и глубину)"]]
      };
    },
    info: "Упрощённый сбор нагрузок (нормативные значения, без коэффициентов надёжности): вес стен с проёмами 15%, перекрытий, кровли (площадь ×1,3), снега по СП 20, полезной нагрузки 1,5 кПа + перегородки 0,5 кПа. Нагрузка распределяется по всем несущим стенам; наиболее нагруженная принята с коэффициентом 1,25. R0 — ориентировочно по таблицам приложения Б СП 22, с пересчётом на ширину и глубину подошвы. Это оценка для выбора — для проекта нужен расчёт по данным изысканий."
  });

  // ---------- Раскладчик ФБС ----------
  const FBS = [[2380, "24"], [1180, "12"], [880, "9"]];
  function fbsCombo(S, j, prefix) {
    const pre = prefix && S > 1180 + j ? 1 : 0;
    const S2 = S - (pre ? 1180 + j : 0);
    let best = null;
    for (let n12 = 0; n12 <= 2; n12++) for (let n9 = 0; n9 <= 3; n9++) {
      const base = n12 * (1180 + j) + n9 * (880 + j);
      if (base > S2 + j) continue;
      const n24 = Math.max(0, Math.floor((S2 - base + j) / (2380 + j)));
      const cnt = n24 + n12 + n9;
      const used = n24 * (2380 + j) + base - (cnt ? j : 0);
      const r = S2 - used, mono = r > 2 * j ? r - j : 0;
      const score = (mono > 0 && mono < 150 ? 1e5 : 0) + mono * 10 + cnt;
      if (!best || score < best.score) best = { score, n24, n12, n9, mono, pre };
    }
    return best;
  }
  function fbsOrders(c) {
    const P = (len, t) => ({ len, t });
    const big = Array.from({ length: c.n24 }, () => P(2380, "24"));
    const small = [...Array.from({ length: c.n12 }, () => P(1180, "12")), ...Array.from({ length: c.n9 }, () => P(880, "9"))];
    const hb = Math.ceil(big.length / 2), hs = Math.ceil(small.length / 2);
    const bases = [big.concat(small), small.concat(big), small.slice(0, hs).concat(big, small.slice(hs)), big.slice(0, hb).concat(small, big.slice(hb)), small.slice().reverse().concat(big)];
    const out = [];
    bases.forEach(b => {
      if (!c.mono) { out.push(b); return; }
      const pos = [...new Set([Math.floor(b.length / 2), 1, Math.max(0, b.length - 1), 0, b.length])];
      pos.forEach(p => { const x = b.slice(); x.splice(Math.min(p, x.length), 0, P(c.mono, "M")); out.push(x); });
    });
    return out.map(o => (c.pre ? [P(1180, "12")] : []).concat(o));
  }
  const fbsJoints = (row, j) => { const xs = []; let x = row.start; row.pcs.forEach((p, i) => { x += p.len; if (i < row.pcs.length - 1) xs.push(x + j / 2); x += j; }); return xs; };
  function fbsRow(len, start, j, prefix, prev) {
    const c = fbsCombo(len, j, prefix);
    const pj = prev ? fbsJoints(prev, j) : [];
    let best = null;
    fbsOrders(c).forEach((pcs, i) => {
      const row = { start, len, pcs };
      const weak = prev ? fbsJoints(row, j).filter(x => pj.some(y => Math.abs(y - x) < 240)).length : 0;
      if (!best || weak < best.weak) best = { weak, row };
    });
    return best.row;
  }
  function fbsSVG(title, wallLen, rows, t, j) {
    const W = 860, rowH = 34, pL = 46, pR = 10, pT = 8, n = rows.length, H = pT + n * rowH + 26;
    const k = (W - pL - pR) / wallLen;
    let s = '<svg viewBox="0 0 ' + W + " " + H + '" class="fbs-svg" role="img" aria-label="' + esc(title) + '">';
    rows.forEach((row, ri) => {
      const y = pT + (n - 1 - ri) * rowH;
      s += '<text x="' + (pL - 8) + '" y="' + (y + rowH / 2 + 3) + '" class="axis" text-anchor="end">ряд ' + (ri + 1) + "</text>";
      if (row.start > 0) s += '<rect x="' + pL + '" y="' + (y + 2) + '" width="' + (row.start * k) + '" height="' + (rowH - 4) + '" class="fb-corner"/>';
      const endStart = row.start + row.len;
      if (endStart < wallLen) s += '<rect x="' + (pL + endStart * k) + '" y="' + (y + 2) + '" width="' + ((wallLen - endStart) * k) + '" height="' + (rowH - 4) + '" class="fb-corner"/>';
      let x = row.start;
      row.pcs.forEach(p => {
        const px = pL + x * k, pw = Math.max(1, p.len * k);
        s += '<rect x="' + px + '" y="' + (y + 2) + '" width="' + pw + '" height="' + (rowH - 4) + '" rx="2" class="fb-' + p.t + '"><title>' + (p.t === "M" ? "Монолитный добор " + p.len + " мм" : "ФБС " + p.t + "." + t / 100 + ".6") + "</title></rect>";
        if (pw > 22) s += '<text x="' + (px + pw / 2) + '" y="' + (y + rowH / 2 + 4) + '" class="fb-l" text-anchor="middle">' + (p.t === "M" ? (pw > 46 ? "М " + p.len : "М") : p.t) + "</text>";
        x += p.len + j;
      });
    });
    const yb = pT + n * rowH + 16;
    s += '<line x1="' + pL + '" x2="' + (W - pR) + '" y1="' + (yb - 8) + '" y2="' + (yb - 8) + '" class="dim"/><text x="' + (pL + (W - pL - pR) / 2) + '" y="' + yb + '" class="axis" text-anchor="middle">' + nint(wallLen) + " мм</text>";
    return s + "</svg>";
  }
  add({
    id: "fbs", cat: "found", mark: "чертёж рядов", name: "Раскладка блоков ФБС", kw: "фбс блоки фундаментные раскладка схема ряды перевязка фл плиты ленточные подвал сборный фундамент 24.4.6 12.4.6 9.4.6",
    desc: "Схема каждого ряда с перевязкой, спецификация ФБС 24/12/9, доборы, масса и плиты ФЛ",
    inputs: [
      { k: "L", label: "Длина фундамента по наружным граням, мм", def: 10000 },
      { k: "B", label: "Ширина по наружным граням, мм", def: 8000 },
      { k: "t", label: "Ширина блока", type: "sel", def: "400", opts: [["300", "300 мм (ФБС ..3.6)"], ["400", "400 мм (ФБС ..4.6)"], ["500", "500 мм (ФБС ..5.6)"], ["600", "600 мм (ФБС ..6.6)"]] },
      { k: "rows", label: "Рядов (по 600 мм)", def: 4 },
      { k: "j", label: "Вертикальный шов, мм", def: 20 },
      { k: "inner", label: "Внутренняя стена поперёк дома", type: "check", def: true },
      { k: "fl", label: "Ленточные плиты ФЛ под блоки", type: "sel", def: "12", opts: [["0", "Нет (монолитная подушка)"], ["8", "ФЛ 8 (800 мм)"], ["10", "ФЛ 10 (1000 мм)"], ["12", "ФЛ 12 (1200 мм)"], ["14", "ФЛ 14 (1400 мм)"], ["16", "ФЛ 16 (1600 мм)"], ["20", "ФЛ 20 (2000 мм)"]] }
    ],
    run(v) {
      const t = +v.t, j = Math.max(0, v.j), L = v.L, B = v.B, R = Math.max(1, Math.min(12, Math.round(v.rows)));
      if (L < 2 * t + 1000 || B < 2 * t + 1000) return { warn: "Слишком маленькие размеры." };
      const A = [], Bw = [], I = [];
      for (let r = 0; r < R; r++) {
        const odd = r % 2 === 0;
        A.push(odd ? fbsRow(L, 0, j, false, A[r - 1]) : fbsRow(L - 2 * t - 2 * j, t + j, j, false, A[r - 1]));
        Bw.push(odd ? fbsRow(B - 2 * t - 2 * j, t + j, j, false, Bw[r - 1]) : fbsRow(B, 0, j, false, Bw[r - 1]));
        if (v.inner) I.push(fbsRow(B - 2 * t - 2 * j, t + j, j, r % 2 === 1, I[r - 1]));
      }
      // перевязка: соседние ряды — расстояние между вертикальными швами
      const joints = row => fbsJoints(row, j);
      let weak = 0;
      [A, Bw, I].forEach(rs => { for (let r = 1; r < rs.length; r++) { const a = joints(rs[r - 1]), b = joints(rs[r]); b.forEach(x => { if (a.some(y => Math.abs(y - x) < 240)) weak++; }); } });
      const cnt = { "24": 0, "12": 0, "9": 0 }; let monoN = 0, monoL = 0;
      const tally = (rs, mult) => rs.forEach(row => row.pcs.forEach(p => { if (p.t === "M") { monoN += mult; monoL += p.len * mult; } else cnt[p.t] += mult; }));
      tally(A, 2); tally(Bw, 2); tally(I, 1);
      const w = t / 100, massOne = { "24": 2.38, "12": 1.18, "9": 0.88 };
      const mass = Object.keys(cnt).reduce((s, k) => s + cnt[k] * massOne[k] * t / 1000 * 0.58 * 2.4 * 0.98, 0);
      const monoV = monoL / 1000 * t / 1000 * 0.58;
      const wallLenRow = 2 * L + 2 * (B - 2 * t) + (v.inner ? B - 2 * t : 0);
      const mortar = wallLenRow / 1000 * t / 1000 * 0.02 * R * 1.15;
      const items = [["ФБС 24." + w + ".6", cnt["24"], "шт."], ["ФБС 12." + w + ".6", cnt["12"], "шт."], ["ФБС 9." + w + ".6", cnt["9"], "шт."]].filter(i => i[1] > 0);
      if (monoV > 0) items.push(["Бетон B15 на монолитные доборы", Math.round(monoV * 1.05 * 100) / 100, "м³"]);
      items.push(["Раствор М100 для швов", Math.round(mortar * 100) / 100, "м³"]);
      const extra = [];
      if (v.fl !== "0") {
        const flW = +v.fl * 100, flLen = 2 * L + 2 * (B - 2 * flW) + (v.inner ? B - 2 * flW : 0);
        const n24 = Math.floor(flLen / 2380), rem = flLen - n24 * 2380, n12 = rem >= 1180 ? 1 : 0;
        const flH = +v.fl >= 20 ? 500 : 300;
        items.push(["Плита ФЛ " + v.fl + ".24", n24, "шт."]); if (n12) items.push(["Плита ФЛ " + v.fl + ".12", n12, "шт."]);
        extra.push(["Плиты ФЛ " + v.fl + " (" + flW + "×" + flH + ")", n24 + " × 24 + " + n12 + " × 12, остаток " + nint(rem - n12 * 1180) + " мм — монолитом или разрывом"]);
      }
      const leg = '<div class="legend fb-leg"><span class="legend-item"><span class="sw fb-24"></span>ФБС 24</span><span class="legend-item"><span class="sw fb-12"></span>ФБС 12</span><span class="legend-item"><span class="sw fb-9"></span>ФБС 9</span><span class="legend-item"><span class="sw fb-M"></span>монолит</span><span class="legend-item"><span class="sw fb-corner"></span>блок поперечной стены</span></div>';
      const blocks = [
        { title: "Продольные стены (2 шт.) · " + nint(L) + " мм", aside: leg, html: '<div class="chart-scroll">' + fbsSVG("Продольная стена", L, A, t, j) + "</div>" },
        { title: "Торцевые стены (2 шт.) · " + nint(B) + " мм", html: '<div class="chart-scroll">' + fbsSVG("Торцевая стена", B, Bw, t, j) + "</div>" }
      ];
      if (v.inner) blocks.push({ title: "Внутренняя стена (1 шт.) · " + nint(B - 2 * t - 2 * j) + " мм между наружными", html: '<div class="chart-scroll">' + fbsSVG("Внутренняя стена", B, I, t, j) + '</div><p class="hint">Внутренняя стена примыкает к наружным — в местах примыкания уложите в шов арматурную сетку или Г-образные стержни.</p>' });
      return {
        stats: [S("ФБС 24 / 12 / 9", cnt["24"] + " / " + cnt["12"] + " / " + cnt["9"], "шт.", "", true), S("Монолитные доборы", nint(monoN), "шт.", nf(monoV, 2) + " м³ бетона"), S("Масса блоков", nf(mass, 1), "т", "≈ " + ceil(mass / 10) + " рейсов манипулятора по 10 т"), S("Высота стены", nint(R * 600), "мм", R + " рядов по 580 + шов 20"), S("Слабая перевязка", nint(weak), "мест", weak ? "сдвиг швов < 240 мм" : "перевязка в норме")],
        warn: weak > 0 ? "В " + weak + " местах вертикальные швы соседних рядов ближе 240 мм (0,4 высоты блока). Положите в эти швы арматурную сетку или поменяйте местами блоки в ряду." : "",
        blocks, table: { head: ["Позиция", "Количество"], rows: items.map(i => [i[0], (typeof i[1] === "number" ? i[1].toLocaleString("ru-RU") : i[1]) + " " + i[2]]) }, extra: extra.length ? extra : undefined,
        items
      };
    },
    info: "Углы перевязываются чередованием: в нечётных рядах продольные стены идут на всю длину, а торцевые встают между ними; в чётных — наоборот. Внутренняя стена в чётных рядах начинается с ФБС 12 для перевязки. Доборы из монолита ставятся в середину ряда — там удобно оставить проём для ввода коммуникаций или продуха. Рядность по высоте — 600 мм (блок 580 + шов 20)."
  });

  // ====================================================================
  //  БЛАГОУСТРОЙСТВО И СЕТИ
  // ====================================================================
  // kind: unit (м²), bulk (насыпной, kc — уплотнение, rho т/м³), conc, cps, xps, asph, sheet
  const MAT = {
    tile: { kind: "unit", cls: "m-tile", name: "Тротуарная плитка" },
    cps: { kind: "cps", cls: "m-cps", name: "ЦПС (сухая смесь)" },
    sand: { kind: "bulk", cls: "m-sand", rho: 1.5, kc: 1.2, name: "Песок" },
    gravel: { kind: "bulk", cls: "m-gravel", rho: 1.37, kc: 1.3, name: "Щебень 20–40" },
    gravelB: { kind: "bulk", cls: "m-gravel", rho: 1.38, kc: 1.3, name: "Щебень 40–70" },
    deco: { kind: "bulk", cls: "m-deco", rho: 1.37, kc: 1.15, name: "Щебень 5–20" },
    soil: { kind: "bulk", cls: "m-soil", rho: 1.2, kc: 1.2, name: "Растительный грунт" },
    conc: { kind: "conc", cls: "m-conc", name: "Бетон" },
    xps: { kind: "xps", cls: "m-xps", name: "ЭППС" },
    asph: { kind: "asph", cls: "m-asph", name: "Асфальтобетон" },
    geo: { kind: "sheet", cls: "m-geo", name: "Геотекстиль" },
    memb: { kind: "sheet", cls: "m-memb", name: "Профилированная мембрана" },
    lawn: { kind: "unit", cls: "m-lawn", name: "Газон" }
  };
  const PIES = {
    walk: ["Пешеходная дорожка из плитки", [["tile", "Тротуарная плитка 60 мм", 60], ["cps", "ЦПС 1:5", 40], ["sand", "Песок", 100], ["gravel", "Щебень 20–40", 150], ["geo", "Геотекстиль", 0]]],
    car: ["Площадка под легковой автомобиль", [["tile", "Тротуарная плитка 80 мм", 80], ["cps", "ЦПС 1:4", 40], ["gravel", "Щебень 20–40", 200], ["sand", "Песок", 150], ["geo", "Геотекстиль", 0]]],
    truck: ["Въезд для грузовой техники", [["tile", "Плитка 80 мм", 80], ["cps", "ЦПС 1:4", 40], ["conc", "Бетон B20 с сеткой", 150], ["gravel", "Щебень 20–40", 200], ["sand", "Песок", 200], ["geo", "Геотекстиль", 0]]],
    asphalt: ["Асфальтовый проезд", [["asph", "Асфальтобетон", 50], ["gravelB", "Щебень 40–70", 200], ["sand", "Песок", 200], ["geo", "Геотекстиль", 0]]],
    gravel: ["Щебёночная площадка или дорожка", [["deco", "Щебень 5–20, верхний слой", 50], ["gravel", "Щебень 20–40", 150], ["sand", "Песок", 100], ["geo", "Геотекстиль", 0]]],
    otm: ["Отмостка бетонная утеплённая", [["conc", "Бетон B15 с сеткой", 100], ["xps", "ЭППС", 50], ["sand", "Песок", 150], ["memb", "Мембрана / геомембрана", 0]]],
    lawn: ["Газон", [["lawn", "Рулонный или посевной газон", 20], ["soil", "Растительный грунт", 150], ["sand", "Песок дренажный", 100], ["geo", "Геотекстиль", 0]]]
  };
  function pieSVG(layers) {
    const W = 640, x0 = 20, wB = 330, labX = x0 + wB + 18, pT = 12;
    const vis = layers.map(l => ({ ...l, hh: l.kind === "sheet" ? 4 : Math.max(16, l.t * 0.55) }));
    const H = pT + vis.reduce((s, l) => s + l.hh, 0) + 30;
    let y = pT, s = '<svg viewBox="0 0 ' + W + " " + H + '" class="pie-svg" role="img" aria-label="Разрез пирога"><defs>' +
      '<pattern id="p-sand" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" class="pf-sand"/><circle cx="2" cy="2" r=".9" class="pd"/><circle cx="6" cy="5" r=".7" class="pd"/></pattern>' +
      '<pattern id="p-gravel" width="16" height="12" patternUnits="userSpaceOnUse"><rect width="16" height="12" class="pf-gravel"/><ellipse cx="4" cy="4" rx="3" ry="2.2" class="pg"/><ellipse cx="12" cy="9" rx="3.4" ry="2.4" class="pg"/></pattern>' +
      '<pattern id="p-deco" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" class="pf-deco"/><circle cx="2" cy="3" r="1.6" class="pg"/><circle cx="6" cy="6" r="1.4" class="pg"/></pattern>' +
      '<pattern id="p-soil" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" class="pf-soil"/><path d="M1 8 L4 5 M6 9 L9 6" class="ps"/></pattern>' +
      '<pattern id="p-conc" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" class="pf-conc"/><path d="M2 3 l2 2 M8 8 l2 -1" class="ps"/></pattern>' +
      '<pattern id="p-xps" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" class="pf-xps"/><path d="M0 10 L10 0" class="ps"/></pattern>' +
      '<pattern id="p-tile" width="40" height="20" patternUnits="userSpaceOnUse"><rect width="40" height="20" class="pf-tile"/><path d="M0 0 H40 M20 0 V20" class="pt"/></pattern>' +
      '<pattern id="p-lawn" width="6" height="10" patternUnits="userSpaceOnUse"><rect width="6" height="10" class="pf-lawn"/><path d="M3 10 L2 2 M3 10 L5 3" class="pl"/></pattern></defs>';
    const fill = { unit: null, cps: "url(#p-sand)", bulk: null, conc: "url(#p-conc)", xps: "url(#p-xps)", asph: "var(--ink-2)", sheet: null };
    vis.forEach(l => {
      let f = fill[l.kind];
      if (l.m === "tile") f = "url(#p-tile)"; if (l.m === "lawn") f = "url(#p-lawn)";
      if (l.kind === "bulk") f = l.m === "sand" ? "url(#p-sand)" : l.m === "soil" ? "url(#p-soil)" : l.m === "deco" ? "url(#p-deco)" : "url(#p-gravel)";
      if (l.kind === "sheet") s += '<line x1="' + x0 + '" x2="' + (x0 + wB) + '" y1="' + (y + 2) + '" y2="' + (y + 2) + '" class="p-sheet"/>';
      else s += '<rect x="' + x0 + '" y="' + y + '" width="' + wB + '" height="' + l.hh + '" fill="' + f + '" class="p-lay"/>' + (l.m === "conc" && /сетк/.test(l.label) ? '<line x1="' + (x0 + 6) + '" x2="' + (x0 + wB - 6) + '" y1="' + (y + l.hh * 0.45) + '" y2="' + (y + l.hh * 0.45) + '" class="p-mesh"/>' : "");
      s += '<line x1="' + (x0 + wB + 4) + '" x2="' + (labX - 4) + '" y1="' + (y + l.hh / 2) + '" y2="' + (y + l.hh / 2) + '" class="dim"/><text x="' + labX + '" y="' + (y + l.hh / 2 + 4) + '" class="p-lab">' + esc(l.label) + (l.kind === "sheet" ? "" : " — " + l.t + " мм") + "</text>";
      y += l.hh;
    });
    s += '<rect x="' + x0 + '" y="' + y + '" width="' + wB + '" height="14" fill="url(#p-soil)" opacity=".55"/><text x="' + labX + '" y="' + (y + 11) + '" class="axis">уплотнённое основание</text>';
    return s + "</svg>";
  }
  const pieInputs = [
    { k: "type", label: "Покрытие", type: "sel", def: "walk", opts: Object.entries(PIES).map(([k, p]) => [k, p[0]]) },
    { k: "A", label: "Площадь, м²", def: 40 },
    { k: "edge", label: "Длина бордюров, м", def: 30 },
    { k: "ek", label: "Бордюр", type: "sel", def: "garden", opts: [["garden", "Садовый 1000×200×80"], ["road", "Дорожный 1000×300×150"], ["none", "Без бордюра"]] }
  ];
  for (let i = 0; i < 6; i++) pieInputs.push({
    k: "t" + i, dep: "type",
    label: v => { const l = PIES[v.type][1][i]; return l ? l[1].replace(/ \d+ мм$/, "") + ", мм" : ""; },
    def: v => { const l = PIES[v.type][1][i]; return l ? l[2] : 0; },
    show: v => { const l = PIES[v.type][1][i]; return !!l && MAT[l[0]].kind !== "sheet"; }
  });
  add({
    id: "pie", cat: "land", mark: "разрез + материалы", name: "Пироги дорожек и площадок", kw: "пирог дорожка площадка плитка парковка отмостка газон асфальт щебень бордюр геотекстиль благоустройство мощение основание",
    desc: "Типовые пироги с разрезом: объём каждого слоя, выемка грунта, бордюры — всё в смету",
    inputs: pieInputs,
    run(v) {
      const P = PIES[v.type], A = v.A;
      const layers = P[1].map((l, i) => ({ m: l[0], label: l[1], t: MAT[l[0]].kind === "sheet" ? 0 : Math.max(0, v["t" + i]), kind: MAT[l[0]].kind }));
      const rows = [], items = [];
      let depth = 0;
      layers.forEach(l => {
        const M = MAT[l.m], V = A * l.t / 1000; depth += l.t;
        if (l.kind === "unit") { if (l.m === "lawn") { rows.push([l.label, nf(A * 1.05, 1) + " м²", "рулонов 0,8 м² ≈ " + nint(ceil(A * 1.05 / 0.8)) + " или семян " + nf(A * 0.04, 1) + " кг"]); items.push(["Газон рулонный", ceil(A * 1.05 / 0.8), "рул."]); } else { rows.push([l.label, nf(A * 1.05, 1) + " м²", "+5% на подрезку"]); items.push([l.label, Math.round(A * 1.05 * 10) / 10, "м²"]); } }
        else if (l.kind === "bulk") { const Vl = V * M.kc, T = Vl * M.rho; rows.push([l.label + " " + l.t + " мм", nf(Vl, 2) + " м³", nf(T, 1) + " т (уплотнение ×" + nf(M.kc, 2) + ")"]); items.push([l.label, Math.round(T * 10) / 10, "т"]); }
        else if (l.kind === "cps") { const Vl = V * 1.25, ratio = /1:4/.test(l.label) ? 4 : 5, cem = Vl / (ratio + 1) * 1.3 * 1000 / 1.1, sand = Vl * ratio / (ratio + 1) * 1.1; rows.push([l.label + " " + l.t + " мм", nf(Vl, 2) + " м³", "цемент " + nint(cem) + " кг · песок " + nf(sand, 2) + " м³"]); items.push(["Цемент ПЦ М500, 50 кг", ceil(cem / 50), "меш."], ["Песок для ЦПС", Math.round(sand * 100) / 100, "м³"]); }
        else if (l.kind === "conc") { rows.push([l.label + " " + l.t + " мм", nf(V * 1.03, 2) + " м³", /сетк/.test(l.label) ? "сетка ВР 5 100×100: " + nf(A * 1.1, 0) + " м²" : ""]); items.push([l.label.replace(" с сеткой", ""), Math.round(V * 1.03 * 100) / 100, "м³"]); if (/сетк/.test(l.label)) items.push(["Сетка кладочная ВР 5, 100×100", Math.round(A * 1.1), "м²"]); }
        else if (l.kind === "xps") { rows.push([l.label + " " + l.t + " мм", nf(A * 1.05, 1) + " м²", nf(V, 2) + " м³"]); items.push(["ЭППС " + l.t + " мм", Math.round(A * 1.05 * 10) / 10, "м²"]); }
        else if (l.kind === "asph") { const T = V * 2.35; rows.push([l.label + " " + l.t + " мм", nf(T, 1) + " т", "≈ " + nf(V, 2) + " м³ в плотном теле"]); items.push(["Асфальтобетонная смесь", Math.round(T * 10) / 10, "т"]); }
        else { rows.push([l.label, nf(A * 1.15, 1) + " м²", "с нахлёстом 15%"]); items.push([l.label, Math.round(A * 1.15), "м²"]); }
      });
      const exc = A * depth / 1000, loose = exc * 1.25;
      if (v.ek !== "none" && v.edge > 0) { const road = v.ek === "road"; const n = ceil(v.edge * 1.02); const c = v.edge * (road ? 0.06 : 0.03); rows.push([road ? "Бордюр дорожный 1000×300×150" : "Бордюр садовый 1000×200×80", nint(n) + " шт.", "бетон на замок ≈ " + nf(c, 2) + " м³"]); items.push([road ? "Бордюр дорожный 1000×300×150" : "Бордюр садовый 1000×200×80", n, "шт."], ["Бетон B15 под бордюр", Math.round(c * 100) / 100, "м³"]); }
      return {
        stats: [S("Толщина пирога", nint(depth), "мм"), S("Выемка грунта", nf(exc, 1), "м³", "вывоз ≈ " + nf(loose, 1) + " м³ в разрыхлении"), S("Площадь", nf(A, 1), "м²"), S("Позиций материалов", nint(items.length), "", "кнопка «+ В смету» сверху", true)],
        blocks: [{ title: "Разрез: " + P[0], html: '<div class="chart-scroll">' + pieSVG(layers) + "</div>" }],
        table: { head: ["Слой", "Количество", "Примечание"], rows }, items
      };
    },
    info: "Пироги — типовые для средней полосы на непучинистом или осушенном основании. Насыпные слои: объём к закупке = площадь × толщина × коэффициент уплотнения (песок 1,2, щебень 1,3). На глинах и при высоких водах добавьте дренаж и увеличьте песчаный слой; под проезд грузовой техники основание считается по нагрузке."
  });

  // ---------- Септик ----------
  add({
    id: "septic", cat: "land", name: "Септик из колец", kw: "септик канализация кольца кс жб выгребная яма автономная станция очистки объем отстойник фильтрующий колодец",
    desc: "Объём по СП 32, число камер и колец, плиты днища и перекрытия",
    inputs: [
      { k: "n", label: "Проживает человек", def: 4 },
      { k: "q", label: "Расход на человека, л/сут", def: 200, hint: "С ванной и стиралкой — 200, без ванны — 150" },
      { k: "d", label: "Кольца", type: "sel", def: "1.5", opts: [["1", "КС 10.9 (Ø 1,0 м)"], ["1.5", "КС 15.9 (Ø 1,5 м)"], ["2", "КС 20.9 (Ø 2,0 м)"]] },
      { k: "ch", label: "Камер-отстойников", type: "sel", def: "2", opts: [["1", "1"], ["2", "2"], ["3", "3"]] },
      { k: "inlet", label: "Глубина ввода трубы, м", def: 1.2, hint: "Лоток трубы на входе в септик" },
      { k: "filt", label: "Последним — фильтрующий колодец", type: "check", def: true }
    ],
    run(v) {
      const Q = v.n * v.q / 1000, V = Q <= 5 ? 3 * Q : 2.5 * Q;
      const d = num(v.d), area = Math.PI * d * d / 4, nc = +v.ch;
      const share = nc === 1 ? [1] : nc === 2 ? [0.75, 0.25] : [0.5, 0.25, 0.25];
      const ringCode = { 1: "КС 10.9", 1.5: "КС 15.9", 2: "КС 20.9" }[d];
      const rows = [];
      const h = Math.max(1, V * share[0] / area); // глубина жидкости по первой камере, остальные — такой же высоты
      const r1 = Math.max(2, ceil((v.inlet + h + 0.05) / 0.9));
      let rings = 0, Vact = 0;
      share.forEach((s, i) => {
        const r = i === 0 ? r1 : Math.max(2, r1 - 1);
        const hh = i === 0 ? h : Math.max(0.6, h - 0.9 + 0.05 * i);
        rings += r; Vact += area * hh;
        rows.push(["Камера " + (i + 1), nf(area * hh, 2) + " м³", nf(hh, 2) + " м жидкости", nint(r) + " колец " + ringCode]);
      });
      let filtR = 0;
      if (v.filt) { filtR = Math.max(2, ceil((v.inlet + 1.2) / 0.9)); rows.push(["Фильтрующий колодец", "—", "дно — щебень 0,5 м", nint(filtR) + " колец " + ringCode + " (перфорированных)"]); }
      const wells = nc + (v.filt ? 1 : 0);
      const items = [["Кольцо " + ringCode, rings + filtR, "шт."], ["Плита днища ПН " + Math.round(d * 10), nc, "шт."], ["Плита перекрытия с люком 1ПП " + Math.round(d * 10), wells, "шт."], ["Люк полимерный", wells, "шт."], ["Труба ПВХ 110 для переливов", 6 * wells, "м"]];
      if (v.filt) items.push(["Щебень 20–40 на дно фильтрующего колодца", Math.round(area * 0.5 * 1.37 * 10) / 10, "т"]);
      return {
        stats: [S("Суточный приток", nf(Q, 2), "м³/сут"), S("Объём септика по СП 32", nf(V, 2), "м³", Q <= 5 ? "трёхсуточный приток" : "2,5-кратный приток", true), S("Колец всего", nint(rings + filtR), "шт.", ringCode + " · рабочий объём " + nf(Vact, 1) + " м³"), S("Колодцев", nint(wells), "шт.")],
        table: { head: ["Камера", "Объём", "Слой жидкости", "Колец"], rows },
        warn: v.filt ? "Фильтрующий колодец работает только на песках и супесях при уровне вод ниже дна на 1 м и более. На глине и при высоких водах нужна станция биоочистки или поле фильтрации с дренажом." : "",
        items
      };
    },
    info: "СП 32.13330: полный объём септика при притоке до 5 м³/сут — не менее трёхсуточного, свыше — 2,5-суточного. В двухкамерном первая камера — 75% объёма, в трёхкамерном — 50%. Расстояния: от дома не менее 5 м, от колодца или скважины — не менее 50 м (по СанПиН зависит от грунта)."
  });

  // ---------- Дренаж ----------
  add({
    id: "drain", cat: "land", name: "Дренаж вокруг дома", kw: "дренаж кольцевой пристенный труба дренажная геотекстиль щебень колодцы уклон грунтовые воды водоотвод",
    desc: "Длина трубы, уклон и перепад, щебень, геотекстиль, колодцы, объём траншеи",
    inputs: [
      { k: "L", label: "Длина дома, м", def: 10 }, { k: "B", label: "Ширина дома, м", def: 9 },
      { k: "off", label: "Отступ от стены, м", def: 1, hint: "Кольцевой дренаж — 1–3 м от фундамента" },
      { k: "sole", label: "Глубина подошвы фундамента, м", def: 1.5 },
      { k: "sl", label: "Уклон, %", def: 0.5, hint: "Не менее 0,2% в глинах и 0,3% в песках, удобно 0,5–1%" },
      { k: "gw", label: "Ширина траншеи по дну, м", def: 0.4 },
      { k: "gh", label: "Высота щебёночной обсыпки, м", def: 0.4 },
      { k: "out", label: "Отвод до сборного колодца, м", def: 8 }
    ],
    run(v) {
      const Lr = 2 * (v.L + 2 * v.off + v.B + 2 * v.off);
      const pipe = (Lr + v.out) * 1.05;
      const half = Lr / 2, fall = half * v.sl / 100;
      const top = v.sole + 0.3, bot = top + fall;
      const avgD = (top + bot) / 2 + 0.1;
      const trench = Lr * (v.gw + 0.3) * avgD + v.out * 0.6 * bot;
      const grav = Lr * v.gw * v.gh - Lr * 0.0095;
      const geo = Lr * (2 * (v.gw + v.gh) + 0.3);
      const wells = 4 + Math.floor(Lr / 25) + 1;
      return {
        stats: [S("Труба дренажная Ø110", nf(pipe, 0), "м", "в геотекстиле, с запасом 5%"), S("Перепад по кольцу", nint(fall * 1000), "мм", "от верхней точки до сборного колодца"), S("Глубина лотка", nf(top, 2) + "–" + nf(bot, 2), "м", "на 0,3 м ниже подошвы"), S("Щебень 20–40", nf(grav * 1.37 * 1.1, 1), "т", nf(grav, 1) + " м³"), S("Колодцев", nint(wells), "шт.", "на углах + сборный")],
        table: { head: ["Позиция", "Количество"], rows: [["Длина кольца по оси трубы", nf(Lr, 1) + " м"], ["Геотекстиль 200 г/м² (обёртка щебня)", nf(geo, 0) + " м²"], ["Объём траншеи", nf(trench, 1) + " м³"], ["Песок для обратной засыпки (≈ 60% траншеи)", nf(trench * 0.6, 1) + " м³"]] },
        items: [["Труба дренажная ПНД 110 в геотекстиле", Math.round(pipe), "м"], ["Щебень гранитный 20–40", Math.round(grav * 1.37 * 1.1 * 10) / 10, "т"], ["Геотекстиль 200 г/м²", Math.round(geo), "м²"], ["Колодец дренажный Ø315", wells - 1, "шт."], ["Колодец сборный Ø400–630", 1, "шт."]]
      };
    },
    info: "Две ветки кольца сходятся к сборному колодцу в нижней точке участка — поэтому перепад считается на половину длины кольца. Ревизионные колодцы — на углах и через каждые 25 м. Сборный колодец откачивается насосом или имеет перелив в канаву."
  });

  // ====================================================================
  //  ОЗЕЛЕНЕНИЕ
  // ====================================================================
  // [id, название, латинское, категория, зона USDA (мин.), высота м, ширина м, свет (s солнце, p полутень, t тень), почва, цветение [мес1, мес2] | 0, цвет, теги, посадка, уход, зима]
  const PL = [
    // --- лиственные деревья
    ["birch", "Берёза повислая", "Betula pendula", "tree", 2, 20, 8, "sp", "any", 0, "#d9c75a", "fast easy autumn", "Весной до распускания почек или в сентябре, лучше с комом.", "В первый год полив раз в неделю 30–50 л. Формирующую обрезку — только летом или осенью: весной берёза сильно «плачет».", "Зимует без укрытия."],
    ["mapleN", "Клён остролистный", "Acer platanoides", "tree", 3, 20, 12, "sp", "any", [4, 5], "#e8a33c", "fast autumn honey", "Весна или начало осени, корневая шейка на уровне земли.", "Неприхотлив, переносит город. Санитарная обрезка — конец лета.", "Без укрытия; молодые штамбы обмотать от солнечных ожогов."],
    ["mapleG", "Клён Гиннала (приречный)", "Acer tataricum subsp. ginnala", "tree", 2, 5, 4, "sp", "any", [5, 6], "#c4382b", "easy autumn hedge", "Весной или осенью, яма 60×60 см.", "Один из самых ярких осенью — алые листья. Хорошо переносит стрижку.", "Полностью зимостоек."],
    ["rowan", "Рябина обыкновенная", "Sorbus aucuparia", "tree", 2, 8, 5, "sp", "any", [5, 6], "#e06a2b", "easy autumn berry honey", "Весной или осенью, с комом.", "Почти не требует ухода; любит лёгкие суглинки. Ягоды украшают сад до зимы и кормят птиц.", "Без укрытия."],
    ["linden", "Липа мелколистная", "Tilia cordata", "tree", 3, 20, 10, "spt", "rich", [7, 7], "#e7d36b", "honey fragrant hedge", "Весной, крупномер — с комом, в яму с плодородным грунтом.", "Медонос, июльское цветение с ароматом. Отлично стрижётся в «шпалеру» и «зелёную крышу».", "Без укрытия."],
    ["oak", "Дуб черешчатый", "Quercus robur", "tree", 4, 25, 15, "s", "rich", 0, "#a3772f", "autumn", "Весной; сеянцы 2–3 лет приживаются лучше крупномеров (длинный стержневой корень).", "Растёт медленно, живёт сотни лет. Сажайте не ближе 8–10 м от дома.", "Молодые деревья — мульча в приствольный круг."],
    ["chestnut", "Каштан конский", "Aesculus hippocastanum", "tree", 4, 20, 12, "sp", "rich", [5, 6], "#f2efe6", "honey", "Весной, место без застоя воды.", "Пышные «свечи» цветков в мае. Подкормка весной, мульча.", "Молодые — укрыть штамб мешковиной первые 2–3 зимы."],
    ["willow", "Ива белая плакучая", "Salix alba 'Tristis'", "tree", 3, 15, 10, "sp", "wet", 0, "#e2d36a", "fast", "Весной; идеальна у пруда и на мокрых местах.", "Много воды; сильно растёт — сажайте далеко от труб и дренажа.", "Без укрытия."],
    ["cherryB", "Черёмуха обыкновенная", "Prunus padus", "tree", 2, 8, 6, "spt", "any", [5, 5], "#ffffff", "easy fragrant honey", "Весной или осенью.", "Ароматное цветение в мае; даёт поросль — удаляйте.", "Без укрытия."],
    ["malus", "Яблоня декоративная (Недзвецкого, 'Ройялти')", "Malus × purpurea", "tree", 3, 5, 4, "s", "any", [5, 5], "#c03a74", "autumn", "Весной, солнечное место, яма 70×70 см.", "Пурпурная листва и малиновое цветение. Обрезка в марте.", "Без укрытия; штамб — побелка или обмотка от зайцев."],
    // --- хвойные
    ["spruceP", "Ель колючая (голубая)", "Picea pungens", "conifer", 2, 15, 5, "s", "any", 0, "#7ea2bf", "evergreen winter", "Апрель–май или конец августа–сентябрь, только с комом.", "Голубизна ярче на солнце. Не заглубляйте корневую шейку. Полив в засуху.", "Без укрытия; первую весну притенить от ожогов."],
    ["spruce", "Ель обыкновенная", "Picea abies", "conifer", 2, 25, 6, "spt", "rich", 0, "#2f5d3a", "evergreen winter hedge", "С комом, весной или в конце лета.", "Терпит тень, отлично стрижётся в плотную изгородь. Карликовые формы ('Нидиформис') — для композиций.", "Без укрытия."],
    ["pine", "Сосна обыкновенная", "Pinus sylvestris", "conifer", 2, 25, 8, "s", "sand dry", 0, "#3d6b3f", "evergreen winter easy", "Весной, только с комом — корни быстро пересыхают.", "Любит песок и солнце, не переносит застоя воды. Формируют «прищипкой» свечей в мае.", "Без укрытия."],
    ["pineM", "Сосна горная", "Pinus mugo", "conifer", 3, 2, 2, "s", "any dry", 0, "#3f7247", "evergreen winter easy", "Весной или в конце лета, с комом.", "Компактная, идеальна для рокария и у входа. Прищипка свечей для плотности.", "Без укрытия."],
    ["larch", "Лиственница сибирская", "Larix sibirica", "conifer", 1, 25, 8, "s", "any", 0, "#d8b64c", "fast autumn", "Ранней весной до распускания хвои.", "Сбрасывает хвою на зиму — золотая осенью. Быстрорастущая, светолюбивая.", "Без укрытия."],
    ["thujaS", "Туя западная 'Смарагд'", "Thuja occidentalis 'Smaragd'", "conifer", 4, 4, 1.2, "sp", "rich", 0, "#2e7d4d", "evergreen hedge winter", "Апрель–май или август–сентябрь, с комом; для изгороди — шаг 0,5–0,7 м.", "Обильный полив первый год, мульча. Стрижка — июнь.", "Первые 2–3 зимы — укрыть от февральского солнца и связать от снега."],
    ["thujaB", "Туя западная 'Брабант'", "Thuja occidentalis 'Brabant'", "conifer", 4, 8, 2, "sp", "rich", 0, "#3c8a4e", "evergreen hedge fast", "С комом; изгородь — шаг 0,6–0,8 м.", "Растёт быстрее 'Смарагда' (до 30 см в год), стрижка 2 раза за сезон.", "Притенение от весенних ожогов первые годы."],
    ["junS", "Можжевельник казацкий", "Juniperus sabina", "conifer", 3, 1, 3, "s", "sand dry", 0, "#4b7a54", "evergreen easy winter", "Весной или в начале осени, на дренаж.", "Засухоустойчив, держит склоны. Ядовит — учитывайте, если есть дети и животные.", "Без укрытия."],
    ["junH", "Можжевельник горизонтальный", "Juniperus horizontalis", "ground", 3, 0.3, 2, "s", "sand dry", 0, "#5f8fa0", "evergreen easy winter", "Весной, шаг 0,8–1 м как почвопокровник.", "Стелется ковром, зимой у многих сортов сизо-фиолетовый.", "Без укрытия."],
    ["firK", "Пихта корейская", "Abies koreana", "conifer", 5, 4, 2, "sp", "rich acid", 0, "#2c5e44", "evergreen winter", "Весной с комом, в кисловатый грунт.", "Медленно растёт, рано даёт фиолетовые шишки. Не терпит загазованности и застоя воды.", "Молодые — укрыть лапником от ожогов."],
    ["taxus", "Тис средний", "Taxus × media", "conifer", 5, 3, 2, "spt", "rich", 0, "#1f4d33", "evergreen hedge winter", "Весной, с комом.", "Лучший хвойный для тени и стрижки. Ядовит.", "В средней полосе — укрытие первые зимы."],
    // --- кустарники
    ["spJ", "Спирея японская", "Spiraea japonica", "shrub", 4, 0.8, 1, "sp", "any", [6, 8], "#e07ab0", "easy hedge honey", "Весной или в сентябре, шаг 0,5 м для бордюра.", "Цветёт всё лето. Обрезка ранней весной почти до земли — будет компактной.", "Без укрытия."],
    ["spV", "Спирея Вангутта", "Spiraea × vanhouttei", "shrub", 4, 2, 2, "sp", "any", [5, 6], "#ffffff", "easy hedge", "Весной или осенью.", "«Белый водопад» в конце мая. Обрезка — сразу после цветения.", "Без укрытия."],
    ["physo", "Пузыреплодник 'Диаболо'", "Physocarpus opulifolius 'Diabolo'", "shrub", 3, 2.5, 2, "s", "any", [6, 6], "#6e1f3a", "easy hedge fast foliage", "Весна или осень, изгородь — шаг 0,4–0,5 м.", "Тёмно-бордовая листва весь сезон. Стрижка 2–3 раза за лето.", "Без укрытия."],
    ["cornus", "Дёрен белый", "Cornus alba", "shrub", 2, 2.5, 2.5, "spt", "any wet", [5, 6], "#c8352f", "easy winter hedge", "Весной, любые почвы, даже сырые.", "Красные побеги особенно эффектны зимой на снегу. Раз в 3 года омолаживающая обрезка «на пенёк».", "Без укрытия."],
    ["hydP", "Гортензия метельчатая", "Hydrangea paniculata", "shrub", 4, 2, 2, "sp", "rich acid", [7, 9], "#f3e3ea", "easy", "Весной в кислую влажную почву (торф, хвойный опад).", "Обильный полив, кислые подкормки. Обрезка весной на 2–4 почки — цветёт на побегах текущего года.", "Без укрытия; соцветия можно оставить на зиму."],
    ["hydA", "Гортензия древовидная 'Анабель'", "Hydrangea arborescens 'Annabelle'", "shrub", 4, 1.5, 1.5, "pt", "rich", [7, 9], "#ffffff", "easy", "Весной, полутень, влажное место.", "Огромные белые шары. Весной обрезать на 10–20 см от земли.", "Подмерзает, но восстанавливается за сезон."],
    ["berb", "Барбарис Тунберга", "Berberis thunbergii", "shrub", 4, 1.5, 1.5, "s", "any dry", [5, 5], "#a62a2a", "easy hedge autumn foliage", "Весной или осенью; низкая изгородь — шаг 0,4 м.", "Окраска листвы ярче на солнце. Колючий — защитная изгородь.", "Молодые кусты — укрыть лапником."],
    ["phil", "Чубушник (садовый жасмин)", "Philadelphus coronarius", "shrub", 4, 2.5, 2, "sp", "any", [6, 6], "#ffffff", "easy fragrant", "Весной или в сентябре.", "Сильный аромат в июне. Обрезка отцветших ветвей сразу после цветения.", "Без укрытия."],
    ["coton", "Кизильник блестящий", "Cotoneaster lucidus", "shrub", 3, 2, 1.5, "sp", "any", 0, "#2f6b3a", "easy hedge autumn", "Изгородь — траншея 50×50 см, шаг 0,3–0,4 м в 1–2 ряда.", "Классическая стриженая изгородь, переносит город и загазованность. Стрижка с июня.", "Без укрытия."],
    ["potent", "Лапчатка кустарниковая", "Dasiphora fruticosa", "shrub", 2, 1, 1, "s", "any", [6, 9], "#f2c94c", "easy hedge", "Весной, шаг для бордюра 0,4–0,5 м.", "Цветёт всё лето до заморозков. Весенняя обрезка на треть.", "Без укрытия."],
    ["rugosa", "Роза морщинистая (парковая)", "Rosa rugosa", "shrub", 2, 1.5, 1.5, "s", "any sand", [6, 9], "#d9468f", "easy hedge fragrant", "Весной или осенью, на 3–5 см глубже корневой шейки.", "Самая неприхотливая роза: цветёт всё лето, крупные плоды осенью. Даёт поросль.", "Без укрытия."],
    ["roseHT", "Розы чайно-гибридные", "Rosa (Hybrid Tea)", "shrub", 6, 1, 0.7, "s", "rich", [6, 9], "#d23a52", "fragrant", "Весной (май), место привоя на 3–5 см ниже уровня почвы.", "Подкормки каждые 2–3 недели до августа, обрезка весной на 3–4 почки, обработки от болезней.", "В средней полосе — обязательное воздушно-сухое укрытие при −5…−7 °C."],
    ["lilac", "Сирень обыкновенная", "Syringa vulgaris", "shrub", 3, 4, 3, "s", "any", [5, 5], "#a678c8", "easy fragrant hedge", "Конец августа–сентябрь или ранняя весна.", "Удаляйте поросль и отцветшие кисти. Не любит кислые и сырые почвы.", "Без укрытия."],
    ["lilacH", "Сирень венгерская", "Syringa josikaea", "shrub", 3, 3, 2, "sp", "any", [6, 6], "#9b6bc0", "easy hedge", "Весной или осенью; изгородь — шаг 0,5–0,7 м.", "Не даёт поросли, отлично стрижётся. Цветёт позже обыкновенной.", "Без укрытия."],
    ["vib", "Калина 'Бульденеж'", "Viburnum opulus 'Roseum'", "shrub", 3, 3, 3, "sp", "any wet", [5, 6], "#ffffff", "easy", "Весной или осенью.", "Белые шары в июне. Следите за калиновым листоедом — обработка в мае.", "Без укрытия."],
    ["amel", "Ирга канадская", "Amelanchier canadensis", "shrub", 3, 5, 4, "sp", "any", [5, 5], "#ffffff", "easy berry autumn honey", "Весной или осенью.", "Белое облако цветов, вкусные ягоды, красная осенняя листва — красива круглый год.", "Без укрытия."],
    ["rhodo", "Рододендрон кэтевбинский", "Rhododendron catawbiense", "shrub", 5, 2, 2, "pt", "acid rich", [5, 6], "#c45aa8", "evergreen", "Весной в кислую торфяную смесь (pH 4,5–5,5), неглубоко, без извести.", "Мульча хвойным опадом, кислый полив, защита от ветра.", "Укрытие от зимнего солнца и ветра обязательно."],
    ["mahon", "Магония падуболистная", "Mahonia aquifolium", "shrub", 5, 1, 1, "pt", "any", [5, 5], "#f2c94c", "evergreen berry", "Весной, в тени деревьев.", "Вечнозелёная, зимой листья бронзовеют. Синие ягоды.", "Под снегом зимует хорошо; укрыть от солнца в марте."],
    ["boxw", "Самшит вечнозелёный", "Buxus sempervirens", "shrub", 6, 1, 1, "pt", "rich", 0, "#2f6b3a", "evergreen hedge", "Весной, с комом.", "Мелкие бордюры и топиари. Стрижка 2–3 раза за сезон.", "В средней полосе — укрытие спанбондом, иначе выгорает и подмерзает."],
    ["forsyth", "Форзиция", "Forsythia × intermedia", "shrub", 5, 2, 2, "s", "any", [4, 5], "#f6c90e", "", "Весной, место, защищённое от ветра.", "Самое раннее жёлтое цветение. Обрезка — сразу после цветения.", "В средней полосе цветочные почки над снегом часто подмерзают — пригибайте ветви."],
    // --- плодовые
    ["apple", "Яблоня (Антоновка, Мельба, Медуница)", "Malus domestica", "fruit", 3, 5, 5, "s", "rich", [5, 5], "#f6d7e3", "fruit honey", "Весной (апрель) или в конце сентября; яма 80×80 см, колышек с южной стороны, шейка на уровне земли.", "Обрезка в марте, побелка штамба осенью и в феврале, обработки от парши и плодожорки. Для урожая нужно 2 сорта рядом.", "Обмотка штамба сеткой от грызунов."],
    ["pear", "Груша (Чижовская, Лада, Памяти Яковлева)", "Pyrus communis", "fruit", 4, 5, 4, "s", "rich", [5, 5], "#ffffff", "fruit", "Весной, солнечное защищённое место, грунтовые воды не выше 2 м.", "Обрезка в марте, обязательно 2 сорта для опыления.", "Побелка, защита от грызунов."],
    ["cherry", "Вишня (Владимирская, Любская, Молодёжная)", "Prunus cerasus", "fruit", 4, 3, 3, "s", "any", [5, 5], "#ffffff", "fruit honey", "Весной, на возвышенном месте — не любит застоя воды.", "Обработки от коккомикоза и монилиоза. Удаление поросли.", "Без укрытия; побелка."],
    ["plum", "Слива (Евразия, Утро, Скороплодная)", "Prunus domestica", "fruit", 4, 4, 3, "s", "rich", [5, 5], "#ffffff", "fruit", "Весной, на солнечном склоне, без низин.", "Регулярный полив в засуху, удаление поросли. Многие сорта самобесплодны.", "Без укрытия в средней полосе для районированных сортов."],
    ["currant", "Смородина чёрная", "Ribes nigrum", "berry", 2, 1.5, 1.5, "sp", "rich", [5, 5], "#6b8f3e", "fruit easy", "Лучше осенью (сентябрь), с наклоном 45° и заглублением на 5–7 см.", "Ежегодно вырезать ветви старше 5 лет. Подкормка весной азотом, летом — калием.", "Без укрытия."],
    ["goose", "Крыжовник", "Ribes uva-crispa", "berry", 3, 1.2, 1.5, "s", "any", [5, 5], "#8fae4d", "fruit easy", "Осенью, шаг 1,2–1,5 м.", "Обработки от американской мучнистой росы, обрезка старых ветвей.", "Без укрытия."],
    ["rasp", "Малина (ремонтантная и летняя)", "Rubus idaeus", "berry", 3, 1.8, 0.5, "s", "rich", [6, 7], "#ffffff", "fruit easy", "Траншея 40×40 см, шаг 0,5 м, ряды через 1,5–2 м.", "Шпалера, мульча, удаление отплодоносивших побегов. Ремонтантную скашивают под корень осенью.", "Без укрытия."],
    ["honeys", "Жимолость съедобная", "Lonicera caerulea", "berry", 2, 1.5, 1.5, "s", "any", [4, 5], "#f2e6a8", "fruit easy honey", "Конец лета–осень; обязательно 2–3 сорта рядом для опыления.", "Самая ранняя ягода (начало июня). Почти не болеет.", "Без укрытия."],
    ["seabuck", "Облепиха", "Hippophae rhamnoides", "berry", 2, 3, 3, "s", "sand dry", 0, "#f09a1a", "fruit easy", "Весной; нужно женское растение и мужское (1 на 5–8 женских).", "Корни расходятся далеко и дают поросль — ограничьте шифером.", "Без укрытия."],
    ["blueb", "Голубика садовая", "Vaccinium corymbosum", "berry", 4, 1.5, 1.2, "s", "acid", [5, 6], "#5f7fb8", "fruit autumn", "Только в кислый грунт (верховой торф, pH 4–5): яма 60×60 см, плёнка по стенкам на суглинке.", "Подкисление водой с лимонной кислотой, мульча хвоей. Обычные удобрения губят.", "Сорта северной селекции без укрытия."],
    ["grape", "Виноград (Альфа, Кристалл, Плевен)", "Vitis", "berry", 5, 3, 1.5, "s", "any", 0, "#6b2f6b", "fruit", "Весной у южной стены, глубокая посадка с дренажом.", "Формировка по шпалере, обрезка осенью и пасынкование летом.", "Укрывное: снять со шпалеры и укрыть до заморозков."],
    // --- многолетники
    ["hosta", "Хоста", "Hosta", "perennial", 3, 0.6, 0.8, "pt", "rich wet", [7, 8], "#9cb8a8", "easy foliage", "Весной или в конце лета, делением куста.", "Главное — листва. Полив, мульча; защита от слизней.", "Без укрытия."],
    ["peony", "Пион травянистый", "Paeonia lactiflora", "perennial", 3, 0.9, 0.9, "s", "rich", [6, 6], "#e47aa0", "easy fragrant", "Только конец августа–сентябрь; почки на 3–5 см ниже земли — иначе не зацветёт.", "Растёт на одном месте десятилетиями. Опора для крупных цветков.", "Стебли срезать осенью."],
    ["dayl", "Лилейник", "Hemerocallis", "perennial", 3, 0.8, 0.8, "sp", "any", [6, 8], "#ef8a2f", "easy", "Весной или в августе, делением.", "Почти не требует ухода, цветёт в любом месте.", "Без укрытия."],
    ["phlox", "Флокс метельчатый", "Phlox paniculata", "perennial", 3, 1, 0.6, "sp", "rich", [7, 8], "#c45aa8", "easy fragrant honey", "Весной или осенью.", "Влажная плодородная почва, деление раз в 5 лет.", "Без укрытия."],
    ["astil", "Астильба", "Astilbe", "perennial", 4, 0.7, 0.5, "pt", "rich wet", [6, 7], "#e889a6", "", "Весной, в тени и влаге.", "Не переносит пересыхания. Мульча.", "Без укрытия."],
    ["echin", "Эхинацея пурпурная", "Echinacea purpurea", "perennial", 4, 0.9, 0.5, "s", "any dry", [7, 9], "#c95c9a", "easy honey", "Весной.", "Засухоустойчива, привлекает бабочек.", "Без укрытия."],
    ["iris", "Ирис бородатый", "Iris germanica", "perennial", 3, 0.8, 0.5, "s", "dry sand", [5, 6], "#6d67c9", "easy", "Июль–август, корневище наполовину над землёй.", "Не заглублять и не мульчировать корневище.", "Без укрытия."],
    ["bergen", "Бадан", "Bergenia", "perennial", 3, 0.4, 0.5, "pt", "any", [4, 5], "#e0699a", "easy evergreen foliage", "Весной или в конце лета.", "Крупные кожистые листья зимуют зелёными, весной — розовые цветы.", "Без укрытия."],
    ["heuch", "Гейхера", "Heuchera", "perennial", 4, 0.4, 0.4, "p", "rich", [6, 7], "#7d2f4f", "foliage", "Весной.", "Яркая листва — от лаймовой до тёмно-бордовой.", "Укрыть лапником от весеннего солнца."],
    ["rudb", "Рудбекия блестящая", "Rudbeckia fulgida", "perennial", 4, 0.7, 0.5, "s", "any", [7, 9], "#f2b31c", "easy honey", "Весной.", "Цветёт до заморозков, неприхотлива.", "Без укрытия."],
    ["lav", "Лаванда узколистная", "Lavandula angustifolia", "perennial", 5, 0.5, 0.5, "s", "dry sand", [7, 8], "#8d7fd1", "fragrant honey", "Весной на сухое солнечное место с дренажом.", "Не поливать часто; стрижка после цветения.", "В средней полосе — сорта 'Хидкот', 'Мунстед', сухое укрытие лапником."],
    ["leuc", "Нивяник (садовая ромашка)", "Leucanthemum", "perennial", 4, 0.7, 0.4, "s", "any", [6, 8], "#ffffff", "easy", "Весной или в августе.", "Деление раз в 3 года.", "Без укрытия."],
    ["nepeta", "Котовник Фассена", "Nepeta × faassenii", "perennial", 4, 0.5, 0.6, "s", "dry", [6, 9], "#8f96d8", "easy honey", "Весной.", "После первой волны цветения подстричь — зацветёт снова.", "Без укрытия."],
    ["delph", "Дельфиниум", "Delphinium", "perennial", 3, 1.6, 0.6, "s", "rich", [6, 7], "#3f62c8", "", "Весной.", "Высоким нужна опора; срезать отцветшие стрелки.", "Без укрытия; главная опасность — вымокание."],
    ["salvia", "Шалфей дубравный", "Salvia nemorosa", "perennial", 4, 0.5, 0.4, "s", "dry", [6, 8], "#6f4fbf", "easy honey", "Весной.", "Засухоустойчив; стрижка после цветения для повторной волны.", "Без укрытия."],
    ["aquil", "Аквилегия (водосбор)", "Aquilegia", "perennial", 3, 0.6, 0.4, "sp", "any", [5, 6], "#8a6fc9", "easy", "Весной или посев осенью.", "Даёт самосев, живёт 4–5 лет.", "Без укрытия."],
    ["misc", "Мискантус китайский", "Miscanthus sinensis", "perennial", 5, 1.6, 1, "s", "rich wet", [8, 9], "#d9c8a0", "foliage winter", "Весной (май), когда прогреется почва.", "Злак-«фонтан», красив зимой. Срезать весной.", "Мульча корней."],
    ["festuca", "Овсяница сизая", "Festuca glauca", "perennial", 4, 0.3, 0.3, "s", "dry sand", 0, "#8fb3c7", "easy foliage evergreen", "Весной, группами.", "Голубые «ёжики» для рокариев и бордюров. Деление раз в 3 года.", "Без укрытия."],
    ["tulip", "Тюльпаны", "Tulipa", "perennial", 3, 0.5, 0.15, "s", "any", [5, 5], "#e0344b", "bulb", "Сентябрь — начало октября, на глубину 3 высоты луковицы.", "Выкапывать раз в 2–3 года после пожелтения листьев.", "Без укрытия."],
    ["narc", "Нарциссы", "Narcissus", "perennial", 4, 0.4, 0.15, "sp", "any", [4, 5], "#f6d64a", "bulb easy", "Конец августа — сентябрь.", "Не выкапывают 4–5 лет; грызуны не трогают.", "Без укрытия."],
    // --- почвопокровные
    ["vinca", "Барвинок малый", "Vinca minor", "ground", 4, 0.15, 0.6, "pt", "any", [5, 5], "#5b6fd6", "evergreen easy", "Весной, шаг 0,3 м.", "Ковёр под деревьями, листья зелёные под снегом.", "Без укрытия."],
    ["ajuga", "Живучка ползучая", "Ajuga reptans", "ground", 3, 0.15, 0.4, "spt", "any", [5, 6], "#4f5fc0", "easy", "Весной, шаг 0,25 м.", "Быстро затягивает землю, сорта с бордовой листвой.", "Без укрытия."],
    ["sedum", "Очиток (седум)", "Sedum", "ground", 3, 0.15, 0.4, "s", "dry sand", [7, 8], "#f2c94c", "easy honey", "Весной, на сухие места и рокарии.", "Полив почти не нужен.", "Без укрытия."],
    ["thyme", "Тимьян ползучий (чабрец)", "Thymus serpyllum", "ground", 4, 0.1, 0.4, "s", "dry sand", [6, 7], "#c27ab7", "easy fragrant honey", "Весной, между плитами дорожек и на склонах.", "Стрижка после цветения.", "Без укрытия."],
    ["phloxS", "Флокс шиловидный", "Phlox subulata", "ground", 3, 0.15, 0.5, "s", "dry sand", [5, 6], "#e46fb0", "easy", "Весной, шаг 0,3 м.", "Сплошной цветущий ковёр в мае; стрижка после цветения.", "Без укрытия."],
    ["lamium", "Яснотка крапчатая", "Lamium maculatum", "ground", 4, 0.2, 0.5, "pt", "any", [5, 7], "#d98ab8", "easy", "Весной.", "Серебристые листья осветляют тень.", "Без укрытия."],
    ["convall", "Ландыш майский", "Convallaria majalis", "ground", 2, 0.2, 0.3, "pt", "any", [5, 5], "#ffffff", "easy fragrant", "Конец лета, корневищами.", "Агрессивно разрастается; ядовит.", "Без укрытия."]
  ].map(a => ({ id: a[0], n: a[1], lat: a[2], cat: a[3], z: a[4], h: a[5], w: a[6], light: a[7], soil: a[8], bloom: a[9] || null, color: a[10], tags: a[11].split(" ").filter(Boolean), plant: a[12], care: a[13], winter: a[14] }));
  const PCAT = { tree: "Лиственные деревья", conifer: "Хвойные", shrub: "Кустарники", fruit: "Плодовые деревья", berry: "Ягодники", perennial: "Многолетние цветы и злаки", ground: "Почвопокровные" };
  const MONTHS_G = ["", "янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const zoneOf = t => t == null ? null : Math.max(1, Math.min(9, Math.floor((t + 51.1) / 5.56) + 1));
  const zoneHalf = t => { const z = zoneOf(t); const lo = -51.1 + (z - 1) * 5.56; return z + (t - lo >= 2.78 ? "b" : "a"); };
  const doyStr = d => { if (d == null) return "—"; const dt = new Date(Date.UTC(2023, 0, 1) + (Math.round(d) - 1) * 864e5); return dt.getUTCDate() + " " + ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"][dt.getUTCMonth()]; };
  const lightTxt = l => [l.includes("s") ? "солнце" : "", l.includes("p") ? "полутень" : "", l.includes("t") ? "тень" : ""].filter(Boolean).join(", ");
  const climateInputs = [
    { k: "place", label: "Населённый пункт", type: "place" },
    { k: "zsrc", label: "Зона зимостойкости", type: "sel", def: "auto", opts: [["auto", "Определить по погоде за 15 лет"], ["2", "2 (до −45 °C)"], ["3", "3 (до −40 °C)"], ["4", "4 (до −34 °C)"], ["5", "5 (до −29 °C) — средняя полоса"], ["6", "6 (до −23 °C)"], ["7", "7 (до −18 °C) — юг"]] }
  ];
  const climKey = v => v.zsrc === "auto" ? v.place.latitude.toFixed(2) + "," + v.place.longitude.toFixed(2) : "z" + v.zsrc;
  const climLoad = v => v.zsrc === "auto" ? loadClimate(v.place) : Promise.resolve(null);
  function siteZone(v, data, loading) {
    if (v.zsrc !== "auto") return { z: +v.zsrc, zl: v.zsrc, ok: true };
    if (loading) return { loading: true };
    if (!data || data.error || data.tmin == null) return { err: true };
    return { z: zoneOf(data.tmin), zl: zoneHalf(data.tmin), ok: true, data };
  }

  // ---------- Подбор растений ----------
  add({
    id: "plants", cat: "green", mark: "по климату", name: "Что посадить на участке", kw: "растения деревья кустарники цветы хвойные плодовые ягодники многолетники посадить уход зимостойкость зона usda подбор озеленение сад туя гортензия",
    desc: "Зона зимостойкости и заморозки по погоде вашего места — и растения, которые точно перезимуют, с уходом",
    inputs: climateInputs.concat([
      { k: "cat", label: "Что ищем", type: "sel", def: "all", opts: [["all", "Всё"]].concat(Object.entries(PCAT)) },
      { k: "light", label: "Освещение места", type: "sel", def: "s", opts: [["s", "Солнце большую часть дня"], ["p", "Полутень (солнце 3–6 часов)"], ["t", "Тень (под деревьями, с севера)"]] },
      { k: "soil", label: "Почва", type: "sel", def: "any", opts: [["any", "Обычная садовая, суглинок"], ["sand", "Песчаная, сухая"], ["wet", "Сырая, близко вода"], ["acid", "Кислая, торфяная"]] },
      { k: "hmax", label: "Высота не более, м", def: 30 },
      { k: "want", label: "Особенно важно", type: "sel", def: "none", opts: [["none", "Ничего особенного"], ["easy", "Минимум ухода"], ["hedge", "Для живой изгороди"], ["evergreen", "Зелёное зимой"], ["fragrant", "Аромат"], ["honey", "Медоносы, бабочки"], ["autumn", "Яркая осень"], ["fast", "Быстрый рост"]] },
      { k: "risk", label: "Показывать растения «на грани» (с укрытием)", type: "check", def: true }
    ]),
    loadKey: climKey, load: climLoad,
    run(v, data, loading) {
      const sz = siteZone(v, data, loading);
      if (sz.loading) return { note: "Загружаю погоду за 15 лет для " + v.place.name + "…" };
      if (sz.err) return { warn: "Не удалось загрузить погоду на этой странице. Выберите зону зимостойкости вручную (средняя полоса — 4–5)." };
      const Z = sz.z;
      const soilOk = p => v.soil === "any" ? !p.soil.includes("acid") && p.soil !== "wet" : p.soil.includes(v.soil) || p.soil.includes("any") || (v.soil === "sand" && p.soil.includes("dry"));
      const list = PL.filter(p => (v.cat === "all" || p.cat === v.cat) && p.light.includes(v.light) && p.h <= v.hmax && soilOk(p) && (v.want === "none" || p.tags.includes(v.want)) && (p.z <= Z || (v.risk && p.z === Z + 1)));
      list.sort((a, b) => (a.z > Z) - (b.z > Z) || Object.keys(PCAT).indexOf(a.cat) - Object.keys(PCAT).indexOf(b.cat) || a.n.localeCompare(b.n, "ru"));
      const stats = [S("Зона зимостойкости", sz.zl, "", sz.data ? "средний годовой минимум " + nf(sz.data.tmin, 1) + " °C" : "задана вручную", true)];
      if (sz.data) {
        const d = sz.data;
        stats.push(S("Последние заморозки", "≈ " + doyStr(d.last), "", "в поздние годы — до " + doyStr(d.lastMax)), S("Первые осенние", "≈ " + doyStr(d.first), ""), S("Без заморозков", d.first && d.last ? nint(d.first - d.last) : "—", "сут", "рассаду — после " + doyStr((d.lastMax || d.last) + 3)));
      }
      stats.push(S("Подходит растений", nint(list.length), "", "из " + PL.length + " в базе"));
      const card = p => {
        const risky = p.z > Z;
        return '<div class="pcard' + (risky ? " risky" : "") + '"><div class="pc-h"><span class="pc-dot" style="background:' + p.color + '"></span><div><b>' + esc(p.n) + '</b><div class="pc-lat">' + esc(p.lat) + '</div></div><span class="pc-z' + (risky ? " r" : "") + '">зона ' + p.z + (risky ? " · с укрытием" : "") + "</span></div>" +
          '<div class="pc-meta"><span>' + PCAT[p.cat].replace(/ .*/, "") + "</span><span>до " + nf(p.h, p.h < 1 ? 1 : 0) + " м</span><span>" + lightTxt(p.light) + "</span>" + (p.bloom ? "<span>цветёт " + MONTHS_G[p.bloom[0]] + (p.bloom[1] !== p.bloom[0] ? "–" + MONTHS_G[p.bloom[1]] : "") + "</span>" : "") + "</div>" +
          '<details class="pc-det"><summary>Посадка, уход, зимовка</summary><dl class="pc-care"><dt>Посадка</dt><dd>' + esc(p.plant) + "</dd><dt>Уход</dt><dd>" + esc(p.care) + "</dd><dt>Зима</dt><dd>" + esc(p.winter) + "</dd></dl></details></div>";
      };
      const groups = {};
      list.forEach(p => (groups[p.cat] = groups[p.cat] || []).push(p));
      const blocks = Object.keys(PCAT).filter(k => groups[k]).map(k => ({ title: PCAT[k] + " · " + groups[k].length, html: '<div class="pgrid">' + groups[k].map(card).join("") + "</div>" }));
      if (!list.length) blocks.push({ html: '<p class="hint">Под такие условия в базе ничего нет — ослабьте фильтры (высота, «особенно важно», освещение).</p>' });
      blocks.push({ cls: "method", title: "Общие правила посадки", html: "<p><strong>Яма</strong> — в 1,5–2 раза шире кома и на 15–20 см глубже; на глине — дренаж из щебня 10–15 см. <strong>Корневая шейка</strong> — на уровне земли (исключения — смородина, розы и клематисы, их заглубляют). <strong>После посадки</strong> — полив 10–20 л под куст и 30–50 л под дерево, мульча 5–8 см, не касаясь ствола. <strong>Хвойные</strong> сажают только с комом и первые весны притеняют от февральско-мартовского солнца. Покупайте растения в контейнерах из местных питомников — они уже прошли акклиматизацию.</p>" });
      return { stats, blocks, note: sz.data ? "Погода " + sz.data.y1 + "–" + sz.data.y2 + " гг., " + placeLabel(v.place) + ". Зона по шкале USDA; на участке возможны микроклиматические отличия ±½ зоны." : "" };
    },
    info: "Зона зимостойкости (USDA) — по среднему за 15 лет годовому минимуму температуры воздуха: каждая зона — 5,6 °C. Растения с зоной на единицу выше вашей отмечены «с укрытием»: перезимуют в защищённом месте и под укрытием. Даты заморозков — средние по дням с минимальной температурой воздуха ≤ 0 °C; на почве и в низинах заморозки бывают позже."
  });

  // ---------- Посадка и живая изгородь ----------
  add({
    id: "planting", cat: "green", name: "Посадка: ямы, грунт, изгородь", kw: "посадка яма посадочная грунт торф живая изгородь саженцы шаг траншея мульча полив колышки газон семена",
    desc: "Размер ям, объём грунта и мульчи, число саженцев для изгороди, полив и семена газона",
    inputs: [
      { k: "what", label: "Что сажаем", type: "sel", def: "hedge", opts: [["tree", "Деревья с комом"], ["shrub", "Кустарники"], ["hedge", "Живая изгородь"], ["peren", "Цветник из многолетников"], ["lawn", "Газон посевной"]] },
      { k: "n", label: "Количество растений", def: 5, show: v => v.what === "tree" || v.what === "shrub" },
      { k: "ball", label: "Диаметр кома, см", def: v => v.what === "tree" ? 60 : 30, dep: "what", show: v => v.what === "tree" || v.what === "shrub" },
      { k: "L", label: "Длина изгороди, м", def: 20, show: v => v.what === "hedge" },
      { k: "hk", label: "Растение для изгороди", type: "sel", def: "thuja", opts: [["thuja", "Туя 'Смарагд' (шаг 0,6 м)"], ["spruce", "Ель обыкновенная (шаг 0,8 м)"], ["coton", "Кизильник (шаг 0,35 м)"], ["physo", "Пузыреплодник (шаг 0,45 м)"], ["berb", "Барбарис (шаг 0,4 м)"], ["spirea", "Спирея (шаг 0,5 м)"], ["lilac", "Сирень венгерская (шаг 0,6 м)"]], show: v => v.what === "hedge" },
      { k: "rows", label: "Рядов", type: "sel", def: "1", opts: [["1", "1 ряд"], ["2", "2 ряда в шахматном порядке"]], show: v => v.what === "hedge" },
      { k: "A", label: "Площадь, м²", def: v => v.what === "lawn" ? 100 : 6, dep: "what", show: v => v.what === "peren" || v.what === "lawn" },
      { k: "dens", label: "Растений на 1 м²", def: 5, show: v => v.what === "peren", hint: "Крупные 3–4, средние 5–7, низкие 9–12" },
      { k: "soil", label: "Грунт на участке", type: "sel", def: "loam", opts: [["loam", "Суглинок"], ["clay", "Тяжёлая глина"], ["sand", "Песок"]] }
    ],
    run(v) {
      const mix = { loam: [["Садовая земля", 0.6], ["Торф", 0.3], ["Песок", 0.1]], clay: [["Садовая земля", 0.4], ["Торф", 0.3], ["Песок", 0.3]], sand: [["Садовая земля", 0.6], ["Торф", 0.3], ["Глина или компост", 0.1]] }[v.soil];
      const drain = v.soil === "clay";
      let st = [], rows = [], items = [], soilV = 0, mulchA = 0, water = "", extra = [];
      if (v.what === "tree" || v.what === "shrub") {
        const b = v.ball / 100, w = Math.max(b + 0.4, b * 1.6), d = b * 0.8 + 0.2 + (drain ? 0.15 : 0);
        const pit = w * w * d, ballV = Math.PI * b * b / 4 * b * 0.8;
        soilV = Math.max(0, pit - ballV - (drain ? w * w * 0.15 : 0)) * v.n;
        mulchA = Math.PI * Math.pow(Math.max(w, v.what === "tree" ? 1 : 0.6) / 2, 2) * v.n;
        st.push(S("Яма", nint(w * 100) + "×" + nint(w * 100) + "×" + nint(d * 100), "см", drain ? "в т. ч. дренаж 15 см" : ""));
        st.push(S("Грунтосмесь", nf(soilV, 2), "м³", "на " + v.n + " шт.", true));
        water = v.what === "tree" ? "30–50 л раз в неделю первый сезон" : "10–20 л раз в неделю первый сезон";
        if (v.what === "tree") items.push(["Колышки и подвязка (3 на дерево)", v.n * 3, "шт."]);
        if (drain) items.push(["Щебень 20–40 на дренаж", Math.round(w * w * 0.15 * v.n * 1.37 * 100) / 100, "т"]);
      } else if (v.what === "hedge") {
        const step = { thuja: 0.6, spruce: 0.8, coton: 0.35, physo: 0.45, berb: 0.4, spirea: 0.5, lilac: 0.6 }[v.hk];
        const r = +v.rows, n = r === 1 ? ceil(v.L / step) + 1 : (ceil(v.L / step) + 1) * 2;
        const tw = r === 1 ? 0.5 : 0.8, td = { thuja: 0.6, spruce: 0.6 }[v.hk] || 0.5;
        soilV = v.L * tw * td * 0.85; mulchA = v.L * (tw + 0.3);
        st.push(S("Саженцев", nint(n), "шт.", (r === 2 ? "2 ряда, " : "") + "шаг " + nf(step, 2) + " м · +1–2 в запас", true), S("Траншея", nint(tw * 100) + "×" + nint(td * 100), "см", "ширина × глубина"), S("Грунтосмесь", nf(soilV, 1), "м³"));
        items.push(["Саженцы для изгороди", n + 2, "шт."]);
        water = "10–20 л на растение раз в неделю, хвойным — дождевание кроны вечером";
        extra.push(["Сомкнётся изгородь", { thuja: "через 3–4 года", spruce: "через 4–5 лет", coton: "через 2–3 года", physo: "через 2 года", berb: "через 3 года", spirea: "через 2 года", lilac: "через 3 года" }[v.hk]]);
      } else if (v.what === "peren") {
        const n = ceil(v.A * v.dens);
        soilV = v.A * 0.2; mulchA = v.A;
        st.push(S("Растений", nint(n), "шт.", "", true), S("Перекопка и грунт", nf(soilV, 2), "м³", "плодородный слой 20 см"));
        items.push(["Многолетники", n, "шт."]);
        water = "по 5 л на растение 2 раза в неделю до укоренения";
      } else {
        const seed = v.A * 0.04, soil = v.A * 0.12;
        st.push(S("Семян", nf(seed, 1), "кг", "40 г/м², при подсеве 20 г/м²", true), S("Плодородный грунт", nf(soil, 1), "м³", "слой 10–12 см"), S("Стартовое удобрение", nf(v.A * 0.04, 1), "кг", "40 г/м²"));
        items.push(["Семена газона", Math.round(seed * 10) / 10, "кг"], ["Грунт растительный", Math.round(soil * 10) / 10, "м³"], ["Удобрение для газона стартовое", Math.round(v.A * 0.04 * 10) / 10, "кг"]);
        return { stats: st, items, table: { head: ["Этап", "Как делать"], rows: [["Сроки", "Май — начало июня или конец августа — начало сентября"], ["Подготовка", "Выбрать корни сорняков, выровнять, прикатать катком, полить"], ["Посев", "Половину семян вдоль, половину поперёк, заделать граблями на 0,5–1 см, прикатать"], ["Полив", "Ежедневно мелким дождеванием до всходов (10–14 дней), затем 2–3 раза в неделю"], ["Первый покос", "При высоте 8–10 см, срезать не более трети"]] } };
      }
      const mulch = mulchA * 0.07;
      if (soilV > 0) mix.forEach(([n, p]) => { rows.push([n, nf(soilV * p, 2) + " м³", Math.round(p * 100) + "%"]); items.push([n + " для посадки", Math.round(soilV * p * 100) / 100, "м³"]); });
      if (mulch > 0) { rows.push(["Мульча (кора, щепа) слоем 7 см", nf(mulch, 2) + " м³", ""]); items.push(["Мульча (кора, щепа)", Math.round(mulch * 100) / 100, "м³"]); }
      st.push(S("Полив", water.split(" ")[0], "", water.replace(/^\S+ /, "")));
      return { stats: st, table: { head: ["Состав", "Объём", "Доля"], rows }, extra: extra.length ? extra : undefined, items };
    },
    info: "Яма — на 40 см шире кома и на 20 см глубже, на глине — с дренажом. Грунтосмесь подбирается к вашему грунту: на глину добавляют песок, на песок — глину или компост. Под хвойные и голубику вместо торфа низинного берите верховой кислый."
  });

  // ---------- Конструктор цветника ----------
  function rng(seed) { let s = seed * 9301 + 49297; return () => (s = (s * 9301 + 49297) % 233280) / 233280; }
  add({
    id: "border", cat: "green", mark: "план + календарь", name: "Конструктор цветника (миксбордер)", kw: "миксбордер цветник клумба схема посадки план непрерывное цветение рабатка вдоль забора дорожки композиция многолетники",
    desc: "План цветника с растениями под ваш климат и свет, количество и календарь цветения с весны до осени",
    inputs: climateInputs.concat([
      { k: "L", label: "Длина цветника, м", def: 6 }, { k: "D", label: "Глубина, м", def: 2 },
      { k: "light", label: "Освещение", type: "sel", def: "s", opts: [["s", "Солнце"], ["p", "Полутень"], ["t", "Тень"]] },
      { k: "pal", label: "Палитра", type: "sel", def: "mix", opts: [["mix", "Разноцветная"], ["cool", "Холодная (белый, голубой, сиреневый)"], ["warm", "Тёплая (жёлтый, оранжевый, красный)"], ["pink", "Розово-белая"]] },
      { k: "shrubs", label: "Кустарники на заднем плане", type: "check", def: true },
      { k: "var", label: "Вариант подбора", type: "sel", def: "1", opts: [["1", "Вариант 1"], ["2", "Вариант 2"], ["3", "Вариант 3"], ["4", "Вариант 4"]] }
    ]),
    loadKey: climKey, load: climLoad,
    run(v, data, loading) {
      const sz = siteZone(v, data, loading);
      if (sz.loading) return { note: "Загружаю погоду для " + v.place.name + "…" };
      if (sz.err) return { warn: "Не удалось загрузить погоду на этой странице. Выберите зону зимостойкости вручную (средняя полоса — 4–5)." };
      const Z = sz.z, rand = rng(+v.var * 7 + 3);
      const hue = c => { const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx - mn < 25) return "white"; if (r > 180 && g > 150 && b < 120) return "warm"; if (r > g && r > b && b < 110) return "warm"; if (b >= r || (b > 150 && r < 200)) return "cool"; return "pink"; };
      const palOk = p => v.pal === "mix" || !p.bloom || hue(p.color) === "white" || hue(p.color) === v.pal || (v.pal === "pink" && hue(p.color) === "pink");
      const pool = PL.filter(p => p.z <= Z && p.light.includes(v.light) && !p.soil.startsWith("acid") && (p.cat === "perennial" || p.cat === "ground" || (v.shrubs && p.cat === "shrub" && p.h <= 2.5) || (p.cat === "conifer" && p.h <= 2.5)) && palOk(p));
      const pick = (arr, n) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } const out = [], months = new Set(); a.sort((x, y) => { const nx = x.bloom ? [...Array(x.bloom[1] - x.bloom[0] + 1)].filter((_, k) => !months.has(x.bloom[0] + k)).length : 0; const ny = y.bloom ? [...Array(y.bloom[1] - y.bloom[0] + 1)].filter((_, k) => !months.has(y.bloom[0] + k)).length : 0; return ny - nx; }); for (const p of a) { if (out.length >= n) break; out.push(p); if (p.bloom) for (let m = p.bloom[0]; m <= p.bloom[1]; m++) months.add(m); } return out; };
      const back = pick(pool.filter(p => p.h >= 1 || ((p.cat === "shrub" || p.cat === "conifer") && p.h >= 0.8)), 3);
      const mid = pick(pool.filter(p => p.h >= 0.4 && p.h < 1 && !back.includes(p)), 4);
      const front = pick(pool.filter(p => p.h < 0.4 && !back.includes(p) && !mid.includes(p)), 3);
      const all = back.concat(mid, front);
      if (!all.length) return { warn: "Под эти условия не нашлось растений — смените палитру или освещение." };
      // план: три ряда по глубине, группы-«пятна» вдоль длины
      const L = Math.max(1, v.L), D = Math.max(0.6, v.D);
      const rowsDef = [[back, 0.42], [mid, 0.33], [front, 0.25]].filter(r => r[0].length);
      const tot = rowsDef.reduce((s, r) => s + r[1], 0);
      const W = 860, sc = Math.min((W - 20) / L, 260 / D), H = D * sc + 30;
      let svg = '<svg viewBox="0 0 ' + W + " " + H + '" class="bord-svg" role="img" aria-label="План цветника"><rect x="10" y="10" width="' + (L * sc) + '" height="' + (D * sc) + '" rx="6" class="bd-bed"/>';
      const counts = {}, idx = {};
      all.forEach((p, i) => idx[p.id] = i + 1);
      let y0 = 0;
      rowsDef.forEach(([plants, frac]) => {
        const rh = D * frac / tot;
        const groupL = Math.max(0.8, Math.min(2.2, L / Math.max(2, plants.length * 1.5)));
        const nG = Math.max(1, Math.round(L / groupL)), gl = L / nG;
        for (let g = 0; g < nG; g++) {
          const p = plants[(g + (y0 > 0 ? 1 : 0)) % plants.length];
          const sp = Math.max(0.25, Math.min(p.w, 1.5));
          const nx = Math.max(1, Math.floor(gl / sp)), ny = Math.max(1, Math.floor(rh / sp));
          for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) {
            const cx = 10 + (g * gl + (a + 0.5) * gl / nx) * sc + (b % 2 ? sp * sc * 0.15 : 0), cy = 10 + (y0 + (b + 0.5) * rh / ny) * sc;
            svg += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + Math.max(4, Math.min(sp * sc * 0.48, gl / nx * sc * 0.48, rh / ny * sc * 0.48)).toFixed(1) + '" fill="' + p.color + '" class="bd-pl"><title>' + esc(p.n) + "</title></circle>";
            counts[p.id] = (counts[p.id] || 0) + 1;
          }
          svg += '<text x="' + (10 + (g + 0.5) * gl * sc) + '" y="' + (10 + (y0 + rh / 2) * sc + 4) + '" class="bd-num" text-anchor="middle">' + idx[p.id] + "</text>";
        }
        y0 += rh;
      });
      svg += '<text x="10" y="' + (H - 6) + '" class="axis">' + (v.light === "t" ? "" : "задний план (забор, стена) — сверху · ") + nf(L, 1) + " × " + nf(D, 1) + " м</text></svg>";
      // календарь цветения
      const months = [4, 5, 6, 7, 8, 9, 10];
      const cal = '<div class="row-scroll"><table class="data bcal"><thead><tr><th>№</th><th>Растение</th>' + months.map(m => "<th>" + MONTHS_G[m] + "</th>").join("") + "<th>Шт.</th></tr></thead><tbody>" +
        all.map(p => "<tr><td>" + idx[p.id] + '</td><td class="bn"><span class="pc-dot" style="background:' + p.color + '"></span>' + esc(p.n) + (p.z > Z ? " *" : "") + "</td>" + months.map(m => '<td class="bc">' + (p.bloom && m >= p.bloom[0] && m <= p.bloom[1] ? '<span style="background:' + p.color + '"></span>' : p.tags.includes("evergreen") || p.tags.includes("foliage") ? '<span class="lf"></span>' : "") + "</td>").join("") + "<td>" + nint(counts[p.id] || 0) + "</td></tr>").join("") + "</tbody></table></div>";
      const covered = months.filter(m => all.some(p => p.bloom && m >= p.bloom[0] && m <= p.bloom[1])).length;
      const total = Object.values(counts).reduce((s, x) => s + x, 0);
      return {
        note: sz.data ? "Зона " + sz.zl + " для " + placeLabel(v.place) + "." : "",
        stats: [S("Растений", nint(total), "шт.", all.length + " видов"), S("Цветёт месяцев", covered + " из 7", "", "апрель — октябрь", true), S("Площадь", nf(L * D, 1), "м²"), S("Зона", sz.zl, "")],
        blocks: [{ title: "План посадки", html: '<div class="chart-scroll">' + svg + "</div>" }, { title: "Календарь цветения и состав", html: cal + '<p class="hint">Полоса — цветение, серая — декоративная листва. Цифры на плане — номер растения.</p>' }],
        items: all.map(p => [p.n, counts[p.id] || 0, "шт."])
      };
    },
    info: "Растения подбираются под зону зимостойкости, освещение и палитру так, чтобы цветение перекрывало сезон: высокие на заднем плане, средние в центре, почвопокровные спереди. Растения сажаются группами по 3–7 шт. — так цветник смотрится цельно. Смените «Вариант подбора», чтобы увидеть другую композицию."
  });

  // ====================================================================
  //  ОСТЕКЛЕНИЕ
  // ====================================================================
  // СП 20.13330: нормативное давление ветра по районам, k(z) и ζ(z) для типов местности A/B/C
  const W0 = [["Ia", 0.17], ["I", 0.23], ["II", 0.30], ["III", 0.38], ["IV", 0.48], ["V", 0.60], ["VI", 0.73], ["VII", 0.85]];
  const KZ = { A: [[5, 0.75], [10, 1.0], [20, 1.25], [40, 1.5], [60, 1.7], [100, 2.0]], B: [[5, 0.5], [10, 0.65], [20, 0.85], [40, 1.1], [60, 1.3], [100, 1.6]], C: [[5, 0.4], [10, 0.4], [20, 0.55], [40, 0.8], [60, 1.0], [100, 1.25]] };
  const ZT = { A: [[5, 0.85], [10, 0.76], [20, 0.69], [40, 0.62], [60, 0.58], [100, 0.54]], B: [[5, 1.22], [10, 1.06], [20, 0.92], [40, 0.80], [60, 0.74], [100, 0.67]], C: [[5, 1.78], [10, 1.78], [20, 1.50], [40, 1.26], [60, 1.14], [100, 1.02]] };
  const interp = (tab, z) => { if (z <= tab[0][0]) return tab[0][1]; for (let i = 1; i < tab.length; i++) if (z <= tab[i][0]) { const [a, x] = tab[i - 1], [b, y] = tab[i]; return x + (y - x) * (z - a) / (b - a); } return tab[tab.length - 1][1]; };
  const windKPa = (reg, z, terr) => { const w0 = W0.find(r => r[0] === reg)[1]; return 1.4 * w0 * interp(KZ[terr], z) * (1 + interp(ZT[terr], z)) * 1.2; };
  const glassSigma = (wkpa, H, t) => 0.75 * wkpa * 1e-3 * H * H / (t * t); // МПа, полоса с опорами сверху и снизу


  // ---------- Безрамное стационарное остекление ----------
  const GL = {
    t10: ["Закалённое 10 мм", "mono", 10, 10, 5.7], t12: ["Закалённое 12 мм", "mono", 12, 12, 5.7], t15: ["Закалённое 15 мм", "mono", 15, 15, 5.6], t19: ["Закалённое 19 мм", "mono", 19, 19, 5.5],
    l55: ["Триплекс закалённый 5+5", "lam", 5, 10.8, 5.6], l66: ["Триплекс закалённый 6+6", "lam", 6, 12.8, 5.6], l88: ["Триплекс закалённый 8+8", "lam", 8, 16.8, 5.5], l1010: ["Триплекс закалённый 10+10", "lam", 10, 20.8, 5.4],
    i6: ["Стеклопакет 6–16–6 (i-стекло, аргон)", "igu", 6, 28, 1.1], i8: ["Стеклопакет 8–16–8 (i-стекло, аргон)", "igu", 8, 32, 1.1], i10: ["Стеклопакет 10–14–10 (i-стекло, аргон)", "igu", 10, 34, 1.2], i66: ["Стеклопакет 6.6.2–16–8 (триплекс внутри)", "igu", 7, 31, 1.1]
  };
  const FAM = { mono: ["t10", "t12", "t15", "t19"], lam: ["l55", "l66", "l88", "l1010"], igu: ["i6", "i8", "i66", "i10"] };
  const tEff = (g, kind) => { const t = g[2]; if (g[1] === "mono") return t; return kind === "s" ? t * Math.SQRT2 : t * Math.cbrt(2); }; // 2 слоя без учёта сдвиговой связи — в запас
  const PLATE = [[1, 0.2874, 0.0444], [1.5, 0.4872, 0.0843], [2, 0.6102, 0.1106], [3, 0.7134, 0.1335], [5, 0.7476, 0.1404], [100, 0.75, 0.1422]];
  function glassCheck(g, w, H, Wp, fins) {
    const q = w * 1e-3, E = 70000, ts = tEff(g, "s"), td = tEff(g, "d");
    let sig, f, span;
    if (!fins) { span = H; sig = 0.75 * q * H * H / (ts * ts); f = 0.15625 * q * Math.pow(H, 4) / (E * td * td * td); }
    else { const a = Math.max(H, Wp), b = Math.min(H, Wp), r = a / b; const beta = interp(PLATE.map(p => [p[0], p[1]]), r), alpha = interp(PLATE.map(p => [p[0], p[2]]), r); span = b; sig = beta * q * b * b / (ts * ts); f = alpha * q * Math.pow(b, 4) / (E * td * td * td); }
    const fLim = Math.min(span / 65, 50);
    return { sig, f, fLim, ok: sig <= 50 && f <= fLim };
  }
  function nodeSVG(kind, g) {
    const tg = g[3], igu = g[1] === "igu", s = 2.2;
    const W = 310, H = 200, cx = 110;
    let p = '<svg viewBox="0 0 ' + W + " " + H + '" class="node-svg" role="img" aria-label="Узел">';
    const glass = (x, y, w, h) => igu ? '<rect x="' + x + '" y="' + y + '" width="' + (g[2] * s) + '" height="' + h + '" class="nd-gl"/><rect x="' + (x + w - g[2] * s) + '" y="' + y + '" width="' + (g[2] * s) + '" height="' + h + '" class="nd-gl"/><rect x="' + (x + g[2] * s) + '" y="' + (kind === "bottom" ? y + h - 30 : y) + '" width="' + (w - 2 * g[2] * s) + '" height="30" class="nd-spacer"/>' : '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" class="nd-gl"/>' + (g[1] === "lam" ? '<line x1="' + (x + w / 2) + '" x2="' + (x + w / 2) + '" y1="' + y + '" y2="' + (y + h) + '" class="nd-pvb"/>' : "");
    const glassH = (x, y, len, th) => igu ? '<rect x="' + x + '" y="' + y + '" width="' + len + '" height="' + (g[2] * s) + '" class="nd-gl"/><rect x="' + x + '" y="' + (y + th - g[2] * s) + '" width="' + len + '" height="' + (g[2] * s) + '" class="nd-gl"/>' : '<rect x="' + x + '" y="' + y + '" width="' + len + '" height="' + th + '" class="nd-gl"/>' + (g[1] === "lam" ? '<line x1="' + x + '" x2="' + (x + len) + '" y1="' + (y + th / 2) + '" y2="' + (y + th / 2) + '" class="nd-pvb"/>' : "");
    const lab = (x, y, t, anchor) => '<text x="' + x + '" y="' + y + '" class="nd-l" text-anchor="' + (anchor || "start") + '">' + t + "</text>";
    const gw = tg * s;
    if (kind === "bottom") {
      const chW = gw + 40, chH = 90, y0 = 150;
      p += '<rect x="10" y="' + y0 + '" width="' + (W - 20) + '" height="40" class="nd-slab"/>' + lab(14, y0 + 30, "перекрытие / пол");
      p += '<path d="M' + (cx - chW / 2) + " " + (y0 - chH) + " v" + chH + " h" + chW + " v-" + chH + " h-8 v" + (chH - 8) + " h-" + (chW - 16) + " v-" + (chH - 8) + ' z" class="nd-al"/>';
      p += '<rect x="' + (cx - gw / 2 - 2) + '" y="' + (y0 - 8 - 6) + '" width="' + (gw + 4) + '" height="6" class="nd-block"/>';
      p += glass(cx - gw / 2, 8, gw, y0 - 8 - 6 - 8);
      p += '<path d="M' + (cx - chW / 2 + 8) + " " + (y0 - chH + 4) + " l" + (chW / 2 - gw / 2 - 8) + " 0 l0 30 z" + '" class="nd-wedge"/><path d="M' + (cx + chW / 2 - 8) + " " + (y0 - chH + 4) + " l-" + (chW / 2 - gw / 2 - 8) + " 0 l0 30 z" + '" class="nd-wedge"/>';
      p += '<line x1="' + (cx - chW / 2 + 4 + 12) + '" x2="' + (cx - chW / 2 + 4 + 12) + '" y1="' + (y0 - 6) + '" y2="' + (y0 + 34) + '" class="nd-anchor"/>';
      p += lab(cx + chW / 2 + 6, y0 - chH + 18, "клин EPDM / зажим") + lab(cx + chW / 2 + 6, y0 - 10, "подкладка 2 шт.") + lab(cx - chW / 2 - 6, y0 - chH / 2, "U-профиль", "end") + lab(cx - chW / 2 - 6, y0 - chH / 2 + 13, "≈ 100 мм", "end") + lab(cx - chW / 2 - 6, y0 + 4, "анкер", "end") + lab(cx + gw / 2 + 6, 30, igu ? "стеклопакет" : g[1] === "lam" ? "триплекс" : "стекло");
    } else if (kind === "top") {
      const chW = gw + 28, chH = 60, y0 = 40;
      p += '<rect x="10" y="10" width="' + (W - 20) + '" height="30" class="nd-slab"/>' + lab(14, 30, "балка / перекрытие");
      p += '<path d="M' + (cx - chW / 2) + " " + (y0 + chH) + " v-" + chH + " h" + chW + " v" + chH + " h-8 v-" + (chH - 8) + " h-" + (chW - 16) + " v" + (chH - 8) + ' z" class="nd-al"/>';
      p += glass(cx - gw / 2, y0 + 22, gw, H - y0 - 30);
      p += '<line x1="' + (cx - 30) + '" x2="' + (cx + 30) + '" y1="' + (y0 + 14) + '" y2="' + (y0 + 14) + '" class="nd-dim"/>' + lab(cx + chW / 2 + 6, y0 + 18, "зазор на прогиб") + lab(cx + chW / 2 + 6, y0 + 32, "балки ≥ прогиб + 10 мм") + lab(cx + chW / 2 + 6, y0 + 54, "уплотнитель EPDM");
    } else if (kind === "joint") {
      const y = 70, gl = 90;
      p += glassH(cx - 4 - gl, y, gl, gw) + glassH(cx + 4, y, gl, gw);
      p += '<rect x="' + (cx - 4) + '" y="' + y + '" width="8" height="' + gw + '" class="nd-sil"/>';
      p += lab(cx, y - 14, "шов 6–8 мм — прозрачный силикон", "middle") + lab(cx, y + gw + 22, "или поликарбонатный H-профиль", "middle") + lab(cx, y + gw + 38, "вид сверху", "middle");
    } else {
      const x0 = 40, y0 = 50, L = 120;
      p += glassH(x0, y0, L, gw) + glass(x0 + L - gw, y0 + gw + 6, gw, L - 10);
      p += '<rect x="' + (x0 + L - gw) + '" y="' + (y0 + gw) + '" width="' + gw + '" height="6" class="nd-sil"/>';
      p += lab(x0, y0 - 10, "угол 90° стекло–стекло") + lab(x0 + L + 8, y0 + gw + 30, "торец одного стекла") + lab(x0 + L + 8, y0 + gw + 44, "закрыт другим,") + lab(x0 + L + 8, y0 + gw + 58, "шов — силикон") + lab(x0, y0 + gw + 80, "вид сверху");
    }
    return p + "</svg>";
  }
  add({
    id: "glazing", cat: "glass", mark: "ветер + узлы", name: "Безрамное остекление (стационарное)", kw: "безрамное остекление стационарное панорамное глухое неоткрывающееся стекло в пол зажимной профиль триплекс закалённое стеклопакет структурное стеклянные рёбра стык стекло стекло силикон терраса витраж ветровая нагрузка",
    desc: "Глухое остекление без рам: раскрой стёкол, толщина по ветру, рёбра, узлы, тепло и конденсат, монтаж и спецификация",
    inputs: [
      { k: "shape", label: "Форма в плане", type: "sel", def: "line", opts: [["line", "Прямая"], ["L", "Угловая (2 стороны)"], ["U", "П-образная (3 стороны)"]] },
      { k: "W1", label: v => v.shape === "line" ? "Ширина проёма, мм" : "Сторона 1, мм", def: 6000 },
      { k: "W2", label: "Сторона 2, мм", def: 4000, show: v => v.shape !== "line" },
      { k: "W3", label: "Сторона 3, мм", def: 4000, show: v => v.shape === "U" },
      { k: "H", label: "Высота проёма от чистого пола до балки, мм", def: 2700 },
      { k: "fam", label: "Стекло", type: "sel", def: "lam", opts: [["mono", "Закалённое монолитное (холодное)"], ["lam", "Закалённый триплекс (холодное, безопасное)"], ["igu", "Безрамный стеклопакет (тёплое)"]] },
      { k: "g", label: "Толщина", type: "sel", def: "auto", opts: [["auto", "Подобрать по ветру"]].concat(Object.entries(GL).map(([k, g]) => [k, g[0]])) },
      { k: "maxW", label: "Наибольшая ширина одного стекла, мм", def: 1500, hint: "Ограничение — вес, доставка, подъём; производство закаляет до ≈ 2400×4800" },
      { k: "joint", label: "Вертикальные стыки", type: "sel", def: "sil", opts: [["sil", "Прозрачный силикон 6–8 мм"], ["h", "Поликарбонатный H-профиль"]] },
      { k: "fins", label: "Стеклянные рёбра жёсткости на стыках", type: "check", def: false },
      { k: "bot", label: "Нижний профиль", type: "sel", def: "floor", opts: [["floor", "Утоплен в пол (профиль не виден)"], ["on", "На чистовом полу"]] },
      { k: "defl", label: "Прогиб верхней балки под снегом, мм", def: 5, hint: "Из расчёта балки; под него оставляют зазор в верхнем профиле" },
      { k: "drop", label: "Снаружи перепад высоты (2-й этаж, балкон, обрыв)", type: "check", def: false },
      { k: "reg", label: "Ветровой район (СП 20)", type: "sel", def: "I", opts: W0.map(r => [r[0], r[0] + " — " + nf(r[1], 2) + " кПа" + (r[0] === "I" ? " (Москва, Н. Новгород)" : r[0] === "II" ? " (С.-Петербург)" : "")]) },
      { k: "z", label: "Высота верха остекления над землёй, м", def: 4 },
      { k: "terr", label: "Местность", type: "sel", def: "B", opts: [["A", "Открытая: поле, берег, степь"], ["B", "Пригород, посёлок, лес"], ["C", "Город с застройкой выше 25 м"]] },
      { k: "heat", label: "Помещение зимой", type: "sel", def: "cold", opts: [["warm", "Отапливается"], ["cold", "Не отапливается"]] },
      { k: "tout", label: "Расчётная зимняя температура, °C", def: -25, show: v => v.heat === "warm" }
    ],
    run(v) {
      const sides = [v.W1].concat(v.shape !== "line" ? [v.W2] : []).concat(v.shape === "U" ? [v.W3] : []).filter(x => x > 0);
      const Wtot = sides.reduce((s, x) => s + x, 0), j = v.joint === "sil" ? 7 : 4, wallGap = 8;
      const topGap = Math.max(10, v.defl + 10), bottomIn = 90, topIn = 25;
      const Hg = v.H + (v.bot === "floor" ? bottomIn - 5 : -10) + topIn - topGap - (v.bot === "on" ? 0 : 0);
      const Hvis = v.H - (v.bot === "floor" ? 0 : 100) - (topGap + topIn + 15);
      const w = windKPa(v.reg, v.z, v.terr);
      // раскрой
      const sideRes = sides.map((Ws, si) => {
        const ends = (v.shape === "line" ? 2 : si === 0 || si === sides.length - 1 ? 1 : 0);
        const corners = 2 - ends;
        const net = Ws - ends * wallGap - corners * 0; // угол стекло-стекло учтён в длине стороны
        const n = Math.max(1, ceil((net + j) / (v.maxW + j)));
        const pw = (net - (n - 1) * j) / n;
        return { Ws, n, pw };
      });
      const panes = sideRes.reduce((s, r) => s + r.n, 0), pwMax = Math.max(...sideRes.map(r => r.pw));
      // подбор стекла
      const fam = v.fam, list = FAM[fam];
      let gk = v.g !== "auto" ? v.g : list.find(k => glassCheck(GL[k], w, Hg, pwMax, v.fins).ok) || list[list.length - 1];
      const g = GL[gk], chk = glassCheck(g, w, Hg, pwMax, v.fins);
      const warn = [], notes = [];
      if (!chk.ok) warn.push((v.g === "auto" ? "Даже самое толстое стекло этой группы" : "Выбранное стекло") + " не проходит: σ = " + nf(chk.sig, 0) + " МПа (≤ 50), прогиб " + nint(chk.f) + " мм (≤ " + nint(chk.fLim) + "). " + (v.fins ? "Уменьшите ширину стёкол или высоту." : "Поставьте стеклянные рёбра на стыках — стекло начнёт работать на 4 опорах."));
      if (v.drop && fam === "mono") warn.push("Остекление в пол при перепаде снаружи выполняет роль ограждения — нужно ламинированное стекло (триплекс): при разрушении монолитное закалённое осыпается целиком.");
      if (Hg > 4800) warn.push("Стекло выше 4,8 м — у большинства заводов не закалить; нужна горизонтальная балка-ригель или спецзаказ.");
      if (v.fam !== "igu" && v.heat === "warm") warn.push("Одинарное стекло в отапливаемом помещении: большие теплопотери и конденсат зимой (см. ниже). Для жилого — безрамный стеклопакет.");
      const kgm2 = 2.5 * (g[1] === "igu" ? g[2] * 2 : g[1] === "lam" ? g[2] * 2 : g[2]);
      const area = sideRes.reduce((s, r) => s + r.n * r.pw * Hg, 0) / 1e6;
      const pm = pwMax / 1000 * Hg / 1000 * kgm2;
      if (pm > 150) notes.push("Стекло " + nint(pm) + " кг — монтаж краном или манипулятором с вакуумной траверсой.");
      else if (pm > 60) notes.push("Стекло " + nint(pm) + " кг — нужны вакуумные присоски и 3–4 монтажника.");
      // тепло
      let thermal = "";
      const ti = 20, to = v.tout, dew = (() => { const a = 17.62, b = 243.12, rh = 0.5; const gm = Math.log(rh) + a * ti / (b + ti); return b * gm / (a - gm); })();
      if (v.heat === "warm") {
        const U = g[4], tsi = ti - U * (ti - to) * 0.13, Q = U * area * (ti - to) / 1000;
        const cond = tsi < dew;
        thermal = '<div class="th-row"><div><b>' + nf(U, 1) + '</b> Вт/(м²·°C)<span>коэффициент теплопередачи</span></div><div><b>' + nf(Q, 1) + '</b> кВт<span>теплопотери при ' + to + ' °C</span></div><div class="' + (cond ? "bad" : "good") + '"><b>' + nf(tsi, 1) + ' °C</b><span>стекло изнутри · точка росы ' + nf(dew, 1) + " °C</span></div></div><p>" + (cond ? "Внутренняя поверхность холоднее точки росы — зимой стекло будет запотевать и обмерзать. Нужен стеклопакет с i-стеклом и тёплой дистанционной рамкой, конвектор в полу вдоль остекления." : "Конденсата при влажности 50% не будет. Вдоль остекления в пол всё равно ставят внутрипольный конвектор — он отсекает холодный нисходящий поток от стекла.") + "</p>";
      } else thermal = "<p>Холодное остекление защищает от ветра и осадков, но не держит тепло. Предусмотрите проветривание (щели 5–10 мм у потолка или клапан) — иначе зимой стёкла покроются инеем изнутри.</p>";
      // фасад
      const Wsvg = 860, pL = 10, gapS = 140, sc = Math.min((Wsvg - pL - 70) / (Wtot + (sides.length - 1) * gapS), 230 / v.H);
      const Hs = v.H * sc, top = 16, Ht = top + Hs + 44;
      let svg = '<svg viewBox="0 0 ' + Wsvg + " " + Ht + '" class="gl-svg" role="img" aria-label="Раскрой остекления"><defs><linearGradient id="glg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#bfe0f2" stop-opacity=".55"/><stop offset="1" stop-color="#8fc7e8" stop-opacity=".25"/></linearGradient></defs>';
      let x = pL;
      sideRes.forEach((r, si) => {
        svg += '<rect x="' + x + '" y="' + top + '" width="' + r.Ws * sc + '" height="' + Hs + '" class="gl-open"/>';
        let px = x + (v.shape === "line" || si === 0 ? wallGap * sc : 0);
        for (let i = 0; i < r.n; i++) {
          svg += '<rect x="' + px + '" y="' + (top + 2) + '" width="' + Math.max(1, r.pw * sc) + '" height="' + (Hs - 4) + '" fill="url(#glg)" class="gl-pane2"/><path d="M' + (px + r.pw * sc * 0.15) + " " + (top + Hs * 0.25) + " l" + r.pw * sc * 0.18 + " -" + Hs * 0.12 + '" class="gl-shine"/>';
          svg += '<text x="' + (px + r.pw * sc / 2) + '" y="' + (top + Hs / 2) + '" class="gl-tr" text-anchor="middle">' + nint(r.pw) + "</text>";
          px += r.pw * sc;
          if (i < r.n - 1) { svg += v.fins ? '<rect x="' + (px - 1) + '" y="' + top + '" width="' + (j * sc + 2) + '" height="' + Hs + '" class="gl-fin"/>' : '<rect x="' + px + '" y="' + top + '" width="' + Math.max(1, j * sc) + '" height="' + Hs + '" class="gl-joint"/>'; px += j * sc; }
        }
        svg += '<rect x="' + x + '" y="' + (top + Hs - 3) + '" width="' + r.Ws * sc + '" height="3" class="gl-prof"/><rect x="' + x + '" y="' + top + '" width="' + r.Ws * sc + '" height="4" class="gl-prof"/>';
        svg += '<text x="' + (x + r.Ws * sc / 2) + '" y="' + (top + Hs + 20) + '" class="axis" text-anchor="middle">сторона ' + (si + 1) + ": " + nint(r.Ws) + " мм · " + r.n + " ст.</text>";
        if (si < sides.length - 1) svg += '<text x="' + (x + r.Ws * sc + gapS * sc / 2) + '" y="' + (top + Hs / 2) + '" class="axis" text-anchor="middle">угол</text>';
        x += r.Ws * sc + gapS * sc;
      });
      svg += '<text x="' + (Wsvg - 8) + '" y="' + (top + Hs / 2) + '" class="axis" text-anchor="end">' + nint(v.H) + "</text></svg>";
      // спецификация
      const L = Wtot / 1000, joints = sideRes.reduce((s, r) => s + r.n - 1, 0), corners = sides.length - 1, wallJ = v.shape === "line" ? 2 : 2;
      const silV = (v.joint === "sil" ? joints * j * g[3] * Hg : 0) + corners * 8 * g[3] * Hg + wallJ * 10 * g[3] * Hg + 4 * 36 * Wtot; // мм³
      const tubes = ceil(silV / 1e3 / 280);
      const items = [[g[0] + ", полированная кромка" + (g[1] !== "igu" ? ", закалка + Heat Soak" : ""), Math.round(area * 1.02 * 100) / 100, "м²"], ["Профиль зажимной нижний", Math.round(L * 1.03 * 10) / 10, "м"], ["Профиль верхний (с зазором " + topGap + " мм)", Math.round(L * 1.03 * 10) / 10, "м"], ["Подкладки под стекло", panes * 2, "шт."], ["Клин / уплотнитель EPDM", Math.round(L * 4 * 1.05), "м"], ["Силикон нейтральный прозрачный, 310 мл", tubes, "шт."]];
      if (v.joint === "h") items.push(["H-профиль поликарбонатный", Math.round(joints * Hg / 1000 * 10) / 10, "м"]);
      if (v.fins) { const fd = Math.max(150, Math.round(Hg / 12 / 10) * 10); items.push(["Рёбра — триплекс 12+12, глубина " + fd + " мм", Math.round(joints * fd * Hg / 1e6 * 100) / 100, "м²"]); notes.push("Рёбра жёсткости: " + joints + " шт., глубина ≈ " + Math.max(150, Math.round(Hg / 12 / 10) * 10) + " мм (≈ H/12), крепление — силикон структурный или фитинги."); }
      items.push(["Монтаж остекления", Math.round(area * 10) / 10, "м²"]);
      const rows = [["Расчётное давление ветра (пиковое)", nf(w, 2) + " кПа (≈ " + nint(w * 100) + " кг/м²)"], ["Схема опирания стекла", v.fins ? "4 стороны (низ, верх, рёбра)" : "2 стороны — низ и верх, боковые кромки свободны"], ["Напряжение в стекле", nf(chk.sig, 1) + " МПа из ≈ 50"], ["Прогиб при ветре", nint(chk.f) + " мм из " + nint(chk.fLim)], ["Высота стекла (полная / видимая)", nint(Hg) + " / " + nint(Hvis) + " мм"], ["Ширина стёкол", sideRes.map(r => nint(r.pw)).join(" / ") + " мм"], ["Масса 1 м² / самого тяжёлого стекла", nf(kgm2, 1) + " кг / " + nint(pm) + " кг"], ["Верхний профиль", "заглубление стекла " + topIn + " мм + зазор " + topGap + " мм"]];
      const montage = '<ol class="steps"><li><b>Проверка проёма.</b> Перепад основания по всей длине — не более ±2 мм, иначе выравнивают стяжкой. Верхняя балка — прогиб под снегом известен и ≤ ' + nint(topGap - 10) + " мм.</li><li><b>Нижний профиль.</b> Анкеры через 250–300 мм, выставить по нивелиру; при утоплении в пол — гидроизоляция штрабы и отвод воды наружу.</li><li><b>Верхний профиль</b> — строго над нижним (отвес/лазер), допуск ±1 мм.</li><li><b>Подкладки</b> — по 2 шт. на L/4 от краёв: стекло никогда не ставят на металл.</li><li><b>Установка стекла</b> вакуумными присосками: заводят в верхний профиль, опускают на подкладки, выставляют швы.</li><li><b>Фиксация</b> клиньями EPDM или зажимной системой с двух сторон, момент затяжки — по паспорту профиля.</li><li><b>Швы</b> — нейтральный прозрачный силикон после обезжиривания кромок, шов " + j + " мм; наружные примыкания — герметик и отлив.</li><li><b>Защитная плёнка и маркировка</b> — наклейки на уровне глаз, пока люди не привыкли к «невидимому» стеклу.</li></ol>";
      const rules = "<ul class=\"rules\"><li>Резка, сверление и обработка кромок — <b>только до закалки</b>, после закалки стекло не режут.</li><li>Для крупных закалённых стёкол заказывайте <b>Heat Soak Test</b> — снижает риск самопроизвольного разрушения из-за включений сульфида никеля.</li><li>Кромки — шлифованные или полированные: сколы на кромке — главная причина трещин.</li><li>Зазор между стеклом и стеной, колонной, соседним стеклом — <b>не меньше 5–8 мм</b>, заполняется силиконом: стекло не должно касаться твёрдого.</li><li>Над стеклом — только жёсткая балка или ригель: если верх «играет», стекло лопнет.</li><li>Если остекление в пол граничит с перепадом высоты — стекло работает как ограждение: <b>только триплекс</b>, нижняя граница — по нагрузке на ограждение.</li></ul>";
      return {
        stats: [S("Стёкол", nint(panes), "шт.", "ширина ≈ " + sideRes.map(r => nint(r.pw)).join(" / ") + " мм"), S("Стекло", g[0].replace(/ \(.*\)/, ""), "", v.g === "auto" ? "подобрано по ветру" : "задано", true), S("Площадь", nf(area, 2), "м²", "масса ≈ " + nint(area * kgm2) + " кг"), S("Самое тяжёлое стекло", nint(pm), "кг", nint(pwMax) + " × " + nint(Hg) + " мм"), S("Проверка стекла", chk.ok ? "проходит" : "не проходит", "", "σ " + nf(chk.sig, 0) + " МПа · прогиб " + nint(chk.f) + " мм")],
        warn: warn.join(" "), note: notes.join(" "),
        blocks: [
          { title: "Раскрой стёкол (развёртка)", html: '<div class="chart-scroll">' + svg + '</div><p class="hint">Цифры — ширина стекла, мм. ' + (v.fins ? "Тёмные полосы — стеклянные рёбра." : "Тонкие линии — швы " + j + " мм.") + "</p>" },
          { title: "Узлы", html: '<div class="nodes"><figure>' + nodeSVG("bottom", g) + "<figcaption>Низ: зажимной профиль</figcaption></figure><figure>" + nodeSVG("top", g) + "<figcaption>Верх: профиль с зазором на прогиб</figcaption></figure><figure>" + nodeSVG("joint", g) + "<figcaption>Стык стекло–стекло</figcaption></figure><figure>" + nodeSVG("corner", g) + "<figcaption>Угол без стойки</figcaption></figure></div>" },
          { title: v.heat === "warm" ? "Тепло и конденсат" : "Холодное остекление", html: thermal },
          { title: "Порядок монтажа", html: montage },
          { cls: "method", title: "Правила, которые нельзя нарушать", html: rules }
        ],
        table: { head: ["Параметр", "Значение"], rows },
        extra: items.map(i => [i[0], (typeof i[1] === "number" ? i[1].toLocaleString("ru-RU") : i[1]) + " " + i[2]]),
        items
      };
    },
    info: "Стационарное безрамное остекление — стекло вставлено в зажимной профиль снизу и в профиль с зазором сверху, боковые кромки соединены прозрачным швом. Ветер — по СП 20.13330 (пиковое давление с пульсациями и краевыми зонами). Стекло на двух опорах считается как полоса пролётом H, с рёбрами — как пластина, опёртая по контуру (коэффициенты Тимошенко). Двухслойные стёкла (триплекс, стеклопакет) — без учёта совместной работы слоёв, в запас. Допускаемое напряжение для закалённого стекла ≈ 50 МПа, прогиб — не более L/65 и 50 мм. Это предварительный подбор: финальную толщину и узлы подтверждает производитель профильной системы."
  });

  // ====================================================================
  //  ВЕНТИЛЯЦИЯ: расчёт и обучалка
  // ====================================================================
  const rhoAir = t => 353 / (273 + t);
  const draftPa = (H, ti, to) => Math.max(0, H * 9.81 * (rhoAir(to) - rhoAir(ti)));
  const ventVel = dp => Math.min(1.0, Math.sqrt(2 * dp / (1.2 * 8)));
  const CH = { b140: ["Кирпичный 140×140", 0.0196], b140x270: ["Кирпичный 140×270", 0.0378], r125: ["Круглый Ø125", 0.0123], r150: ["Круглый Ø150", 0.0177], vb: ["Вентблок 150×200", 0.03] };
  add({
    id: "vent", cat: "tech", mark: "по тяге", name: "Естественная вентиляция: каналы и приток", kw: "вентиляция естественная вытяжка приток вентканал канал сечение кухня санузел клапан кив переток тяга котельная воздухообмен",
    desc: "Нормы воздухообмена, тяга по высоте канала, сколько каналов и приточных клапанов нужно",
    inputs: [
      { k: "area", label: "Жилая площадь (комнаты), м²", def: 80 },
      { k: "people", label: "Проживает человек", def: 4 },
      { k: "rooms", label: "Жилых комнат", def: 4 },
      { k: "stove", label: "Плита на кухне", type: "sel", def: "el", opts: [["el", "Электрическая — 60 м³/ч"], ["gas", "Газовая — 90 м³/ч"]] },
      { k: "comb", label: "Совмещённых санузлов", def: 1 },
      { k: "bath", label: "Отдельных ванных / душевых", def: 0 },
      { k: "wc", label: "Отдельных туалетов", def: 1 },
      { k: "boil", label: "Котельная (топочная)", type: "check", def: false },
      { k: "bv", label: "Объём котельной, м³", def: 15, show: v => v.boil },
      { k: "bkw", label: "Мощность котла, кВт", def: 24, show: v => v.boil },
      { k: "fl", label: "Этажей", type: "sel", def: "2", opts: [["1", "1"], ["2", "2"]] },
      { k: "up", label: "Из них санузлов на 2-м этаже", def: 1, show: v => v.fl === "2" },
      { k: "H1", label: "Высота канала с 1-го этажа, м", def: 7.5, hint: "От решётки до верха трубы" },
      { k: "H2", label: "Высота канала со 2-го этажа, м", def: 4.5, show: v => v.fl === "2" },
      { k: "ch", label: "Тип канала", type: "sel", def: "b140", opts: Object.entries(CH).map(([k, c]) => [k, c[0] + " (" + nf(c[1] * 1e4, 0) + " см²)"]) }
    ],
    run(v) {
      const ti = 20, to = 5, A = CH[v.ch][1];
      const cap = H => { const dp = draftPa(H, ti, to), vel = ventVel(dp); return { dp, vel, q: A * vel * 3600 }; };
      const two = v.fl === "2", up = two ? Math.min(v.up, v.comb + v.bath + v.wc) : 0;
      const rooms = [];
      const addR = (name, L, H, n) => { for (let i = 0; i < n; i++) rooms.push({ name: n > 1 ? name + " " + (i + 1) : name, L, H }); };
      addR("Кухня", v.stove === "gas" ? 90 : 60, v.H1, 1);
      let upLeft = up;
      const wet = [["Совмещённый санузел", 50, v.comb], ["Ванная / душевая", 25, v.bath], ["Туалет", 25, v.wc]];
      wet.forEach(([nm, L, n]) => { for (let i = 0; i < n; i++) { const onUp = upLeft > 0; if (onUp) upLeft--; rooms.push({ name: nm + (n > 1 ? " " + (i + 1) : "") + (onUp ? " (2 эт.)" : ""), L, H: onUp ? v.H2 : v.H1 }); } });
      if (v.boil) rooms.push({ name: "Котельная", L: Math.round(3 * v.bv), H: v.H1 });
      let ex = 0, chTot = 0, maxCh = 0;
      const rows = rooms.map(r => { const c = cap(r.H), n = Math.max(1, ceil(r.L / c.q)); ex += r.L; chTot += n; maxCh = Math.max(maxCh, n); return [r.name, nint(r.L), nf(r.H, 1) + " м", nf(c.dp, 1) + " Па", nf(c.vel, 2) + " м/с", nint(c.q) + " м³/ч", String(n)]; });
      const need = Math.max(ex, v.people * 30, v.area * 3);
      const valves = Math.max(v.rooms, ceil(need / 25));
      const doors = v.comb + v.bath + v.wc + 1 + (v.boil ? 1 : 0);
      const items = [["Решётка вытяжная регулируемая", chTot, "шт."], ["Приточный стеновой клапан (КИВ-125 или аналог)", valves, "шт."], ["Переточная решётка в дверь (или подрезка полотна 20 мм)", doors, "шт."]];
      if (v.boil) items.push(["Приточная решётка котельной ≥ 0,02 м²", 1, "шт."]);
      const warn = maxCh > 2 ? "Для некоторых помещений нужно 3 и больше каналов — увеличьте сечение (140×270, вентблок) или поднимите трубу выше: тяга растёт с высотой." : "";
      return {
        stats: [S("Вытяжка всего", nint(ex), "м³/ч", "по нормам для кухни и санузлов"), S("Нужно притока", nint(need), "м³/ч", "≥ 30 м³/ч на человека и ≥ 3 м³/ч на м²"), S("Вытяжных каналов", nint(chTot), "шт.", CH[v.ch][0], true), S("Приточных клапанов", nint(valves), "шт.", "≈ 25 м³/ч каждый, минимум по одному на комнату"), S("Тяга со 2-го этажа", two ? nf(cap(v.H2).dp, 1) : nf(cap(v.H1).dp, 1), "Па", "при +5 °C снаружи — расчётный случай")],
        warn, note: "Расчёт по наихудшему режиму СП 60: снаружи +5 °C, внутри +20 °C. Зимой тяга в 2–3 раза сильнее — ставьте регулируемые решётки.",
        table: { head: ["Помещение", "Норма, м³/ч", "Канал", "Тяга", "Скорость", "1 канал даёт", "Каналов"], rows },
        blocks: [{ html: '<p>Не знаете, с чего начать? ' + goBtn("ventguide", "Обучалка по естественной вентиляции") + "</p>" }],
        items
      };
    },
    info: "Тяга: Δp = H·g·(ρнар − ρвн), плотность воздуха ρ = 353 / (273 + t). Скорость в канале — из баланса давления и сопротивлений (решётки, вход, поворот, выход, приток и перетоки, суммарный КМС ≈ 8), но не больше 1 м/с. Нормы вытяжки — СП 54.13330 и СП 60.13330: кухня 60 м³/ч с электроплитой и 90 м³/ч с газовой, ванная и туалет по 25, совмещённый санузел 50; котельная — 3 обмена в час плюс воздух на горение."
  });

  // ---------- Обучалка ----------
  function houseSVG() {
    return '<svg viewBox="0 0 640 400" class="lv-svg" role="img" aria-label="Схема движения воздуха в доме"><defs><marker id="ab" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#3b82c4"/></marker><marker id="ao" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#e0710f"/></marker></defs>' +
      '<path d="M60 150 L320 40 L580 150" class="lv-roof"/><rect x="80" y="150" width="480" height="230" class="lv-house"/><line x1="80" y1="265" x2="560" y2="265" class="lv-wall"/><line x1="320" y1="150" x2="320" y2="380" class="lv-wall"/>' +
      '<rect x="316" y="236" width="8" height="29" class="lv-gap"/><rect x="316" y="351" width="8" height="29" class="lv-gap"/>' +
      '<rect x="470" y="40" width="22" height="225" class="lv-duct"/><rect x="500" y="62" width="22" height="318" class="lv-duct"/>' +
      '<text x="200" y="180" class="lv-t" text-anchor="middle">Спальня</text><text x="440" y="180" class="lv-t" text-anchor="middle">Санузел</text><text x="200" y="295" class="lv-t" text-anchor="middle">Гостиная</text><text x="420" y="295" class="lv-t" text-anchor="middle">Кухня</text>' +
      '<rect x="80" y="220" width="10" height="14" class="lv-valve"/><rect x="80" y="335" width="10" height="14" class="lv-valve"/>' +
      '<path d="M20 227 H120 Q200 227 230 245 T312 254" class="lv-fb" marker-end="url(#ab)"/><path d="M20 342 H120 Q200 342 240 360 T312 368" class="lv-fb" marker-end="url(#ab)"/>' +
      '<path d="M330 252 Q400 240 465 200" class="lv-fb" marker-end="url(#ab)"/><path d="M330 366 Q420 350 495 300" class="lv-fb" marker-end="url(#ab)"/>' +
      '<path d="M481 215 V30" class="lv-fo" marker-end="url(#ao)"/><path d="M511 330 V52" class="lv-fo" marker-end="url(#ao)"/>' +
      '<text x="18" y="215" class="lv-s">приточный клапан</text><text x="282" y="230" class="lv-s" text-anchor="end">переток под дверью</text><text x="530" y="24" class="lv-s">вытяжные каналы</text><text x="530" y="36" class="lv-s">выше кровли</text>' +
      '<text x="320" y="396" class="lv-s" text-anchor="middle">свежий воздух — в жилые комнаты, вытяжка — из кухни и санузлов</text></svg>';
  }
  function roofSVG() {
    return '<svg viewBox="0 0 640 260" class="lv-svg" role="img" aria-label="Высота вентканала над кровлей"><path d="M40 230 L320 90 L600 230" class="lv-roof"/>' +
      '<line x1="320" y1="90" x2="600" y2="139" class="lv-dash"/><text x="560" y="128" class="lv-s" text-anchor="end">линия 10° от конька</text>' +
      '<rect x="345" y="48" width="16" height="56" class="lv-duct"/><line x1="320" y1="48" x2="345" y2="48" class="lv-dim"/><text x="368" y="58" class="lv-s">до 1,5 м от конька: ≥ 0,5 м выше конька</text>' +
      '<rect x="420" y="86" width="16" height="56" class="lv-duct"/><line x1="300" y1="90" x2="430" y2="90" class="lv-dash"/><text x="442" y="96" class="lv-s">1,5–3 м: не ниже конька</text>' +
      '<rect x="520" y="104" width="16" height="78" class="lv-duct"/><text x="540" y="200" class="lv-s" text-anchor="end">дальше 3 м: не ниже линии 10°</text>' +
      '<text x="40" y="252" class="lv-s">Иначе ветер «задувает» канал — тяга опрокидывается. Над плоской кровлей — не менее 0,5 м.</text></svg>';
  }
  function stackSVG() {
    return '<svg viewBox="0 0 640 236" class="lv-svg" role="img" aria-label="Тяга"><rect x="260" y="20" width="40" height="185" class="lv-duct"/><path d="M280 200 V30" class="lv-fo" marker-end="url(#ao2)"/><defs><marker id="ao2" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#e0710f"/></marker></defs>' +
      '<text x="250" y="110" class="lv-t" text-anchor="end">тёплый воздух +20 °C</text><text x="250" y="126" class="lv-s" text-anchor="end">легче — поднимается</text><text x="310" y="110" class="lv-t">холодный снаружи</text><text x="310" y="126" class="lv-s">тяжелее — давит снизу</text>' +
      '<line x1="330" y1="20" x2="330" y2="210" class="lv-dim"/><text x="338" y="30" class="lv-s">H — высота канала</text><text x="320" y="228" class="lv-s" text-anchor="middle">Δp = H · g · (ρ снаружи − ρ внутри) ≈ 0,04 · H · Δt, Па</text></svg>';
  }
  const LESSONS = [
    { t: "Как работает естественная вентиляция", h: () => "<p>Вентиляция без вентиляторов работает за счёт <b>тяги</b>: тёплый воздух в доме легче холодного уличного и уходит вверх по вертикальным каналам, а на его место через приточные отверстия заходит свежий. Чем выше канал и чем холоднее на улице, тем сильнее тяга.</p>" + stackSVG() + '<div class="lv-play"><label><span>Высота канала: <b data-o="hv">5</b> м</span><input type="range" min="2" max="12" step="0.5" value="5" data-i="h"></label><label><span>Снаружи: <b data-o="tv">5</b> °C</span><input type="range" min="-25" max="25" step="1" value="5" data-i="t"></label><div class="lv-res" data-o="res"></div></div><p>Подвигайте ползунки: зимой тяга сильная, а летом, когда на улице +20…+25 °C, её почти нет. Поэтому летом естественная вентиляция работает за счёт открытых окон, а расчёт ведут для +5 °C — это самый слабый режим отопительного сезона.</p>' },
    { t: "Путь воздуха по дому", h: () => "<p>Главное правило: <b>свежий воздух подаётся в «чистые» помещения</b> — спальни, гостиную, кабинет, — а <b>удаляется из «грязных»</b> — кухни, санузлов, гардеробных, котельной. По дороге он проходит через двери и коридор. Так запахи и влага не расходятся по дому.</p>" + houseSVG() + "<p>Если поменять местами — сделать вытяжку в спальне, а приток на кухне, — запах готовки разойдётся по всему дому.</p>" },
    { t: "Приток: откуда брать свежий воздух", h: () => '<p>В старых домах воздух заходил через щели в деревянных окнах. Пластиковые окна герметичны, и без отдельного притока вытяжка просто перестаёт работать: воздуху неоткуда прийти. Отсюда духота, сырость, плесень на откосах.</p><table class="data lv-t2"><thead><tr><th>Решение</th><th>Плюсы</th><th>Минусы</th></tr></thead><tbody><tr><td>Стеновой приточный клапан (КИВ)</td><td>20–35 м³/ч, регулируется, есть шумоглушение и фильтр</td><td>Нужно сверлить стену Ø 125–160 мм</td></tr><tr><td>Оконный клапан в раме</td><td>Не нужно сверлить стену</td><td>Меньше расход, зимой может обмерзать</td></tr><tr><td>Микропроветривание окна</td><td>Бесплатно</td><td>Нет фильтра и регулировки, сквозняк</td></tr></tbody></table><p><b>Куда ставить:</b> за радиатором под окном (воздух сразу прогревается) или под потолком на высоте 2–2,2 м. <b>Сколько:</b> не меньше одного на каждую жилую комнату — примерно 30 м³/ч на человека.</p>' },
    { t: "Перетоки: путь через двери", h: () => "<p>Воздух должен свободно пройти из комнаты в комнату к вытяжке. Плотно закрытая дверь в санузел без зазора полностью «выключает» вентиляцию в нём.</p><ul class=\"rules\"><li>Зазор под дверью <b>15–20 мм</b> — достаточно для комнаты и санузла.</li><li>Или переточная решётка в полотне двери — около 200×100 мм.</li><li>Двери в котельную — обязательно решётка, площадь — по паспорту котла.</li><li>Порог в санузле — тогда только решётка.</li></ul>" },
    { t: "Вытяжные каналы", h: () => '<table class="data lv-t2"><thead><tr><th>Помещение</th><th>Вытяжка по нормам</th></tr></thead><tbody><tr><td>Кухня с электроплитой</td><td>60 м³/ч</td></tr><tr><td>Кухня с газовой плитой</td><td>90 м³/ч</td></tr><tr><td>Ванная, туалет</td><td>по 25 м³/ч</td></tr><tr><td>Совмещённый санузел</td><td>50 м³/ч</td></tr><tr><td>Котельная</td><td>3 обмена в час + воздух на горение</td></tr></tbody></table><ul class="rules"><li><b>Отдельный канал от каждого помещения</b>: объединять кухню и санузел в один канал нельзя — запахи пойдут в соседнюю комнату.</li><li>Минимум — кирпичный 140×140 мм или круглый Ø 125–150 мм. Стенки гладкие.</li><li>Канал вертикальный, допускается отклонение до 30° на длине не больше 1 м.</li><li>На холодном чердаке и над кровлей канал <b>утепляют</b> — иначе он остывает, в нём выпадает конденсат, и тяга «опрокидывается».</li><li>Каналы со второго этажа короче — тяга в них слабее, им нужно большее сечение.</li></ul>' + roofSVG() },
    { t: "Кухня, котельная, камин", h: () => "<ul class=\"rules\"><li><b>Кухонный зонт с вентилятором</b> подключайте к отдельному каналу или каналу-спутнику. Если загнать его в единственный канал кухни, при выключенном зонте канал перекрыт его коробом, а при включённом вентилятор выдувает воздух в соседние каналы.</li><li><b>Газ на кухне</b> — окно с открывающейся створкой, вытяжной канал, приток (зазор под дверью); требования — СП 62.13330 и проект газификации.</li><li><b>Котельная</b> — постоянный приток с улицы через решётку (для горения), вытяжной канал под потолком и <b>отдельный дымоход</b>. Котёл с закрытой камерой берёт воздух коаксиальной трубой.</li><li><b>Камин и печь</b> съедают много воздуха: без отдельного притока к топке они «перетягивают» на себя вентканалы, и запахи из санузлов идут в дом.</li></ul>" },
    { t: "Частые ошибки", h: () => "<ol class=\"steps\"><li>Пластиковые окна без приточных клапанов — духота и конденсат.</li><li>Двери без зазора — санузел не проветривается.</li><li>Каналы выведены на чердак, а не на улицу — сырость и плесень на стропилах.</li><li>Неутеплённые каналы на холодном чердаке — обмерзание и обратная тяга.</li><li>Труба ниже конька или рядом с ним — ветер задувает внутрь.</li><li>Вентилятор в одном канале с соседями или зонт в единственном канале кухни.</li><li>Вытяжка из спальни и приток в кухню — запахи по всему дому.</li><li>Канал сделали 100×100 «чтобы поместился» — расхода не хватает.</li></ol>" },
    { t: "Как проверить, что работает", h: () => "<ul class=\"rules\"><li><b>Лист бумаги</b> у вытяжной решётки при приоткрытом окне должен притягиваться. Если отталкивается — тяга опрокинута.</li><li><b>Анемометр</b> у решётки: скорость × площадь решётки = расход. Сравните с нормой.</li><li><b>Датчик CO₂</b> в спальне ночью: до 800 ppm — отлично, до 1000 ppm — нормально, выше 1200 ppm — притока мало.</li><li><b>Влажность</b> 40–60%. Выше — конденсат на окнах и плесень, ниже (зимой) — сухость, нужен увлажнитель, а не закрытая вентиляция.</li><li>Запотевающие окна и тёмные пятна в углах — первый признак, что вентиляции не хватает.</li></ul><p>Если естественной тяги не хватает (одноэтажный дом, короткие каналы, жаркий климат) — ставят <b>приточно-вытяжную установку с рекуперацией</b>: она работает круглый год и возвращает до 80–90% тепла.</p>" }
  ];
  const QUIZ = [
    ["Из каких помещений делают вытяжку?", ["Из спален и гостиной", "Из кухни, санузлов, котельной", "Из коридора"], 1, "Вытяжка — из «грязных» помещений, приток — в жилые."],
    ["Почему летом естественная вентиляция почти не тянет?", ["Каналы забиваются пылью", "Разница температур внутри и снаружи маленькая", "Летом выше влажность"], 1, "Тяга пропорциональна высоте канала и разнице температур."],
    ["Дверь в санузел плотная, без зазора. Что с вытяжкой?", ["Работает как обычно", "Почти не работает — воздуху неоткуда прийти", "Работает лучше"], 1, "Нужен зазор 15–20 мм под дверью или переточная решётка."],
    ["Вентканал идёт через холодный чердак без утепления. Что будет?", ["Ничего", "Конденсат, обмерзание и опрокидывание тяги", "Тяга станет сильнее"], 1, "Канал на холодном чердаке и над кровлей утепляют."],
    ["Можно подключить кухонный зонт к единственному вентканалу кухни?", ["Да, так все делают", "Нет — нужен отдельный канал или канал-спутник", "Только с гофрой"], 1, "Иначе зонт перекрывает естественную вытяжку."],
    ["Вентканал выходит в 1 м от конька. Какой высоты трубу делать?", ["Не ниже конька", "Не менее 0,5 м выше конька", "Высота не важна"], 1, "До 1,5 м от конька — не менее 0,5 м выше него."]
  ];
  add({
    id: "ventguide", cat: "learn", custom: true, mark: "обучалка", name: "Естественная вентиляция в доме", kw: "обучение вентиляция естественная как сделать приток вытяжка ошибки тяга урок гайд обучалка",
    desc: "8 коротких уроков со схемами, интерактивная тяга, разбор ошибок и тест на понимание",
    render(panel, api) {
      let step = Math.min(store.get("vg:step") || 0, LESSONS.length);
      const answers = {};
      const draw = () => {
        store.set("vg:step", step);
        const nav = '<div class="lv-nav">' + LESSONS.map((l, i) => '<button type="button" data-step="' + i + '" class="' + (i === step ? "on" : i < step ? "done" : "") + '"><span>' + (i + 1) + "</span>" + esc(l.t) + "</button>").join("") + '<button type="button" data-step="' + LESSONS.length + '" class="' + (step === LESSONS.length ? "on" : "") + '"><span>✓</span>Тест</button></div>';
        let body;
        if (step < LESSONS.length) {
          const l = LESSONS[step];
          body = '<div class="lv-prog"><span style="width:' + Math.round(step / LESSONS.length * 100) + '%"></span></div><div class="eyebrow">Урок ' + (step + 1) + " из " + LESSONS.length + '</div><h3 class="lv-h">' + esc(l.t) + '</h3><div class="lv-body">' + l.h() + '</div><div class="lv-btns">' + (step > 0 ? '<button type="button" class="btn sm ghost" data-step="' + (step - 1) + '">← Назад</button>' : "") + '<button type="button" class="btn sm" data-step="' + (step + 1) + '">' + (step === LESSONS.length - 1 ? "К тесту →" : "Дальше →") + "</button></div>";
        } else {
          body = '<div class="eyebrow">Проверьте себя</div><h3 class="lv-h">Тест: 6 вопросов</h3>' + QUIZ.map((q, i) => '<div class="qz" data-q="' + i + '"><p><b>' + (i + 1) + ". " + esc(q[0]) + "</b></p>" + q[1].map((o, k) => '<button type="button" class="qz-o" data-q="' + i + '" data-a="' + k + '">' + esc(o) + "</button>").join("") + '<p class="qz-f"></p></div>').join("") + '<div class="qz-total" data-o="total"></div><div class="lv-btns"><button type="button" class="btn sm ghost" data-step="0">Пройти заново</button><button type="button" class="btn sm" data-open="vent">Рассчитать каналы для своего дома →</button></div>';
        }
        panel.innerHTML = '<section class="card lv">' + nav + '<div class="lv-main">' + body + "</div></section>";
        const play = panel.querySelector(".lv-play");
        if (play) {
          const upd = () => { const H = +play.querySelector('[data-i="h"]').value, t = +play.querySelector('[data-i="t"]').value; play.querySelector('[data-o="hv"]').textContent = nf(H, 1); play.querySelector('[data-o="tv"]').textContent = t; const dp = draftPa(H, 20, t), vel = ventVel(dp), q = 0.0196 * vel * 3600; play.querySelector('[data-o="res"]').innerHTML = "Тяга <b>" + nf(dp, 1) + " Па</b> · скорость в канале 140×140 <b>" + nf(vel, 2) + " м/с</b> · расход <b>" + nint(q) + " м³/ч</b>" + (q < 25 ? ' <span class="bad">— меньше нормы даже для туалета</span>' : q < 60 ? ' <span class="mid">— хватит на санузел, на кухню мало</span>' : ' <span class="good">— хватит и на кухню</span>'); };
          play.addEventListener("input", upd); upd();
        }
      };
      panel.addEventListener("click", e => {
        const op = e.target.closest("[data-open]");
        if (op) { api.open(op.dataset.open); return; }
        const s = e.target.closest("[data-step]");
        if (s) { step = +s.dataset.step; draw(); panel.scrollIntoView({ block: "start", behavior: "smooth" }); return; }
        const o = e.target.closest(".qz-o");
        if (o) {
          const qi = +o.dataset.q, a = +o.dataset.a; answers[qi] = a;
          const box = panel.querySelector('.qz[data-q="' + qi + '"]'), q = QUIZ[qi];
          box.querySelectorAll(".qz-o").forEach(b => { b.classList.remove("right", "wrong"); if (+b.dataset.a === q[2]) b.classList.add(a === q[2] ? "right" : ""); });
          o.classList.add(a === q[2] ? "right" : "wrong");
          box.querySelector(".qz-f").textContent = (a === q[2] ? "Верно. " : "Не совсем. ") + q[3];
          const done = Object.keys(answers).length, ok = Object.entries(answers).filter(([i, x]) => QUIZ[i][2] === x).length;
          panel.querySelector('[data-o="total"]').textContent = done === QUIZ.length ? "Результат: " + ok + " из " + QUIZ.length + (ok === QUIZ.length ? " — все ответы верны. Можно переходить к расчёту." : ok >= 4 ? " — хороший результат. Перечитайте урок о частых ошибках." : " — рекомендуем пройти уроки ещё раз.") : "";
        }
      });
      draw();
    }
  });

  // ====================================================================
  //  ПЕРЕМЫЧКИ, ПУСТОТНЫЕ ПЛИТЫ, ОБУЧАЛКА ПО ПЛИТАМ
  // ====================================================================
  const PB_LEN = { 10: 1030, 13: 1290, 16: 1550, 17: 1680, 18: 1810, 19: 1940, 21: 2070, 22: 2200, 25: 2460, 26: 2590, 27: 2720, 29: 2850, 30: 2980, 31: 3110, 34: 3370, 36: 3630, 39: 3890 };
  const PB_FAM = { "2ПБ": [120, 140, "10-1 13-1 16-2 17-2 19-3 22-3 25-3 26-4 29-4 30-4"], "3ПБ": [120, 220, "13-37 16-37 18-8 18-37 21-8 25-8 25-37 27-8 30-8 34-4 36-4 39-8"], "8ПБ": [120, 190, "10-1 13-1 16-1 17-2 19-3"], "9ПБ": [120, 190, "13-37 16-37 18-8 18-37 22-3 25-8 26-4 27-8 29-4"], "5ПБ": [250, 220, "18-27 21-27 25-27 25-37 27-27 27-37 30-27 30-37 31-27 34-20 36-20"] };
  const PB = [];
  Object.entries(PB_FAM).forEach(([f, [b, h, list]]) => list.split(" ").forEach(s => { const [l, q] = s.split("-").map(Number); const L = PB_LEN[l]; PB.push({ name: f + l + "-" + q + "п", fam: f, b, h, L, q, kg: b / 1000 * h / 1000 * L / 1000 * 2500 }); }));
  const LW = { brickC: ["Кирпич керамический полнотелый", 18, "brick"], brickS: ["Кирпич силикатный", 19, "brick"], brickH: ["Кирпич пустотелый", 14, "brick"], keramz: ["Керамзитобетонный блок", 12, "block"], aer: ["Газобетон D500", 6.5, "aer"] };
  const pickPB = (b, Lreq, q, prefH) => PB.filter(p => p.b === b && p.L >= Lreq && p.q >= q && (!prefH || p.h === prefH || true)).sort((x, y) => x.kg - y.kg || x.L - y.L)[0];
  add({
    id: "lintel", cat: "struct", mark: "по нагрузке", name: "Подбор перемычек над проёмами", kw: "перемычка перемычки пб 2пб 3пб 5пб 9пб проём окно дверь нагрузка кладка кирпич газобетон серия 1.038.1-1 подбор брусковые",
    desc: "Нагрузка от кладки и плит, сколько брусков на толщину стены, марки по серии 1.038.1-1, схема",
    inputs: [
      { k: "B", label: "Ширина проёма в свету, мм", def: 1500 },
      { k: "mat", label: "Материал стены", type: "sel", def: "brickS", opts: Object.entries(LW).map(([k, w]) => [k, w[0]]) },
      { k: "t", label: "Толщина стены, мм", type: "sel", def: "380", opts: [["120", "120 (½ кирпича)"], ["250", "250 (1 кирпич)"], ["380", "380 (1½ кирпича)"], ["510", "510 (2 кирпича)"], ["640", "640 (2½ кирпича)"], ["300", "300 (блок)"], ["375", "375 (блок)"], ["400", "400 (блок)"]] },
      { k: "role", label: "Стена", type: "sel", def: "bear", opts: [["bear", "Несущая — на неё опираются плиты или балки"], ["self", "Самонесущая / перегородка"]] },
      { k: "ha", label: "Кладка над перемычкой до перекрытия, мм", def: 600, hint: "Если плиты ближе, чем ширина проёма, их вес идёт на перемычку" },
      { k: "span", label: "Пролёт перекрытия, опирающегося на стену, м", def: 6, show: v => v.role === "bear" },
      { k: "slab", label: "Перекрытие", type: "sel", def: "pk", opts: [["pk", "Пустотные плиты 220 мм"], ["mono", "Монолит 200 мм"], ["wood", "Деревянные балки"]], show: v => v.role === "bear" },
      { k: "two", label: "Плиты опираются с двух сторон (внутренняя стена)", type: "check", def: false, show: v => v.role === "bear" },
      { k: "clad", label: "Наружная верста — облицовочный кирпич", type: "check", def: false }
    ],
    run(v) {
      const B = v.B, t = +v.t, w = LW[v.mat], gam = w[1];
      const sup = v.role === "bear" ? (B > 1500 ? 250 : 200) : 120;
      const Lreq = B + 2 * sup;
      // нагрузки, кН/м по всей толщине
      const band = v.ha >= B / 3 ? B / 3 : v.ha;
      const qMas = gam * t / 1000 * band / 1000 * 1.1;
      let qSlab = 0;
      if (v.role === "bear" && v.ha < B) {
        const g = { pk: 3.0 + 1.5, mono: 5.0 + 1.5, wood: 0.5 + 0.5 }[v.slab];
        qSlab = (g * 1.1 + 1.5 * 1.3) * v.span / 2 * (v.two ? 2 : 1);
      }
      // варианты набора брусков по толщине
      const sets = { 120: [[120]], 250: [[120, 120], [250]], 380: [[120, 120, 120], [120, 250]], 510: [[120, 120, 120, 120], [250, 250], [120, 120, 250]], 640: [[120, 120, 120, 120, 120], [120, 250, 250]], 300: [[120, 120]], 375: [[120, 120, 120]], 400: [[120, 120, 120]] }[t];
      let best = null;
      sets.forEach(set => {
        const sum = set.reduce((s, x) => s + x, 0);
        const bars = set.map((b, i) => {
          const outer = i === 0, inner = i === set.length - 1;
          let q = qMas * b / t;
          const share = v.two && set.length > 1 ? 0.5 : 1;
          if (inner) q += qSlab * share;
          if (outer && v.two && set.length > 1) q += qSlab * 0.5;
          if (outer && v.clad && !v.two) q = 19 * 0.12 * band / 1000 * 1.1;
          const p = pickPB(b, Lreq, q);
          return { b, q, p, outer, inner };
        });
        if (bars.some(x => !x.p)) return;
        const kg = bars.reduce((s, x) => s + x.p.kg, 0);
        if (!best || kg < best.kg) best = { bars, kg, gap: t - sum };
      });
      const warn = [];
      if (!best) return { warn: "Под такую нагрузку и ширину проёма в серии нет подходящих брусковых перемычек. Нужна монолитная перемычка или металлическая (уголки, швеллеры) по расчёту." };
      if (w[2] === "aer") warn.push("В газобетонной стене ж/б перемычки — мостик холода: снаружи утеплите их 50 мм или используйте газобетонные армированные перемычки и U-блоки. Под опоры — распределительный слой раствора, в зоне опирания под плитами — армопояс.");
      if (best.gap > 20) warn.push("Остаток толщины " + nint(best.gap) + " мм между брусками заполните утеплителем или кладкой.");
      if (B > 2500 && v.role === "bear") warn.push("Проём шире 2,5 м в несущей стене — проверьте перемычку расчётом, рассмотрите монолитную.");
      // схема: фасад и разрез
      const W = 860, sc = Math.min(560 / (Lreq + 600), 0.16), ox = 40, oy = 40;
      const hBar = Math.max(...best.bars.map(x => x.p.h));
      const wallW = (Lreq + 600) * sc, opW = B * sc, opH = 1400 * sc;
      const yL = oy + Math.max(band, v.ha) * sc + 20;
      let s = '<svg viewBox="0 0 ' + W + ' ' + (yL + hBar * sc + opH + 50) + '" class="gl-svg" role="img" aria-label="Схема перемычки">';
      s += '<rect x="' + ox + '" y="' + oy + '" width="' + wallW + '" height="' + (yL - oy + hBar * sc + opH) + '" class="ln-wall"/>';
      if (v.role === "bear") s += '<rect x="' + (ox - 10) + '" y="' + (yL - v.ha * sc - 22 * sc * 10 / 10 - 8) + '" width="' + (wallW + 20) + '" height="8" class="ln-slab"/>';
      const xo = ox + 300 * sc;
      s += '<rect x="' + (xo + sup * sc) + '" y="' + (yL + hBar * sc) + '" width="' + opW + '" height="' + opH + '" class="ln-open"/>';
      s += '<rect x="' + xo + '" y="' + yL + '" width="' + Lreq * sc + '" height="' + hBar * sc + '" class="ln-bar"/>';
      s += '<path d="M' + (xo + sup * sc) + ' ' + yL + ' L' + (xo + sup * sc + opW / 2) + ' ' + (yL - band * sc) + ' L' + (xo + sup * sc + opW) + ' ' + yL + ' Z" class="ln-load"/>';
      s += '<text x="' + (xo + sup * sc + opW / 2) + '" y="' + (yL - band * sc / 3) + '" class="axis" text-anchor="middle">кладка ' + nint(band) + ' мм</text>';
      s += '<text x="' + (xo + Lreq * sc / 2) + '" y="' + (yL + hBar * sc + opH / 2) + '" class="axis" text-anchor="middle">проём ' + nint(B) + ' мм</text>';
      s += '<text x="' + (xo + Lreq * sc / 2) + '" y="' + (yL + hBar * sc + opH + 18) + '" class="axis" text-anchor="middle">перемычка ' + nint(best.bars[best.bars.length - 1].p.L) + ' мм, опирание ≥ ' + sup + ' мм</text>';
      // разрез
      const sx = ox + wallW + 80, ss = Math.min(0.45, (W - sx - 230) / (t + 40));
      let bx = sx;
      s += '<text x="' + sx + '" y="' + (oy + 10) + '" class="axis">разрез стены</text>';
      best.bars.forEach(x => { s += '<rect x="' + bx + '" y="' + (yL + (hBar - x.p.h) * ss) + '" width="' + x.b * ss + '" height="' + x.p.h * ss + '" class="ln-bar"/><text x="' + (bx + x.b * ss / 2) + '" y="' + (yL + hBar * ss + 14) + '" class="axis" text-anchor="middle">' + x.p.fam + '</text>'; bx += x.b * ss + (best.gap > 0 && x === best.bars[0] ? best.gap * ss : 3); });
      if (v.role === "bear") s += '<rect x="' + (bx - 130 * ss) + '" y="' + (yL - 230 * ss) + '" width="' + (200) + '" height="' + 220 * ss + '" class="ln-slab"/><text x="' + (bx + 40) + '" y="' + (yL - 230 * ss - 6) + '" class="axis">плита</text>';
      s += '<text x="' + sx + '" y="' + (yL + hBar * ss + 34) + '" class="axis">снаружи → внутрь</text></svg>';
      const rows = best.bars.map((x, i) => [(x.outer ? "Наружный" : x.inner ? "Внутренний" : "Средний") + " брусок " + x.b + " мм", x.p.name, nf(x.q, 1) + " кН/м", nf(x.p.q, 0) + " кН/м", nint(x.p.kg) + " кг"]);
      const cnt = {};
      best.bars.forEach(x => cnt[x.p.name] = (cnt[x.p.name] || 0) + 1);
      return {
        stats: [S("Перемычки на 1 проём", Object.entries(cnt).map(([n, c]) => c + " × " + n).join(" + "), "", "", true), S("Длина", nint(best.bars[0].p.L) + "–" + nint(Math.max(...best.bars.map(x => x.p.L))), "мм", "нужно ≥ " + nint(Lreq)), S("Нагрузка от кладки", nf(qMas, 1), "кН/м", "пояс " + nint(band) + " мм" + (v.ha >= B / 3 ? " (⅓ проёма)" : "")), S("Нагрузка от перекрытия", nf(qSlab, 1), "кН/м", qSlab ? "плиты ближе ширины проёма" : v.role === "bear" ? "плиты выше зоны — не учитывается" : "стена самонесущая"), S("Масса", nint(best.kg), "кг")],
        warn: warn.join(" "),
        blocks: [{ title: "Схема", html: '<div class="chart-scroll">' + s + "</div>" }],
        table: { head: ["Положение", "Марка", "Нагрузка", "Допускается", "Масса"], rows },
        items: Object.entries(cnt).map(([n, c]) => ["Перемычка " + n, c, "шт."])
      };
    },
    info: "Нагрузка от кладки — по поясу высотой ⅓ пролёта (сводовый эффект в схватившейся кладке), если кладки выше больше; иначе — вся кладка до перекрытия. Нагрузка от перекрытия учитывается, если оно ближе к перемычке, чем ширина проёма; вся она передаётся на внутренний брусок, на который опираются плиты. Коэффициенты надёжности 1,1 и 1,3. Несущая способность — по числу в марке серии 1.038.1-1 (кН/м). Опирание на кладку — не менее 120 мм, под плитами — 200–250 мм. Пока раствор не набрал прочность, ставьте временные стойки."
  });

  // ---------- Раскладка пустотных плит ----------
  const VOIDS = { 1000: 5, 1200: 6, 1500: 7, 1800: 9 };
  add({
    id: "slabs", cat: "struct", mark: "схема", name: "Раскладка пустотных плит", kw: "плиты перекрытия пустотные пк пб раскладка схема монолитный участок опирание кран ширина длина перекрытие 60.15",
    desc: "Подбор длины по опиранию, сочетание ширин с минимальным монолитом, схема, масса и кран",
    inputs: [
      { k: "span", label: "Пролёт в свету между несущими стенами, мм", def: 5600 },
      { k: "len", label: "Длина перекрываемого участка вдоль стен, мм", def: 8400, hint: "В свету между боковыми стенами" },
      { k: "n", label: "Одинаковых участков", def: 1 },
      { k: "wall", label: "Опирание на", type: "sel", def: "brick", opts: [["brick", "Кирпич (≥ 120 мм)"], ["aer", "Газобетон через армопояс (≥ 150 мм)"], ["rc", "Ж/б ригель или монолит (≥ 100 мм)"]] },
      { k: "wt", label: "Толщина несущей стены, мм", def: 380 },
      { k: "type", label: "Тип плит", type: "sel", def: "pk", opts: [["pk", "ПК — длины кратны 300 мм"], ["pb", "ПБ — любая длина с шагом 100 мм"]] },
      { k: "w1500", label: "Ширина 1500", type: "check", def: true }, { k: "w1200", label: "Ширина 1200", type: "check", def: true }, { k: "w1000", label: "Ширина 1000", type: "check", def: true },
      { k: "load", label: "Расчётная нагрузка", type: "sel", def: "8", opts: [["8", "8 кПа (800 кг/м²) — жилые дома"], ["12.5", "12,5 кПа — тяжёлые нагрузки"]] }
    ],
    run(v) {
      const minS = { brick: 120, aer: 150, rc: 100 }[v.wall], maxS = Math.min(v.wt - 50, 250);
      const Lmin = v.span + 2 * minS, Lmax = v.span + 2 * maxS;
      let Lp = v.type === "pk" ? Math.ceil(Lmin / 300) * 300 - 20 : Math.ceil(Lmin / 100) * 100 - 20;
      if (Lp < Lmin) Lp += v.type === "pk" ? 300 : 100;
      const warn = [];
      if (maxS < minS) warn.push("Стена слишком тонкая для опирания плит.");
      if (Lp > Lmax) warn.push("Ближайшая длина ПК (" + nint(Lp) + " мм) даёт опирание больше допустимого — возьмите ПБ под размер или увеличьте толщину стены.");
      if (v.wall === "aer") warn.push("На газобетон плиты кладут только через монолитный армопояс — иначе блоки под опорой раскрошатся.");
      if (Lp > 9000 && v.type === "pk") warn.push("ПК длиннее 9 м почти не выпускают — нужны ПБ или промежуточная несущая стена.");
      const ws = [1500, 1200, 1000].filter(x => v["w" + x]);
      if (!ws.length) return { warn: "Выберите хотя бы одну ширину плит." };
      // подбор сочетания ширин
      let best = null;
      const L = v.len, rec = (i, cur, sum) => {
        if (i === ws.length) { const r = L - sum; if (r < 0) return; const cnt = cur.reduce((s, x) => s + x, 0); const score = (r > 300 ? 1e4 + r * 10 : r * 10) + cnt; if (!best || score < best.score) best = { score, cur: cur.slice(), r }; return; }
        for (let k = 0; k <= Math.floor(L / ws[i]); k++) { cur.push(k); rec(i + 1, cur, sum + k * ws[i]); cur.pop(); }
      };
      rec(0, [], 0);
      const plates = [];
      ws.forEach((w, i) => { for (let k = 0; k < best.cur[i]; k++) plates.push(w); });
      const r = best.r;
      if (r > 300) warn.push("Монолитный участок " + nint(r) + " мм — шире 300 мм, его нужно считать как монолитную плиту или добавить ширины плит.");
      const nm = w => (v.type === "pk" ? "ПК " : "ПБ ") + Math.round((Lp + 20) / 100) + "." + w / 100 + (v.type === "pb" ? ".22" : "") + "-" + v.load;
      const t = (Lp / 1000) * 0.25; // т на 1 м ширины
      const mass = w => t * w / 1000;
      const heavy = Math.max(...plates.map(mass));
      // схема
      const Wsvg = 860, wallT = Math.min(v.wt, 400), totX = v.span + 2 * wallT, totY = L + 240;
      const sc = Math.min((Wsvg - 120) / totX, 420 / totY), ox = 60, oy = 20;
      let s = '<svg viewBox="0 0 ' + Wsvg + " " + (totY * sc + 60) + '" class="gl-svg" role="img" aria-label="Схема раскладки плит"><defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="sl-h"/></pattern></defs>';
      s += '<rect x="' + ox + '" y="' + oy + '" width="' + wallT * sc + '" height="' + totY * sc + '" fill="url(#hatch)" class="sl-wall"/><rect x="' + (ox + (wallT + v.span) * sc) + '" y="' + oy + '" width="' + wallT * sc + '" height="' + totY * sc + '" fill="url(#hatch)" class="sl-wall"/>';
      s += '<rect x="' + ox + '" y="' + oy + '" width="' + totX * sc + '" height="' + 120 * sc + '" class="sl-side"/><rect x="' + ox + '" y="' + (oy + (120 + L) * sc) + '" width="' + totX * sc + '" height="' + 120 * sc + '" class="sl-side"/>';
      let y = oy + 120 * sc;
      const px = ox + (wallT - (Lp - v.span) / 2) * sc;
      const monoAt = Math.floor(plates.length / 2);
      const drawMono = () => { if (r > 0) { s += '<rect x="' + (ox + wallT * sc) + '" y="' + y + '" width="' + v.span * sc + '" height="' + r * sc + '" class="sl-mono"/>' + (r * sc > 10 ? '<text x="' + (ox + (wallT + v.span / 2) * sc) + '" y="' + (y + r * sc / 2 + 4) + '" class="axis" text-anchor="middle">монолит ' + nint(r) + "</text>" : ""); y += r * sc; } };
      plates.forEach((w, i) => {
        if (i === monoAt) drawMono();
        s += '<rect x="' + px + '" y="' + (y + 0.5) + '" width="' + Lp * sc + '" height="' + (w * sc - 1) + '" class="sl-plate"/>';
        const nv = VOIDS[w] || 6;
        for (let k = 0; k < nv; k++) s += '<line x1="' + (px + 4) + '" x2="' + (px + Lp * sc - 4) + '" y1="' + (y + (k + 0.5) * w * sc / nv) + '" y2="' + (y + (k + 0.5) * w * sc / nv) + '" class="sl-void"/>';
        s += '<text x="' + (px + Lp * sc / 2) + '" y="' + (y + w * sc / 2 + 4) + '" class="sl-l" text-anchor="middle">' + nm(w) + "</text>";
        y += w * sc;
      });
      if (monoAt >= plates.length) drawMono();
      s += '<text x="' + (ox + (wallT + v.span / 2) * sc) + '" y="' + (oy + totY * sc + 18) + '" class="axis" text-anchor="middle">пролёт ' + nint(v.span) + " мм · плита " + nint(Lp) + " мм · опирание " + nint((Lp - v.span) / 2) + " мм</text>";
      s += '<text x="' + (ox + totX * sc + 8) + '" y="' + (oy + totY * sc / 2) + '" class="axis">' + nint(L) + "</text></svg>";
      const cnt = {};
      plates.forEach(w => cnt[nm(w)] = (cnt[nm(w)] || 0) + v.n);
      const N = plates.length * v.n;
      const monoV = r / 1000 * v.span / 1000 * 0.22 * v.n;
      const anchors = (plates.length + 1) * 2 * v.n;
      const plugs = plates.reduce((s2, w) => s2 + (VOIDS[w] || 6) * 2, 0) * v.n;
      const mortar = 2 * (L / 1000) * (minS + 30) / 1000 * 0.02 * v.n + plates.length * v.n * (Lp / 1000) * 0.03 * 0.22 * 0.5;
      const items = Object.entries(cnt).map(([n, c]) => ["Плита " + n, c, "шт."]);
      if (monoV > 0) items.push(["Бетон B20 на монолитный участок", Math.round(monoV * 1.05 * 100) / 100, "м³"]);
      items.push(["Анкер Г-образный Ø10 А500", anchors, "шт."], ["Вкладыши-пробки в пустоты на опорах", plugs, "шт."], ["Раствор М100–М150 (постель и швы)", Math.round(mortar * 100) / 100, "м³"]);
      return {
        stats: [S("Плит", nint(N), "шт.", Object.entries(cnt).map(([n, c]) => c + " × " + n).join(", "), true), S("Длина плиты", nint(Lp), "мм", "опирание " + nint((Lp - v.span) / 2) + " мм (мин. " + minS + ")"), S("Монолитный участок", nint(r), "мм", r === 0 ? "без монолита" : nf(monoV, 2) + " м³ бетона"), S("Самая тяжёлая плита", nf(heavy, 2), "т", "кран ≥ " + nf(Math.max(16, ceil(heavy * 1.3 * 4)), 0) + " т с учётом вылета"), S("Площадь перекрытия", nf(v.span * L / 1e6 * v.n, 1), "м²")],
        warn: warn.join(" "),
        blocks: [{ title: "Схема раскладки" + (v.n > 1 ? " (одного участка из " + v.n + ")" : ""), html: '<div class="chart-scroll">' + s + "</div>" + '<p class="hint">Не понимаете, почему так? ' + goBtn("slabguide", "Обучалка по раскладке плит") + "</p>" }],
        table: { head: ["Позиция", "Количество"], rows: items.map(i => [i[0], (typeof i[1] === "number" ? i[1].toLocaleString("ru-RU") : i[1]) + " " + i[2]]) },
        items
      };
    },
    info: "Длина плиты = пролёт в свету + опирание с двух сторон: на кирпич не меньше 120 мм, на газобетон через армопояс не меньше 150 мм, на ж/б не меньше 100 мм; больше 200–250 мм заводить не нужно. ПК выпускают с шагом 300 мм (фактическая длина на 20 мм меньше номинала), ПБ режут под размер. Ширины подбираются так, чтобы монолитный участок был минимальным и не шире 300 мм. Масса — около 250 кг на 1 м² плиты толщиной 220 мм."
  });

  // ---------- Обучалка по плитам ----------
  function slabPlanSVG(bad) {
    return '<svg viewBox="0 0 640 230" class="lv-svg" role="img" aria-label="Опирание плит"><defs><pattern id="h2" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="sl-h"/></pattern></defs>' +
      '<rect x="40" y="30" width="24" height="160" fill="url(#h2)" class="sl-wall"/><rect x="266" y="30" width="24" height="160" fill="url(#h2)" class="sl-wall"/>' +
      '<rect x="52" y="40" width="226" height="64" class="sl-plate"/><rect x="52" y="108" width="226" height="64" class="sl-plate"/><text x="165" y="76" class="sl-l" text-anchor="middle">опора с двух коротких сторон</text><text x="165" y="214" class="lv-s" text-anchor="middle">правильно</text>' +
      '<rect x="350" y="30" width="24" height="160" fill="url(#h2)" class="sl-wall"/><rect x="576" y="30" width="24" height="160" fill="url(#h2)" class="sl-wall"/><rect x="350" y="166" width="250" height="24" fill="url(#h2)" class="sl-wall"/>' +
      '<rect x="362" y="40" width="226" height="64" class="sl-plate"/><rect x="362" y="108" width="226" height="68" class="sl-plate bad"/><text x="475" y="146" class="sl-l" text-anchor="middle">кромка заведена на стену</text><text x="475" y="214" class="lv-s" text-anchor="middle">нельзя: опора по трём сторонам</text></svg>';
  }
  function markSVG() {
    return '<svg viewBox="0 0 640 120" class="lv-svg" role="img" aria-label="Маркировка"><text x="20" y="50" class="mk-big">ПК</text><text x="90" y="50" class="mk-big">60</text><text x="150" y="50" class="mk-big">.</text><text x="165" y="50" class="mk-big">15</text><text x="225" y="50" class="mk-big">-</text><text x="245" y="50" class="mk-big">8</text><text x="275" y="50" class="mk-big">АтV</text>' +
      '<text x="20" y="80" class="lv-s">тип</text><text x="90" y="80" class="lv-s">длина 60 дм</text><text x="90" y="94" class="lv-s">(5980 мм)</text><text x="165" y="80" class="lv-s">ширина 15 дм</text><text x="165" y="94" class="lv-s">(1490 мм)</text><text x="245" y="80" class="lv-s">нагрузка</text><text x="245" y="94" class="lv-s">8 кПа</text><text x="275" y="108" class="lv-s">класс арматуры</text></svg>';
  }
  function supportSVG() {
    return '<svg viewBox="0 0 640 200" class="lv-svg" role="img" aria-label="Узел опирания"><rect x="250" y="100" width="140" height="90" fill="url(#h3)" class="sl-wall"/><defs><pattern id="h3" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="sl-h"/></pattern></defs>' +
      '<rect x="250" y="88" width="140" height="12" class="sl-mono"/><rect x="40" y="60" width="330" height="28" class="sl-plate"/><circle cx="330" cy="74" r="8" class="sl-plug"/><circle cx="300" cy="74" r="8" class="sl-void2"/><rect x="250" y="56" width="0" height="0"/>' +
      '<line x1="250" y1="40" x2="370" y2="40" class="lv-dim"/><text x="310" y="34" class="lv-s" text-anchor="middle">опирание ≥ 120 мм</text>' +
      '<text x="400" y="96" class="lv-s">армопояс / постель из раствора 10–20 мм</text><text x="400" y="70" class="lv-s">пустоты на опоре заделаны вкладышами</text><text x="60" y="110" class="lv-s">плита</text><text x="400" y="150" class="lv-s">несущая стена</text></svg>';
  }
  const SLESSONS = [
    { t: "Какие бывают пустотные плиты", h: () => '<table class="data lv-t2"><thead><tr><th>Тип</th><th>Как делают</th><th>Что важно</th></tr></thead><tbody><tr><td><b>ПК</b> — круглопустотные</td><td>В опалубке, по стандартной номенклатуре</td><td>Длины с шагом 300 мм (2,4–9 м), ширина 1,0 / 1,2 / 1,5 / 1,8 м. <b>Резать поперёк нельзя</b> — перерезается напряжённая арматура.</td></tr><tr><td><b>ПБ</b> — безопалубочного формования</td><td>Непрерывная лента на стенде, режется пилой</td><td>Любая длина с шагом 100 мм до 9–12 м, ровный потолок. Ширина обычно 1,2 м.</td></tr><tr><td><b>ПНО</b> — облегчённые 160 мм</td><td>Как ПК, но тоньше</td><td>Для лёгких домов и мансард, меньше вес и высота.</td></tr></tbody></table><p>Все пустотные плиты работают как <b>балка на двух опорах</b>: внизу — напряжённая арматура, сверху её почти нет. Отсюда все правила раскладки.</p>' },
    { t: "Как читать маркировку", h: () => markSVG() + "<p>Номинальная длина и ширина — в дециметрах; фактический размер на 10–20 мм меньше, чтобы между плитами остался шов. Последнее число — <b>расчётная нагрузка без собственного веса</b> в кПа: 8 кПа ≈ 800 кг/м². Для жилого дома (пол, стяжка, перегородки, мебель, люди) хватает 8 кПа с запасом. 12,5 кПа берут под тяжёлое оборудование, гаражи, зимние сады с грунтом.</p><p>У ПБ в маркировке ещё и толщина: <b>ПБ 60.12.22-8</b> — 6 м × 1,2 м × 220 мм.</p>" },
    { t: "Опирание", h: () => supportSVG() + '<ul class="rules"><li><b>Только по двум коротким сторонам.</b> Продольную кромку на стену не заводят: плита начинает работать на три опоры, появляются трещины вдоль.</li><li><b>Глубина опирания:</b> на кирпич — не меньше 120 мм, на газобетон — только через монолитный армопояс и не меньше 150 мм, на ж/б ригель или монолит — не меньше 100 мм. Больше 200–250 мм заводить не нужно: плита «защемляется» и трескается сверху над опорой.</li><li><b>Промежуточную опору</b> под середину пустотной плиты не делают: сверху арматуры нет, над стенкой появится трещина. Если стена посередине — раскладывают две короткие плиты.</li><li>Плиту кладут на <b>постель из раствора</b> 10–20 мм, а не «насухо»: иначе она опирается точками.</li></ul>' + slabPlanSVG() },
    { t: "Раскладка: как не ошибиться", h: () => '<ol class="steps"><li><b>Определите пролёт</b> — по короткой стороне помещения между несущими стенами. Плиты всегда перекрывают короткий пролёт.</li><li><b>Длина плиты</b> = пролёт в свету + 2 × опирание. Для ПК округляйте вверх до шага 300 мм и проверьте, что опирание не стало больше 250 мм.</li><li><b>Набор ширин</b> вдоль длины: сочетайте 1,5 / 1,2 / 1,0 м так, чтобы остаток был минимальным.</li><li><b>Остаток до 300 мм</b> — монолитный участок по месту: опалубка снизу, арматурный каркас, бетон B20. Шире — считать как монолитную плиту.</li><li><b>Место монолита</b> выбирайте там, где идут вентканалы, стояки, дымоход: через пустотную плиту их не проводят.</li><li><b>Лестничный проём</b> — монолит или металлические балки, укороченные плиты на них по расчёту.</li></ol><p>Всё это делает калькулятор: ' + goBtn("slabs", "Раскладка пустотных плит") + "</p>" },
    { t: "Монтаж и анкеровка", h: () => '<ul class="rules"><li><b>Кран:</b> плита ПК 60.15 весит около 2,2–2,5 т. Грузоподъёмность выбирают по самой тяжёлой плите и вылету стрелы — обычно 16–25 т для частного дома.</li><li><b>Пустоты на опорах</b> заделывают бетонными вкладышами или бетоном на глубину 120 мм — особенно под стенами следующего этажа, иначе стенки пустот раздавит.</li><li><b>Швы между плитами</b> заполняют раствором М150 или мелкозернистым бетоном — плиты начинают работать вместе, потолок не трескается по швам.</li><li><b>Анкеры:</b> Г-образные стержни Ø 10–12 мм за монтажные петли — соседние плиты между собой и с кладкой. Поверх кирпичной стены или на газобетоне — кольцевой армопояс.</li><li>Разница отметок соседних плит — не больше 5–8 мм, иначе ступенька на потолке.</li></ul>' },
    { t: "Отверстия и коммуникации", h: () => '<ul class="rules"><li>Сверлить можно <b>только по пустоте</b>, не задевая продольные рёбра — в них арматура.</li><li>Отверстие — не шире одной пустоты (≈ 120–160 мм). Под канализационный стояк Ø 110 — коронкой точно по оси пустоты.</li><li>Штробить плиту поперёк для труб нельзя.</li><li>Большие отверстия — только в монолитном участке, поэтому монолит ставят под стояки и вентканалы.</li></ul>' },
    { t: "Частые ошибки", h: () => '<ol class="steps"><li>Плиты на газобетон без армопояса.</li><li>Продольная кромка заведена на стену — опора по трём сторонам.</li><li>Перегородка под серединой плиты как «доп. опора».</li><li>Укороченная ПК — разрезанная поперёк.</li><li>Пустоты на опорах не заделаны, сверху — тяжёлая стена.</li><li>Монолитный участок без опалубки и арматуры, «залили между плитами».</li><li>Плиты положены без раствора — точечное опирание.</li><li>Опирание 50–70 мм «потому что плиты не хватило».</li></ol>' }
  ];
  const SQUIZ = [
    ["На сколько сторон опирается пустотная плита?", ["На три — так надёжнее", "На две короткие", "На все четыре"], 1, "Плита рассчитана как балка на двух опорах."],
    ["Что означает «8» в ПК 60.15-8?", ["Толщину 8 см", "Расчётную нагрузку 8 кПа (≈ 800 кг/м²)", "Количество пустот"], 1, "Без учёта собственного веса плиты."],
    ["Минимальное опирание ПК на кирпич?", ["70 мм", "120 мм", "300 мм"], 1, "На газобетон — через армопояс и от 150 мм."],
    ["Можно отрезать ПК, чтобы попасть в размер?", ["Да, болгаркой", "Нет — перерезается напряжённая арматура; нужна ПБ под размер", "Только вдоль"], 1, "Под точный размер заказывают ПБ."],
    ["Остался зазор 250 мм между плитами. Что делать?", ["Оставить пустым", "Монолитный участок: опалубка, каркас, бетон", "Завести плиту на боковую стену"], 1, "До 300 мм — монолит по месту."],
    ["Где можно сверлить отверстие под стояк?", ["В любом месте", "По оси пустоты, не задевая рёбер", "Только у опоры"], 1, "Рёбра с арматурой повреждать нельзя."]
  ];
  add({
    id: "slabguide", cat: "learn", custom: true, mark: "обучалка", name: "Раскладка пустотных плит", kw: "обучение плиты перекрытия пустотные пк пб раскладка опирание маркировка монтаж анкеровка ошибки урок",
    desc: "7 уроков: виды плит, маркировка, опирание, раскладка, монтаж, отверстия, ошибки — и тест",
    render(panel, api) {
      let step = Math.min(store.get("sg:step") || 0, SLESSONS.length);
      const answers = {};
      const draw = () => {
        store.set("sg:step", step);
        const navH = '<div class="lv-nav">' + SLESSONS.map((l, i) => '<button type="button" data-step="' + i + '" class="' + (i === step ? "on" : i < step ? "done" : "") + '"><span>' + (i + 1) + "</span>" + esc(l.t) + "</button>").join("") + '<button type="button" data-step="' + SLESSONS.length + '" class="' + (step === SLESSONS.length ? "on" : "") + '"><span>✓</span>Тест</button></div>';
        let body;
        if (step < SLESSONS.length) {
          const l = SLESSONS[step];
          body = '<div class="lv-prog"><span style="width:' + Math.round(step / SLESSONS.length * 100) + '%"></span></div><div class="eyebrow">Урок ' + (step + 1) + " из " + SLESSONS.length + '</div><h3 class="lv-h">' + esc(l.t) + '</h3><div class="lv-body">' + l.h() + '</div><div class="lv-btns">' + (step > 0 ? '<button type="button" class="btn sm ghost" data-step="' + (step - 1) + '">← Назад</button>' : "") + '<button type="button" class="btn sm" data-step="' + (step + 1) + '">' + (step === SLESSONS.length - 1 ? "К тесту →" : "Дальше →") + "</button></div>";
        } else {
          body = '<div class="eyebrow">Проверьте себя</div><h3 class="lv-h">Тест: ' + SQUIZ.length + " вопросов</h3>" + SQUIZ.map((q, i) => '<div class="qz" data-q="' + i + '"><p><b>' + (i + 1) + ". " + esc(q[0]) + "</b></p>" + q[1].map((o, k) => '<button type="button" class="qz-o" data-q="' + i + '" data-a="' + k + '">' + esc(o) + "</button>").join("") + '<p class="qz-f"></p></div>').join("") + '<div class="qz-total" data-o="total"></div><div class="lv-btns"><button type="button" class="btn sm ghost" data-step="0">Пройти заново</button><button type="button" class="btn sm" data-open="slabs">Разложить плиты для своего дома →</button></div>';
        }
        panel.innerHTML = '<section class="card lv">' + navH + '<div class="lv-main">' + body + "</div></section>";
      };
      panel.addEventListener("click", e => {
        const op = e.target.closest("[data-open]");
        if (op) { api.open(op.dataset.open); return; }
        const s = e.target.closest("[data-step]");
        if (s) { step = +s.dataset.step; draw(); panel.scrollIntoView({ block: "start", behavior: "smooth" }); return; }
        const o = e.target.closest(".qz-o");
        if (o) {
          const qi = +o.dataset.q, a = +o.dataset.a; answers[qi] = a;
          const box = panel.querySelector('.qz[data-q="' + qi + '"]'), q = SQUIZ[qi];
          box.querySelectorAll(".qz-o").forEach(b => b.classList.remove("right", "wrong"));
          o.classList.add(a === q[2] ? "right" : "wrong");
          if (a !== q[2]) box.querySelector('.qz-o[data-a="' + q[2] + '"]').classList.add("right");
          box.querySelector(".qz-f").textContent = (a === q[2] ? "Верно. " : "Не совсем. ") + q[3];
          const done = Object.keys(answers).length, ok = Object.entries(answers).filter(([i, x]) => SQUIZ[i][2] === x).length;
          panel.querySelector('[data-o="total"]').textContent = done === SQUIZ.length ? "Результат: " + ok + " из " + SQUIZ.length + (ok === SQUIZ.length ? " — все ответы верны." : ok >= 4 ? " — хороший результат. Перечитайте урок об опирании." : " — рекомендуем пройти уроки ещё раз.") : "";
        }
      });
      draw();
    }
  });

  // ====================================================================
  //  UI: sidebar, router, generic renderer
  // ====================================================================
  const byId = Object.fromEntries(CALCS.map(c => [c.id, c]));
  const main = $("gen-host");
  let current = null;
  window.__legacy = window.__legacy || {};

  // ---- sidebar ----
  const nav = $("side-nav"), q = $("side-q");
  // Открытие сайта с диска (file://): папки не открываются как страницы — добавляем index.html к ссылкам
  if (location.protocol === "file:") {
    if (window.PAGE && window.PAGE.urls) Object.keys(window.PAGE.urls).forEach(k => { const u = window.PAGE.urls[k]; if (/\/$/.test(u)) window.PAGE.urls[k] = u + "index.html"; });
    const fixA = a => { const h = a.getAttribute("href"); if (h && !/^(https?:|mailto:|#|data:)/.test(h) && /\/$/.test(h)) a.setAttribute("href", h + "index.html"); else if (h === "./" || h === "") a.setAttribute("href", "index.html"); };
    document.querySelectorAll("a[href]").forEach(fixA);
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) { if (n.matches && n.matches("a[href]")) fixA(n); n.querySelectorAll && n.querySelectorAll("a[href]").forEach(fixA); } }))).observe(document.body, { childList: true, subtree: true });
  }
  const MP = window.PAGE || null;
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  const urlOf = id => MP && MP.urls[id] != null ? MP.root + MP.urls[id] : "#" + id;
  const goal = name => { try { if (window.ym && window.METRIKA_ID) window.ym(window.METRIKA_ID, "reachGoal", name); } catch (e) {} };
  function go(id, params) { if (MP && id !== current && MP.urls[id] != null) { location.href = urlOf(id); return; } open(id, params); }
  function navLink(c) {
    const a = document.createElement("a");
    a.href = urlOf(c.id); a.className = "nav-item" + (current === c.id ? " on" : ""); a.dataset.id = c.id;
    a.innerHTML = '<span class="nav-name"></span>' + (c.mark ? '<span class="nav-mark"></span>' : "");
    a.querySelector(".nav-name").textContent = c.name;
    if (c.mark) a.querySelector(".nav-mark").textContent = c.mark;
    a.onclick = e => { if (MP) return; e.preventDefault(); open(c.id); closeDrawer(); };
    return a;
  }
  let navOpen = {}, lastCat = null;
  function renderNav() {
    const qs = norm(q.value.trim()).split(/\s+/).filter(Boolean);
    nav.innerHTML = "";
    const est = document.createElement("a");
    est.href = "#estimate"; est.className = "nav-item est" + (current === "estimate" ? " on" : "");
    est.innerHTML = '<span class="nav-name">Смета материалов</span><span class="badge" id="est-badge"></span>';
    est.href = urlOf("estimate"); est.onclick = e => { if (MP) return; e.preventDefault(); open("estimate"); closeDrawer(); };
    if (!qs.length) nav.appendChild(est);
    const match = c => { const hay = norm(c.name + " " + c.kw + " " + c.desc); return qs.every(t => hay.includes(t)); };
    let found = 0;
    if (!qs.length) {
      const rec = (store.get("recent") || []).filter(id => byId[id]).slice(0, 4);
      if (rec.length) { const h = document.createElement("div"); h.className = "nav-h"; h.textContent = "Недавние"; nav.appendChild(h); rec.forEach(id => nav.appendChild(navLink(byId[id]))); }
    }
    const curCat = byId[current] ? byId[current].cat : null;
    CATS.forEach(([cat, title]) => {
      const list = CALCS.filter(c => c.cat === cat && match(c));
      if (!list.length) return;
      found += list.length;
      const isOpen = qs.length ? true : (navOpen[cat] !== undefined ? navOpen[cat] : cat === curCat);
      const h = document.createElement("button"); h.type = "button"; h.className = "nav-cat" + (isOpen ? " open" : "") + (cat === curCat ? " cur" : "");
      h.setAttribute("aria-expanded", isOpen);
      h.innerHTML = '<span class="nc-t"></span><span class="nc-n">' + list.length + '</span><svg class="nc-ch" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      h.querySelector(".nc-t").textContent = title;
      h.onclick = () => { navOpen[cat] = !isOpen; renderNav(); };
      nav.appendChild(h);
      if (isOpen) { const box = document.createElement("div"); box.className = "nav-grp"; list.forEach(c => box.appendChild(navLink(c))); nav.appendChild(box); }
    });
    if (qs.length && !found) { const p = document.createElement("div"); p.className = "nav-empty"; p.textContent = "Ничего не найдено. Попробуйте другое слово: «плитка», «уклон», «кубы»."; nav.appendChild(p); }
    updateBadge();
  }
  q.addEventListener("input", renderNav);
  q.addEventListener("keydown", e => {
    if (e.key === "Enter") { const first = nav.querySelector(".nav-item:not(.est)"); if (first) { go(first.dataset.id); q.blur(); closeDrawer(); } }
    if (e.key === "Escape") { q.value = ""; renderNav(); }
  });
  document.addEventListener("keydown", e => {
    if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); openDrawer(); q.focus(); }
  });
  // drawer (mobile)
  function openDrawer() { document.body.classList.add("drawer-open"); }
  function closeDrawer() { document.body.classList.remove("drawer-open"); }
  $("menu-btn").onclick = () => { openDrawer(); setTimeout(() => q.focus(), 50); };
  $("drawer-bg").onclick = closeDrawer;

  // ---- единица измерения внутри поля ----
  const UNIT_RE = /^(.*\S),\s*(мм|см|м|м²|м³|кг|т|т\/м³|°C|°|%|кПа|Па|л|сут|суток|кВт|₽|кг\/м³|кг\/м²|м\/с|мм\/м|л\/сут|м³\/ч|т\/м|шт\.|кг\/м³)$/;
  const splitUnit = s => { const m = UNIT_RE.exec(String(s || "")); return m ? [m[1], m[2]] : [String(s || ""), ""]; };
  function enhanceUnits(root) {
    root.querySelectorAll(".field").forEach(f => {
      const lb = f.querySelector(":scope > label.lbl"), inp = f.querySelector(':scope > input[type="number"], :scope > input[type="text"]');
      if (!lb || !inp || inp.closest(".inp-u") || inp.classList.contains("pl-q")) return;
      const [t, u] = splitUnit(lb.textContent.trim());
      if (!u) return;
      lb.textContent = t;
      const w = document.createElement("div"); w.className = "inp-u"; inp.parentNode.insertBefore(w, inp); w.appendChild(inp);
      const sp = document.createElement("span"); sp.className = "u"; sp.textContent = u; w.appendChild(sp);
    });
  }
  ["tab-strength", "tab-volume", "tab-mix", "tab-rebar", "tab-brick"].forEach(id => { const el = document.getElementById(id); if (el) enhanceUnits(el); });

  // ---- выбор города в шапке (общий для всех расчётов) ----
  (function initCity() {
    const host = document.querySelector("header.top .top-r");
    if (!host) return;
    const PIN = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M10 18s6-5.2 6-10a6 6 0 1 0-12 0c0 4.8 6 10 6 10z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="8" r="2.2" fill="currentColor"/></svg>';
    const wrap = document.createElement("div"); wrap.className = "city";
    wrap.innerHTML = '<button type="button" class="btn sm ghost city-btn" aria-haspopup="dialog" aria-expanded="false">' + PIN + '<span class="city-n"></span></button>' +
      '<div class="city-pop" hidden role="dialog" aria-label="Выбор населённого пункта"><div class="card-title">Ваш населённый пункт</div><p class="hint">Город подставится во все расчёты, где нужна погода и климат: прочность бетона, промерзание, подбор растений, цветник.</p>' +
      '<input type="search" class="city-q" placeholder="Начните вводить: Арзамас, Казань…" aria-label="Населённый пункт"><div class="city-list" role="listbox"></div></div>';
    host.insertBefore(wrap, host.querySelector(".theme"));
    const btn = wrap.querySelector(".city-btn"), pop = wrap.querySelector(".city-pop"), qi = wrap.querySelector(".city-q"), list = wrap.querySelector(".city-list"), nameEl = wrap.querySelector(".city-n");
    const show = () => { const p = store.get("place"); nameEl.textContent = p ? p.name : "Ваш город"; btn.title = p ? [p.name, p.admin1, p.country].filter(Boolean).join(", ") : "Выбрать населённый пункт"; };
    show();
    const close = () => { pop.hidden = true; btn.setAttribute("aria-expanded", "false"); };
    btn.addEventListener("click", e => { e.stopPropagation(); pop.hidden = !pop.hidden; btn.setAttribute("aria-expanded", String(!pop.hidden)); if (!pop.hidden) setTimeout(() => qi.focus(), 30); });
    document.addEventListener("click", e => { if (!wrap.contains(e.target)) close(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
    let tmr = null, ctl = null;
    qi.addEventListener("input", e => {
      e.stopPropagation();
      clearTimeout(tmr);
      const s = qi.value.trim();
      if (s.length < 2) { list.innerHTML = ""; return; }
      tmr = setTimeout(async () => {
        try {
          if (ctl) ctl.abort(); ctl = new AbortController();
          const r = await fetch("https://geocoding-api.open-meteo.com/v1/search?count=8&language=ru&format=json&name=" + encodeURIComponent(s), { signal: ctl.signal });
          const res = (await r.json()).results || [];
          list.innerHTML = res.length ? "" : '<p class="hint">Ничего не найдено.</p>';
          res.forEach(p => {
            const b = document.createElement("button"); b.type = "button"; b.className = "city-opt"; b.textContent = p.name;
            const sm = document.createElement("small"); sm.textContent = [p.admin1, p.country].filter(Boolean).join(", "); b.appendChild(sm);
            b.onclick = () => {
              store.set("place", { name: p.name, admin1: p.admin1 || "", country: p.country || "", latitude: p.latitude, longitude: p.longitude });
              show(); close();
              if (document.querySelector('.pf, #tab-strength')) location.reload();
            };
            list.appendChild(b);
          });
        } catch (err) { if (err.name !== "AbortError") list.innerHTML = '<p class="hint">Поиск городов недоступен на этой странице.</p>'; }
      }, 300);
    });
    qi.addEventListener("change", e => e.stopPropagation());
    // если город выбран внутри калькулятора — обновить шапку
    document.addEventListener("change", () => setTimeout(show, 0));
    document.addEventListener("click", () => setTimeout(show, 0));
  })();

  // ---- generic calc renderer ----
  const built = {}, loadCache = {}, loadPending = {};
  const PLACE_DEF = { name: "Москва", admin1: "", country: "Россия", latitude: 55.7558, longitude: 37.6173 };
  const placeLabel = p => p ? p.name + (p.admin1 ? ", " + p.admin1 : "") + (p.country ? ", " + p.country : "") : "";
  const defOf = (f, v) => typeof f.def === "function" ? f.def(v) : f.def;
  const fmtVal = (f, val) => f.type === "text" || f.type === "place" ? String(val) : String(val).replace(".", ",");
  function readVals(c, panel) {
    const v = {};
    c.inputs.forEach(f => {
      const el = panel.querySelector('[data-k="' + f.k + '"]');
      if (!el) return;
      if (f.type === "check") v[f.k] = el.checked;
      else if (f.type === "sel" || f.type === "text") v[f.k] = el.value;
      else if (f.type === "place") { try { v[f.k] = JSON.parse(el.value); } catch (e) { v[f.k] = PLACE_DEF; } }
      else if (f.type === "list") v[f.k] = el.value.split(/[\s;]+/).map(x => x.replace(",", ".").replace("−", "-")).filter(Boolean).map(Number).filter(x => !isNaN(x));
      else v[f.k] = num(el.value);
    });
    return v;
  }
  function rawVals(c, panel) {
    const o = {};
    c.inputs.forEach(f => { const el = panel.querySelector('[data-k="' + f.k + '"]'); if (el) o[f.k] = f.type === "check" ? (el.checked ? "1" : "0") : el.value; });
    return o;
  }
  function wirePlace(box, panel) {
    const qi = box.querySelector(".pl-q"), hid = box.querySelector('input[type="hidden"]'), sug = box.querySelector(".suggest"), hint = box.querySelector(".pl-hint");
    let tmr = null, ctl = null;
    const showHint = () => { try { const p = JSON.parse(hid.value); hint.textContent = "Координаты: " + nf(p.latitude, 2) + ", " + nf(p.longitude, 2); } catch (e) {} };
    showHint();
    qi.addEventListener("input", e => {
      e.stopPropagation();
      clearTimeout(tmr);
      const s = qi.value.trim();
      if (s.length < 2) { sug.classList.remove("show"); return; }
      tmr = setTimeout(async () => {
        try {
          if (ctl) ctl.abort(); ctl = new AbortController();
          const r = await fetch("https://geocoding-api.open-meteo.com/v1/search?count=7&language=ru&format=json&name=" + encodeURIComponent(s), { signal: ctl.signal });
          const list = (await r.json()).results || [];
          sug.innerHTML = list.length ? "" : '<button type="button" disabled>Ничего не найдено</button>';
          list.forEach(p => {
            const b = document.createElement("button"); b.type = "button"; b.textContent = p.name;
            const sm = document.createElement("small"); sm.textContent = [p.admin1, p.country].filter(Boolean).join(", "); b.appendChild(sm);
            b.onclick = () => {
              const pl = { name: p.name, admin1: p.admin1 || "", country: p.country || "", latitude: p.latitude, longitude: p.longitude };
              hid.value = JSON.stringify(pl); qi.value = placeLabel(pl); store.set("place", pl);
              sug.classList.remove("show"); showHint(); panel.dispatchEvent(new Event("change"));
            };
            sug.appendChild(b);
          });
          sug.classList.add("show");
        } catch (err) { if (err.name !== "AbortError") { sug.innerHTML = '<button type="button" disabled>Поиск недоступен на этой странице</button>'; sug.classList.add("show"); } }
      }, 300);
    });
    qi.addEventListener("change", e => e.stopPropagation());
    document.addEventListener("click", e => { if (!box.contains(e.target)) sug.classList.remove("show"); });
  }
  function build(c, params) {
    const panel = document.createElement("div");
    panel.className = "tab-panel gen"; panel.id = "tab-" + c.id; panel.hidden = true;
    const saved = Object.assign({}, store.get("g:" + c.id) || {}, params || {});
    const v0 = {};
    c.inputs.forEach(f => { if (typeof f.def !== "function") v0[f.k] = saved[f.k] != null ? saved[f.k] : f.def; });
    let html = "";
    if (c.inputs.length) {
      html += '<section class="card"><div class="form">';
      c.inputs.forEach(f => {
        let val = saved[f.k] != null ? saved[f.k] : defOf(f, v0);
        const id = "g-" + c.id + "-" + f.k;
        if (f.type === "place") {
          val = (params && params[f.k]) || JSON.stringify(store.get("place") || PLACE_DEF);
          let pl; try { pl = JSON.parse(val); } catch (e) { pl = PLACE_DEF; val = JSON.stringify(pl); }
          html += '<div class="field wide pf" data-f="' + f.k + '"><label class="lbl" for="' + id + '"></label><input type="text" class="pl-q" id="' + id + '" autocomplete="off" value="' + esc(placeLabel(pl)) + '" placeholder="Начните вводить город или посёлок"><input type="hidden" data-k="' + f.k + '" value="' + esc(val) + '"><div class="suggest"></div><div class="hint pl-hint"></div></div>';
          return;
        }
        let ctl;
        if (f.type === "sel") ctl = '<select id="' + id + '" data-k="' + f.k + '">' + f.opts.map(o => '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(val) ? " selected" : "") + ">" + esc(o[1]) + "</option>").join("") + "</select>";
        else if (f.type === "list") ctl = '<textarea id="' + id + '" data-k="' + f.k + '">' + esc(val) + "</textarea>";
        else if (f.type === "text") ctl = '<input type="text" inputmode="text" id="' + id + '" data-k="' + f.k + '" value="' + esc(fmtVal(f, val)) + '">';
        else if (f.type !== "check") ctl = '<div class="inp-u"><input type="text" inputmode="decimal" id="' + id + '" data-k="' + f.k + '" value="' + esc(fmtVal(f, val)) + '"><span class="u"></span></div>';
        if (f.type === "check") {
          const on = val === true || val === "1" || val === 1;
          html += '<div class="field wide" data-f="' + f.k + '"><label class="check"><input type="checkbox" id="' + id + '" data-k="' + f.k + '"' + (on ? " checked" : "") + '> <span>' + esc(f.label) + "</span></label></div>";
        } else {
          html += '<div class="field' + (f.type === "list" || f.wide ? " wide" : "") + '" data-f="' + f.k + '"><label class="lbl" for="' + id + '"></label>' + ctl + (f.hint ? '<div class="hint">' + esc(f.hint) + "</div>" : "") + "</div>";
        }
      });
      html += "</div></section>";
    }
    html += '<div class="banner" data-o="warn"></div><div class="stats auto" data-o="stats"></div><div class="blocks" data-o="blocks"></div><section class="card" data-o="tablecard" hidden><div class="row-scroll"><table class="data"><caption data-o="cap"></caption><thead data-o="thead"></thead><tbody data-o="tbody"></tbody></table></div></section>';
    if (c.info) html += '<section class="card method"><div class="card-title" style="margin-bottom:8px">Как считается</div><p>' + esc(c.info) + "</p></section>";
    panel.innerHTML = html;
    main.appendChild(panel);
    panel.querySelectorAll(".pf").forEach(b => wirePlace(b, panel));
    const lastDep = {};
    const recalc = () => {
      let v = readVals(c, panel);
      // dependent defaults (e.g. layer thickness from a preset)
      let changed = false;
      c.inputs.forEach(f => {
        if (!f.dep) return;
        if (lastDep[f.dep] !== undefined && lastDep[f.dep] !== v[f.dep]) { const el = panel.querySelector('[data-k="' + f.k + '"]'); if (el) { el.value = fmtVal(f, defOf(f, v)); changed = true; } }
      });
      if (changed) v = readVals(c, panel);
      c.inputs.forEach(f => { if (f.dep) lastDep[f.dep] = v[f.dep]; });
      c.inputs.forEach(f => {
        const box = panel.querySelector('[data-f="' + f.k + '"]');
        if (f.type !== "check") {
          const full = typeof f.label === "function" ? f.label(v) : f.label, uEl = box.querySelector(".u");
          if (uEl) { const [t, u] = splitUnit(full); box.querySelector(".lbl").textContent = t; uEl.textContent = u; uEl.parentNode.classList.toggle("no-u", !u); }
          else box.querySelector(".lbl").textContent = full;
        }
        box.hidden = f.show ? !f.show(v) : false;
      });
      store.set("g:" + c.id, rawVals(c, panel));
      let data = null, loading = false;
      if (c.load) {
        const key = c.id + ":" + c.loadKey(v);
        if (key in loadCache) data = loadCache[key];
        else {
          loading = true;
          if (!loadPending[key]) {
            loadPending[key] = 1;
            Promise.resolve().then(() => c.load(v)).then(d => { loadCache[key] = d; }, e => { loadCache[key] = { error: String(e && e.message || e) }; }).then(() => { delete loadPending[key]; recalc(); });
          }
        }
      }
      let out;
      try { out = c.run(v, data, loading) || {}; } catch (e) { out = { warn: "Проверьте введённые данные." }; console.error(e); }
      const wb = panel.querySelector('[data-o="warn"]');
      wb.textContent = out.warn || out.note || "";
      wb.className = "banner" + (out.warn ? " err" : "");
      const st = panel.querySelector('[data-o="stats"]');
      st.innerHTML = "";
      (out.stats || []).forEach(s => {
        const d = document.createElement("div"); d.className = "stat";
        d.innerHTML = '<div class="stat-label"></div><div class="stat-value' + (s.accent ? " s" : "") + '"><span class="v"></span>' + (s.unit ? '<span class="unit"></span>' : "") + '</div><div class="stat-sub"></div>';
        d.querySelector(".stat-label").textContent = s.label; d.querySelector(".v").textContent = s.value;
        if (s.unit) d.querySelector(".unit").textContent = " " + s.unit;
        d.querySelector(".stat-sub").textContent = s.sub || "";
        st.appendChild(d);
      });
      st.hidden = !(out.stats || []).length;
      const bl = panel.querySelector('[data-o="blocks"]');
      bl.innerHTML = (out.blocks || []).map(b => '<section class="card ' + (b.cls || "") + '">' + (b.title ? '<div class="card-head"><div class="card-title">' + esc(b.title) + "</div>" + (b.aside || "") + "</div>" : "") + b.html + "</section>").join("");
      bl.hidden = !(out.blocks || []).length;
      const rows = (out.table ? out.table.rows : []).concat(out.extra || []);
      const tc = panel.querySelector('[data-o="tablecard"]');
      tc.hidden = !rows.length;
      if (rows.length) {
        const head = out.table ? out.table.head : ["Параметр", "Значение"];
        panel.querySelector('[data-o="cap"]').textContent = out.table && out.table.cap || "";
        panel.querySelector('[data-o="thead"]').innerHTML = "<tr>" + head.map(h => "<th>" + esc(h) + "</th>").join("") + "</tr>";
        const tb = panel.querySelector('[data-o="tbody"]'); tb.innerHTML = "";
        if (out.table && out.extra) { out.table.rows.forEach(r => addRow(tb, r, head.length)); const sep = document.createElement("tr"); sep.className = "sep"; sep.innerHTML = '<td colspan="' + head.length + '"></td>'; tb.appendChild(sep); out.extra.forEach(r => addRow(tb, r, head.length)); }
        else rows.forEach(r => addRow(tb, r, head.length));
      }
      c._last = { v: rawVals(c, panel), out };
      if (c.after) { try { c.after(v, out, data); } catch (e) {} }
      updateActions();
    };
    const addRow = (tb, r, n) => { const tr = document.createElement("tr"); for (let i = 0; i < n; i++) { const td = document.createElement("td"); td.textContent = r[i] != null ? r[i] : ""; tr.appendChild(td); } tb.appendChild(tr); };
    panel.addEventListener("input", recalc); panel.addEventListener("change", recalc);
    panel.addEventListener("click", e => { const o = e.target.closest("[data-open]"); if (o) { e.preventDefault(); go(o.dataset.open); } });
    built[c.id] = { panel, recalc };
    recalc();
  }

  // ---- open / router ----
  const head = $("calc-head");
  function open(id, params, noHash) {
    if (id !== "estimate" && !byId[id]) id = "strength";
    current = id;
    const cc = byId[id] ? byId[id].cat : null;
    if (cc !== lastCat) { navOpen = {}; lastCat = cc; }
    document.querySelectorAll(".tab-panel").forEach(p => p.hidden = true);
    const c = byId[id];
    if (id === "estimate") { renderEstimate(); $("tab-estimate").hidden = false; }
    else if (c.legacy) { $("tab-" + id).hidden = false; }
    else if (c.custom) {
      if (!built[id]) { const p = document.createElement("div"); p.className = "tab-panel gen"; p.id = "tab-" + id; main.appendChild(p); built[id] = { panel: p, recalc() {} }; c.render(p, { open: go, setItems: items => { c._last = { v: {}, out: { items } }; updateActions(); } }); }
      built[id].panel.hidden = false;
    }
    else {
      if (!built[id]) build(c, params);
      else if (params) { const p = built[id].panel; Object.entries(params).forEach(([k, val]) => { const el = p.querySelector('[data-k="' + k + '"]'); if (el) { if (el.type === "checkbox") el.checked = val === "1"; else el.value = val; } }); built[id].recalc(); }
      built[id].panel.hidden = false;
    }
    if (!MP) {
      $("calc-title").textContent = id === "estimate" ? "Смета материалов" : c.name;
      $("calc-desc").textContent = id === "estimate" ? "Всё, что вы добавили из калькуляторов. Укажите цены — получится сумма." : c.desc;
    }
    if ($("menu-cur")) $("menu-cur").textContent = id === "estimate" ? "Смета" : c.name;
    if (id !== "estimate") { const rec = (store.get("recent") || []).filter(x => x !== id); rec.unshift(id); store.set("recent", rec.slice(0, 6)); }
    store.set("tab", id);
    if (!noHash && !MP) { try { history.replaceState(null, "", "#" + id); } catch (e) {} }
    renderNav(); updateActions();
    if (window.innerWidth < 900) window.scrollTo({ top: 0 });
  }
  window.App = { open: go };

  // ---- actions: add to estimate / share ----
  function currentItems() {
    if (!current || current === "estimate") return [];
    const c = byId[current];
    if (c.legacy) return (window.__legacy[current] || []).map(i => Array.isArray(i) ? i : [i.name, i.qty, i.unit]);
    return (c._last && c._last.out.items) || [];
  }
  function updateActions() {
    const items = currentItems().filter(i => i[1] > 0);
    if (!$("act-add")) return;
    $("act-add").hidden = !items.length;
    $("act-share").hidden = current === "estimate" || current === "strength" || !!(byId[current] && byId[current].custom);
  }
  // legacy calculators notify through this hook
  window.__legacyChanged = () => { if (current && byId[current] && byId[current].legacy) updateActions(); };

  let toastT;
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2600); }

  on("act-add", "click", () => {
    const items = currentItems().filter(i => i[1] > 0);
    const est = store.get("estimate") || [];
    const src = byId[current].name;
    items.forEach(i => est.push({ src, name: String(i[0]), qty: Number(i[1]), unit: i[2], price: "" }));
    store.set("estimate", est);
    updateBadge();
    toast("В смету добавлено позиций: " + items.length);
    goal("add_to_estimate");
  });

  function shareText() {
    const c = byId[current];
    let lines = [c.name];
    if (!c.legacy && !c.custom && c._last) {
      c.inputs.forEach(f => {
        const box = built[c.id].panel.querySelector('[data-f="' + f.k + '"]');
        if (box.hidden) return;
        const lbl = typeof f.label === "function" ? f.label(readVals(c, built[c.id].panel)) : f.label;
        let val = c._last.v[f.k];
        if (f.type === "sel") { const o = f.opts.find(o => String(o[0]) === String(val)); val = o ? o[1] : val; }
        if (f.type === "check") val = val === "1" ? "да" : "нет";
        lines.push("• " + lbl + ": " + val);
      });
      lines.push("");
      (c._last.out.stats || []).forEach(s => lines.push(s.label + ": " + s.value + (s.unit ? " " + s.unit : "") + (s.sub ? " (" + s.sub + ")" : "")));
    } else {
      currentItems().forEach(i => lines.push("• " + i[0] + ": " + (typeof i[1] === "number" ? i[1].toLocaleString("ru-RU") : i[1]) + " " + i[2]));
    }
    let link = "";
    try {
      const base = location.href.split("#")[0];
      const qs = !c.legacy && !c.custom && c._last ? "?" + new URLSearchParams(c._last.v).toString() : "";
      if (/^https?:/.test(base)) link = MP ? location.origin + location.pathname + qs : base + "#" + current + qs;
    } catch (e) {}
    if (link) lines.push("", link);
    return lines.join("\n");
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast("Скопировано — вставьте в мессенджер"); return; } catch (e) {}
    const box = $("copy-box"); box.querySelector("textarea").value = text; box.hidden = false; box.querySelector("textarea").select();
  }
  on("act-share", "click", () => { goal("share"); copy(shareText()); });
  on("copy-close", "click", () => { $("copy-box").hidden = true; });

  // ---- estimate ----
  function updateBadge() { const b = $("est-badge"); if (b) { const n = (store.get("estimate") || []).length; b.textContent = n || ""; b.hidden = !n; } }
  function renderEstimate() {
    const est = store.get("estimate") || [];
    const tb = $("est-body"); tb.innerHTML = "";
    $("est-empty").hidden = !!est.length; $("est-wrap").hidden = !est.length;
    let total = 0, src = null;
    est.forEach((it, i) => {
      if (it.src !== src) { src = it.src; const h = document.createElement("tr"); h.className = "grp"; h.innerHTML = '<td colspan="6"></td>'; h.firstChild.textContent = src; tb.appendChild(h); }
      const sum = num(it.qty) * num(it.price); total += sum;
      const tr = document.createElement("tr");
      tr.innerHTML = '<td class="nm"></td><td><input class="ein" data-i="' + i + '" data-f="qty" inputmode="decimal"></td><td class="u"></td><td><input class="ein" data-i="' + i + '" data-f="price" inputmode="decimal" placeholder="—"></td><td class="sm"></td><td><button type="button" class="rdel" data-del="' + i + '" aria-label="Удалить">×</button></td>';
      tr.querySelector(".nm").textContent = it.name; tr.querySelector(".u").textContent = it.unit;
      tr.querySelector('[data-f="qty"]').value = String(it.qty).replace(".", ",");
      tr.querySelector('[data-f="price"]').value = it.price ? String(it.price).replace(".", ",") : "";
      tr.querySelector(".sm").textContent = sum ? nint(sum) + " ₽" : "";
      tb.appendChild(tr);
    });
    $("est-total").textContent = total ? nint(total) + " ₽" : "—";
    updateBadge();
  }
  on("est-body", "change", e => {
    const t = e.target; if (!t.dataset.f) return;
    const est = store.get("estimate") || []; const it = est[+t.dataset.i]; if (!it) return;
    it[t.dataset.f] = t.dataset.f === "price" ? (t.value.trim() ? num(t.value) : "") : num(t.value);
    store.set("estimate", est); renderEstimate();
  });
  on("est-body", "click", e => {
    const d = e.target.closest("[data-del]"); if (!d) return;
    const est = store.get("estimate") || []; est.splice(+d.dataset.del, 1); store.set("estimate", est); renderEstimate();
  });
  on("est-clear", "click", () => { if ($("est-clear").dataset.arm) { store.set("estimate", []); delete $("est-clear").dataset.arm; $("est-clear").textContent = "Очистить"; renderEstimate(); } else { $("est-clear").dataset.arm = "1"; $("est-clear").textContent = "Точно очистить?"; setTimeout(() => { delete $("est-clear").dataset.arm; $("est-clear").textContent = "Очистить"; }, 3000); } });
  on("est-copy", "click", () => {
    const est = store.get("estimate") || []; let src = null, total = 0; const lines = ["Смета материалов"];
    est.forEach(it => { if (it.src !== src) { src = it.src; lines.push("", src + ":"); } const s = num(it.qty) * num(it.price); total += s; lines.push("• " + it.name + " — " + num(it.qty).toLocaleString("ru-RU") + " " + it.unit + (s ? " × " + nint(it.price) + " ₽ = " + nint(s) + " ₽" : "")); });
    if (total) lines.push("", "Итого: " + nint(total) + " ₽");
    copy(lines.join("\n"));
  });
  on("est-print", "click", () => { try { window.print(); } catch (e) { toast("Печать недоступна на этой странице"); } });

  // ---- start ----
  function fromHash() {
    const h = decodeURIComponent((location.hash || "").slice(1));
    if (!h) return null;
    const [id, qs] = h.split("?");
    const params = qs ? Object.fromEntries(new URLSearchParams(qs)) : null;
    return { id, params };
  }
  if (MP) {
    const sp = new URLSearchParams(location.search), params = sp.toString() ? Object.fromEntries(sp) : null;
    if (MP.id) open(MP.id, params, true); else { if (MP.cat) navOpen[MP.cat] = true; renderNav(); }
    let used = false;
    document.addEventListener("input", e => { if (!used && e.target.closest && e.target.closest(".main")) { used = true; goal("calc_used"); } });
  } else {
    const start = fromHash();
    open(start && (byId[start.id] || start.id === "estimate") ? start.id : (store.get("tab") || "strength"), start && start.params, false);
    window.addEventListener("hashchange", () => { const h = fromHash(); if (h && (h.id !== current || h.params)) open(h.id, h.params, true); });
  }
})();
