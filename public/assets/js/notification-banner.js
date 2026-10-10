let activeBannerResolver = null;

window.showScheduleTopBanner = (notification, message, onOpen) => new Promise(resolve => {
	if (activeBannerResolver) activeBannerResolver();
	document.getElementById("scheduleTopBanner")?.remove();
	activeBannerResolver = resolve;

	const isCancelled = notification && notification.type === "eventCancelled";
	const isReinstated = notification && notification.type === "eventReinstated";
	const banner = document.createElement("section");
	banner.id = "scheduleTopBanner";
	banner.setAttribute("role", isCancelled ? "alert" : "status");
	banner.setAttribute("aria-live", isCancelled ? "assertive" : "polite");
	banner.style.cssText = [
		"position:fixed",
		"top:12px",
		"left:50%",
		"transform:translateX(-50%)",
		"z-index:12000",
		"width:min(680px,calc(100vw - 24px))",
		"box-sizing:border-box",
		"display:grid",
		"grid-template-columns:minmax(0,1fr) auto",
		"gap:10px 16px",
		"align-items:center",
		`padding:14px 16px;border:1px solid ${isCancelled ? "#e5484d" : isReinstated ? "#17855b" : "#315ca8"}`,
		`border-left:5px solid ${isCancelled ? "#e5484d" : isReinstated ? "#17855b" : "#315ca8"}`,
		`background:${isCancelled ? "#fff2f1" : isReinstated ? "#effaf4" : "#f1f6ff"}`,
		"color:#18212b",
		"box-shadow:0 8px 28px rgba(18,30,42,.2)",
		"font:500 14px/1.45 'IBM Plex Sans',system-ui,sans-serif"
	].join(";");

	const content = document.createElement("div");
	const title = document.createElement("strong");
	title.textContent = isCancelled ? "Event cancelled" : isReinstated ? "Event reinstated" : "Schedule update";
	title.style.cssText = "display:block;font-weight:700;margin-bottom:3px";
	const body = document.createElement("div");
	body.textContent = String(message || "Your schedule has changed.");
	body.style.cssText = "white-space:pre-line;overflow-wrap:anywhere";
	content.append(title, body);

	const actions = document.createElement("div");
	actions.style.cssText = "display:flex;gap:8px;align-items:center;justify-content:flex-end";
	const finish = () => {
		if (activeBannerResolver === resolve) activeBannerResolver = null;
		banner.remove();
		resolve();
	};
	if (typeof onOpen === "function") {
		const viewButton = document.createElement("button");
		viewButton.type = "button";
		viewButton.textContent = "View event";
		viewButton.style.cssText = "border:0;border-radius:4px;padding:8px 11px;background:#18212b;color:#fff;font:600 13px 'IBM Plex Sans',system-ui,sans-serif;cursor:pointer";
		viewButton.addEventListener("click", () => {
			try { onOpen(); } finally { finish(); }
		});
		actions.appendChild(viewButton);
	}
	const dismissButton = document.createElement("button");
	dismissButton.type = "button";
	dismissButton.textContent = "Dismiss";
	dismissButton.setAttribute("aria-label", "Dismiss schedule notification");
	dismissButton.style.cssText = "border:1px solid #aab3bd;border-radius:4px;padding:8px 11px;background:#fff;color:#18212b;font:600 13px 'IBM Plex Sans',system-ui,sans-serif;cursor:pointer";
	dismissButton.addEventListener("click", finish);
	actions.appendChild(dismissButton);

	banner.append(content, actions);
	document.body.appendChild(banner);
});