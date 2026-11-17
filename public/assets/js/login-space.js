(() => {
  const scene = document.getElementById("spaceScene");
  const card = document.querySelector("[data-login-card]");
  const tabs = document.querySelector(".login-tabs");
  const form = document.getElementById("loginForm");
  const submitButton = document.getElementById("loginBtn");
  const errorMessage = document.getElementById("loginError");
  const forgotLink = document.getElementById("forgotPassword");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!scene || !card || !tabs || !form || !submitButton) return;

  for (let index = 0; index < 58; index += 1) {
    const star = document.createElement("span");
    star.className = "star";
    star.style.setProperty("--star-x", `${Math.random() * 100}%`);
    star.style.setProperty("--star-y", `${Math.random() * 100}%`);
    star.style.setProperty("--star-size", `${Math.random() * 2 + 1}px`);
    star.style.setProperty("--star-time", `${3 + Math.random() * 5}s`);
    star.style.setProperty("--star-delay", `${-Math.random() * 7}s`);
    star.style.setProperty("--star-dx", `${Math.random() * 18 - 9}px`);
    star.style.setProperty("--star-dy", `${Math.random() * 22 - 11}px`);
    scene.append(star);
  }

  const shooter = document.createElement("span");
  shooter.className = "shooting-star";
  scene.append(shooter);

  if (!reducedMotion) {
    const shoot = () => {
      shooter.style.setProperty("--shoot-y", `${8 + Math.random() * 36}%`);
      shooter.classList.remove("is-shooting");
      void shooter.offsetWidth;
      shooter.classList.add("is-shooting");
      window.setTimeout(() => shooter.classList.remove("is-shooting"), 1200);
    };
    const scheduleShot = () => window.setTimeout(() => {
      shoot();
      scheduleShot();
    }, 3500 + Math.random() * 2500);
    scheduleShot();
  }

  const currentMode = tabs.dataset.mode;
  forgotLink?.addEventListener("click", (event) => {
    event.preventDefault();
    if (currentMode === "employee") {
      if (errorMessage) {
        errorMessage.textContent = "Please contact your department administrator to reset your password.";
        errorMessage.style.display = "block";
      }
      return;
    }
    window.dispatchEvent(new Event("pd-forgot-password"));
  });

  const previousMode = sessionStorage.getItem("pd-login-previous-mode");
  if (!reducedMotion && previousMode && previousMode !== currentMode) {
    tabs.classList.add("mode-transition");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      tabs.classList.remove("mode-transition");
      sessionStorage.removeItem("pd-login-previous-mode");
    }));
  }
  tabs.querySelectorAll(".login-tab").forEach((tab) => {
    tab.addEventListener("click", () => sessionStorage.setItem("pd-login-previous-mode", currentMode));
  });

  if (!reducedMotion) {
    window.addEventListener("pointermove", (event) => {
      if (event.pointerType !== "mouse") return;
      const offsetX = (event.clientX / window.innerWidth - .5) * 24;
      const offsetY = (event.clientY / window.innerHeight - .5) * 18;
      scene.querySelectorAll(".floating-saturn").forEach((planet, index) => {
        const factor = index === 0 ? 1 : .55;
        planet.style.setProperty("--parallax-x", `${offsetX * factor}px`);
        planet.style.setProperty("--parallax-y", `${offsetY * factor}px`);
      });
      const surface = scene.querySelector(".planet-surface");
      surface?.style.setProperty("--parallax-x", `${offsetX * .55}px`);
      surface?.style.setProperty("--parallax-y", `${offsetY * .55}px`);

      const bounds = card.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width - .5;
      const y = (event.clientY - bounds.top) / bounds.height - .5;
      if (event.clientX >= bounds.left - 80 && event.clientX <= bounds.right + 80
          && event.clientY >= bounds.top - 80 && event.clientY <= bounds.bottom + 80) {
        card.style.setProperty("--tilt-x", `${-y * 3}deg`);
        card.style.setProperty("--tilt-y", `${x * 3}deg`);
      } else {
        card.style.setProperty("--tilt-x", "0deg");
        card.style.setProperty("--tilt-y", "0deg");
      }
    });

    submitButton.addEventListener("pointermove", (event) => {
      if (submitButton.disabled || event.pointerType !== "mouse") return;
      const bounds = submitButton.getBoundingClientRect();
      submitButton.style.setProperty("--mag-x", `${(event.clientX - bounds.left - bounds.width / 2) * .06}px`);
      submitButton.style.setProperty("--mag-y", `${(event.clientY - bounds.top - bounds.height / 2) * .12}px`);
    });
    submitButton.addEventListener("pointerleave", () => {
      submitButton.style.setProperty("--mag-x", "0px");
      submitButton.style.setProperty("--mag-y", "0px");
    });
  }

  submitButton.addEventListener("click", (event) => {
    if (reducedMotion || submitButton.disabled) return;
    const bounds = submitButton.getBoundingClientRect();
    const ripple = document.createElement("span");
    ripple.className = "button-ripple";
    ripple.style.left = `${event.clientX - bounds.left}px`;
    ripple.style.top = `${event.clientY - bounds.top}px`;
    submitButton.append(ripple);
    ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
  });

  const updateFormState = () => {
    submitButton.classList.toggle("is-loading", submitButton.disabled
      && submitButton.textContent.trim().toLowerCase().startsWith("signing in"));
    const activeError = errorMessage?.style.display !== "none" ? errorMessage?.textContent.trim() : "";
    if (activeError && activeError !== lastError) {
      form.classList.remove("is-error");
      void form.offsetWidth;
      form.classList.add("is-error");
      window.setTimeout(() => form.classList.remove("is-error"), 450);
    }
    lastError = activeError;
  };
  let lastError = "";
  const stateObserver = new MutationObserver(updateFormState);
  stateObserver.observe(submitButton, {
    attributes: true,
    childList: true,
    subtree: true,
    characterData: true,
  });
  if (errorMessage) {
    stateObserver.observe(errorMessage, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
  }
})();
