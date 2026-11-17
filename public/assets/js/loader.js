/* Planet Drugstore — global loading overlay (spinning logo)
   Usage:
     1) Put this file + logo-transparent.png in the same folder as your HTML pages.
     2) Add before </body>:  <script src="loader.js"></script>
     3) Call PDLoader.show() right before any async action (login, save, delete, etc.)
        and PDLoader.hide() when it's done / if it fails.
*/
(function(){
  const LOGO_PATH = 'logo-transparent.png';

  function getStoredSession(){
    try {
      const raw = localStorage.getItem('pdEmployeeSession') || sessionStorage.getItem('pdEmployeeSession');
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function isViewerSession(session){
    if (!session) return false;
    const role = String(session.role || session.accountType || '').trim().toLowerCase();
    const staffId = String(session.staffId || '').trim().toLowerCase();
    const email = String(session.email || '').trim().toLowerCase();
    return role === 'viewer' || staffId === 'pdsviewing' || staffId === 'viewer' || email === 'pdsviewing@planetdrugstore.ph';
  }

  function applyReadOnlyGuard(){
    const session = getStoredSession();
    if (!isViewerSession(session)) return;

    const bannerId = 'pdsReadOnlyBanner';
    let banner = document.getElementById(bannerId);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = bannerId;
      banner.textContent = 'View-only access: changes are disabled.';
      banner.setAttribute('role', 'status');
      banner.style.cssText = [
        'position:fixed',
        'top:0',
        'left:0',
        'right:0',
        'z-index:100000',
        'background:#6E1620',
        'color:#fff',
        'padding:10px 16px',
        'font:600 12px/1.4 Inter,Segoe UI,sans-serif',
        'letter-spacing:0.2px',
        'text-align:center',
        'box-shadow:0 4px 14px rgba(0,0,0,0.18)',
      ].join(';');
      document.body.appendChild(banner);
    }

    const allowedSelector = [
      '#OnLogout',
      '#logoutBtn',
      '#adminChipBtn',
      '#closeEmployeeUpdateHistory',
      '#closeProfileButton',
      '#cancelProfileButton',
      '[data-allow-viewer="true"]'
    ];
    document.querySelectorAll('button, input, textarea, select').forEach((element) => {
      if (element.matches(allowedSelector.join(', '))) return;
      if (element.type === 'hidden') return;
      element.disabled = true;
      element.setAttribute('aria-disabled', 'true');
      if (element.tagName === 'BUTTON') {
        element.style.opacity = '0.65';
        element.style.cursor = 'not-allowed';
      }
    });

    document.querySelectorAll('form').forEach((form) => {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        event.stopPropagation();
      }, { capture: true });
    });

    window.PDSViewerMode = true;
  }

  const style = document.createElement('style');
  style.textContent = `
    #pdLoaderOverlay{
      position:fixed; inset:0; z-index:99999;
      display:none; align-items:center; justify-content:center;
      background:rgba(19,29,59,0.55);
      backdrop-filter:blur(2px);
    }
    #pdLoaderOverlay.pd-show{ display:flex; }
    #pdLoaderOverlay img{
      width:84px; height:84px;
      animation:pdSpin 1s linear infinite;
      filter:drop-shadow(0 6px 18px rgba(0,0,0,0.35));
    }
    @keyframes pdSpin{
      from{ transform:rotate(0deg); }
      to{ transform:rotate(360deg); }
    }
  `;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.id = 'pdLoaderOverlay';
  overlay.innerHTML = `<img src="${LOGO_PATH}" alt="Loading">`;
  document.addEventListener('DOMContentLoaded', ()=> {
    if (document.body) document.body.appendChild(overlay);
    applyReadOnlyGuard();
  });
  if(document.body) document.body.appendChild(overlay);

  window.PDLoader = {
    show(){ overlay.classList.add('pd-show'); },
    hide(){ overlay.classList.remove('pd-show'); },
    // Wrap an async function so the spinner shows while it runs and
    // hides automatically when it finishes (success or error).
    wrap(fn){
      return async function(...args){
        overlay.classList.add('pd-show');
        try{
          return await fn.apply(this, args);
        } finally {
          overlay.classList.remove('pd-show');
        }
      };
    }
  };

  if (document.readyState !== 'loading') {
    applyReadOnlyGuard();
  }
})();