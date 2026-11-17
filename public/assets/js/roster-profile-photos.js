import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const profilePhotoCache = new Map();

function isValidProfilePhoto(value) {
  return typeof value === "string"
    && value.length <= 180000
    && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(value);
}

export function attachRosterProfilePhotos(container, db) {
  container.querySelectorAll(".roster-profile-avatar[data-profile-key]").forEach(avatar => {
    const profileKey = avatar.dataset.profileKey.toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(profileKey)) return;

    if (!profilePhotoCache.has(profileKey)) {
      profilePhotoCache.set(profileKey, getDoc(doc(db, "dailyTaskProfilePhotos", profileKey))
        .then(snapshot => {
          const photoData = snapshot.exists() ? snapshot.data().photoData : null;
          return isValidProfilePhoto(photoData) ? photoData : null;
        })
        .catch(error => {
          profilePhotoCache.delete(profileKey);
          throw error;
        }));
    }

    void profilePhotoCache.get(profileKey).then(photoData => {
      if (!photoData || !avatar.isConnected) return;
      const image = document.createElement("img");
      image.src = photoData;
      image.alt = "";
      avatar.replaceChildren(image);
    }).catch(error => {
      console.error(`Unable to load roster profile photo ${profileKey}:`, error);
    });
  });
}
