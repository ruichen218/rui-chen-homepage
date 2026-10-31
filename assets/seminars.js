(() => {
  'use strict';

  const series = window.CSU_SEMINAR_SERIES;
  const home = document.getElementById('csu-seminar-home');
  const seriesPage = document.getElementById('seminar-series-page');
  if (!series || (!home && !seriesPage)) return;

  const siteBase = new URL('../', document.currentScript.src);
  const storageKey = 'rui-chen-homepage-language';
  const labels = {
    en: {
      organizer: 'Organizers', language: 'Language', online: 'Online series',
      next: 'Next session', current: 'Current session', recent: 'Recent session',
      upcoming: 'Upcoming', live: 'In progress', past: 'Past session',
      session: 'Session', details: 'Details & all sessions',
      home: 'Back to homepage', skip: 'Skip to seminar sessions',
      series: 'Seminar series', upcomingSessions: 'Upcoming sessions',
      pastSessions: 'Past sessions', speaker: 'Speaker', time: 'Time',
      format: 'Format', timezone: 'Beijing time (UTC+8)', abstract: 'Abstract',
      biography: 'About the speaker', join: 'Email the organizer for joining details.',
      posterAlt: 'Chinese-language poster for session',
      posterCaption: 'Poster in Chinese', posterDownload: 'View / download poster (PDF)',
      contact: 'Contact the organizer', count: count => `${count} ${count === 1 ? 'session' : 'sessions'}`,
      mailSubject: event => `Joining details: CSU Alumni Seminar, Session ${event.number}`
    },
    zh: {
      organizer: '组织者', language: '报告语言', online: '线上系列活动',
      next: '下一场', current: '正在进行', recent: '最近一期',
      upcoming: '即将举行', live: '正在进行', past: '往期活动',
      session: '第', details: '查看详情与历次活动',
      home: '返回个人主页', skip: '跳转至活动场次',
      series: '系列学术活动', upcomingSessions: '近期活动',
      pastSessions: '往期活动', speaker: '报告人', time: '时间',
      format: '会议方式', timezone: '北京时间（UTC+8）', abstract: '报告摘要',
      biography: '报告人介绍', join: '请发邮件联系组织者获取参会信息。',
      posterAlt: '第', posterCaption: '中文活动海报', posterDownload: '查看 / 下载海报（PDF）',
      contact: '联系组织者', count: count => `${count} 场`,
      mailSubject: event => `中南数统学友学术交流 Seminar 第 ${event.number} 场参会信息`
    }
  };

  const escape = value => String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
  const text = (value, language) => typeof value === 'string' ? value : (value[language] || value.en);
  const organizerNames = language => series.organizers.map(person => text(person.name, language)).join(language === 'zh' ? '、' : ' · ');
  const organizerLinks = language => series.organizers.map(person => person.email ? `<a href="mailto:${escape(person.email)}">${escape(text(person.name, language))}</a>` : escape(text(person.name, language))).join(language === 'zh' ? '、' : ' · ');
  const lang = () => document.documentElement.lang.startsWith('zh') ? 'zh' : 'en';
  const sessionLabel = (event, language) => language === 'zh' ? `第 ${event.number} 场` : `Session ${event.number}`;
  const eventStatus = (event, now) => now < Date.parse(event.startsAt) ? 'upcoming' : now < Date.parse(event.endsAt) ? 'live' : 'past';
  const siteURL = (path, language, hash = '') => {
    const url = new URL(path, siteBase);
    if (language) url.searchParams.set('lang', language);
    if (hash) url.hash = hash;
    return url.href;
  };
  const emailURL = (event, language) => `mailto:${series.contactEmail}?subject=${encodeURIComponent(labels[language].mailSubject(event))}`;
  const byStart = (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt);

  function eventDate(event, language) {
    const date = new Date(event.startsAt);
    const locale = language === 'zh' ? 'zh-CN' : 'en-GB';
    return new Intl.DateTimeFormat(locale, {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: language === 'zh' ? 'long' : 'long',
      day: 'numeric', weekday: 'long'
    }).format(date);
  }

  function eventTime(event) {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    });
    return `${formatter.format(new Date(event.startsAt))}–${formatter.format(new Date(event.endsAt))}`;
  }

  function renderHome() {
    if (!home) return;
    const language = lang();
    const ui = labels[language];
    const now = Date.now();
    const ordered = [...series.events].sort(byStart);
    const event = ordered.find(item => Date.parse(item.endsAt) > now) || ordered[ordered.length - 1];
    const seriesLink = siteURL('seminars/csu-alumni/', language);
    let eventHTML = '';
    if (event) {
      const status = eventStatus(event, now);
      const heading = status === 'past' ? ui.recent : status === 'live' ? ui.current : ui.next;
      eventHTML = `<div class="seminar-home-event">
        <p class="seminar-event-label"><span>${escape(heading)} · ${escape(sessionLabel(event, language))}</span><span class="seminar-status">${escape(ui[status])}</span></p>
        <h4 lang="en"><a href="${escape(siteURL('seminars/csu-alumni/', language, event.id))}">${escape(event.title)}</a></h4>
        <p class="seminar-home-speaker"><strong>${escape(text(event.speaker.name, language))}</strong> · ${escape(text(event.speaker.affiliation, language))}</p>
        <p class="seminar-home-time"><time datetime="${escape(event.startsAt)}">${escape(eventDate(event, language))} · ${escape(eventTime(event))}</time> · ${escape(ui.timezone)}</p>
      </div>`;
    }
    home.innerHTML = `<article class="seminar-home-card">
      <h3><a href="${escape(seriesLink)}">${escape(text(series.title, language))}</a></h3>
      <div class="seminar-meta-line"><span>${escape(ui.organizer)}: ${escape(organizerNames(language))}</span><span>${escape(ui.language)}: ${escape(text(series.language, language))}</span><span>${escape(ui.online)}</span></div>
      ${eventHTML}<a class="seminar-series-link" href="${escape(seriesLink)}">${escape(ui.details)}</a>
    </article>`;
  }

  function sessionHTML(event, language) {
    const ui = labels[language];
    const status = eventStatus(event, Date.now());
    const poster = event.poster ? `<figure class="seminar-poster">
      <a href="${escape(siteURL(event.poster.pdf))}" target="_blank" rel="noopener" aria-label="${escape(`${sessionLabel(event, language)} · ${ui.posterDownload}`)}">
        <img src="${escape(siteURL(event.poster.image))}" alt="${escape(language === 'zh' ? `第 ${event.number} 场中文活动海报` : `${ui.posterAlt} ${event.number}`)}" width="1025" height="1536" loading="lazy">
      </a>
      <figcaption>${escape(ui.posterCaption)}<br><a href="${escape(siteURL(event.poster.pdf))}" target="_blank" rel="noopener">${escape(ui.posterDownload)}</a></figcaption>
    </figure>` : '';
    return `<article class="seminar-session" id="${escape(event.id)}" aria-labelledby="${escape(event.id)}-title">
      <p class="seminar-event-label"><span>${escape(sessionLabel(event, language))}</span><span class="seminar-status">${escape(ui[status])}</span></p>
      <h3 class="seminar-session-title" id="${escape(event.id)}-title" lang="en">${escape(event.title)}</h3>
      <div class="seminar-session-grid"><div>
        <dl class="seminar-session-info">
          <div class="seminar-info-row"><dt>${escape(ui.speaker)}</dt><dd><strong>${escape(text(event.speaker.name, language))}</strong><br>${escape(text(event.speaker.affiliation, language))}</dd></div>
          <div class="seminar-info-row"><dt>${escape(ui.time)}</dt><dd><time datetime="${escape(event.startsAt)}">${escape(eventDate(event, language))}<br>${escape(eventTime(event))}</time><br><span class="seminar-time-zone">${escape(ui.timezone)}</span></dd></div>
          <div class="seminar-info-row"><dt>${escape(ui.language)}</dt><dd>${escape(text(series.language, language))}</dd></div>
          <div class="seminar-info-row"><dt>${escape(ui.format)}</dt><dd>${escape(text(event.format || series.format, language))}</dd></div>
        </dl>
        <div class="seminar-join"><p>${escape(ui.join)}</p><a href="${escape(emailURL(event, language))}">${escape(series.contactEmail)}</a></div>
        <h4 class="seminar-text-heading">${escape(ui.abstract)}</h4><p class="seminar-copy">${escape(text(event.abstract, language))}</p>
        <h4 class="seminar-text-heading">${escape(ui.biography)}</h4><p class="seminar-copy">${escape(text(event.biography, language))}</p>
      </div>${poster}</div>
    </article>`;
  }

  function groupHTML(events, language, archived) {
    if (!events.length) return '';
    const ui = labels[language];
    return `<section class="seminar-session-group" aria-labelledby="${archived ? 'past' : 'upcoming'}-heading">
      <div class="seminar-group-heading"><h2 id="${archived ? 'past' : 'upcoming'}-heading">${escape(archived ? ui.pastSessions : ui.upcomingSessions)}</h2><span class="seminar-group-count">${escape(ui.count(events.length))}</span></div>
      ${events.map(event => sessionHTML(event, language)).join('')}
    </section>`;
  }

  function renderSeries() {
    if (!seriesPage) return;
    const language = lang();
    const ui = labels[language];
    const now = Date.now();
    const upcoming = series.events.filter(event => Date.parse(event.endsAt) > now).sort(byStart);
    const past = series.events.filter(event => Date.parse(event.endsAt) <= now).sort((a, b) => byStart(b, a));
    document.title = `${text(series.title, language)} | Rui Chen`;
    document.querySelector('meta[name="description"]').content = text(series.description, language);
    document.querySelectorAll('[data-seminar-label]').forEach(node => {
      node.textContent = ui[node.dataset.seminarLabel];
    });
    document.querySelectorAll('[data-seminar-home]').forEach(link => {
      link.href = siteURL('', language, 'organizing');
    });
    document.querySelectorAll('.seminar-language-button').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.language === language));
    });
    seriesPage.innerHTML = `<header class="seminar-page-hero">
      <p class="seminar-page-eyebrow">${escape(ui.series)}</p>
      <h1 class="seminar-page-title">${escape(text(series.title, language))}</h1>
      <p class="seminar-page-description">${escape(text(series.description, language))}</p>
      <div class="seminar-series-meta"><p><span class="seminar-meta-caption">${escape(ui.organizer)}</span>${organizerLinks(language)}</p><p><span class="seminar-meta-caption">${escape(ui.language)}</span>${escape(text(series.language, language))}</p><p>${escape(ui.online)}</p></div>
    </header>
    <div id="seminar-sessions">${groupHTML(upcoming, language, false)}${groupHTML(past, language, true)}</div>`;
  }

  function applySeriesLanguage(language, remember) {
    if (language !== 'en' && language !== 'zh') return;
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    renderSeries();
    if (remember) {
      try { localStorage.setItem(storageKey, language); } catch (_) { /* Optional storage. */ }
      const url = new URL(window.location.href);
      url.searchParams.set('lang', language);
      try { history.replaceState(null, '', url.href); } catch (_) { /* Optional history. */ }
    }
  }

  if (seriesPage) {
    let language = 'en';
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === 'en' || saved === 'zh') language = saved;
    } catch (_) { /* Use English when storage is unavailable. */ }
    const requested = new URLSearchParams(window.location.search).get('lang');
    if (requested === 'en' || requested === 'zh') language = requested;
    applySeriesLanguage(language, false);
    document.querySelectorAll('.seminar-language-button').forEach(button => {
      button.addEventListener('click', () => applySeriesLanguage(button.dataset.language, true));
    });
    if (window.location.hash) {
      requestAnimationFrame(() => {
        const target = document.getElementById(window.location.hash.slice(1));
        if (target) target.scrollIntoView({ block: 'start' });
      });
    }
  }
  if (home) {
    renderHome();
    new MutationObserver(renderHome).observe(document.documentElement, {
      attributes: true, attributeFilter: ['lang']
    });
  }

  // Reclassify sessions when a start/end boundary passes, including an open tab.
  let transitionTimer;
  function scheduleTransition() {
    clearTimeout(transitionTimer);
    const now = Date.now();
    const boundaries = series.events.flatMap(event => [Date.parse(event.startsAt), Date.parse(event.endsAt)]).filter(time => time > now);
    if (!boundaries.length) return;
    transitionTimer = setTimeout(() => {
      renderHome();
      renderSeries();
      scheduleTransition();
    }, Math.min(Math.min(...boundaries) - now + 100, 86400000));
  }
  scheduleTransition();
})();
