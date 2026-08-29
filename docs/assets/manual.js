(function(){
  /* TOC toggle (mobile) */
  var toc = document.getElementById('toc');
  var tocToggle = document.getElementById('toc-toggle');
  if (tocToggle) {
    tocToggle.addEventListener('click', function(){ toc.classList.toggle('open'); });
  }
  toc.querySelectorAll('a').forEach(function(a){
    a.addEventListener('click', function(){ toc.classList.remove('open'); });
  });

  /* Reveal-on-scroll for chapters */
  var chapters = document.querySelectorAll('section.chapter');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if (e.isIntersecting) {
          e.target.classList.add('show');
          io.unobserve(e.target);
        }
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.05 });
    chapters.forEach(function(c){ io.observe(c); });
  } else {
    chapters.forEach(function(c){ c.classList.add('show'); });
  }

  /* Active section highlighting */
  var headings = Array.prototype.slice.call(document.querySelectorAll('section.chapter[id], section.chapter h3[id], section.chapter h4[id]'));
  var tocLinks = {};
  toc.querySelectorAll('a[href^="#"]').forEach(function(link){
    tocLinks[link.getAttribute('href').slice(1)] = link;
  });

  function onScroll(){
    var y = window.scrollY + 120;
    var current = null;
    for (var i = 0; i < headings.length; i++) {
      if (headings[i].offsetTop <= y) current = headings[i].id;
    }
    Object.keys(tocLinks).forEach(function(id){
      tocLinks[id].classList.toggle('active', id === current);
    });
    /* chapter-level highlight */
    document.querySelectorAll('.toc .ch-item').forEach(function(item){ item.classList.remove('active'); });
    if (current) {
      var match = current.match(/^ch(\d+)/);
      if (match) {
        var chapterAnchor = toc.querySelector('a[href="#chapter-' + parseInt(match[1], 10) + '"]');
        if (chapterAnchor) chapterAnchor.closest('.ch-item').classList.add('active');
      } else if (current.indexOf('chapter-') === 0) {
        var a = toc.querySelector('a[href="#' + current + '"]');
        if (a) a.closest('.ch-item').classList.add('active');
      }
    }
    /* back-to-top */
    document.getElementById('back-top').classList.toggle('show', window.scrollY > 400);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* Back to top */
  document.getElementById('back-top').addEventListener('click', function(){
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  /* Copy code blocks on click */
  document.querySelectorAll('pre').forEach(function(pre){
    pre.style.cursor = 'pointer';
    pre.title = 'Click to copy';
    pre.addEventListener('click', function(){
      var code = pre.querySelector('code') ? pre.querySelector('code').textContent : pre.textContent;
      navigator.clipboard && navigator.clipboard.writeText(code);
      var original = pre.style.borderColor;
      pre.style.borderColor = 'var(--green)';
      setTimeout(function(){ pre.style.borderColor = original; }, 600);
    });
  });
})();
