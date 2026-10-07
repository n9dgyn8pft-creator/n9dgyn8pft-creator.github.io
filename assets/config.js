/* Настройки сайта SPUTNIK.
   METRIKA_ID — номер счётчика Яндекс.Метрики (только цифры). 0 — Метрика выключена. */
window.METRIKA_ID = 0;
(function () {
  if (!window.METRIKA_ID) return;
  (function (m, e, t, r, i, k, a) { m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); }; m[i].l = 1 * new Date();
    for (var j = 0; j < document.scripts.length; j++) { if (document.scripts[j].src === r) { return; } }
    k = e.createElement(t), a = e.getElementsByTagName(t)[0], k.async = 1, k.src = r, a.parentNode.insertBefore(k, a); })
  (window, document, "script", "https://mc.yandex.ru/metrika/tag.js", "ym");
  window.ym(window.METRIKA_ID, "init", { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: true });
})();
