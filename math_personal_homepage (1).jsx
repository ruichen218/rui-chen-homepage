<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Rui Chen | Mathematics</title>
  <meta name="description" content="Rui Chen - PhD Student in Mathematics. Research in nonlocal operators, spectral theory, and partial differential equations." />
  <style>
    :root {
      --bg: #ffffff;
      --panel: #f8fafc;
      --card: #ffffff;
      --text: #0f172a;
      --muted: #475569;
      --line: #e2e8f0;
      --accent: #0f172a;
      --accent-soft: #f1f5f9;
      --maxw: 1100px;
      --shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
      --radius: 22px;
    }

    * {
      box-sizing: border-box;
    }

    html {
      scroll-behavior: smooth;
    }

    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.7;
    }

    a {
      color: inherit;
      text-decoration: none;
    }

    .container {
      width: min(var(--maxw), calc(100% - 32px));
      margin: 0 auto;
    }

    .site-header {
      position: sticky;
      top: 0;
      z-index: 20;
      background: rgba(255, 255, 255, 0.92);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--line);
    }

    .header-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      padding: 18px 0;
    }

    .brand h1 {
      margin: 0;
      font-size: 2rem;
      line-height: 1.1;
      font-weight: 650;
      letter-spacing: -0.03em;
    }

    .brand p {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 0.98rem;
    }

    .nav {
      display: flex;
      flex-wrap: wrap;
      gap: 18px;
      color: var(--muted);
      font-size: 0.96rem;
    }

    .nav a:hover {
      color: var(--text);
    }

    .hero {
      padding: 72px 0 48px;
    }

    .hero-grid {
      display: grid;
      grid-template-columns: 1.35fr 0.9fr;
      gap: 28px;
      align-items: start;
    }

    .eyebrow {
      margin: 0;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.22em;
      font-size: 0.78rem;
    }

    .hero h2 {
      margin: 14px 0 0;
      font-size: clamp(2.2rem, 4vw, 4rem);
      line-height: 1.08;
      letter-spacing: -0.04em;
      font-weight: 680;
      max-width: 820px;
    }

    .hero p.lead {
      margin: 22px 0 0;
      color: var(--muted);
      font-size: 1.08rem;
      max-width: 760px;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      margin-top: 28px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 12px 18px;
      border-radius: 16px;
      border: 1px solid var(--line);
      background: white;
      transition: 0.2s ease;
      font-weight: 500;
    }

    .btn:hover {
      transform: translateY(-1px);
    }

    .btn-primary {
      background: var(--accent);
      color: white;
      border-color: var(--accent);
    }

    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 24px;
    }

    .panel h3,
    .card h3,
    .section h3 {
      margin: 0;
      font-size: 1.45rem;
      line-height: 1.2;
      font-weight: 650;
      letter-spacing: -0.02em;
    }

    .mini-card {
      background: white;
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 14px 16px;
      margin-top: 12px;
      color: #334155;
    }

    .mini-meta {
      margin-top: 18px;
      font-size: 0.96rem;
      color: var(--muted);
    }

    .section {
      padding: 16px 0 12px;
    }

    .section-block {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: white;
      box-shadow: var(--shadow);
      padding: 30px;
    }

    .section-block p,
    .section > p {
      color: var(--muted);
    }

    .cards-3 {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 20px;
      margin-top: 20px;
    }

    .cards-2 {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 20px;
      margin-top: 20px;
    }

    .card {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: white;
      box-shadow: var(--shadow);
      padding: 24px;
    }

    .card p {
      color: var(--muted);
      margin-bottom: 0;
    }

    .pub-list,
    .link-list {
      display: grid;
      gap: 14px;
      margin-top: 18px;
    }

    .pub-item,
    .link-item {
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 16px 18px;
      background: white;
      color: #334155;
    }

    .link-item:hover {
      background: var(--accent-soft);
    }

    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 18px;
    }

    .tag {
      padding: 8px 14px;
      border-radius: 999px;
      border: 1px solid #cbd5e1;
      color: #334155;
      font-size: 0.92rem;
      background: white;
    }

    .contact {
      background: var(--accent);
      color: white;
    }

    .contact p,
    .contact .contact-meta {
      color: rgba(255, 255, 255, 0.82);
    }

    .footer {
      padding: 28px 0 48px;
      color: #64748b;
      font-size: 0.92rem;
    }

    @media (max-width: 900px) {
      .hero-grid,
      .cards-3,
      .cards-2 {
        grid-template-columns: 1fr;
      }

      .header-inner {
        flex-direction: column;
        align-items: flex-start;
      }
    }

    @media (max-width: 640px) {
      .hero {
        padding-top: 52px;
      }

      .section-block,
      .panel,
      .card {
        padding: 22px;
      }

      .nav {
        gap: 12px;
      }
    }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="container header-inner">
      <div class="brand">
        <h1>Rui Chen</h1>
        <p>PhD Student in Mathematics</p>
      </div>
      <nav class="nav">
        <a href="#about">About</a>
        <a href="#research">Research</a>
        <a href="#publications">Publications</a>
        <a href="#links">Links</a>
        <a href="#contact">Contact</a>
      </nav>
    </div>
  </header>

  <main>
    <section class="hero">
      <div class="container hero-grid">
        <div>
          <p class="eyebrow">Academic Homepage</p>
          <h2>Analysis, nonlocal operators, and spectral problems.</h2>
          <p class="lead">
            I am a PhD student in mathematics. My research focuses on nonlocal operators, spectral theory, and partial differential equations, with particular interest in fractional and logarithmic operators on Euclidean spaces, manifolds, and graphs.
          </p>
          <div class="actions">
            <a class="btn btn-primary" href="#publications">View Publications</a>
            <a class="btn" href="#contact">Contact</a>
          </div>
        </div>

        <aside class="panel">
          <h3>Current Profile</h3>
          <div class="mini-card">PhD Student in Mathematics</div>
          <div class="mini-card">Research in analysis, PDE, and spectral theory</div>
          <div class="mini-card">Interested in nonlocal operators on continuous and discrete spaces</div>
          <div class="mini-meta">
            <div><strong style="color:#0f172a;">Affiliation:</strong> Fudan University / Brandenburg University of Technology Cottbus-Senftenberg</div>
            <div><strong style="color:#0f172a;">Stage:</strong> Doctoral researcher / early-career academic profile</div>
          </div>
        </aside>
      </div>
    </section>

    <section id="about" class="section">
      <div class="container">
        <div class="section-block">
          <h3>About</h3>
          <p>
            Welcome to my personal webpage. This site presents my research interests, current work, and academic links. At this stage of my career, I aim to build a clear and focused profile centered on mathematical analysis, spectral problems, and nonlocal partial differential equations.
          </p>
          <p>
            The design is intentionally clean and research-oriented, making it suitable for applications, collaborations, and future transition from PhD student to postdoctoral researcher.
          </p>
        </div>
      </div>
    </section>

    <section id="research" class="section">
      <div class="container">
        <h3>Research Interests</h3>
        <p>Main topics currently shaping my work.</p>
        <div class="cards-3">
          <article class="card">
            <h3 style="font-size:1.15rem;">Nonlocal Operators</h3>
            <p>Fractional Laplacians, logarithmic Laplacians, and related nonlocal operators on Euclidean spaces, manifolds, and graphs.</p>
          </article>
          <article class="card">
            <h3 style="font-size:1.15rem;">Spectral Theory and Geometric Analysis</h3>
            <p>Eigenvalue problems, sharp inequalities, and spectral phenomena arising in geometric and nonlocal settings.</p>
          </article>
          <article class="card">
            <h3 style="font-size:1.15rem;">Partial Differential Equations</h3>
            <p>Existence, regularity, asymptotic analysis, and variational methods for nonlocal and pseudo-differential equations.</p>
          </article>
        </div>
      </div>
    </section>

    <section id="publications" class="section">
      <div class="container">
        <div class="section-block">
          <h3>Publications and Preprints</h3>
          <p>A structured section for papers, preprints, and ongoing projects.</p>
          <div class="pub-list">
            <div class="pub-item">Selected publications and preprints can be listed here in reverse chronological order.</div>
            <div class="pub-item">You may add arXiv links, journal information, and coauthor details.</div>
            <div class="pub-item">This section is intentionally structured for a PhD student or early-career researcher profile.</div>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container cards-2">
        <div class="card">
          <h3>Research Keywords</h3>
          <div class="tags">
            <span class="tag">Fractional Laplacian</span>
            <span class="tag">Logarithmic Laplacian</span>
            <span class="tag">Spectral Theory</span>
            <span class="tag">Geometric Analysis</span>
            <span class="tag">PDE</span>
            <span class="tag">Manifolds</span>
            <span class="tag">Graphs</span>
            <span class="tag">Variational Methods</span>
          </div>
        </div>

        <div class="card" id="links">
          <h3>Academic Links</h3>
          <div class="link-list">
            <a class="link-item" href="https://scholar.google.com/citations?hl=zh-CN&user=o7l0Pa0AAAAJ&view_op=list_works&sortby=pubdate" target="_blank" rel="noopener noreferrer">Google Scholar</a>
            <a class="link-item" href="#">arXiv</a>
            <a class="link-item" href="#">ORCID</a>
            <a class="link-item" href="#">CV</a>
          </div>
        </div>
      </div>
    </section>

    <section id="contact" class="section">
      <div class="container">
        <div class="section-block contact">
          <h3>Contact</h3>
          <p>
            For academic correspondence, collaboration, or research discussion, please contact me via email. You may also include your CV, institutional webpage, and research profiles here.
          </p>
          <div class="contact-meta">
            <div>Email: your.email@university.edu</div>
            <div>Office: Department of Mathematics / University</div>
            <div>Location: Germany / China</div>
          </div>
        </div>
      </div>
    </section>
  </main>

  <footer class="footer">
    <div class="container">
      © 2026 Rui Chen. Academic homepage template.
    </div>
  </footer>
</body>
</html>
