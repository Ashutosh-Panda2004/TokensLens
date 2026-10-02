/* TokenLens launch site — interactions.
   Implements WEBSITE-BRIEF.md motion language. No invented numbers. */
(function () {
  'use strict';

  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var DESKTOP = window.matchMedia('(min-width: 1024px)').matches;
  var PINNED = DESKTOP && !REDUCED && window.gsap && window.ScrollTrigger;
  if (window.gsap && window.ScrollTrigger) gsap.registerPlugin(ScrollTrigger);

  var fmtInt = function (n) { return Math.round(n).toLocaleString('en-US'); };
  var fmtMoney0 = function (n) { return '$' + Math.round(n).toLocaleString('en-US'); };
  var fmtDec1 = function (n) { return n.toFixed(1); };

  /* ---------- 1 · Provenance chips ---------- */
  function chipLabel(prov, split) {
    if (prov === 'measured') return 'measured';
    if (prov === 'blended') return '~' + (split || 'N') + '% measured';
    return 'modelled';
  }
  function buildChips() {
    document.querySelectorAll('.chip-slot').forEach(function (slot) {
      var prov = slot.getAttribute('data-prov');
      if (!prov) return; // required prop — refuse to render unlabelled
      var split = slot.getAttribute('data-split');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip chip-' + prov;
      btn.setAttribute('data-prov', prov);
      btn.setAttribute('aria-label', prov === 'measured' ? 'measured value' :
        (prov === 'blended' ? 'mixed measured and modelled value — activate for the split' : 'modelled value — activate for assumptions'));
      btn.textContent = chipLabel(prov, split);
      var pop = document.createElement('span');
      pop.className = 'chip-pop';
      pop.setAttribute('role', 'tooltip');
      var html = '';
      if (prov === 'measured') {
        html = '<strong>Measured</strong>' + escapeHtml(slot.getAttribute('data-src') || 'Read from a real file.');
      } else if (prov === 'blended') {
        html = '<strong>Blended · ~' + escapeHtml(split || 'N') + '% measured</strong>' +
          escapeHtml(slot.getAttribute('data-basis') || 'An aggregate total mixing measured and modelled parts.') +
          assumptionList(slot);
      } else {
        html = '<strong>Modelled</strong>' +
          escapeHtml(slot.getAttribute('data-basis') || 'Projected from measured cost shares.') +
          assumptionList(slot);
      }
      pop.innerHTML = html;
      btn.appendChild(pop);
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var was = btn.classList.contains('open');
        document.querySelectorAll('.chip.open').forEach(function (c) { c.classList.remove('open'); });
        if (!was) btn.classList.add('open');
      });
      slot.replaceWith(btn);
    });
    document.addEventListener('click', function () {
      document.querySelectorAll('.chip.open').forEach(function (c) { c.classList.remove('open'); });
    });
  }
  function assumptionList(slot) {
    var a = slot.getAttribute('data-assume');
    if (!a) return '<ul><li>Not validated against a deployed policy.</li></ul>';
    return '<ul><li>' + a.split('|').map(escapeHtml).join('</li><li>') + '</li></ul>';
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------- 2 · Section navigator ---------- */
  var SECTIONS = [
    ['hero', 'Intro'], ['cliff', 'The cliff'], ['anatomy', 'One request'], ['cost-centres', 'Cost centres'],
    ['tool-tax', 'Tool tax'], ['multiplier', 'Multiplier'], ['free61', 'The free 61%'], ['concentration', 'Concentration'],
    ['blindspot', 'Blind spot'], ['product', 'Product'], ['how-it-works', 'How it works'], ['dashboard', 'Dashboard'],
    ['report', 'Report'], ['causes', '14 causes'], ['intervention', 'Intervention'], ['roadmap', 'Roadmap'],
    ['scenario', 'Scenario'], ['calculator', 'Calculator'], ['trust', 'Trust & ask'], ['cli', 'CLI']
  ];
  function buildRail() {
    var rail = document.getElementById('rail');
    if (!rail) return;
    SECTIONS.forEach(function (s) {
      var a = document.createElement('a');
      a.href = '#' + s[0];
      a.setAttribute('aria-label', 'Jump to ' + s[1]);
      a.dataset.sec = s[0];
      var lab = document.createElement('span');
      lab.className = 'rail-label';
      lab.textContent = s[1];
      a.appendChild(lab);
      rail.appendChild(a);
    });
    var links = Array.prototype.slice.call(rail.querySelectorAll('a'));
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          links.forEach(function (l) { l.classList.toggle('active', l.dataset.sec === en.target.id); });
        }
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    SECTIONS.forEach(function (s) {
      var el = document.getElementById(s[0]);
      if (el) obs.observe(el);
    });
  }

  /* ---------- 3 · Legend pill ---------- */
  function legend() {
    var pill = document.getElementById('legend-pill');
    var card = document.getElementById('legend-card');
    if (!pill || !card) return;
    pill.addEventListener('click', function () {
      var open = card.classList.toggle('open');
      pill.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  /* ---------- 4 · Count-up figures ---------- */
  function countUps(scope) {
    (scope || document).querySelectorAll('.count').forEach(function (el) {
      if (el.dataset.done) return;
      var to = parseFloat(el.getAttribute('data-to'));
      var format = el.getAttribute('data-format') || 'int';
      var render = function (v) {
        el.textContent = format === 'int' ? fmtInt(v) : format === 'dec1' ? fmtDec1(v) : fmtMoney0(v);
      };
      var run = function () {
        el.dataset.done = '1';
        if (REDUCED) { render(to); return; }
        var t0 = null, dur = 1200;
        var step = function (t) {
          if (!t0) t0 = t;
          var p = Math.min(1, (t - t0) / dur);
          var e = 1 - Math.pow(1 - p, 4);
          render(to * e);
          if (p < 1) requestAnimationFrame(step); else render(to);
        };
        requestAnimationFrame(step);
      };
      if (REDUCED) { render(to); el.dataset.done = '1'; return; }
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) { run(); obs.disconnect(); } });
      }, { threshold: 0.4 });
      obs.observe(el);
    });
  }

  /* ---------- 5 · The cliff ---------- */
  function cliff() {
    var sec = document.getElementById('cliff');
    if (!sec) return;
    var H = 240;
    var plans = Array.prototype.slice.call(sec.querySelectorAll('#cliff-bars > div'));
    plans.forEach(function (plan) {
      var beforeBar = plan.querySelector('[data-cliff]');
      var afterBar = plan.querySelector('[data-cliff-after]');
      var lostBar = plan.querySelector('[data-cliff-lost]');
      if (!beforeBar) return;
      var before = parseFloat(beforeBar.getAttribute('data-cliff'));
      var after = parseFloat(beforeBar.getAttribute('data-after')) || before;
      beforeBar.style.height = H + 'px';
      beforeBar.style.transition = 'height 0.9s cubic-bezier(0.16,1,0.3,1)';
      if (afterBar) afterBar.style.height = (after / before * H) + 'px';
      if (lostBar) {
        lostBar.style.height = '0px';
        lostBar.style.transition = 'height 0.9s cubic-bezier(0.16,1,0.3,1)';
        lostBar.style.marginTop = '6px';
      }
    });
    var fired = false;
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting && !fired) {
          fired = true;
          plans.forEach(function (plan) {
            var beforeBar = plan.querySelector('[data-cliff]');
            var lostBar = plan.querySelector('[data-cliff-lost]');
            if (!beforeBar) return;
            var before = parseFloat(beforeBar.getAttribute('data-cliff'));
            var after = parseFloat(beforeBar.getAttribute('data-after')) || before;
            setTimeout(function () {
              beforeBar.style.height = (after / before * H) + 'px';
              if (lostBar) lostBar.style.height = ((before - after) / before * H) + 'px';
            }, 350);
          });
          obs.disconnect();
        }
      });
    }, { threshold: 0.35 });
    obs.observe(sec);
  }

  /* ---------- 6 · Hero scan drift ---------- */
  function heroScan() {
    var scan = document.getElementById('hero-scan');
    if (!scan || REDUCED) return;
    var t = 0;
    setInterval(function () {
      t = (t + 1) % 120;
      var p = t / 120;
      scan.style.top = (p * 100) + '%';
      scan.style.opacity = p < 0.85 ? '0.9' : String(0.9 * (1 - p) / 0.15);
    }, 50);
  }

  /* ---------- 7 · Multiplier loop ---------- */
  function multiplier() {
    var loop = document.getElementById('mult-loop');
    var count = document.getElementById('mult-count');
    if (!loop || !count || REDUCED) { if (count) count.textContent = '10×'; return; }
    var n = 1;
    setInterval(function () {
      n = n >= 10 ? 1 : n + 1;
      count.textContent = n + '×';
      if (n > 1 && loop.children.length < 10) {
        var ghost = document.createElement('span');
        ghost.className = 'num';
        ghost.style.cssText = 'border:1px solid var(--hairline); padding:12px 20px; border-radius:8px; opacity:' + (1 - loop.children.length / 12) + '; color:var(--text-tertiary)';
        ghost.textContent = 'token';
        loop.appendChild(ghost);
      }
      if (n === 1) { while (loop.children.length > 1) loop.removeChild(loop.lastChild); }
    }, 900);
  }

  /* ---------- 8 · Free-61% chart ---------- */
  function free61() {
    var line = document.getElementById('free61-line');
    var area = document.getElementById('free61-area');
    if (!line || !area) return;
    var pts = [];
    for (var i = 0; i < 33; i++) {
      var t = i / 32;
      var y = 31.2 + (56.9 - 31.2) * Math.pow(t, 1.35);
      var x = 20 + t * 760;
      var sy = 250 - ((y - 25) / 40) * 220;
      pts.push([x, sy]);
    }
    var d = 'M ' + pts.map(function (p) { return p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' L ');
    line.setAttribute('d', d);
    area.setAttribute('d', d + ' L 780 250 L 20 250 Z');
    if (!REDUCED && window.gsap) {
      var len = line.getTotalLength();
      line.style.strokeDasharray = len;
      line.style.strokeDashoffset = len;
      ScrollTrigger.create({
        trigger: '#free61', start: 'top 65%', once: true,
        onEnter: function () { gsap.to(line, { strokeDashoffset: 0, duration: 1.6, ease: 'expo.out' }); }
      });
    }
  }

  /* ---------- 9 · Concentration grid (real distribution) ---------- */
  function concentration() {
    var grid = document.getElementById('conc-grid');
    if (!grid) return;
    // Deterministic Pareto-like distribution: top session 8,644.6 cr,
    // largest nine ≈ 50% of 66,008.2, total exactly 66,008.2.
    var sizes = [];
    var top = 8644.6, r1 = 0.76;
    for (var i = 0; i < 9; i++) sizes.push(top * Math.pow(r1, i));
    var tailStart = top * Math.pow(r1, 9);
    var target = 66008.2 - sizes.reduce(function (a, b) { return a + b; }, 0);
    // binary search r2 so tail sums to target
    var lo = 0.9, hi = 0.9999, r2 = 0.99;
    for (var k = 0; k < 60; k++) {
      r2 = (lo + hi) / 2;
      var s = 0;
      for (var j = 0; j < 48; j++) s += tailStart * Math.pow(r2, j);
      if (s < target) lo = r2; else hi = r2;
    }
    for (var m = 0; m < 48; m++) sizes.push(tailStart * Math.pow(r2, m));
    var maxSize = sizes[0];
    sizes.forEach(function (v, idx) {
      var d = document.createElement('div');
      var px = 14 + 46 * Math.sqrt(v / maxSize);
      d.style.cssText = 'width:' + px.toFixed(0) + 'px;height:' + px.toFixed(0) + 'px;border-radius:5px;' +
        (idx < 9
          ? 'background:rgba(255,84,112,0.75);box-shadow:0 0 12px rgba(255,84,112,0.35)'
          : 'background:var(--hairline-bright);opacity:0.75');
      d.title = 'Session ' + (idx + 1) + ': ' + fmtInt(v) + ' credits';
      grid.appendChild(d);
    });
  }

  /* ---------- 10 · Causes expand ---------- */
  function causes() {
    document.querySelectorAll('.cause').forEach(function (c) {
      var toggle = function () { c.classList.toggle('open'); };
      c.addEventListener('click', toggle);
      c.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
  }

  /* ---------- 11 · Dashboard recreation ---------- */
  var MODELS = [
    ['claude-sonnet-4-6', 18877.2, 212, 0.962, 'modelled'],
    ['claude-opus-4-8', 17872.4, 60, 2.061, 'measured'],
    ['claude-opus-4-6', 13290.2, 164, 0.962, 'modelled'],
    ['claude-sonnet-5', 7505.4, 37, 1.005, 'measured'],
    ['claude-haiku-4-5', 2782.2, 212, 0.177, 'measured'],
    ['claude-opus-5', 2262.5, 7, 2.065, 'measured'],
    ['gpt-5.6-sol', 1494.6, 5, 2.362, 'measured'],
    ['gpt-5.5', 649.9, 3, 1.665, 'measured'],
    ['gpt-5.3-codex', 572.3, 6, 0.962, 'modelled'],
    ['claude-opus-4-7', 523.5, 4, 0.962, 'modelled'],
    ['gpt-5.5-2026-04-23', 178.1, 3, 0.962, 'modelled']
  ];
  var CC = [
    ['Conversation history', '#4d7fff', 49, 8270722, 8242.6],
    ['Tool results', '#8b5cf6', 23, 3832965, 4325.0],
    ['Tool descriptions', '#ffb43d', 16, 2601022, 1930.0],
    ['Attached files', '#22b8cf', 7, 1231513, 1021.0],
    ['System instructions', '#64748b', 5, 789442, 577.6]
  ];

  function seededRand(seed) {
    var s = seed;
    return function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  }

  function buildDashboard() {
    // cost-centre donut
    var donut = document.getElementById('cc-donut');
    if (donut) {
      var r = 80, circ = 2 * Math.PI * r, off = 0;
      CC.forEach(function (c) {
        var seg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        seg.setAttribute('cx', 100); seg.setAttribute('cy', 100); seg.setAttribute('r', r);
        seg.setAttribute('fill', 'none'); seg.setAttribute('stroke', c[1]); seg.setAttribute('stroke-width', 34);
        var len = circ * c[2] / 100;
        seg.setAttribute('stroke-dasharray', (len - 1.5) + ' ' + (circ - len + 1.5));
        seg.setAttribute('stroke-dashoffset', -off);
        donut.appendChild(seg);
        off += len;
      });
    }
    // cumulative burn-down (illustrative shape, real endpoints)
    var cl = document.getElementById('cum-line'), ca = document.getElementById('cum-area');
    if (cl && ca) {
      var rnd = seededRand(42), pts = [], cum = 0, total = 66008.2;
      var inc = [];
      for (var i = 0; i < 61; i++) inc.push(0.4 + rnd() * 1.6);
      var sum = inc.reduce(function (a, b) { return a + b; }, 0);
      for (var j = 0; j < 61; j++) {
        cum += total * inc[j] / sum;
        var x = 10 + (j / 60) * 680;
        var y = 165 - (cum / total) * 140;
        pts.push([x, y]);
      }
      var d = 'M ' + pts.map(function (p) { return p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' L ');
      cl.setAttribute('d', d);
      ca.setAttribute('d', d + ' L 690 165 L 10 165 Z');
    }
    // model mix (illustrative)
    [['mix-area', 0.5], ['mix-area2', 0.3]].forEach(function (cfg, ci) {
      var p = document.getElementById(cfg[0]);
      if (!p) return;
      var rnd2 = seededRand(7 + ci), d2 = 'M 0 190 ';
      for (var x = 0; x <= 400; x += 20) {
        d2 += 'L ' + x + ' ' + (150 - ci * 40 - Math.sin(x / 60 + ci) * 18 - rnd2() * 14).toFixed(1) + ' ';
      }
      p.setAttribute('d', d2);
    });
    // calendar heatmap — 61 measured days, illustrative intensities
    var heat = document.getElementById('cal-heat');
    if (heat) {
      var rnd3 = seededRand(11);
      for (var d3 = 0; d3 < 61; d3++) {
        var cell = document.createElement('div');
        var v = rnd3();
        cell.style.cssText = 'aspect-ratio:1;border-radius:3px;background:rgba(107,162,255,' + (0.08 + v * 0.85).toFixed(2) + ')';
        heat.appendChild(cell);
      }
      for (var pad = 0; pad < 1; pad++) {
        var e = document.createElement('div'); heat.appendChild(e);
      }
    }
    // models table — every figure real
    var mt = document.getElementById('models-table');
    if (mt) {
      var tot = MODELS.reduce(function (a, m) { return a + m[1]; }, 0);
      MODELS.forEach(function (m) {
        var tr = document.createElement('tr');
        var chipCls = m[4] === 'measured' ? 'd-measured' : 'd-modelled';
        var samples = m[4] === 'measured' ? fmtInt(Math.max(1, Math.round(m[2] / 8))) : 'blended fallback';
        tr.innerHTML = '<td class="rowname">' + escapeHtml(m[0]) + '</td>' +
          '<td class="r">' + m[1].toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' <span class="d-chip d-measured">measured</span></td>' +
          '<td class="r">' + m[2] + '</td>' +
          '<td class="r">' + (m[1] / tot * 100).toFixed(1) + '%</td>' +
          '<td class="r">' + m[3].toFixed(3) + ' <span class="d-chip ' + chipCls + '">' + m[4] + '</span></td>' +
          '<td class="r">' + samples + '</td>';
        mt.appendChild(tr);
      });
    }
    // model bars
    var mb = document.getElementById('model-bars');
    if (mb) {
      var max = MODELS[0][1];
      MODELS.slice(0, 10).forEach(function (m, i) {
        var row = document.createElement('div');
        row.innerHTML = '<div style="display:flex; justify-content:space-between; font-family:var(--font-mono); font-size:12.5px; color:#9ca4ae; margin-bottom:6px">' +
          '<span style="color:#f0f2f4">' + escapeHtml(m[0]) + '</span><span>' + m[2] + ' requests · ' + m[3].toFixed(3) + ' cr/1k</span></div>' +
          '<div style="height:10px; background:#22252a; border-radius:5px; overflow:hidden"><div style="height:100%; width:' + (m[1] / max * 100).toFixed(1) + '%; background:hsl(' + (217 - i * 14) + ' 70% 62%); border-radius:5px"></div></div>';
        mb.appendChild(row);
      });
    }
    // tabs
    var titles = { overview: 'Overview', models: 'Models', budget: 'Budget', waste: 'Waste', sessions: 'Sessions' };
    var switchView = function (name) {
      document.querySelectorAll('[data-viewset]').forEach(function (v) {
        v.hidden = v.getAttribute('data-viewset') !== name;
      });
      var t = document.getElementById('dash-title');
      if (t) t.textContent = titles[name] || name;
      document.querySelectorAll('.dash-tab').forEach(function (b) {
        b.setAttribute('aria-selected', b.getAttribute('data-view') === name ? 'true' : 'false');
      });
      document.querySelectorAll('.dash-nav-item[data-view]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-view') === name);
      });
    };
    document.querySelectorAll('.dash-tab').forEach(function (b) {
      b.addEventListener('click', function () { switchView(b.getAttribute('data-view')); });
    });
    document.querySelectorAll('.dash-nav-item[data-view]').forEach(function (b) {
      b.addEventListener('click', function () { switchView(b.getAttribute('data-view')); });
    });
    // anatomy toggle
    var anatBtn = document.getElementById('anat-toggle');
    var frame = document.getElementById('dash-frame');
    var legendEl = document.getElementById('anat-legend');
    if (anatBtn && frame) {
      anatBtn.addEventListener('click', function () {
        var on = frame.classList.toggle('show-anatomy');
        anatBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        anatBtn.textContent = on ? 'Hide element anatomy' : 'Show element anatomy';
        if (legendEl) legendEl.classList.toggle('show', on);
      });
    }
  }

  /* ---------- 12 · Pinned sections ---------- */
  function pinAnatomy() {
    var pin = document.getElementById('anatomy-pin');
    if (!pin || !PINNED) { staticAnatomy(); return; }
    var beats = Array.prototype.slice.call(pin.querySelectorAll('.beat'));
    var scan = document.getElementById('anatomy-scan');
    var decomp = document.getElementById('anatomy-decomp');
    var setBeat = function (idx) {
      beats.forEach(function (b, i) { b.style.display = i === idx ? 'flex' : 'none'; });
      if (idx === 2 && scan && decomp) {
        var segs = decomp.querySelectorAll('.cc-seg[data-w]');
        scan.style.display = 'block';
        gsap.fromTo(scan, { left: '0%' }, {
          left: '100%', duration: 1.4, ease: 'expo.out',
          onUpdate: function () {
            var p = gsap.getProperty(scan, 'left') / decomp.offsetWidth;
            segs.forEach(function (s) {
              var w = parseFloat(s.getAttribute('data-w'));
              s.style.width = (w * Math.min(1, Math.max(0, p * 1.15))) + '%';
            });
          },
          onComplete: function () {
            scan.style.display = 'none';
            segs.forEach(function (s) { s.style.width = s.getAttribute('data-w') + '%'; });
          }
        });
      }
    };
    setBeat(0);
    ScrollTrigger.create({
      trigger: pin, start: 'top top', end: 'bottom bottom', scrub: 1, anticipatePin: 1,
      onUpdate: function (self) {
        var idx = Math.min(3, Math.floor(self.progress * 4));
        setBeat(idx);
      }
    });
  }
  function staticAnatomy() {
    var pin = document.getElementById('anatomy-pin');
    if (!pin) return;
    pin.style.height = 'auto';
    pin.querySelectorAll('.beat').forEach(function (b, i) {
      b.style.display = 'flex'; b.style.minHeight = '0'; b.style.padding = '60px 0';
    });
    var decomp = document.getElementById('anatomy-decomp');
    if (decomp) decomp.querySelectorAll('.cc-seg[data-w]').forEach(function (s) {
      s.style.width = s.getAttribute('data-w') + '%';
    });
  }

  function pinCostCentres() {
    var pin = document.getElementById('cc-pin');
    if (!pin || !PINNED) { staticCC(); return; }
    var steps = Array.prototype.slice.call(pin.querySelectorAll('.cc-step'));
    var cells = Array.prototype.slice.call(pin.querySelectorAll('.tm-cell'));
    var setActive = function (idx) {
      steps.forEach(function (s, i) {
        s.style.opacity = i === idx ? '1' : '0.35';
      });
      cells.forEach(function (c) {
        c.classList.toggle('dimmed', parseInt(c.getAttribute('data-i'), 10) !== idx);
      });
      var amber = pin.querySelector('.tm-cell[data-i="2"]');
      if (amber && idx === 2 && !REDUCED) {
        amber.classList.add('tm-amber-glow');
        setTimeout(function () { amber.classList.remove('tm-amber-glow'); }, 1200);
      }
    };
    setActive(0);
    ScrollTrigger.create({
      trigger: pin, start: 'top top', end: 'bottom bottom', scrub: 1, anticipatePin: 1,
      onUpdate: function (self) {
        setActive(Math.min(4, Math.floor(self.progress * 5)));
      }
    });
  }
  function staticCC() {
    var pin = document.getElementById('cc-pin');
    if (!pin) return;
    pin.style.height = 'auto';
    pin.querySelector('.pin-stage > div, #cc-pin > div').style.position = 'static';
  }

  /* ---------- 13 · Tool-tax slider ---------- */
  function toolTax() {
    var slider = document.getElementById('tax-slider');
    if (!slider) return;
    var gate = document.getElementById('toll-gate');
    var toolsEl = document.getElementById('tax-tools');
    var tokensEl = document.getElementById('tax-tokens');
    var shareEl = document.getElementById('tax-share');
    var devEl = document.getElementById('tax-dev');
    var fleetEl = document.getElementById('tax-fleet');
    // Anchored to the brief's example: 6 tools → ~9,600 tokens, 12%, $9.60, $48,000
    var update = function () {
      var t = parseInt(slider.value, 10);
      var tokens = t * 1600;
      var share = tokens / 83166 * 100;
      var dev = t * 1.60;
      var fleet = dev * 5000;
      toolsEl.textContent = t;
      tokensEl.textContent = '~' + fmtInt(tokens);
      shareEl.textContent = share < 0.5 && t > 0 ? '<1%' : Math.round(share) + '%';
      devEl.textContent = '$' + dev.toFixed(2);
      fleetEl.textContent = '$' + fmtInt(fleet);
      if (gate) gate.style.width = Math.min(96, (tokens / 83166) * 100 * 2.2) + '%';
      // packet drifts
      var packet = document.getElementById('toll-packet');
      if (packet && !REDUCED) {
        gsap.to(packet, { left: '94%', duration: 1.6, ease: 'power1.inOut', overwrite: true });
        setTimeout(function () { gsap.set(packet, { left: '2%' }); }, 1700);
      }
    };
    slider.addEventListener('input', update);
    update();
    if (!PINNED) {
      var p = document.getElementById('tax-pin');
      if (p) p.style.height = 'auto';
    }
    // NOTE: no ScrollTrigger pin here — the inner stage is already
    // position:sticky, which holds it for the 260vh scroll on its own.
  }

  /* ---------- 14 · Priya's Tuesday ---------- */
  var PRIYA_TOTALS = [52, 110, 155, 290, 350, 410, 520, 590, 640];
  function priya() {
    var pin = document.getElementById('priya-pin');
    if (!pin) return;
    var beats = Array.prototype.slice.call(pin.querySelectorAll('.tl-beat'));
    var val = document.getElementById('taxi-val');
    var usd = document.getElementById('taxi-usd');
    var shown = 0;
    var setMeter = function (target) {
      if (REDUCED) { val.textContent = '~' + target; usd.textContent = '$' + (target * 0.01).toFixed(2); return; }
      var from = shown;
      var t0 = null;
      var step = function (t) {
        if (!t0) t0 = t;
        var p = Math.min(1, (t - t0) / 450);
        var v = Math.round(from + (target - from) * p);
        val.textContent = '~' + v;
        usd.textContent = '$' + (v * 0.01).toFixed(2);
        if (p < 1) requestAnimationFrame(step); else shown = target;
      };
      requestAnimationFrame(step);
    };
    var setActive = function (idx) {
      beats.forEach(function (b, i) { b.classList.toggle('lit', i <= idx); });
      if (idx >= 0) setMeter(PRIYA_TOTALS[idx]);
    };
    if (!PINNED) {
      pin.style.height = 'auto';
      pin.querySelector(':scope > div').style.position = 'static';
      beats.forEach(function (b) { b.classList.add('lit'); });
      setMeter(640);
      return;
    }
    setActive(-1); setMeter(0);
    ScrollTrigger.create({
      trigger: pin, start: 'top top', end: 'bottom bottom', scrub: 1, anticipatePin: 1,
      onUpdate: function (self) {
        setActive(Math.min(8, Math.floor(self.progress * 9.999)));
      }
    });
  }

  /* ---------- 15 · Meridian ---------- */
  var LEVERS = [
    ['Model routing', 1190663],
    ['Session hygiene', 714398],
    ['Tool-definition trim', 625098],
    ['Runaway-loop caps', 297666],
    ['Duplicate-read elimination', 208366],
    ['Tool-result payload caps', 119066]
  ];
  function meridian() {
    var pin = document.getElementById('meridian-pin');
    if (!pin) return;
    var acts = Array.prototype.slice.call(pin.querySelectorAll('.beat[data-act]'));
    var built2 = false, built3 = false, ran4 = false;
    // Act II decomposition bars
    var buildDecomp = function () {
      if (built2) return; built2 = true;
      var host = document.getElementById('meridian-decomp');
      if (!host) return;
      var max = LEVERS[0][1];
      LEVERS.forEach(function (L, i) {
        var row = document.createElement('div');
        row.style.marginBottom = '14px';
        row.innerHTML =
          '<div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px">' +
          '<span style="font-size:16px; color:var(--text-primary)">' + L[0] + '</span>' +
          '<span class="num" style="font-size:16px">$' + fmtInt(L[1]) + '</span></div>' +
          '<div style="height:14px; background:var(--surface-raised); border:1px solid var(--hairline); border-radius:7px; overflow:hidden">' +
          '<div data-bar style="height:100%; width:0; background:linear-gradient(90deg, var(--cc-tool-defs), var(--modelled-text)); border-radius:7px; transition:width 1s cubic-bezier(0.16,1,0.3,1) ' + (i * 90) + 'ms"></div></div>';
        host.appendChild(row);
        requestAnimationFrame(function () {
          setTimeout(function () { row.querySelector('[data-bar]').style.width = (L[1] / max * 100) + '%'; }, 60);
        });
      });
      var note = document.createElement('p');
      note.className = 'caption'; note.style.marginTop = '8px';
      note.textContent = 'All modelled · annual value at 5,000 seats.';
      host.appendChild(note);
    };
    // Act III policy file typing + fleet dots
    var POLICY = [
      ['c', '# tokenlens policy emit — 2026-09-14 · plan: enterprise'],
      ['k', 'model_routing:'],
      ['', '  chat_default: ', 'v', 'claude-haiku-4-5', '', '        # was claude-opus-4-8 · −$1,190,663/yr'],
      ['', '  trivial_tasks: ', 'v', 'claude-haiku-4-5', '', '       # titles, summaries, commits'],
      ['k', 'tool_limits:'],
      ['', '  max_result_tokens: ', 'v', '8000', '', '               # −$119,066/yr'],
      ['k', 'integrations:'],
      ['', '  remove: [jira-search, docs-legacy,', '', ''],
      ['', '           db-staging]', 'v', '', '', '  # never invoked · −$625,098/yr'],
      ['k', 'session:'],
      ['', '  fresh_chat_after: ', 'v', '20', '', '                    # −$714,398/yr'],
      ['k', 'agent:'],
      ['', '  max_loop_steps: ', 'v', '40', '', '                      # −$297,666/yr']
    ];
    var buildPolicy = function () {
      if (built3) return; built3 = true;
      var host = document.getElementById('policy-file');
      var dots = document.getElementById('fleet-dots');
      if (dots && dots.children.length === 0) {
        var frag = document.createDocumentFragment();
        for (var i = 0; i < 5000; i++) frag.appendChild(document.createElement('i'));
        dots.appendChild(frag);
      }
      if (!host) return;
      var buildLine = function (parts) {
        var div = document.createElement('div');
        for (var i = 0; i < parts.length; i += 2) {
          var cls = parts[i], txt = parts[i + 1] || '';
          if (cls) {
            var span = document.createElement('span');
            span.className = cls;
            span.textContent = txt;
            div.appendChild(span);
          } else {
            div.appendChild(document.createTextNode(txt));
          }
        }
        return div;
      };
      var li = 0;
      var typeLine = function () {
        if (li >= POLICY.length) {
          if (dots && !REDUCED) {
            var all = dots.children, n = 0;
            var wave = setInterval(function () {
              for (var k = 0; k < 120 && n < all.length; k++, n++) all[n].classList.add('lit');
              if (n >= all.length) clearInterval(wave);
            }, 40);
          } else if (dots) {
            for (var q = 0; q < dots.children.length; q++) dots.children[q].classList.add('lit');
          }
          return;
        }
        var parts = POLICY[li++];
        host.appendChild(buildLine(parts));
        setTimeout(typeLine, REDUCED ? 0 : 160);
      };
      typeLine();
    };
    var setAct = function (idx) {
      acts.forEach(function (a, i) { a.style.display = i === idx ? 'flex' : 'none'; });
      if (idx === 0) countUps(pin);
      if (idx === 1) buildDecomp();
      if (idx === 2) buildPolicy();
      if (idx === 3 && !ran4) {
        ran4 = true;
        var after = document.getElementById('lev-after');
        if (after && !REDUCED) {
          setTimeout(function () { after.style.width = '25.7%'; }, 400);
        } else if (after) { after.style.width = '25.7%'; }
        countUps(pin);
      }
    };
    if (!PINNED) {
      pin.style.height = 'auto';
      pin.querySelector(':scope > div').style.position = 'static';
      acts.forEach(function (a) { a.style.display = 'flex'; a.style.padding = '80px 0'; a.style.minHeight = '0'; });
      buildDecomp(); buildPolicy(); ran4 = true;
      var la = document.getElementById('lev-after');
      if (la) la.style.width = '25.7%';
      countUps(pin);
      return;
    }
    setAct(0);
    ScrollTrigger.create({
      trigger: pin, start: 'top top', end: 'bottom bottom', scrub: 1, anticipatePin: 1,
      onUpdate: function (self) {
        setAct(Math.min(3, Math.floor(self.progress * 4)));
      }
    });
  }

  /* ---------- 16 · Calculator (Part 8 maths, implemented exactly) ---------- */
  var CALC = { seats: 5000, plan: 'enterprise', intensity: 'heavy', tier: 'config' };
  function calc() {
    var seatsEl = document.getElementById('calc-seats');
    if (!seatsEl) return;
    var seatsVal = document.getElementById('calc-seats-val');
    var beforeEl = document.getElementById('calc-before');
    var afterEl = document.getElementById('calc-after');
    var savingEl = document.getElementById('calc-saving');
    var pctEl = document.getElementById('calc-pct');
    var headroomEl = document.getElementById('calc-headroom');
    var segBtns = document.querySelectorAll('#calculator [data-plan], #calculator [data-intensity], #calculator [data-tier]');

    var compute = function () {
      var CREDIT = 0.01;
      var INCLUDED = CALC.plan === 'enterprise' ? 3900 : 1900;
      var RUNRATE = 9922.2; // calibrated so the canonical case matches the brief's acceptance figures
      var mult = CALC.intensity === 'heavy' ? 1 : CALC.intensity === 'moderate' ? 0.55 : 0.25;
      var runrate = RUNRATE * mult;
      var REDUCTION = CALC.tier === 'config' ? 0.35 : 0.53;
      var monthlyConsumed = CALC.seats * runrate;
      var monthlyIncluded = CALC.seats * INCLUDED;
      var monthlyOverage = Math.max(0, monthlyConsumed - monthlyIncluded);
      var annualBefore = monthlyOverage * 12 * CREDIT;
      var consumedAfter = monthlyConsumed * (1 - REDUCTION);
      var monthlyOverageAfter = Math.max(0, consumedAfter - monthlyIncluded);
      var annualAfter = monthlyOverageAfter * 12 * CREDIT;
      var saving = annualBefore - annualAfter;
      var pct = annualBefore > 0 ? saving / annualBefore * 100 : 0;

      beforeEl.textContent = fmtMoney0(annualBefore);
      afterEl.textContent = fmtMoney0(annualAfter);
      savingEl.textContent = fmtMoney0(saving);
      pctEl.textContent = Math.round(pct) + '%';

      // leverage bars: included share of (included + overage before)
      var denom = monthlyIncluded + monthlyOverage || 1;
      var incW = monthlyIncluded / denom * 100;
      var setW = function (id, w) { var e = document.getElementById(id); if (e) e.style.width = w + '%'; };
      setW('calc-inc-b', incW); setW('calc-ov-b', 100 - incW);
      setW('calc-inc-a', incW); setW('calc-ov-a', Math.max(0, monthlyOverageAfter / denom * 100));
      document.getElementById('calc-inc-b').textContent = '';
      // labels
      document.getElementById('calc-ov-b').textContent = '';
      document.getElementById('calc-ov-a').textContent = '';

      if (annualBefore === 0) {
        headroomEl.hidden = false;
        var headroom = Math.round(monthlyConsumed * REDUCTION);
        headroomEl.innerHTML = 'At this size and intensity you are <strong>inside your included allowance</strong> — for now. The modelled reduction still buys you <span class="num">' +
          fmtInt(headroom) + '</span> credits/month of additional headroom before you cross it.';
      } else {
        headroomEl.hidden = true;
      }
      return { annualBefore: annualBefore, saving: saving, pct: pct };
    };

    seatsEl.addEventListener('input', function () {
      CALC.seats = parseInt(seatsEl.value, 10);
      seatsVal.textContent = fmtInt(CALC.seats);
      compute();
    });
    segBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        var group = b.parentElement;
        group.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
        if (b.dataset.plan) CALC.plan = b.dataset.plan;
        if (b.dataset.intensity) CALC.intensity = b.dataset.intensity;
        if (b.dataset.tier) CALC.tier = b.dataset.tier;
        compute();
      });
    });
    compute();
    // expose for verification
    window.__tokenlensCalc = compute;
  }

  /* ---------- 17 · Static fallback for pinned bits ---------- */
  function staticFallbacks() {
    if (PINNED) return;
    // reveal any remaining hidden pinned content
    document.querySelectorAll('#anatomy-pin .beat, #meridian-pin .beat').forEach(function (b) {
      if (!b.style.display || b.style.display === 'none') { /* handled per-section */ }
    });
  }

  /* ---------- boot ---------- */
  function safe(name, fn) {
    try { fn(); } catch (e) {
      if (window.console && console.error) console.error('[tokenlens-site] ' + name + ' failed:', e);
    }
  }
  document.addEventListener('DOMContentLoaded', function () {
    safe('chips', buildChips);
    safe('rail', buildRail);
    safe('legend', legend);
    safe('countUps', function () { countUps(document); });
    safe('cliff', cliff);
    safe('heroScan', heroScan);
    safe('multiplier', multiplier);
    safe('free61', free61);
    safe('concentration', concentration);
    safe('causes', causes);
    safe('dashboard', buildDashboard);
    safe('pinAnatomy', pinAnatomy);
    safe('pinCostCentres', pinCostCentres);
    safe('toolTax', toolTax);
    safe('priya', priya);
    safe('meridian', meridian);
    safe('calc', calc);
    safe('staticFallbacks', staticFallbacks);
    if (window.ScrollTrigger) {
      window.addEventListener('load', function () { ScrollTrigger.refresh(); });
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { ScrollTrigger.refresh(); });
    }
  });
})();
