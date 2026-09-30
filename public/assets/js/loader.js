/* Planet Drugstore — global loading overlay (spinning logo)
   Usage:
     1) Put this file + logo-transparent.png in the same folder as your HTML pages.
     2) Add before </body>:  <script src="loader.js"></script>
     3) Call PDLoader.show() right before any async action (login, save, delete, etc.)
        and PDLoader.hide() when it's done / if it fails.
*/
(function(){
  const LOGO_PATH = 'logo-transparent.png';

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
  document.addEventListener('DOMContentLoaded', ()=> document.body.appendChild(overlay));
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
})();