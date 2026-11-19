import {
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export async function closePendingSiteSwapsForCard(db, notificationsRef, cardId, action) {
  const resolvedCardId = String(cardId || "").trim();
  if (!resolvedCardId) return 0;

  const [requesterMatches, targetMatches] = await Promise.all([
    getDocs(query(notificationsRef, where("requesterCardId", "==", resolvedCardId))),
    getDocs(query(notificationsRef, where("targetCardId", "==", resolvedCardId)))
  ]);
  const requests = new Map();
  [requesterMatches, targetMatches].forEach(snapshot => {
    snapshot.forEach(request => {
      const data = request.data();
      if (data.type === "siteSwapRequest" && data.status === "pending") {
        requests.set(request.id, request);
      }
    });
  });

  const responseReason = `A site in this swap request was ${action} by Operations. The request was closed automatically.`;
  let closedCount = 0;
  for (const request of requests.values()) {
    const closed = await runTransaction(db, async transaction => {
      const current = await transaction.get(request.ref);
      if (!current.exists()) return false;
      const data = current.data();
      if (data.type !== "siteSwapRequest" || data.status !== "pending") return false;

      transaction.update(request.ref, {
        status: "cancelled",
        responseReason,
        resolved: true,
        resolvedAt: serverTimestamp()
      });
      return true;
    });
    if (closed) closedCount++;
  }
  return closedCount;
}

export async function closePendingSiteSwapsForCards(db, notificationsRef, cardIds, action) {
  const resolvedCardIds = [...new Set(
    (Array.isArray(cardIds) ? cardIds : [])
      .map(cardId => String(cardId || "").trim())
      .filter(Boolean)
  )];
  const results = await Promise.allSettled(
    resolvedCardIds.map(cardId => closePendingSiteSwapsForCard(db, notificationsRef, cardId, action))
  );
  const failures = results.filter(result => result.status === "rejected");
  if (failures.length) {
    throw new AggregateError(failures.map(result => result.reason), "One or more site-swap requests could not be closed.");
  }
  return results.reduce((total, result) => total + result.value, 0);
}
